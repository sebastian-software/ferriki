/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! TextMate regular-expression sources compiled onto ferroni's Scanner API.

use std::array;
use std::fmt;
use std::sync::{Arc, Mutex};

use ferroni::api::Regex;
use ferroni::error::RegexError;
use ferroni::oniguruma::{OnigRegion, ONIG_OPTION_CAPTURE_GROUP, ONIG_OPTION_NONE};
use ferroni::regexec::onig_search;
pub use ferroni::scanner::{CaptureIndex, OnigString, ScannerFindOptions};
use ferroni::scanner::{Scanner, ScannerMatch};

#[derive(Clone, Debug)]
struct AnchorCache {
    a0_g0: String,
    a0_g1: String,
    a1_g0: String,
    a1_g1: String,
}

#[derive(Clone, Debug)]
pub struct RegExpSource<T> {
    pub source: String,
    pub rule_id: T,
    pub has_anchor: bool,
    pub has_back_references: bool,
    anchor_cache: Option<AnchorCache>,
}

impl<T> RegExpSource<T> {
    #[must_use]
    pub fn new(reg_exp_source: impl Into<String>, rule_id: T) -> Self {
        let reg_exp_source = reg_exp_source.into();
        let (source, has_anchor) = rewrite_end_anchor(&reg_exp_source);
        let anchor_cache = has_anchor.then(|| build_anchor_cache(&source));
        let has_back_references = has_back_references(&source);
        Self {
            source,
            rule_id,
            has_anchor,
            has_back_references,
            anchor_cache,
        }
    }

    pub fn set_source(&mut self, new_source: impl Into<String>) {
        let new_source = new_source.into();
        if self.source == new_source {
            return;
        }
        self.source = new_source;
        if self.has_anchor {
            self.anchor_cache = Some(build_anchor_cache(&self.source));
        }
    }

    #[must_use]
    pub fn resolve_back_references(
        &self,
        line_text: &str,
        capture_indices: &[CaptureIndex],
    ) -> String {
        replace_numeric_back_references(&self.source, line_text, capture_indices)
    }

    #[must_use]
    pub fn resolve_anchors(&self, allow_a: bool, allow_g: bool) -> &str {
        let Some(cache) = self.anchor_cache.as_ref() else {
            return &self.source;
        };
        match (allow_a, allow_g) {
            (false, false) => &cache.a0_g0,
            (false, true) => &cache.a0_g1,
            (true, false) => &cache.a1_g0,
            (true, true) => &cache.a1_g1,
        }
    }
}

fn rewrite_end_anchor(source: &str) -> (String, bool) {
    let bytes = source.as_bytes();
    let mut position = 0;
    let mut last_pushed_position = 0;
    let mut output = String::new();
    let mut has_anchor = false;

    while position < bytes.len() {
        if bytes[position] == b'\\' && position + 1 < bytes.len() {
            let next = source[position + 1..]
                .chars()
                .next()
                .expect("backslash must have a following character");
            match next {
                'z' => {
                    output.push_str(&source[last_pushed_position..position]);
                    output.push_str("$(?!\\n)(?<!\\n)");
                    last_pushed_position = position + 1 + next.len_utf8();
                }
                'A' | 'G' => has_anchor = true,
                _ => {}
            }
            position += 1 + next.len_utf8();
        } else {
            position += source[position..]
                .chars()
                .next()
                .expect("position must be within source")
                .len_utf8();
        }
    }

    if last_pushed_position == 0 {
        (source.to_owned(), has_anchor)
    } else {
        output.push_str(&source[last_pushed_position..]);
        (output, has_anchor)
    }
}

fn build_anchor_cache(source: &str) -> AnchorCache {
    let mut variants = array::from_fn::<_, 4, _>(|_| String::with_capacity(source.len()));
    let bytes = source.as_bytes();
    let mut position = 0;

    while position < bytes.len() {
        if bytes[position] == b'\\' && position + 1 < bytes.len() {
            let next = source[position + 1..]
                .chars()
                .next()
                .expect("backslash must have a following character");
            for variant in &mut variants {
                variant.push('\\');
            }
            match next {
                'A' => {
                    variants[0].push('\u{ffff}');
                    variants[1].push('\u{ffff}');
                    variants[2].push('A');
                    variants[3].push('A');
                }
                'G' => {
                    variants[0].push('\u{ffff}');
                    variants[1].push('G');
                    variants[2].push('\u{ffff}');
                    variants[3].push('G');
                }
                _ => {
                    for variant in &mut variants {
                        variant.push(next);
                    }
                }
            }
            position += 1 + next.len_utf8();
            continue;
        }

        let remainder = &source[position..];
        let character = remainder
            .chars()
            .next()
            .expect("position must be within source");
        for variant in &mut variants {
            variant.push(character);
        }
        position += character.len_utf8();
    }

    let [a0_g0, a0_g1, a1_g0, a1_g1] = variants;
    AnchorCache {
        a0_g0,
        a0_g1,
        a1_g0,
        a1_g1,
    }
}

fn has_back_references(source: &str) -> bool {
    let bytes = source.as_bytes();
    bytes
        .windows(2)
        .any(|pair| pair[0] == b'\\' && pair[1].is_ascii_digit())
}

fn replace_numeric_back_references(
    source: &str,
    line_text: &str,
    capture_indices: &[CaptureIndex],
) -> String {
    let bytes = source.as_bytes();
    let mut result = String::with_capacity(source.len());
    let mut position = 0;
    let mut last_pushed_position = 0;

    while position < bytes.len() {
        if bytes[position] != b'\\'
            || bytes
                .get(position + 1)
                .is_none_or(|byte| !byte.is_ascii_digit())
        {
            position += 1;
            continue;
        }

        let digit_start = position + 1;
        let mut digit_end = digit_start + 1;
        while bytes.get(digit_end).is_some_and(u8::is_ascii_digit) {
            digit_end += 1;
        }
        let capture_index = source[digit_start..digit_end]
            .parse::<usize>()
            .expect("ASCII digits must parse as an index");
        let captured_value = capture_indices.get(capture_index).map_or("", |capture| {
            substring_utf16(line_text, capture.start, capture.end)
        });

        result.push_str(&source[last_pushed_position..position]);
        result.push_str(&escape_reg_exp_characters(captured_value));
        last_pushed_position = digit_end;
        position = digit_end;
    }
    result.push_str(&source[last_pushed_position..]);
    result
}

fn substring_utf16(value: &str, start: usize, end: usize) -> &str {
    let start = utf16_offset_to_utf8(value, start);
    let end = utf16_offset_to_utf8(value, end);
    &value[start.min(end)..end]
}

fn utf16_offset_to_utf8(value: &str, offset: usize) -> usize {
    let mut utf16_position = 0;
    for (byte_position, character) in value.char_indices() {
        if utf16_position >= offset {
            return byte_position;
        }
        utf16_position += character.len_utf16();
        if utf16_position > offset {
            return byte_position + character.len_utf8();
        }
    }
    value.len()
}

fn escape_reg_exp_characters(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '-' | '\\'
                | '{'
                | '}'
                | '*'
                | '+'
                | '?'
                | '|'
                | '^'
                | '$'
                | '.'
                | ','
                | '['
                | ']'
                | '('
                | ')'
                | '#'
        ) || character.is_whitespace()
        {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

#[must_use]
pub fn has_captures(regex_source: Option<&str>) -> bool {
    let Some(source) = regex_source else {
        return false;
    };
    find_capture_placeholder(source, 0).is_some()
}

#[must_use]
pub fn replace_captures(
    regex_source: &str,
    capture_source: &str,
    capture_indices: &[CaptureIndex],
) -> String {
    let mut result = String::with_capacity(regex_source.len());
    let mut position = 0;
    while let Some(placeholder) = find_capture_placeholder(regex_source, position) {
        result.push_str(&regex_source[position..placeholder.start]);
        let Some(capture) = capture_indices.get(placeholder.index) else {
            result.push_str(&regex_source[placeholder.start..placeholder.end]);
            position = placeholder.end;
            continue;
        };

        let captured =
            substring_utf16(capture_source, capture.start, capture.end).trim_start_matches('.');
        match placeholder.command {
            Some(CaptureCommand::Downcase) => result.push_str(&captured.to_lowercase()),
            Some(CaptureCommand::Upcase) => result.push_str(&captured.to_uppercase()),
            None => result.push_str(captured),
        }
        position = placeholder.end;
    }
    result.push_str(&regex_source[position..]);
    result
}

#[derive(Clone, Copy)]
enum CaptureCommand {
    Downcase,
    Upcase,
}

struct CapturePlaceholder {
    start: usize,
    end: usize,
    index: usize,
    command: Option<CaptureCommand>,
}

fn find_capture_placeholder(source: &str, from: usize) -> Option<CapturePlaceholder> {
    let bytes = source.as_bytes();
    let mut position = from;
    while position < bytes.len() {
        if bytes[position] != b'$' {
            position += 1;
            continue;
        }

        if bytes.get(position + 1).is_some_and(u8::is_ascii_digit) {
            let digit_start = position + 1;
            let mut end = digit_start + 1;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            return Some(CapturePlaceholder {
                start: position,
                end,
                index: source[digit_start..end].parse().ok()?,
                command: None,
            });
        }

        if bytes.get(position + 1) == Some(&b'{') {
            let digit_start = position + 2;
            let mut digit_end = digit_start;
            while bytes.get(digit_end).is_some_and(u8::is_ascii_digit) {
                digit_end += 1;
            }
            if digit_end == digit_start || source.get(digit_end..digit_end + 2) != Some(":/") {
                position += 1;
                continue;
            }

            let command_start = digit_end + 2;
            let (command, command_length) =
                if source.get(command_start..command_start + 8) == Some("downcase") {
                    (CaptureCommand::Downcase, 8)
                } else if source.get(command_start..command_start + 6) == Some("upcase") {
                    (CaptureCommand::Upcase, 6)
                } else {
                    position += 1;
                    continue;
                };
            let end = command_start + command_length + 1;
            if bytes.get(end - 1) != Some(&b'}') {
                position += 1;
                continue;
            }
            return Some(CapturePlaceholder {
                start: position,
                end,
                index: source[digit_start..digit_end].parse().ok()?,
                command: Some(command),
            });
        }
        position += 1;
    }
    None
}

pub struct RegExpSourceList<T> {
    items: Vec<RegExpSource<T>>,
    has_anchors: bool,
    cached: Option<Arc<CompiledRule<T>>>,
    anchor_cache: [Option<Arc<CompiledRule<T>>>; 4],
}

impl<T> Default for RegExpSourceList<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> RegExpSourceList<T> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            has_anchors: false,
            cached: None,
            anchor_cache: array::from_fn(|_| None),
        }
    }

    pub fn dispose(&mut self) {
        self.dispose_caches();
    }

    fn dispose_caches(&mut self) {
        self.cached = None;
        self.anchor_cache = array::from_fn(|_| None);
    }

    pub fn push(&mut self, item: RegExpSource<T>) {
        self.has_anchors |= item.has_anchor;
        self.items.push(item);
    }

    pub fn unshift(&mut self, item: RegExpSource<T>) {
        self.has_anchors |= item.has_anchor;
        self.items.insert(0, item);
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn set_source(&mut self, index: usize, new_source: impl Into<String>) {
        let new_source = new_source.into();
        if self.items[index].source != new_source {
            self.dispose_caches();
            self.items[index].set_source(new_source);
        }
    }
}

impl<T: Copy> RegExpSourceList<T> {
    pub fn compile(&mut self) -> Result<Arc<CompiledRule<T>>, RegexError> {
        if let Some(cached) = self.cached.as_ref() {
            return Ok(Arc::clone(cached));
        }
        let compiled = Arc::new(CompiledRule::new(
            self.items.iter().map(|item| item.source.clone()).collect(),
            self.items.iter().map(|item| item.rule_id).collect(),
        )?);
        self.cached = Some(Arc::clone(&compiled));
        Ok(compiled)
    }

    pub fn compile_ag(
        &mut self,
        allow_a: bool,
        allow_g: bool,
    ) -> Result<Arc<CompiledRule<T>>, RegexError> {
        if !self.has_anchors {
            return self.compile();
        }

        let cache_index = usize::from(allow_a) * 2 + usize::from(allow_g);
        if let Some(cached) = self.anchor_cache[cache_index].as_ref() {
            return Ok(Arc::clone(cached));
        }
        let compiled = Arc::new(CompiledRule::new(
            self.items
                .iter()
                .map(|item| item.resolve_anchors(allow_a, allow_g).to_owned())
                .collect(),
            self.items.iter().map(|item| item.rule_id).collect(),
        )?);
        self.anchor_cache[cache_index] = Some(Arc::clone(&compiled));
        Ok(compiled)
    }
}

pub struct CompiledRule<T> {
    scanner: Mutex<Scanner>,
    direct_fallbacks: Vec<Option<DirectFallback>>,
    reg_exps: Vec<String>,
    rules: Vec<T>,
}

struct DirectFallback {
    regex: Regex,
    rejects_artificial_end: bool,
}

impl<T: Copy> CompiledRule<T> {
    fn new(reg_exps: Vec<String>, rules: Vec<T>) -> Result<Self, RegexError> {
        let compiled_reg_exps: Vec<_> = reg_exps
            .iter()
            .map(|pattern| normalize_ferroni_pattern(pattern))
            .collect();
        let direct_fallbacks: Vec<_> = compiled_reg_exps
            .iter()
            .map(|pattern| {
                Regex::builder(&stabilize_ferroni_captures(pattern))
                    .option(ONIG_OPTION_CAPTURE_GROUP)
                    .build()
                    .ok()
                    .map(|regex| DirectFallback {
                        regex,
                        rejects_artificial_end: has_line_start_anchor(pattern),
                    })
            })
            .collect();
        let scanner_reg_exps: Vec<_> = compiled_reg_exps
            .iter()
            .zip(&direct_fallbacks)
            .map(|(pattern, direct)| {
                if Regex::new(pattern).is_ok() || direct.is_none() {
                    pattern.as_str()
                } else {
                    // Oniguruma's CAPTURE_GROUP option permits numbered
                    // backreferences alongside named groups. Scanner does
                    // not expose compile options, so leave this pattern to
                    // the equivalent direct engine path below.
                    "(?!)"
                }
            })
            .collect();
        Ok(Self {
            scanner: Mutex::new(Scanner::new(&scanner_reg_exps)?),
            direct_fallbacks,
            reg_exps,
            rules,
        })
    }

    #[must_use]
    pub fn find_next_match(
        &self,
        string: &OnigString,
        start_position: usize,
        options: ScannerFindOptions,
    ) -> Option<FindNextMatchResult<T>> {
        let scanner_match = self
            .scanner
            .lock()
            .expect("compiled scanner lock poisoned")
            .find_next_match_utf16(string, start_position, options);
        let mut best = scanner_match.map(|matched| ScannerMatch {
            index: matched.index,
            capture_indices: matched.capture_indices,
        });

        // Ferroni 1.3.2 reports a `^$` match at the synthetic end position
        // used by TextMate's line scanner. That position is valid for `$`,
        // but not for a line-start anchor after the line terminator. Keep the
        // TextMate distinction here rather than weakening the shared Scanner
        // semantics for other callers.
        if best.as_ref().is_some_and(|best| {
            has_line_start_anchor(&self.reg_exps[best.index])
                && best.capture_indices[0].start == string.utf16_len()
        }) {
            best = None;
        }

        if options == ScannerFindOptions::NONE {
            // Ferroni 1.3's RegSet path can miss a valid lookaround match or
            // return a later start for some extended-mode TextMate patterns.
            // Verify its candidate with the same engine's direct search path
            // until the Scanner oracle covers those cases itself.
            for (index, regex) in self.direct_fallbacks.iter().enumerate() {
                let Some(fallback) = regex else {
                    continue;
                };
                let Some(mut capture_indices) =
                    find_direct_fallback(&fallback.regex, string, start_position)
                else {
                    continue;
                };
                if fallback.rejects_artificial_end && capture_indices[0].start == string.utf16_len()
                {
                    continue;
                }
                let should_replace = best.as_ref().is_none_or(|best| {
                    let best_start = best.capture_indices[0].start;
                    let candidate_start = capture_indices[0].start;
                    candidate_start < best_start
                        || (candidate_start == best_start && index <= best.index)
                });
                if should_replace {
                    if let Some(existing) = best.as_ref().filter(|best| best.index == index) {
                        let full_match_end = capture_indices[0].end;
                        for (capture, existing_capture) in capture_indices
                            .iter_mut()
                            .zip(&existing.capture_indices)
                            .skip(1)
                        {
                            // Ferroni's CAPTURE_GROUP compatibility mode can
                            // retain a competing pattern's end position for an
                            // unmatched alternative. RegSet keeps that
                            // sentinel correct, while the direct path retains
                            // the participating capture groups.
                            if capture.end > full_match_end {
                                *capture = existing_capture.clone();
                            }
                        }
                    }
                    best = Some(ScannerMatch {
                        index,
                        capture_indices: capture_indices.into(),
                    });
                }
            }
        }

        let ScannerMatch {
            index,
            capture_indices,
        } = best?;
        Some(FindNextMatchResult {
            rule_id: self.rules[index],
            capture_indices: capture_indices.into_vec(),
        })
    }
}

fn normalize_ferroni_pattern(pattern: &str) -> String {
    let mut result = String::with_capacity(pattern.len());
    let bytes = pattern.as_bytes();
    let mut position = 0;
    let mut in_character_class = false;

    while position < bytes.len() {
        if bytes[position] == b'\\' {
            result.push('\\');
            position += 1;
            if let Some(character) = pattern[position..].chars().next() {
                result.push(character);
                position += character.len_utf8();
            }
            continue;
        }
        match bytes[position] {
            b'[' => in_character_class = true,
            b']' => in_character_class = false,
            b'{' if !in_character_class
                && !starts_valid_interval(&pattern[position..])
                && !starts_special_brace_expression(pattern, position) =>
            {
                result.push('\\');
            }
            _ => {}
        }
        let character = pattern[position..]
            .chars()
            .next()
            .expect("pattern position must be on a character boundary");
        result.push(character);
        position += character.len_utf8();
    }
    result
}

fn has_line_start_anchor(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    let mut position = 0;
    let mut in_character_class = false;
    while position < bytes.len() {
        if bytes[position] == b'\\' {
            position += 1;
            if position < bytes.len() {
                position += 1;
            }
            continue;
        }
        match bytes[position] {
            b'[' => in_character_class = true,
            b']' => in_character_class = false,
            b'^' if !in_character_class => return true,
            _ => {}
        }
        position += 1;
    }
    false
}

fn starts_valid_interval(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut position = 1;
    let first_digits = take_ascii_digits(bytes, &mut position);
    if bytes.get(position) == Some(&b'}') {
        return first_digits;
    }
    if bytes.get(position) != Some(&b',') {
        return false;
    }
    position += 1;
    let second_digits = take_ascii_digits(bytes, &mut position);
    bytes.get(position) == Some(&b'}') && (first_digits || second_digits)
}

fn take_ascii_digits(bytes: &[u8], position: &mut usize) -> bool {
    let start = *position;
    while bytes.get(*position).is_some_and(u8::is_ascii_digit) {
        *position += 1;
    }
    *position != start
}

fn starts_special_brace_expression(pattern: &str, position: usize) -> bool {
    pattern.get(..position).is_some_and(|prefix| {
        ["\\p", "\\P", "\\x", "\\o", "(?"]
            .iter()
            .any(|marker| prefix.ends_with(marker))
    })
}

fn stabilize_ferroni_captures(pattern: &str) -> String {
    let mut result = String::with_capacity(pattern.len());
    let bytes = pattern.as_bytes();
    let mut position = 0;
    let mut in_character_class = false;

    while position < bytes.len() {
        if bytes[position] == b'\\' {
            result.push('\\');
            position += 1;
            if let Some(character) = pattern[position..].chars().next() {
                result.push(character);
                position += character.len_utf8();
            }
            continue;
        }
        match bytes[position] {
            b'[' => in_character_class = true,
            b']' => in_character_class = false,
            b'(' if !in_character_class => {
                if let Some(opener_end) = named_capture_opener_end(pattern, position) {
                    result.push_str(&pattern[position..opener_end]);
                    result.push_str("(?=)");
                    position = opener_end;
                    continue;
                }
                if bytes.get(position + 1) != Some(&b'?') {
                    result.push_str("((?=)");
                    position += 1;
                    continue;
                }
            }
            _ => {}
        }
        let character = pattern[position..]
            .chars()
            .next()
            .expect("pattern position must be on a character boundary");
        result.push(character);
        position += character.len_utf8();
    }
    result
}

fn named_capture_opener_end(pattern: &str, position: usize) -> Option<usize> {
    let remainder = pattern.get(position..)?;
    if remainder.starts_with("(?<")
        && !remainder.starts_with("(?<=")
        && !remainder.starts_with("(?<!")
    {
        return remainder.find('>').map(|end| position + end + 1);
    }
    if let Some(name) = remainder.strip_prefix("(?'") {
        return name.find('\'').map(|end| position + 3 + end + 1);
    }
    if remainder.starts_with("(?P<") {
        return remainder.find('>').map(|end| position + end + 1);
    }
    None
}

fn find_direct_fallback(
    regex: &Regex,
    string: &OnigString,
    start_position: usize,
) -> Option<Vec<CaptureIndex>> {
    let text = string.content().as_bytes();
    let start = utf16_to_utf8_offset(string.content(), start_position);
    let (result, region) = onig_search(
        regex.as_raw(),
        text,
        text.len(),
        start,
        text.len(),
        Some(OnigRegion::new()),
        ONIG_OPTION_NONE,
    );
    if result < 0 {
        return None;
    }
    let region = region?;
    Some(
        region
            .beg
            .iter()
            .zip(&region.end)
            .map(|(&start, &end)| {
                if start < 0 || end < 0 {
                    return CaptureIndex {
                        start: 0,
                        end: 0,
                        length: 0,
                    };
                }
                let start = utf8_to_utf16_offset(string.content(), start as usize);
                let end = utf8_to_utf16_offset(string.content(), end as usize);
                CaptureIndex {
                    start,
                    end,
                    length: end.saturating_sub(start),
                }
            })
            .collect(),
    )
}

fn utf16_to_utf8_offset(value: &str, target: usize) -> usize {
    let mut utf16_position = 0;
    for (byte_position, character) in value.char_indices() {
        if utf16_position >= target {
            return byte_position;
        }
        utf16_position += character.len_utf16();
        if utf16_position > target {
            return byte_position + character.len_utf8();
        }
    }
    value.len()
}

fn utf8_to_utf16_offset(value: &str, target: usize) -> usize {
    value[..target.min(value.len())]
        .chars()
        .map(char::len_utf16)
        .sum()
}

impl<T: fmt::Debug> fmt::Display for CompiledRule<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, (rule, source)) in self.rules.iter().zip(&self.reg_exps).enumerate() {
            if index != 0 {
                formatter.write_str("\n")?;
            }
            write!(formatter, "   - {rule:?}: {source}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FindNextMatchResult<T> {
    pub rule_id: T,
    pub capture_indices: Vec<CaptureIndex>,
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        has_captures, normalize_ferroni_pattern, replace_captures, stabilize_ferroni_captures,
        CaptureIndex, OnigString, RegExpSource, RegExpSourceList, ScannerFindOptions,
    };

    #[test]
    fn rewrites_end_anchor_and_resolves_a_and_g_anchors() {
        let source = RegExpSource::new(r"\Afoo\Gbar\z", 1_u32);

        assert_eq!(source.source, "\\Afoo\\Gbar$(?!\\n)(?<!\\n)");
        assert!(source.has_anchor);
        assert_eq!(
            source.resolve_anchors(false, false),
            "\\\u{ffff}foo\\\u{ffff}bar$(?!\\n)(?<!\\n)"
        );
        assert_eq!(
            source.resolve_anchors(false, true),
            "\\\u{ffff}foo\\Gbar$(?!\\n)(?<!\\n)"
        );
        assert_eq!(
            source.resolve_anchors(true, false),
            "\\Afoo\\\u{ffff}bar$(?!\\n)(?<!\\n)"
        );
        assert_eq!(
            source.resolve_anchors(true, true),
            "\\Afoo\\Gbar$(?!\\n)(?<!\\n)"
        );

        let unicode_escape = RegExpSource::new("\\é\\A", 2_u32);
        assert_eq!(unicode_escape.resolve_anchors(true, false), "\\é\\A");
    }

    #[test]
    fn resolves_and_escapes_numeric_back_references() {
        let source = RegExpSource::new(r"end-\1-\12", 1_u32);
        let line = "💻 a.b";
        let captures = vec![
            CaptureIndex {
                start: 0,
                end: 6,
                length: 6,
            },
            CaptureIndex {
                start: 3,
                end: 6,
                length: 3,
            },
        ];

        assert!(source.has_back_references);
        assert_eq!(
            source.resolve_back_references(line, &captures),
            r"end-a\.b-"
        );
    }

    #[test]
    fn replaces_name_capture_placeholders() {
        let capture = CaptureIndex {
            start: 0,
            end: 8,
            length: 8,
        };
        assert!(has_captures(Some("entity.${0:/downcase}.$0.${0:/upcase}")));
        assert!(!has_captures(Some("entity.name")));
        assert_eq!(
            replace_captures(
                "entity.${0:/downcase}.$0.${0:/upcase}",
                ".Foo.Bar",
                &[capture]
            ),
            "entity.foo.bar.Foo.Bar.FOO.BAR"
        );
    }

    #[test]
    fn compiles_scanner_patterns_with_utf16_offsets_and_rule_priority() {
        let mut sources = RegExpSourceList::new();
        sources.push(RegExpSource::new("Y", 10_u32));
        sources.push(RegExpSource::new("X", 20_u32));
        let compiled = sources.compile().unwrap();
        let line = OnigString::new("a💻bYX");

        let result = compiled
            .find_next_match(&line, 0, ScannerFindOptions::NONE)
            .unwrap();
        assert_eq!(result.rule_id, 10);
        assert_eq!(result.capture_indices[0].start, 4);
        assert_eq!(result.capture_indices[0].end, 5);
    }

    #[test]
    fn preserves_unmatched_alternative_capture_groups() {
        let line = OnigString::new(r#"<h1 v-if="condition">"#);
        let pattern = r"(?:(v-for)|(v-(?:if|else-if|else)))(?=[)/=>\s])";

        let mut sources = RegExpSourceList::new();
        sources.push(RegExpSource::new(r"(?=/>)|(>)", 0_u32));
        sources.push(RegExpSource::new(pattern, 1_u32));
        sources.push(RegExpSource::new(r"[^>\s]+", 2_u32));
        let compiled = sources.compile().unwrap();

        let result = compiled
            .find_next_match(&line, 3, ScannerFindOptions::NONE)
            .unwrap();

        assert_eq!(result.rule_id, 1);
        assert_eq!(
            result.capture_indices,
            [
                CaptureIndex {
                    start: 4,
                    end: 8,
                    length: 4,
                },
                CaptureIndex {
                    start: 0,
                    end: 0,
                    length: 0,
                },
                CaptureIndex {
                    start: 4,
                    end: 8,
                    length: 4,
                },
            ]
        );
    }

    #[test]
    fn scanner_finds_later_anchored_patterns_after_earlier_misses() {
        let line = OnigString::new(" ok, cool\n");
        for pattern in [
            r"^ ",
            r"^[ \t]*",
            r"^[ \t]*(?=\S)",
            r"^([ \t]*)",
            r"^([ \t]*)(?=\S)",
        ] {
            let mut single_source = RegExpSourceList::new();
            single_source.push(RegExpSource::new(pattern, 2_u32));
            let single_scanner = single_source.compile().unwrap();
            assert!(
                single_scanner
                    .find_next_match(&line, 0, ScannerFindOptions::NONE)
                    .is_some(),
                "pattern {pattern:?} should match"
            );
        }

        let mut sources = RegExpSourceList::new();
        sources.push(RegExpSource::new(r"^\s*(•).*$\n?", 1_u32));
        sources.push(RegExpSource::new(r"^([ \t]*)(?=\S)", 2_u32));
        let scanner = sources.compile().unwrap();

        let result = scanner
            .find_next_match(&line, 0, ScannerFindOptions::NONE)
            .unwrap();

        assert_eq!(result.rule_id, 2);
        assert_eq!(result.capture_indices[0].start, 0);
        assert_eq!(result.capture_indices[0].end, 1);
    }

    #[test]
    fn preserves_captures_when_direct_search_beats_regset() {
        let pattern = r"(?x)
            ( (https?|s?ftp|ftps|file|smb|afp|nfs|(x-)?man(-page)?|gopher|txmt|issue)://|mailto:)
            [-:@a-zA-Z0-9_.,~%+/?=&#;]+(?<![-.,?:#;])
        ";
        let direct = ferroni::api::Regex::new(&stabilize_ferroni_captures(pattern)).unwrap();
        let captures = direct.captures("https://github.com\n").unwrap();
        assert_eq!(captures.get(2).unwrap().as_str(), "https");
        let mut sources = RegExpSourceList::new();
        sources.push(RegExpSource::new(pattern, 1_u32));
        let scanner = sources.compile().unwrap();

        let result = scanner
            .find_next_match(
                &OnigString::new("https://github.com\n"),
                0,
                ScannerFindOptions::NONE,
            )
            .unwrap();

        assert_eq!(result.capture_indices[2].start, 0);
        assert_eq!(result.capture_indices[2].end, 5);
    }

    #[test]
    fn preserves_captures_after_named_recursive_groups() {
        let pattern = r"(?x)
            (?<ft>
                map\s*<\s*\g<ft>\s*,\s*\g<ft>\s*> |
                set\s*<\s*\g<ft>\s*> |
                list\s*<\s*\g<ft>\s*>\s*(cpp_type(?!\S))? |
                [a-zA-Z_][\w.]*
            )[ \t]*
            (?:([a-zA-Z_][\w.]*)[ \t]*)?
        ";
        let stabilized = stabilize_ferroni_captures(pattern);
        let direct = ferroni::api::Regex::builder(&stabilized)
            .option(ferroni::oniguruma::ONIG_OPTION_CAPTURE_GROUP)
            .build()
            .unwrap();
        let captures = direct.captures("string message\n").unwrap();

        assert_eq!(captures.get(1).unwrap().as_str(), "string");
        assert_eq!(captures.get(3).unwrap().as_str(), "message");
    }

    #[test]
    fn supports_numbered_backrefs_alongside_named_groups() {
        let pattern = r"(?<word>a)(b)\2";
        assert!(ferroni::api::Regex::new(pattern).is_err());
        let mut sources = RegExpSourceList::new();
        sources.push(RegExpSource::new(pattern, 1_u32));
        let scanner = sources.compile().unwrap();

        let result = scanner
            .find_next_match(&OnigString::new("abb\n"), 0, ScannerFindOptions::NONE)
            .unwrap();

        assert_eq!(result.capture_indices[0].start, 0);
        assert_eq!(result.capture_indices[0].end, 3);
        assert_eq!(result.capture_indices[2].start, 1);
        assert_eq!(result.capture_indices[2].end, 2);
    }

    #[test]
    fn distinguishes_end_anchor_from_empty_line_anchor_at_artificial_eol() {
        let line = OnigString::new("\n");
        let mut end_sources = RegExpSourceList::new();
        end_sources.push(RegExpSource::new("$", 1_u32));
        assert!(end_sources
            .compile()
            .unwrap()
            .find_next_match(&line, 1, ScannerFindOptions::NONE)
            .is_some());

        let mut empty_line_sources = RegExpSourceList::new();
        empty_line_sources.push(RegExpSource::new("^$", 1_u32));
        assert!(empty_line_sources
            .compile()
            .unwrap()
            .find_next_match(&line, 1, ScannerFindOptions::NONE)
            .is_none());
    }

    #[test]
    fn escapes_invalid_interval_braces_for_ferroni() {
        assert_eq!(
            normalize_ferroni_pattern(r"(:)\s*(?!(\s*{))"),
            r"(:)\s*(?!(\s*\{))"
        );
        for pattern in [
            r"a{1}",
            r"a{1,}",
            r"a{1,3}",
            r"a{,3}",
            r"\p{Greek}",
            r"\x{20}",
            r"[{}]",
            r"(?{callout})",
        ] {
            assert_eq!(normalize_ferroni_pattern(pattern), pattern);
        }
    }

    #[test]
    fn invalidates_compiled_scanner_when_a_source_changes() {
        let mut sources = RegExpSourceList::new();
        sources.push(RegExpSource::new("a", 1_u32));
        let first = sources.compile().unwrap();
        assert!(Arc::ptr_eq(&first, &sources.compile().unwrap()));

        sources.set_source(0, "b");
        let second = sources.compile().unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        let line = OnigString::new("b");
        assert_eq!(
            second
                .find_next_match(&line, 0, ScannerFindOptions::NONE)
                .unwrap()
                .rule_id,
            1
        );
    }

    #[test]
    fn forwards_find_options_and_supports_anchor_rewriting_fallback() {
        let line = OnigString::new("foo");
        let mut sources = RegExpSourceList::new();
        sources.push(RegExpSource::new(r"\Afoo", 1_u32));

        let compiled = sources.compile().unwrap();
        assert!(compiled
            .find_next_match(&line, 0, ScannerFindOptions::NONE)
            .is_some());
        assert!(compiled
            .find_next_match(&line, 0, ScannerFindOptions::NOT_BEGIN_STRING)
            .is_none());

        assert!(sources
            .compile_ag(false, false)
            .unwrap()
            .find_next_match(&line, 0, ScannerFindOptions::NONE)
            .is_none());
        assert!(sources
            .compile_ag(true, false)
            .unwrap()
            .find_next_match(&line, 0, ScannerFindOptions::NONE)
            .is_some());
    }
}
