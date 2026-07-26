use crate::injection::*;
use crate::render::*;
use crate::scanner::*;
use crate::theme::*;
use crate::types::*;
use ferroni::scanner::{OnigString, Scanner, ScannerFindOptions};
use napi::bindgen_prelude::*;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

// ─────────────────────────────────────────────────────────────────────────────
// Tokenization helpers (mostly unchanged)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn push_styled_slice(
    out: &mut Vec<StyledJsonToken>,
    utf16_map: &[usize],
    code: &str,
    start_utf16: usize,
    end_utf16: usize,
    color: &Arc<str>,
    font_style: u8,
) -> Result<()> {
    if end_utf16 <= start_utf16 || end_utf16 >= utf16_map.len() {
        return Ok(());
    }

    let start_byte = utf16_map[start_utf16];
    let end_byte = utf16_map[end_utf16];
    let content = code.get(start_byte..end_byte).ok_or_else(|| {
        Error::from_reason("Ferriki grammar tokenizer failed to slice source text.")
    })?;

    if content.is_empty() {
        return Ok(());
    }

    let utf16_len = end_utf16 - start_utf16;
    out.push(StyledJsonToken {
        content: content.to_owned(),
        content_utf16_len: utf16_len,
        offset_utf16: start_utf16,
        color: color.clone(),
        font_style,
        dark_color: None,
    });
    Ok(())
}

pub(crate) struct CaptureRange {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) color: Arc<str>,
    pub(crate) font_style: u8,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn push_with_capture_ranges(
    out: &mut Vec<StyledJsonToken>,
    utf16_map: &[usize],
    code: &str,
    match_start_utf16: usize,
    match_end_utf16: usize,
    base_color: &Arc<str>,
    base_font_style: u8,
    mut capture_ranges: Vec<CaptureRange>,
) -> Result<()> {
    if capture_ranges.is_empty() {
        return push_styled_slice(
            out,
            utf16_map,
            code,
            match_start_utf16,
            match_end_utf16,
            base_color,
            base_font_style,
        );
    }

    capture_ranges.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));

    let mut cursor = match_start_utf16;
    for cr in &capture_ranges {
        if cr.start > cursor {
            push_styled_slice(
                out,
                utf16_map,
                code,
                cursor,
                cr.start,
                base_color,
                base_font_style,
            )?;
        }
        let segment_start = cr.start.max(cursor);
        if cr.end > segment_start {
            push_styled_slice(
                out,
                utf16_map,
                code,
                segment_start,
                cr.end,
                &cr.color,
                cr.font_style,
            )?;
            cursor = cr.end;
        }
    }

    if match_end_utf16 > cursor {
        push_styled_slice(
            out,
            utf16_map,
            code,
            cursor,
            match_end_utf16,
            base_color,
            base_font_style,
        )?;
    }

    Ok(())
}

pub(crate) fn escape_regex_literal(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

pub(crate) fn resolve_pattern_backrefs(
    pattern: &str,
    capture_indices: &[ferroni::scanner::CaptureIndex],
    utf16_map: &[usize],
    code: &str,
) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut chars = pattern.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }

        let mut digits = String::new();
        while let Some(next) = chars.peek() {
            if next.is_ascii_digit() {
                digits.push(*next);
                chars.next();
            } else {
                break;
            }
        }

        if digits.is_empty() {
            out.push('\\');
            continue;
        }

        let Ok(index) = digits.parse::<usize>() else {
            continue;
        };
        let Some(range) = capture_indices.get(index) else {
            continue;
        };
        if range.end <= range.start {
            continue;
        }
        if range.start >= utf16_map.len() || range.end >= utf16_map.len() {
            continue;
        }

        let start_byte = utf16_map[range.start];
        let end_byte = utf16_map[range.end];
        let Some(captured) = code.get(start_byte..end_byte) else {
            continue;
        };

        out.push_str(&escape_regex_literal(captured));
    }

    out
}

pub(crate) fn resolve_capture_name_backrefs(
    pattern: &str,
    capture_indices: &[ferroni::scanner::CaptureIndex],
    utf16_map: &[usize],
    code: &str,
) -> String {
    let mut out = String::with_capacity(pattern.len());
    let chars = pattern.as_bytes();
    let mut index = 0usize;

    while index < chars.len() {
        if chars[index] != b'$' {
            out.push(chars[index] as char);
            index += 1;
            continue;
        }

        if index + 1 >= chars.len() {
            out.push('$');
            index += 1;
            continue;
        }

        if chars[index + 1] == b'{' {
            let mut cursor = index + 2;
            let mut digits = String::new();
            while cursor < chars.len() && chars[cursor].is_ascii_digit() {
                digits.push(chars[cursor] as char);
                cursor += 1;
            }

            let mut transform = None;
            if cursor + 2 < chars.len() && chars[cursor] == b':' && chars[cursor + 1] == b'/' {
                cursor += 2;
                let start = cursor;
                while cursor < chars.len() && chars[cursor] != b'}' {
                    cursor += 1;
                }
                if cursor <= chars.len() {
                    transform = std::str::from_utf8(&chars[start..cursor]).ok();
                }
            }

            if cursor < chars.len() && chars[cursor] == b'}' {
                if let Some(captured) =
                    resolve_capture_reference(&digits, capture_indices, utf16_map, code)
                {
                    match transform {
                        Some("downcase") => out.push_str(&captured.to_lowercase()),
                        Some("upcase") => out.push_str(&captured.to_uppercase()),
                        _ => out.push_str(&captured),
                    }
                    index = cursor + 1;
                    continue;
                }
            }
        }

        let mut cursor = index + 1;
        let mut digits = String::new();
        while cursor < chars.len() && chars[cursor].is_ascii_digit() {
            digits.push(chars[cursor] as char);
            cursor += 1;
        }
        if let Some(captured) = resolve_capture_reference(&digits, capture_indices, utf16_map, code)
        {
            out.push_str(&captured);
            index = cursor;
            continue;
        }

        out.push('$');
        index += 1;
    }

    out
}

pub(crate) fn resolve_capture_reference(
    digits: &str,
    capture_indices: &[ferroni::scanner::CaptureIndex],
    utf16_map: &[usize],
    code: &str,
) -> Option<String> {
    let index = digits.parse::<usize>().ok()?;
    let range = capture_indices.get(index)?;
    if range.end <= range.start || range.start >= utf16_map.len() || range.end >= utf16_map.len() {
        return None;
    }
    let start_byte = utf16_map[range.start];
    let end_byte = utf16_map[range.end];
    code.get(start_byte..end_byte).map(str::to_owned)
}

pub(crate) fn build_scope_stack_from_frames(
    stack: &[StateFrame],
    root_scope: Option<&str>,
) -> Vec<String> {
    let mut scopes = Vec::new();
    if let Some(root) = root_scope {
        scopes.push(root.to_owned());
    }
    for frame in stack {
        for s in &frame.name_scopes {
            scopes.push(s.clone());
        }
        for s in &frame.content_scopes {
            scopes.push(s.clone());
        }
    }
    scopes
}

pub(crate) fn resolve_color_for_scope_stack_owned(
    scope_stack: &[String],
    theme: &ThemeData,
    cache: &mut ThemeCache,
) -> (Arc<str>, u8) {
    let style = cache.resolve_owned(scope_stack, theme);
    let color = style
        .foreground
        .clone()
        .unwrap_or_else(|| theme.fg_normalized.clone());
    (color, style.font_style)
}

pub(crate) fn resolve_color_with_extra_scope(
    scope_stack: &[String],
    extra: &str,
    theme: &ThemeData,
    cache: &mut ThemeCache,
) -> (Arc<str>, u8) {
    let style = cache.resolve_with_extra_owned(scope_stack, extra, theme);
    let color = style
        .foreground
        .clone()
        .unwrap_or_else(|| theme.fg_normalized.clone());
    (color, style.font_style)
}

// ─────────────────────────────────────────────────────────────────────────────
// Main tokenization loop (port of vscode-textmate _tokenizeString)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn tokenize_with_grammar_skeleton(
    code: &str,
    compiled: &mut CompiledGrammar,
    root_scope: Option<&str>,
    theme: &ThemeData,
    initial_stack: Option<Vec<StateFrame>>,
) -> Result<(Vec<StyledJsonToken>, Vec<StateFrame>)> {
    let root_rule_id = compiled.root_rule_id;

    if !compiled.scanner_cache.contains_key(&(root_rule_id, None)) {
        let default_fg = theme.fg_normalized.clone();
        let default_stack = initial_stack.unwrap_or_else(|| {
            vec![StateFrame {
                rule_id: root_rule_id,
                _enter_pos: -1,
                _anchor_pos: 0,
                end_rule: None,
                name_scopes: Vec::new(),
                content_scopes: Vec::new(),
            }]
        });
        let utf16_len = code.encode_utf16().count();
        return Ok((
            vec![StyledJsonToken {
                content: code.to_owned(),
                content_utf16_len: utf16_len,
                offset_utf16: 0,
                color: default_fg,
                font_style: 0,
                dark_color: None,
            }],
            default_stack,
        ));
    }

    // Build state stack
    let mut stack: Vec<StateFrame> = initial_stack.unwrap_or_else(|| {
        vec![StateFrame {
            rule_id: root_rule_id,
            _enter_pos: -1,
            _anchor_pos: 0,
            end_rule: None,
            name_scopes: Vec::new(),
            content_scopes: Vec::new(),
        }]
    });

    // ── Global UTF-16 map (for output positioning) ──
    let utf16_map = utf16_to_byte_map(code);
    let total_utf16 = utf16_map.len().saturating_sub(1);
    let find_options = ScannerFindOptions::from_bits(0);
    let mut out = Vec::new();

    // Safeguards against infinite loops
    let max_iterations = code.len().saturating_mul(10).max(50_000);
    let mut iterations = 0usize;
    let max_stack_depth: usize = 64;
    let deadline = Instant::now() + Duration::from_secs(30);

    // ── Theme resolution cache ──
    let mut theme_cache = ThemeCache::new();

    // ── Scope-stack & color cache ──
    let mut stack_generation: u64 = 0;
    let mut cached_scope_stack: Vec<String> = build_scope_stack_from_frames(&stack, root_scope);
    let (mut cached_color, mut cached_font_style) =
        resolve_color_for_scope_stack_owned(&cached_scope_stack, theme, &mut theme_cache);
    let mut cached_generation: u64 = 0;

    // ── Per-line tokenization (like vscode-textmate) ──
    // Split code into lines and process each line with a line-local OnigString.
    // This avoids O(n²) scanning of the full code string on every match.
    let lines: Vec<&str> = code.split('\n').collect();
    let mut global_offset_utf16: usize = 0;
    // Cache frame info to avoid repeated extraction when stack hasn't changed
    let mut last_cache_key: Option<(RuleId, Option<String>)> = None;
    let mut cached_frame_is_while: bool = false;
    let mut cached_frame_apply_end_last: bool = false;
    let mut injection_cache_generation: u64 = u64::MAX;
    let mut active_injections: Vec<(RuleId, InjectionPriority)> = Vec::new();
    let mut selector_scope_match_cache: Vec<HashMap<String, bool>> = (0..compiled.injections.len())
        .map(|_| HashMap::new())
        .collect();

    'line_loop: for (line_idx, &line_text) in lines.iter().enumerate() {
        // Build line text with trailing \n (except last line)
        let has_newline = line_idx < lines.len() - 1;
        let line_with_nl: String;
        let line_str: &str = if has_newline {
            let mut buf = String::with_capacity(line_text.len() + 1);
            buf.push_str(line_text);
            buf.push('\n');
            line_with_nl = buf;
            &line_with_nl
        } else {
            line_text
        };
        let line_input = OnigString::new(line_str);
        let line_str_id = NEXT_ONIG_STR_ID.fetch_add(1, Ordering::Relaxed);
        let line_utf16_map = utf16_to_byte_map(line_str);
        let line_utf16_len = line_utf16_map.len().saturating_sub(1);

        if line_utf16_len == 0 {
            global_offset_utf16 += if has_newline { 1 } else { 0 };
            continue;
        }

        let mut cursor: usize = 0; // line-local cursor (UTF-16 units)
        let mut zero_width_count = 0usize;
        let mut last_zero_width_pos = usize::MAX;
        let mut last_zero_width_generation = u64::MAX;

        // While-condition check at start of each line (except first)
        if line_idx > 0 && !stack.is_empty() {
            let top_rule_id = stack.last().map(|f| f.rule_id).unwrap_or(0);
            let top_is_while = matches!(
                compiled.registry.get(top_rule_id),
                Some(Rule::BeginWhile { .. })
            );
            if top_is_while {
                let while_re = {
                    let frame = stack.last().unwrap();
                    if let Some(end_rule) = &frame.end_rule {
                        Some(end_rule.clone())
                    } else if let Some(Rule::BeginWhile { while_re, .. }) =
                        compiled.registry.get(top_rule_id)
                    {
                        Some(while_re.clone())
                    } else {
                        None
                    }
                };

                if let Some(while_re) = while_re {
                    let while_matched = {
                        let scanner = match compiled.while_scanner_cache.entry(while_re.clone()) {
                            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                            std::collections::hash_map::Entry::Vacant(entry) => {
                                let scanner =
                                    Scanner::new(&[while_re.as_str()]).map_err(|err| {
                                        Error::from_reason(format!(
                                            "Failed to compile while pattern: {err}"
                                        ))
                                    })?;
                                entry.insert(scanner)
                            }
                        };
                        scanner.find_next_match_utf16(&line_input, 0, find_options)
                    };

                    if cached_generation != stack_generation {
                        cached_scope_stack = build_scope_stack_from_frames(&stack, root_scope);
                        let (c, fs) = resolve_color_for_scope_stack_owned(
                            &cached_scope_stack,
                            theme,
                            &mut theme_cache,
                        );
                        cached_color = c;
                        cached_font_style = fs;
                        cached_generation = stack_generation;
                    }

                    if let Some(found_while) = while_matched {
                        let first = found_while.capture_indices.first().ok_or_else(|| {
                            Error::from_reason("While scanner returned match without capture 0.")
                        })?;
                        let while_start = first.start;
                        let while_end = first.end;

                        if while_start != 0 {
                            if stack.len() > 1 {
                                stack.pop();
                                stack_generation += 1;
                                // Don't skip line — continue tokenizing it with the new stack
                            }
                        } else {
                            // While matched — handle captures and advance cursor
                            let while_captures: &[GrammarCapture] =
                                if let Some(Rule::BeginWhile { while_captures, .. }) =
                                    compiled.registry.get(top_rule_id)
                                {
                                    while_captures
                                } else {
                                    &[]
                                };

                            let scope_stack = &cached_scope_stack;
                            let mut capture_ranges = Vec::new();
                            for capture in while_captures {
                                let Some(range) = found_while.capture_indices.get(capture.index)
                                else {
                                    continue;
                                };
                                if range.end <= range.start {
                                    continue;
                                }
                                if range.start < while_start || range.end > while_end {
                                    continue;
                                }
                                let (cap_color, cap_fs) =
                                    if let Some(name) = capture.name.as_deref() {
                                        let resolved_name = resolve_capture_name_backrefs(
                                            name,
                                            &found_while.capture_indices,
                                            &line_utf16_map,
                                            line_str,
                                        );
                                        resolve_color_with_extra_scope(
                                            scope_stack,
                                            &resolved_name,
                                            theme,
                                            &mut theme_cache,
                                        )
                                    } else {
                                        (cached_color.clone(), cached_font_style)
                                    };
                                capture_ranges.push(CaptureRange {
                                    start: while_start + global_offset_utf16,
                                    end: range.end + global_offset_utf16,
                                    color: cap_color,
                                    font_style: cap_fs,
                                });
                            }
                            // Adjust capture ranges back to global coordinates for output
                            let global_while_start = while_start + global_offset_utf16;
                            let global_while_end = while_end + global_offset_utf16;
                            let mut cap_ranges_global = Vec::new();
                            for capture in while_captures {
                                let Some(range) = found_while.capture_indices.get(capture.index)
                                else {
                                    continue;
                                };
                                if range.end <= range.start {
                                    continue;
                                }
                                if range.start < while_start || range.end > while_end {
                                    continue;
                                }
                                let (cap_color, cap_fs) =
                                    if let Some(name) = capture.name.as_deref() {
                                        let resolved_name = resolve_capture_name_backrefs(
                                            name,
                                            &found_while.capture_indices,
                                            &line_utf16_map,
                                            line_str,
                                        );
                                        resolve_color_with_extra_scope(
                                            &cached_scope_stack,
                                            &resolved_name,
                                            theme,
                                            &mut theme_cache,
                                        )
                                    } else {
                                        (cached_color.clone(), cached_font_style)
                                    };
                                cap_ranges_global.push(CaptureRange {
                                    start: range.start + global_offset_utf16,
                                    end: range.end + global_offset_utf16,
                                    color: cap_color,
                                    font_style: cap_fs,
                                });
                            }
                            if global_while_end > global_while_start {
                                push_with_capture_ranges(
                                    &mut out,
                                    &utf16_map,
                                    code,
                                    global_while_start,
                                    global_while_end,
                                    &cached_color,
                                    cached_font_style,
                                    cap_ranges_global,
                                )?;
                            }
                            cursor = while_end;
                        }
                    } else if stack.len() > 1 {
                        stack.pop();
                        stack_generation += 1;
                    }
                }
            }
        }

        // ── Inner loop: process matches within this line ──
        while cursor < line_utf16_len {
            iterations += 1;
            if iterations > max_iterations || (iterations & 1023 == 0 && Instant::now() > deadline)
            {
                // Bail out — emit rest of file as single token
                let remaining_global = cursor + global_offset_utf16;
                if remaining_global < total_utf16 {
                    if cached_generation != stack_generation {
                        cached_scope_stack = build_scope_stack_from_frames(&stack, root_scope);
                        let (c, fs) = resolve_color_for_scope_stack_owned(
                            &cached_scope_stack,
                            theme,
                            &mut theme_cache,
                        );
                        cached_color = c;
                        cached_font_style = fs;
                    }
                    push_styled_slice(
                        &mut out,
                        &utf16_map,
                        code,
                        remaining_global,
                        total_utf16,
                        &cached_color,
                        cached_font_style,
                    )?;
                }
                break 'line_loop;
            }

            if stack.is_empty() {
                break 'line_loop;
            }

            // Get or build scanner for current frame (cached across iterations)
            if cached_generation != stack_generation || last_cache_key.is_none() {
                let frame_rule_id_new = stack.last().map(|f| f.rule_id).unwrap_or(0);
                let frame_is_while_new = matches!(
                    compiled.registry.get(frame_rule_id_new),
                    Some(Rule::BeginWhile { .. })
                );
                let frame_end_rule_new = if frame_is_while_new {
                    None
                } else {
                    stack.last().and_then(|f| f.end_rule.clone())
                };
                let frame_apply_end_last_new = if let Some(Rule::BeginEnd {
                    apply_end_pattern_last,
                    ..
                }) = compiled.registry.get(frame_rule_id_new)
                {
                    *apply_end_pattern_last
                } else {
                    false
                };
                last_cache_key = Some((frame_rule_id_new, frame_end_rule_new));
                cached_frame_is_while = frame_is_while_new;
                cached_frame_apply_end_last = frame_apply_end_last_new;
            }
            let cache_key = last_cache_key.as_ref().unwrap();
            let frame_rule_id = cache_key.0;
            let frame_is_while = cached_frame_is_while;
            if !compiled.scanner_cache.contains_key(cache_key) {
                let scanner = build_scanner_for_rule(
                    frame_rule_id,
                    &compiled.registry,
                    cache_key.1.as_deref(),
                    cached_frame_apply_end_last,
                );
                if let Some(scanner) = scanner {
                    compiled.scanner_cache.insert(cache_key.clone(), scanner);
                }
            }

            // Refresh scope stack + color cache if stack changed
            if cached_generation != stack_generation {
                cached_scope_stack = build_scope_stack_from_frames(&stack, root_scope);
                let (c, fs) = resolve_color_for_scope_stack_owned(
                    &cached_scope_stack,
                    theme,
                    &mut theme_cache,
                );
                cached_color = c;
                cached_font_style = fs;
                cached_generation = stack_generation;
            }
            let scope_stack = &cached_scope_stack;
            let inherited_color = &cached_color;
            let inherited_font_style = cached_font_style;

            if !compiled.injections.is_empty() && injection_cache_generation != stack_generation {
                active_injections.clear();
                for (idx, injection) in compiled.injections.iter().enumerate() {
                    let scope_cache = &mut selector_scope_match_cache[idx];
                    let scope_key = scope_stack.join("\u{1f}");
                    let matches_scope = if let Some(cached) = scope_cache.get(&scope_key) {
                        *cached
                    } else {
                        let parsed =
                            selector_matches_compiled(&injection.compiled_selector, scope_stack);
                        scope_cache.insert(scope_key, parsed);
                        parsed
                    };

                    if matches_scope {
                        active_injections.push((injection.rule_id, injection.priority));
                    }
                }
                injection_cache_generation = stack_generation;
            }

            // Scanner uses line-local OnigString and cursor
            let main_match = if let Some(cached_scanner) = compiled.scanner_cache.get_mut(cache_key)
            {
                let m = find_next_match_ordered(
                    cached_scanner,
                    &line_input,
                    line_str_id,
                    cursor,
                    find_options,
                );
                m.map(|m| {
                    let rule_id = cached_scanner.rule_ids.get(m.index).copied().unwrap_or(0);
                    (m, rule_id)
                })
            } else {
                None
            };

            // Injection matches also use line-local input
            let injection_match = if !active_injections.is_empty() {
                find_injection_match(
                    compiled,
                    &active_injections,
                    &line_input,
                    line_str_id,
                    cursor,
                    find_options,
                )
            } else {
                None
            };

            // Pick the best match
            let (found, matched_rule_id) = match (main_match, injection_match) {
                (None, None) => {
                    // No match in this line — emit rest of line
                    if frame_is_while {
                        // For while frames, emit to end of line (while check happens at next line start)
                        let g_cursor = cursor + global_offset_utf16;
                        let g_end = line_utf16_len + global_offset_utf16;
                        push_styled_slice(
                            &mut out,
                            &utf16_map,
                            code,
                            g_cursor,
                            g_end,
                            inherited_color,
                            inherited_font_style,
                        )?;
                    } else {
                        let g_cursor = cursor + global_offset_utf16;
                        let g_end = line_utf16_len + global_offset_utf16;
                        push_styled_slice(
                            &mut out,
                            &utf16_map,
                            code,
                            g_cursor,
                            g_end,
                            inherited_color,
                            inherited_font_style,
                        )?;
                    }
                    break; // next line
                }
                (Some(m), None) => m,
                (None, Some((inj_found, inj_id, _))) => (inj_found, inj_id),
                (Some((main_found, main_id)), Some((inj_found, inj_id, inj_prio))) => {
                    let main_start = main_found
                        .capture_indices
                        .first()
                        .map(|c| c.start)
                        .unwrap_or(usize::MAX);
                    let inj_start = inj_found
                        .capture_indices
                        .first()
                        .map(|c| c.start)
                        .unwrap_or(usize::MAX);
                    if inj_start < main_start
                        || (inj_start == main_start && inj_prio == InjectionPriority::Left)
                    {
                        (inj_found, inj_id)
                    } else {
                        (main_found, main_id)
                    }
                }
            };

            let first = found.capture_indices.first().ok_or_else(|| {
                Error::from_reason("Ferriki grammar scanner returned match without capture 0.")
            })?;
            // Line-local match positions
            let start_local = first.start;
            let end_local = first.end;
            // Global positions for output
            let start_utf16 = start_local + global_offset_utf16;
            let end_utf16 = end_local + global_offset_utf16;

            if start_local > cursor {
                let g_cursor = cursor + global_offset_utf16;
                push_styled_slice(
                    &mut out,
                    &utf16_map,
                    code,
                    g_cursor,
                    start_utf16,
                    inherited_color,
                    inherited_font_style,
                )?;
                cursor = start_local;
                continue;
            }

            // Zero-width handling
            if end_local <= start_local {
                match matched_rule_id {
                    END_RULE_ID => {
                        if stack.len() > 1 {
                            stack.pop();
                            stack_generation += 1;
                        }
                        continue;
                    }
                    _ => {
                        let is_begin = matches!(
                            compiled.registry.get(matched_rule_id),
                            Some(Rule::BeginEnd { .. }) | Some(Rule::BeginWhile { .. })
                        );
                        if !is_begin {
                            cursor = start_local.saturating_add(1);
                            continue;
                        }
                        // Fall through to begin handling below
                    }
                }
            }

            // Dispatch based on matched rule type
            if matched_rule_id == END_RULE_ID {
                let end_captures: &[GrammarCapture] =
                    if let Some(Rule::BeginEnd { end_captures, .. }) =
                        compiled.registry.get(frame_rule_id)
                    {
                        end_captures
                    } else {
                        &[]
                    };

                let mut capture_ranges = Vec::new();
                for capture in end_captures {
                    let Some(range) = found.capture_indices.get(capture.index) else {
                        continue;
                    };
                    if range.end <= range.start {
                        continue;
                    }
                    if range.start < start_local || range.end > end_local {
                        continue;
                    }
                    let (cap_color, cap_fs) = if let Some(name) = capture.name.as_deref() {
                        let resolved_name = resolve_capture_name_backrefs(
                            name,
                            &found.capture_indices,
                            &line_utf16_map,
                            line_str,
                        );
                        resolve_color_with_extra_scope(
                            scope_stack,
                            &resolved_name,
                            theme,
                            &mut theme_cache,
                        )
                    } else {
                        (inherited_color.clone(), inherited_font_style)
                    };
                    capture_ranges.push(CaptureRange {
                        start: range.start + global_offset_utf16,
                        end: range.end + global_offset_utf16,
                        color: cap_color,
                        font_style: cap_fs,
                    });
                }
                if capture_ranges.is_empty() && end_captures.len() == 1 && end_utf16 > start_utf16 {
                    if let Some(name) = end_captures[0].name.as_deref() {
                        let resolved_name = resolve_capture_name_backrefs(
                            name,
                            &found.capture_indices,
                            &line_utf16_map,
                            line_str,
                        );
                        let (cap_color, cap_fs) = resolve_color_with_extra_scope(
                            scope_stack,
                            &resolved_name,
                            theme,
                            &mut theme_cache,
                        );
                        capture_ranges.push(CaptureRange {
                            start: start_utf16,
                            end: end_utf16,
                            color: cap_color,
                            font_style: cap_fs,
                        });
                    }
                }
                push_with_capture_ranges(
                    &mut out,
                    &utf16_map,
                    code,
                    start_utf16,
                    end_utf16,
                    inherited_color,
                    inherited_font_style,
                    capture_ranges,
                )?;
                if stack.len() > 1 {
                    stack.pop();
                    stack_generation += 1;
                }
            } else {
                let matched_rule = compiled.registry.get(matched_rule_id);

                match matched_rule {
                    Some(Rule::Match { name, captures, .. }) => {
                        let (color, font_style) = if let Some(n) = name.as_deref() {
                            resolve_color_with_extra_scope(scope_stack, n, theme, &mut theme_cache)
                        } else {
                            (inherited_color.clone(), inherited_font_style)
                        };
                        let mut capture_ranges = Vec::new();
                        for capture in captures {
                            let Some(range) = found.capture_indices.get(capture.index) else {
                                continue;
                            };
                            if range.end <= range.start {
                                continue;
                            }
                            if range.start < start_local || range.end > end_local {
                                continue;
                            }
                            let (cap_color, cap_fs) = if let Some(n) = capture.name.as_deref() {
                                let resolved_name = resolve_capture_name_backrefs(
                                    n,
                                    &found.capture_indices,
                                    &line_utf16_map,
                                    line_str,
                                );
                                resolve_color_with_extra_scope(
                                    scope_stack,
                                    &resolved_name,
                                    theme,
                                    &mut theme_cache,
                                )
                            } else {
                                (color.clone(), font_style)
                            };
                            capture_ranges.push(CaptureRange {
                                start: range.start + global_offset_utf16,
                                end: range.end + global_offset_utf16,
                                color: cap_color,
                                font_style: cap_fs,
                            });
                        }
                        push_with_capture_ranges(
                            &mut out,
                            &utf16_map,
                            code,
                            start_utf16,
                            end_utf16,
                            &color,
                            font_style,
                            capture_ranges,
                        )?;
                    }

                    Some(Rule::BeginEnd {
                        name,
                        content_name,
                        end_re,
                        end_has_back_references,
                        begin_captures,
                        ..
                    }) => {
                        let resolved_end_re = if *end_has_back_references {
                            resolve_pattern_backrefs(
                                end_re,
                                &found.capture_indices,
                                &line_utf16_map,
                                line_str,
                            )
                        } else {
                            end_re.clone()
                        };

                        let (color, font_style) = if let Some(n) = name.as_deref() {
                            resolve_color_with_extra_scope(scope_stack, n, theme, &mut theme_cache)
                        } else {
                            (inherited_color.clone(), inherited_font_style)
                        };

                        let mut capture_ranges = Vec::new();
                        for capture in begin_captures {
                            let Some(range) = found.capture_indices.get(capture.index) else {
                                continue;
                            };
                            if range.end <= range.start {
                                continue;
                            }
                            if range.start < start_local || range.end > end_local {
                                continue;
                            }
                            let (cap_color, cap_fs) = if let Some(n) = capture.name.as_deref() {
                                let resolved_name = resolve_capture_name_backrefs(
                                    n,
                                    &found.capture_indices,
                                    &line_utf16_map,
                                    line_str,
                                );
                                resolve_color_with_extra_scope(
                                    scope_stack,
                                    &resolved_name,
                                    theme,
                                    &mut theme_cache,
                                )
                            } else {
                                (color.clone(), font_style)
                            };
                            capture_ranges.push(CaptureRange {
                                start: range.start + global_offset_utf16,
                                end: range.end + global_offset_utf16,
                                color: cap_color,
                                font_style: cap_fs,
                            });
                        }

                        if end_utf16 > start_utf16 {
                            push_with_capture_ranges(
                                &mut out,
                                &utf16_map,
                                code,
                                start_utf16,
                                end_utf16,
                                &color,
                                font_style,
                                capture_ranges,
                            )?;
                        }

                        let name_scopes = name.as_deref().map(parse_scope_list).unwrap_or_default();
                        let content_scopes = content_name
                            .as_deref()
                            .map(parse_scope_list)
                            .unwrap_or_default();

                        stack.push(StateFrame {
                            rule_id: matched_rule_id,
                            _enter_pos: start_utf16 as i32,
                            _anchor_pos: end_utf16 as i32,
                            end_rule: Some(resolved_end_re),
                            name_scopes,
                            content_scopes,
                        });
                        stack_generation += 1;
                    }

                    Some(Rule::BeginWhile {
                        name,
                        content_name,
                        while_re,
                        while_has_back_references,
                        begin_captures,
                        ..
                    }) => {
                        let resolved_while_re = if *while_has_back_references {
                            resolve_pattern_backrefs(
                                while_re,
                                &found.capture_indices,
                                &line_utf16_map,
                                line_str,
                            )
                        } else {
                            while_re.clone()
                        };

                        let (color, font_style) = if let Some(n) = name.as_deref() {
                            resolve_color_with_extra_scope(scope_stack, n, theme, &mut theme_cache)
                        } else {
                            (inherited_color.clone(), inherited_font_style)
                        };

                        let mut capture_ranges = Vec::new();
                        for capture in begin_captures {
                            let Some(range) = found.capture_indices.get(capture.index) else {
                                continue;
                            };
                            if range.end <= range.start {
                                continue;
                            }
                            if range.start < start_local || range.end > end_local {
                                continue;
                            }
                            let (cap_color, cap_fs) = if let Some(n) = capture.name.as_deref() {
                                let resolved_name = resolve_capture_name_backrefs(
                                    n,
                                    &found.capture_indices,
                                    &line_utf16_map,
                                    line_str,
                                );
                                resolve_color_with_extra_scope(
                                    scope_stack,
                                    &resolved_name,
                                    theme,
                                    &mut theme_cache,
                                )
                            } else {
                                (color.clone(), font_style)
                            };
                            capture_ranges.push(CaptureRange {
                                start: range.start + global_offset_utf16,
                                end: range.end + global_offset_utf16,
                                color: cap_color,
                                font_style: cap_fs,
                            });
                        }

                        if end_utf16 > start_utf16 {
                            push_with_capture_ranges(
                                &mut out,
                                &utf16_map,
                                code,
                                start_utf16,
                                end_utf16,
                                &color,
                                font_style,
                                capture_ranges,
                            )?;
                        }

                        let name_scopes = name.as_deref().map(parse_scope_list).unwrap_or_default();
                        let content_scopes = content_name
                            .as_deref()
                            .map(parse_scope_list)
                            .unwrap_or_default();

                        stack.push(StateFrame {
                            rule_id: matched_rule_id,
                            _enter_pos: start_utf16 as i32,
                            _anchor_pos: end_utf16 as i32,
                            end_rule: Some(resolved_while_re),
                            name_scopes,
                            content_scopes,
                        });
                        stack_generation += 1;
                    }

                    Some(Rule::IncludeOnly { .. }) | None => {
                        cursor = end_local.max(cursor.saturating_add(1));
                        continue;
                    }
                }
            }

            // Zero-width loop detection
            if end_local == cursor {
                if cursor == last_zero_width_pos && stack_generation == last_zero_width_generation {
                    zero_width_count += 1;
                    if zero_width_count > 3 {
                        cursor = cursor.saturating_add(1);
                        zero_width_count = 0;
                        continue;
                    }
                } else {
                    last_zero_width_pos = cursor;
                    last_zero_width_generation = stack_generation;
                    zero_width_count = 1;
                }
            } else {
                zero_width_count = 0;
            }

            // Stack depth limit
            if stack.len() > max_stack_depth {
                if cached_generation != stack_generation {
                    cached_scope_stack = build_scope_stack_from_frames(&stack, root_scope);
                    let (c, fs) = resolve_color_for_scope_stack_owned(
                        &cached_scope_stack,
                        theme,
                        &mut theme_cache,
                    );
                    cached_color = c;
                    cached_font_style = fs;
                }
                push_styled_slice(
                    &mut out,
                    &utf16_map,
                    code,
                    end_utf16,
                    total_utf16,
                    &cached_color,
                    cached_font_style,
                )?;
                break 'line_loop;
            }

            cursor = end_local;
        }

        // Advance global offset past this line.
        // line_utf16_len already includes the \n when has_newline is true,
        // because line_str includes it.
        global_offset_utf16 += line_utf16_len;
    }

    // Merge adjacent tokens with the same color and font_style
    let mut merged = Vec::with_capacity(out.len());
    for token in out {
        if let Some(last) = merged.last_mut() {
            let last: &mut StyledJsonToken = last;
            let last_end_utf16 = last.offset_utf16 + last.content_utf16_len;
            if last.color == token.color
                && last.font_style == token.font_style
                && last_end_utf16 == token.offset_utf16
            {
                last.content.push_str(&token.content);
                last.content_utf16_len += token.content_utf16_len;
                continue;
            }
        }
        merged.push(token);
    }

    Ok((merged, stack))
}

/// Try to find the best injection match at the current position.
/// Returns (match, matched_rule_id, priority) — extracting the single matched rule_id
/// instead of cloning the entire rule_ids Vec.
pub(crate) fn find_injection_match(
    compiled: &mut CompiledGrammar,
    active_injections: &[(RuleId, InjectionPriority)],
    input: &OnigString,
    line_str_id: u64,
    cursor: usize,
    find_options: ScannerFindOptions,
) -> Option<(ferroni::scanner::ScannerMatch, RuleId, InjectionPriority)> {
    let mut best_result: Option<(
        ferroni::scanner::ScannerMatch,
        RuleId,
        usize,
        InjectionPriority,
    )> = None;

    for (rule_id, priority) in active_injections {
        // Build and cache injection scanner
        if !compiled.injection_scanner_cache.contains_key(rule_id) {
            let mut pattern_pairs: Vec<(String, RuleId)> = Vec::new();
            collect_patterns(*rule_id, &compiled.registry, &mut pattern_pairs);
            if pattern_pairs.is_empty() {
                continue;
            }

            let regexes: Vec<String> = pattern_pairs.iter().map(|(re, _)| re.clone()).collect();
            let ids: Vec<RuleId> = pattern_pairs.iter().map(|(_, id)| *id).collect();
            let regex_refs: Vec<&str> = regexes.iter().map(String::as_str).collect();
            let Ok(scanner) = Scanner::new(&regex_refs) else {
                continue;
            };
            let single_scanners = std::iter::repeat_with(|| None)
                .take(regexes.len())
                .collect();
            compiled.injection_scanner_cache.insert(
                *rule_id,
                CompiledScanner {
                    scanner,
                    rule_ids: ids,
                    regexes,
                    single_scanners,
                },
            );
        }

        let Some(cached) = compiled.injection_scanner_cache.get_mut(rule_id) else {
            continue;
        };
        let Some(found) = find_next_match_ordered(cached, input, line_str_id, cursor, find_options)
        else {
            continue;
        };

        let start = found
            .capture_indices
            .first()
            .map(|c| c.start)
            .unwrap_or(usize::MAX);
        let matched_id = cached.rule_ids.get(found.index).copied().unwrap_or(0);

        let dominated = if let Some((_, _, best_start, best_prio)) = &best_result {
            if start < *best_start {
                false
            } else if start == *best_start {
                *best_prio == InjectionPriority::Left && *priority != InjectionPriority::Left
            } else {
                true
            }
        } else {
            false
        };

        if !dominated {
            best_result = Some((found, matched_id, start, *priority));
            if start == cursor && *priority == InjectionPriority::Left {
                break;
            }
        }
    }

    best_result.map(|(found, matched_id, _, prio)| (found, matched_id, prio))
}
