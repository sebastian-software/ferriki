use crate::grammar::*;
use crate::theme::*;
use crate::tokenize::*;
use crate::types::*;
use ferroni::scanner::{OnigString, Scanner, ScannerFindOptions};
use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

// ─────────────────────────────────────────────────────────────────────────────
// UTF-16 mapping and utility functions (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn utf16_to_byte_map(input: &str) -> Vec<usize> {
    let mut map = Vec::with_capacity(input.encode_utf16().count() + 1);
    for (byte_idx, ch) in input.char_indices() {
        map.push(byte_idx);
        if ch.len_utf16() == 2 {
            map.push(byte_idx);
        }
    }
    map.push(input.len());
    map
}

pub(crate) fn supports_plaintext(lang: &str) -> bool {
    matches!(lang, "text" | "txt" | "plain" | "plaintext")
}

pub(crate) fn supports_json(lang: &str) -> bool {
    lang == "json"
}

pub(crate) fn lang_mode_from_scope(scope_name: &str) -> Option<LangMode> {
    if scope_name == "source.json" || scope_name.ends_with(".json") {
        return Some(LangMode::Json);
    }
    if scope_name == "text.plain" {
        return Some(LangMode::Plaintext);
    }
    None
}

pub(crate) fn resolve_lang_mode_from_lang(lang: &str) -> Option<LangMode> {
    if supports_plaintext(lang) {
        return Some(LangMode::Plaintext);
    }
    if supports_json(lang) {
        return Some(LangMode::Json);
    }
    None
}

pub(crate) fn resolve_lang_from_options(options_json: &str) -> Result<String> {
    let Some(lang) = parse_lang(options_json) else {
        return Err(Error::from_reason(
            "Ferriki vertical slice requires options.lang.",
        ));
    };
    Ok(lang)
}

pub(crate) fn escape_html(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&#x26;"),
            '<' => escaped.push_str("&#x3C;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

pub(crate) fn render_plain_html(
    code: &str,
    options_json: &str,
    themes: &HashMap<String, ThemeData>,
) -> String {
    let theme = resolve_html_theme_profile(options_json, "ferriki-plain", themes);
    render_unstyled_html(code, &theme)
}

pub(crate) fn render_plain_tokens_json(
    code: &str,
    options_json: &str,
    themes: &HashMap<String, ThemeData>,
) -> Result<String> {
    let theme = resolve_theme_profile(options_json, "ferriki-plain", themes);
    let utf16_len = code.encode_utf16().count();
    let styled = vec![StyledJsonToken {
        content: code.to_owned(),
        content_utf16_len: utf16_len,
        offset_utf16: 0,
        color: Arc::<str>::from(COLOR_DEFAULT_FG),
        font_style: 0,
        dark_color: None,
    }];
    let styled_lines = styled_json_lines(&styled);
    let line_start_offsets = line_start_offsets_utf16(code);

    let mut out = String::with_capacity(styled_lines.len() * 64);
    out.push_str("{\"tokens\":[");
    for (line_index, line) in styled_lines.into_iter().enumerate() {
        if line_index > 0 {
            out.push(',');
        }
        let line_offset = line_start_offsets
            .get(line_index)
            .copied()
            .unwrap_or_else(|| line_start_offsets.last().copied().unwrap_or(0));

        if line.is_empty() {
            out.push_str("[{\"content\":\"\",\"offset\":");
            push_usize(&mut out, line_offset);
            out.push_str("}]");
            continue;
        }

        let mut content = String::new();
        let mut offset = line_offset;
        for (index, token) in line.iter().enumerate() {
            if index == 0 {
                offset = token.offset_utf16;
            }
            content.push_str(&token.content);
        }

        out.push_str("[{\"content\":\"");
        push_json_escaped(&mut out, &content);
        out.push_str("\",\"offset\":");
        push_usize(&mut out, offset);
        out.push_str("}]");
    }
    out.push_str("],\"themeName\":\"");
    push_json_escaped(&mut out, &theme.theme_name);
    out.push_str("\",\"fg\":\"");
    out.push_str(&theme.fg.unwrap_or_default());
    out.push_str("\",\"bg\":\"");
    out.push_str(&theme.bg.unwrap_or_default());
    out.push_str("\"}");
    Ok(out)
}

pub(crate) fn render_plain_hast_json(
    code: &str,
    options_json: &str,
    themes: &HashMap<String, ThemeData>,
) -> Result<String> {
    let theme = resolve_html_theme_profile(options_json, "ferriki-plain", themes);
    let utf16_len = code.encode_utf16().count();
    let styled = vec![StyledJsonToken {
        content: code.to_owned(),
        content_utf16_len: utf16_len,
        offset_utf16: 0,
        color: Arc::<str>::from(COLOR_DEFAULT_FG),
        font_style: 0,
        dark_color: None,
    }];
    let lines = styled_json_lines(&styled);
    render_styled_hast_payload_json(&lines, options_json, &theme, None)
}

pub(crate) fn line_start_offsets_utf16(input: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    let mut offset = 0usize;

    for ch in input.chars() {
        offset = offset.saturating_add(ch.len_utf16());
        if ch == '\n' {
            starts.push(offset);
        }
    }

    starts
}

pub(crate) fn push_slice(
    out: &mut Vec<JsonToken>,
    kind: &'static str,
    start_utf16: usize,
    end_utf16: usize,
    utf16_map: &[usize],
    code: &str,
) -> Result<()> {
    if end_utf16 < start_utf16 || end_utf16 >= utf16_map.len() {
        return Err(Error::from_reason(
            "Ferriki JSON tokenizer produced invalid range.",
        ));
    }

    let start_byte = utf16_map[start_utf16];
    let end_byte = utf16_map[end_utf16];
    let content = code
        .get(start_byte..end_byte)
        .ok_or_else(|| Error::from_reason("Ferriki JSON tokenizer failed to slice source text."))?
        .to_owned();

    out.push(JsonToken {
        kind,
        start_utf16,
        end_utf16,
        content,
    });
    Ok(())
}

pub(crate) fn tokenize_json_with_ferroni(code: &str) -> Result<Vec<JsonToken>> {
    let patterns = [
        r#""(?:\\.|[^"\\])*""#,
        r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?",
        r"\b(?:true|false|null)\b",
        r"[{}\[\]:,]",
    ];
    let pattern_refs = patterns.to_vec();
    let mut scanner = Scanner::new(&pattern_refs).map_err(|err| {
        Error::from_reason(format!("Failed to initialize Ferroni JSON scanner: {err}"))
    })?;
    let input = OnigString::new(code);
    let utf16_map = utf16_to_byte_map(code);
    let total_utf16 = utf16_map.len().saturating_sub(1);
    let find_options = ScannerFindOptions::from_bits(0);

    let mut cursor = 0usize;
    let mut out = Vec::new();

    while cursor < total_utf16 {
        let Some(found) = scanner.find_next_match_utf16(&input, cursor, find_options) else {
            push_slice(&mut out, "text", cursor, total_utf16, &utf16_map, code)?;
            break;
        };

        let first = found.capture_indices.first().ok_or_else(|| {
            Error::from_reason("Ferriki JSON scanner returned match without capture 0.")
        })?;
        let start_utf16 = first.start;
        let end_utf16 = first.end;

        if start_utf16 > cursor {
            push_slice(&mut out, "text", cursor, start_utf16, &utf16_map, code)?;
        }

        if end_utf16 <= start_utf16 {
            cursor = start_utf16.saturating_add(1);
            continue;
        }

        let kind = match found.index {
            0 => "string",
            1 => "number",
            2 => "literal",
            3 => "punct",
            _ => "text",
        };

        push_slice(&mut out, kind, start_utf16, end_utf16, &utf16_map, code)?;
        cursor = end_utf16;
    }

    Ok(out)
}

pub(crate) fn merge_adjacent_json_punct_tokens(tokens: Vec<JsonToken>) -> Vec<JsonToken> {
    let mut merged: Vec<JsonToken> = Vec::with_capacity(tokens.len());

    for token in tokens {
        if token.kind == "punct" {
            if let Some(last) = merged.last_mut() {
                if last.kind == "punct" && last.end_utf16 == token.start_utf16 {
                    last.end_utf16 = token.end_utf16;
                    last.content.push_str(&token.content);
                    continue;
                }
            }
        }

        merged.push(token);
    }

    merged
}

pub(crate) fn theme_profile_by_name(
    theme_name: &str,
    themes: &HashMap<String, ThemeData>,
) -> JsonThemeProfile {
    if theme_name == "none" {
        return JsonThemeProfile {
            pre_class: "shiki none".to_owned(),
            pre_style: Some("background-color:;color:".to_owned()),
            theme_name: "none".to_owned(),
            fg: None,
            bg: None,
        };
    }

    if let Some(theme_data) = themes.get(theme_name) {
        let fg = if theme_data.fg.is_empty() {
            None
        } else {
            Some(theme_data.fg.clone())
        };
        let bg = if theme_data.bg.is_empty() {
            None
        } else {
            Some(theme_data.bg.clone())
        };
        let pre_style = match (&fg, &bg) {
            (Some(f), Some(b)) => Some(format!("background-color:{b};color:{f}")),
            _ => None,
        };
        return JsonThemeProfile {
            pre_class: format!("shiki {theme_name}"),
            pre_style,
            theme_name: theme_name.to_owned(),
            fg,
            bg,
        };
    }

    JsonThemeProfile {
        pre_class: format!("shiki {theme_name}"),
        pre_style: None,
        theme_name: theme_name.to_owned(),
        fg: None,
        bg: None,
    }
}

pub(crate) fn resolve_theme_profile(
    options_json: &str,
    fallback_theme: &str,
    themes: &HashMap<String, ThemeData>,
) -> JsonThemeProfile {
    if let Some((light, _dark)) = parse_dual_themes(options_json) {
        return theme_profile_by_name(&light, themes);
    }
    let theme_name = parse_theme(options_json).unwrap_or_else(|| fallback_theme.to_owned());
    theme_profile_by_name(&theme_name, themes)
}

pub(crate) fn resolve_html_theme_profile(
    options_json: &str,
    fallback_theme: &str,
    themes: &HashMap<String, ThemeData>,
) -> HtmlThemeProfile {
    if let Some((light, dark)) = parse_dual_themes(options_json) {
        let light_profile = theme_profile_by_name(&light, themes);
        let dark_profile = theme_profile_by_name(&dark, themes);
        let light_bg = light_profile.bg.clone().unwrap_or_default();
        let light_fg = light_profile.fg.clone().unwrap_or_default();
        let dark_bg = if dark == "none" {
            COLOR_INHERIT.to_owned()
        } else {
            dark_profile.bg.clone().unwrap_or_default()
        };
        let dark_fg = if dark == "none" {
            COLOR_INHERIT.to_owned()
        } else {
            dark_profile.fg.clone().unwrap_or_default()
        };

        return HtmlThemeProfile {
      pre_class: format!("shiki shiki-themes {light} {dark}"),
      pre_style: Some(format!(
        "background-color:{light_bg};--shiki-dark-bg:{dark_bg};color:{light_fg};--shiki-dark:{dark_fg}"
      )),
      theme_name: light_profile.theme_name,
      dark_theme_name: Some(dark_profile.theme_name),
      fg: Some(light_fg),
      bg: Some(light_bg),
      dark_fg: Some(dark_fg),
      dark_bg: Some(dark_bg),
      disable_token_coloring: light == "none",
    };
    }

    let profile = resolve_theme_profile(options_json, fallback_theme, themes);
    let disable_token_coloring = profile.theme_name == "none";
    HtmlThemeProfile {
        pre_class: profile.pre_class,
        pre_style: profile.pre_style,
        theme_name: profile.theme_name,
        dark_theme_name: None,
        fg: profile.fg,
        bg: profile.bg,
        dark_fg: None,
        dark_bg: None,
        disable_token_coloring,
    }
}

pub(crate) fn resolve_json_theme(
    options_json: &str,
    themes: &HashMap<String, ThemeData>,
) -> JsonThemeProfile {
    resolve_theme_profile(options_json, "ferriki-json", themes)
}

pub(crate) fn is_json_key_string(tokens: &[JsonToken], index: usize) -> bool {
    for token in tokens.iter().skip(index.saturating_add(1)) {
        if token.kind == "text" && token.content.chars().all(char::is_whitespace) {
            continue;
        }
        return token.kind == "punct" && token.content == ":";
    }
    false
}

pub(crate) fn push_styled_token(
    out: &mut Vec<StyledJsonToken>,
    content: String,
    offset_utf16: usize,
    color: &Arc<str>,
) {
    if content.is_empty() {
        return;
    }
    let content_utf16_len = content.encode_utf16().count();
    out.push(StyledJsonToken {
        content,
        content_utf16_len,
        offset_utf16,
        color: color.clone(),
        font_style: 0,
        dark_color: None,
    });
}

pub(crate) fn push_styled_string_token(
    out: &mut Vec<StyledJsonToken>,
    token: &JsonToken,
    _is_key: bool,
    quote_color: &Arc<str>,
    body_color: &Arc<str>,
) {
    if quote_color == body_color {
        push_styled_token(out, token.content.clone(), token.start_utf16, body_color);
        return;
    }

    if token.content.len() >= 2 && token.content.starts_with('"') && token.content.ends_with('"') {
        let char_count = token.content.chars().count();
        if char_count >= 2 {
            let body = token
                .content
                .chars()
                .skip(1)
                .take(char_count.saturating_sub(2))
                .collect::<String>();
            push_styled_token(out, "\"".to_owned(), token.start_utf16, quote_color);
            push_styled_token(out, body, token.start_utf16.saturating_add(1), body_color);
            push_styled_token(
                out,
                "\"".to_owned(),
                token.end_utf16.saturating_sub(1),
                quote_color,
            );
            return;
        }
    }

    push_styled_token(out, token.content.clone(), token.start_utf16, body_color);
}

/// Write a JSON-escaped string (handles \n, \r, \t, \\, \", and control chars)
pub(crate) fn push_json_escaped(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < '\x20' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}

/// Write a usize as decimal digits without allocation
pub(crate) fn push_usize(out: &mut String, n: usize) {
    if n == 0 {
        out.push('0');
        return;
    }
    let start = out.len();
    let mut val = n;
    while val > 0 {
        out.push((b'0' + (val % 10) as u8) as char);
        val /= 10;
    }
    // Reverse the digits we just pushed
    unsafe {
        let bytes = out.as_bytes_mut();
        bytes[start..].reverse();
    }
}

pub(crate) fn normalize_hex_color(color: &str) -> String {
    match color.strip_prefix('#') {
        Some(rest) => format!("#{}", rest.to_uppercase()),
        None => color.to_owned(),
    }
}

pub(crate) fn resolve_json_scope_color(scope_names: &[&str], theme: &ThemeData) -> Arc<str> {
    let style = resolve_token_style(scope_names, theme);
    style
        .foreground
        .unwrap_or_else(|| theme.fg_normalized.clone())
}

pub(crate) fn resolve_json_scope_color_with_fallback(
    scope_names: &[&str],
    fallback_color: &Arc<str>,
    theme: &ThemeData,
) -> Arc<str> {
    let mut has_specific_match = false;
    for rule in &theme.settings {
        if rule.scopes.is_empty() {
            continue;
        }
        for parts in &rule.scope_parts {
            if selector_matches_presplit(parts, scope_names).is_some() {
                has_specific_match = true;
                break;
            }
        }
        if has_specific_match {
            break;
        }
    }

    if has_specific_match {
        resolve_json_scope_color(scope_names, theme)
    } else {
        fallback_color.clone()
    }
}

pub(crate) fn style_json_tokens(tokens: &[JsonToken], theme: &ThemeData) -> Vec<StyledJsonToken> {
    let mut styled = Vec::new();
    let root = "source.json";
    let default_fg = theme.fg_normalized.clone();

    // Pre-resolve all JSON scope colors once (avoids repeated theme lookups per token)
    let key_body_color = resolve_json_scope_color(
        &[root, "string.json", "support.type.property-name.json"],
        theme,
    );
    let key_quote_color = resolve_json_scope_color_with_fallback(
        &[
            root,
            "string.json",
            "support.type.property-name.json",
            "punctuation.support.type.property-name.json",
        ],
        &key_body_color,
        theme,
    );
    let key_has_separate_quotes = key_quote_color != key_body_color;

    let str_body_color = resolve_json_scope_color(&[root, "string.quoted.double.json"], theme);
    let str_quote_color = resolve_json_scope_color_with_fallback(
        &[
            root,
            "string.quoted.double.json",
            "punctuation.definition.string.json",
        ],
        &str_body_color,
        theme,
    );
    let str_has_separate_quotes = str_quote_color != str_body_color;

    let number_color = resolve_json_scope_color(&[root, "constant.numeric.json"], theme);
    let literal_color = resolve_json_scope_color(&[root, "constant.language.json"], theme);
    let punct_sep_color = resolve_json_scope_color(&[root, "punctuation.separator.json"], theme);
    let punct_def_color = resolve_json_scope_color(&[root, "punctuation.definition.json"], theme);

    for (index, token) in tokens.iter().enumerate() {
        match token.kind {
            "text" => push_styled_token(
                &mut styled,
                token.content.clone(),
                token.start_utf16,
                &default_fg,
            ),
            "string" => {
                let is_key = is_json_key_string(tokens, index);
                if is_key {
                    if key_has_separate_quotes {
                        push_styled_string_token(
                            &mut styled,
                            token,
                            true,
                            &key_quote_color,
                            &key_body_color,
                        );
                    } else {
                        push_styled_token(
                            &mut styled,
                            token.content.clone(),
                            token.start_utf16,
                            &key_body_color,
                        );
                    }
                } else {
                    if str_has_separate_quotes {
                        push_styled_string_token(
                            &mut styled,
                            token,
                            false,
                            &str_quote_color,
                            &str_body_color,
                        );
                    } else {
                        push_styled_token(
                            &mut styled,
                            token.content.clone(),
                            token.start_utf16,
                            &str_body_color,
                        );
                    }
                }
            }
            "number" => {
                push_styled_token(
                    &mut styled,
                    token.content.clone(),
                    token.start_utf16,
                    &number_color,
                );
            }
            "literal" => {
                push_styled_token(
                    &mut styled,
                    token.content.clone(),
                    token.start_utf16,
                    &literal_color,
                );
            }
            "punct" => {
                let is_sep = token.content == ":" || token.content == ",";
                let color = if is_sep {
                    &punct_sep_color
                } else {
                    &punct_def_color
                };
                push_styled_token(&mut styled, token.content.clone(), token.start_utf16, color);
            }
            _ => push_styled_token(
                &mut styled,
                token.content.clone(),
                token.start_utf16,
                &default_fg,
            ),
        }
    }

    styled
}

pub(crate) fn styled_json_lines(styled: &[StyledJsonToken]) -> Vec<Vec<StyledJsonToken>> {
    let mut lines: Vec<Vec<StyledJsonToken>> = vec![Vec::new()];

    for token in styled {
        let mut piece = String::new();
        let mut offset_utf16 = token.offset_utf16;
        let mut piece_start_utf16 = token.offset_utf16;

        for ch in token.content.chars() {
            if ch == '\r' {
                offset_utf16 = offset_utf16.saturating_add(1);
                continue;
            }

            if ch == '\n' {
                if !piece.is_empty() {
                    lines
                        .last_mut()
                        .expect("line exists")
                        .push(StyledJsonToken {
                            content: piece.clone(),
                            content_utf16_len: offset_utf16 - piece_start_utf16,
                            offset_utf16: piece_start_utf16,
                            color: token.color.clone(),
                            font_style: token.font_style,
                            dark_color: token.dark_color.clone(),
                        });
                }
                piece.clear();
                lines.push(Vec::new());
                offset_utf16 = offset_utf16.saturating_add(1);
                piece_start_utf16 = offset_utf16;
                continue;
            }

            if piece.is_empty() {
                piece_start_utf16 = offset_utf16;
            }

            piece.push(ch);
            offset_utf16 = offset_utf16.saturating_add(ch.len_utf16());
        }

        if !piece.is_empty() {
            lines
                .last_mut()
                .expect("line exists")
                .push(StyledJsonToken {
                    content: piece,
                    content_utf16_len: offset_utf16 - piece_start_utf16,
                    offset_utf16: piece_start_utf16,
                    color: token.color.clone(),
                    font_style: token.font_style,
                    dark_color: token.dark_color.clone(),
                });
        }
    }

    lines
}

pub(crate) fn merge_line_for_html(
    line: &[StyledJsonToken],
    _default_fg: &str,
) -> Vec<StyledJsonToken> {
    line.to_vec()
}

pub(crate) fn merge_leading_whitespace_tokens(line: &[StyledJsonToken]) -> Vec<StyledJsonToken> {
    const FONT_STYLE_UNDERLINE: u8 = 4;
    const FONT_STYLE_STRIKETHROUGH: u8 = 8;

    let mut merged: Vec<StyledJsonToken> = Vec::with_capacity(line.len());
    let mut carry: Option<StyledJsonToken> = None;

    for token in line {
        let content = token.content.as_str();
        let is_decorated =
            token.font_style & (FONT_STYLE_UNDERLINE | FONT_STYLE_STRIKETHROUGH) != 0;
        let is_whitespace_only = !content.is_empty() && content.chars().all(char::is_whitespace);

        if !is_decorated && is_whitespace_only {
            if let Some(existing) = carry.as_mut() {
                existing.content.push_str(content);
                existing.content_utf16_len += token.content_utf16_len;
            } else {
                carry = Some(token.clone());
            }
            continue;
        }

        if let Some(carry_token) = carry.take() {
            if !is_decorated {
                let mut combined = token.clone();
                combined.offset_utf16 = carry_token.offset_utf16;
                combined.content = format!("{}{}", carry_token.content, token.content);
                combined.content_utf16_len =
                    carry_token.content_utf16_len + token.content_utf16_len;
                merged.push(combined);
            } else {
                merged.push(carry_token);
                merged.push(token.clone());
            }
            continue;
        }

        merged.push(token.clone());
    }

    if let Some(carry_token) = carry {
        merged.push(carry_token);
    }

    merged
}

pub(crate) fn split_whitespace_tokens(line: &[StyledJsonToken]) -> Vec<StyledJsonToken> {
    let mut split = Vec::with_capacity(line.len());

    for token in line {
        let content = token.content.as_str();
        if !content.chars().any(char::is_whitespace) || content.chars().all(char::is_whitespace) {
            split.push(token.clone());
            continue;
        }

        let leading_len = content.chars().take_while(|ch| ch.is_whitespace()).count();
        let trailing_len = content
            .chars()
            .rev()
            .take_while(|ch| ch.is_whitespace())
            .count();
        if leading_len == 0 && trailing_len == 0 {
            split.push(token.clone());
            continue;
        }

        let total_len = content.chars().count();
        let content_len = total_len.saturating_sub(leading_len + trailing_len);
        let mut utf16_offset = token.offset_utf16;

        if leading_len > 0 {
            let leading: String = content.chars().take(leading_len).collect();
            split.push(StyledJsonToken {
                content_utf16_len: leading.encode_utf16().count(),
                content: leading,
                offset_utf16: utf16_offset,
                color: Arc::<str>::from(""),
                font_style: 0,
                dark_color: None,
            });
            utf16_offset += split.last().expect("leading token").content_utf16_len;
        }

        if content_len > 0 {
            let middle: String = content
                .chars()
                .skip(leading_len)
                .take(content_len)
                .collect();
            split.push(StyledJsonToken {
                content_utf16_len: middle.encode_utf16().count(),
                content: middle,
                offset_utf16: utf16_offset,
                color: token.color.clone(),
                font_style: token.font_style,
                dark_color: token.dark_color.clone(),
            });
            utf16_offset += split.last().expect("middle token").content_utf16_len;
        }

        if trailing_len > 0 {
            let trailing: String = content.chars().skip(leading_len + content_len).collect();
            split.push(StyledJsonToken {
                content_utf16_len: trailing.encode_utf16().count(),
                content: trailing,
                offset_utf16: utf16_offset,
                color: Arc::<str>::from(""),
                font_style: 0,
                dark_color: None,
            });
        }
    }

    split
}

pub(crate) fn merge_adjacent_styled_tokens(line: &[StyledJsonToken]) -> Vec<StyledJsonToken> {
    let mut merged: Vec<StyledJsonToken> = Vec::with_capacity(line.len());

    for token in line {
        if let Some(previous) = merged.last_mut() {
            let prev_decorated = previous.font_style & 4 != 0 || previous.font_style & 8 != 0;
            let current_decorated = token.font_style & 4 != 0 || token.font_style & 8 != 0;
            if !prev_decorated
                && !current_decorated
                && previous.color == token.color
                && previous.font_style == token.font_style
                && previous.dark_color == token.dark_color
            {
                previous.content.push_str(&token.content);
                previous.content_utf16_len += token.content_utf16_len;
                continue;
            }
        }
        merged.push(token.clone());
    }

    merged
}

pub(crate) fn parse_merge_whitespaces_mode(options: &Value) -> i8 {
    match options.get("mergeWhitespaces") {
        Some(Value::String(value)) if value == "never" => -1,
        Some(Value::Bool(false)) => 0,
        _ => 1,
    }
}

pub(crate) fn parse_merge_same_style_tokens(options: &Value) -> bool {
    matches!(options.get("mergeSameStyleTokens"), Some(Value::Bool(true)))
}

pub(crate) fn apply_render_line_options(
    lines: Vec<Vec<StyledJsonToken>>,
    options: &Value,
) -> Vec<Vec<StyledJsonToken>> {
    let merge_whitespace_mode = parse_merge_whitespaces_mode(options);
    let merge_same_style = parse_merge_same_style_tokens(options);

    lines
        .into_iter()
        .map(|line| {
            let line = match merge_whitespace_mode {
                -1 => split_whitespace_tokens(&line),
                1 => merge_leading_whitespace_tokens(&line),
                _ => line,
            };
            if merge_same_style {
                merge_adjacent_styled_tokens(&line)
            } else {
                line
            }
        })
        .collect()
}

pub(crate) fn collect_color_replacements_from_source(
    target: &mut HashMap<String, String>,
    source: Option<&Value>,
    theme_name: &str,
) {
    let Some(Value::Object(map)) = source else {
        return;
    };

    for (key, value) in map {
        if let Some(replacement) = value.as_str() {
            target.insert(normalize_hex_color(key), replacement.to_owned());
            continue;
        }

        if key != theme_name {
            continue;
        }

        let Some(scoped) = value.as_object() else {
            continue;
        };
        for (scoped_key, scoped_value) in scoped {
            if let Some(replacement) = scoped_value.as_str() {
                target.insert(normalize_hex_color(scoped_key), replacement.to_owned());
            }
        }
    }
}

pub(crate) fn resolve_color_replacements(
    options: &Value,
    theme_name: &str,
) -> HashMap<String, String> {
    let mut replacements = HashMap::new();
    collect_color_replacements_from_source(
        &mut replacements,
        options.get("colorReplacements"),
        theme_name,
    );
    replacements
}

pub(crate) fn apply_color_replacement_value(
    color: &str,
    replacements: &HashMap<String, String>,
) -> String {
    replacements
        .get(&normalize_hex_color(color))
        .cloned()
        .unwrap_or_else(|| color.to_owned())
}

pub(crate) fn apply_color_replacements_to_lines(
    lines: &mut [Vec<StyledJsonToken>],
    replacements: &HashMap<String, String>,
) {
    if replacements.is_empty() {
        return;
    }

    for line in lines {
        for token in line {
            token.color =
                Arc::<str>::from(apply_color_replacement_value(&token.color, replacements));
            if let Some(dark_color) = token.dark_color.as_ref() {
                token.dark_color = Some(Arc::<str>::from(apply_color_replacement_value(
                    dark_color,
                    replacements,
                )));
            }
        }
    }
}

pub(crate) fn apply_color_replacements_to_json_theme_profile(
    theme: &mut JsonThemeProfile,
    replacements: &HashMap<String, String>,
) {
    if replacements.is_empty() {
        return;
    }

    theme.fg = theme
        .fg
        .as_ref()
        .map(|fg| apply_color_replacement_value(fg, replacements));
    theme.bg = theme
        .bg
        .as_ref()
        .map(|bg| apply_color_replacement_value(bg, replacements));
    theme.pre_style = match (&theme.fg, &theme.bg) {
        (Some(fg), Some(bg)) => Some(format!("background-color:{bg};color:{fg}")),
        _ => theme.pre_style.clone(),
    };
}

pub(crate) fn apply_color_replacements_to_html_theme_profile(
    theme: &mut HtmlThemeProfile,
    replacements: &HashMap<String, String>,
) {
    if replacements.is_empty() {
        return;
    }

    theme.fg = theme
        .fg
        .as_ref()
        .map(|fg| apply_color_replacement_value(fg, replacements));
    theme.bg = theme
        .bg
        .as_ref()
        .map(|bg| apply_color_replacement_value(bg, replacements));
    theme.dark_fg = theme
        .dark_fg
        .as_ref()
        .map(|fg| apply_color_replacement_value(fg, replacements));
    theme.dark_bg = theme
        .dark_bg
        .as_ref()
        .map(|bg| apply_color_replacement_value(bg, replacements));

    theme.pre_style = if let (Some(fg), Some(bg)) = (&theme.fg, &theme.bg) {
        if let (Some(dark_fg), Some(dark_bg)) = (&theme.dark_fg, &theme.dark_bg) {
            Some(format!(
                "background-color:{bg};--shiki-dark-bg:{dark_bg};color:{fg};--shiki-dark:{dark_fg}"
            ))
        } else {
            Some(format!("background-color:{bg};color:{fg}"))
        }
    } else {
        theme.pre_style.clone()
    };
}

pub(crate) fn apply_dark_theme_inherit(mut styled: Vec<StyledJsonToken>) -> Vec<StyledJsonToken> {
    for token in &mut styled {
        token.dark_color = Some(Arc::<str>::from(COLOR_INHERIT));
    }
    styled
}

pub(crate) fn apply_dark_theme_palette(
    mut light_styled: Vec<StyledJsonToken>,
    dark_styled: &[StyledJsonToken],
) -> Vec<StyledJsonToken> {
    for (index, light) in light_styled.iter_mut().enumerate() {
        let Some(dark) = dark_styled.get(index) else {
            break;
        };
        if dark.offset_utf16 == light.offset_utf16 && dark.content == light.content {
            light.dark_color = Some(dark.color.clone());
        }
    }
    light_styled
}

pub(crate) fn render_unstyled_html(code: &str, theme: &HtmlThemeProfile) -> String {
    let utf16_len = code.encode_utf16().count();
    let styled = vec![StyledJsonToken {
        content: code.to_owned(),
        content_utf16_len: utf16_len,
        offset_utf16: 0,
        color: Arc::<str>::from(COLOR_DEFAULT_FG),
        font_style: 0,
        dark_color: None,
    }];
    let lines = styled_json_lines(&styled);
    render_styled_html_lines(&lines, theme, true)
}

pub(crate) fn render_styled_html_lines(
    lines: &[Vec<StyledJsonToken>],
    theme: &HtmlThemeProfile,
    unstyled_spans: bool,
) -> String {
    let mut html = String::new();
    html.push_str("<pre class=\"");
    html.push_str(&theme.pre_class);
    html.push('"');
    if let Some(style) = &theme.pre_style {
        html.push_str(" style=\"");
        html.push_str(style);
        html.push('"');
    }
    html.push_str(" tabindex=\"0\"><code>");

    for (line_index, line) in lines.iter().enumerate() {
        html.push_str("<span class=\"line\">");
        if line.is_empty() {
            if unstyled_spans {
                html.push_str("<span></span>");
            }
        } else {
            for token in line {
                if unstyled_spans {
                    html.push_str("<span>");
                } else if let Some(style) = styled_token_style_string(token) {
                    html.push_str("<span style=\"");
                    html.push_str(&style);
                    html.push_str("\">");
                } else {
                    html.push_str("<span>");
                }
                html.push_str(&escape_html(&token.content));
                html.push_str("</span>");
            }
        }
        html.push_str("</span>");
        if line_index + 1 < lines.len() {
            html.push('\n');
        }
    }

    html.push_str("</code></pre>");
    html
}

pub(crate) fn styled_token_style_string(token: &StyledJsonToken) -> Option<String> {
    let mut style = String::new();

    if !token.color.is_empty() {
        style.push_str("color:");
        style.push_str(&token.color);
    }
    if let Some(dark_color) = &token.dark_color {
        if !style.is_empty() {
            style.push(';');
        }
        style.push_str("--shiki-dark:");
        style.push_str(dark_color);
    }
    if token.font_style & 1 != 0 {
        if !style.is_empty() {
            style.push(';');
        }
        style.push_str("font-style:italic");
    }
    if token.font_style & 2 != 0 {
        if !style.is_empty() {
            style.push(';');
        }
        style.push_str("font-weight:bold");
    }
    if token.font_style & 4 != 0 || token.font_style & 8 != 0 {
        if !style.is_empty() {
            style.push(';');
        }
        style.push_str("text-decoration:");
        if token.font_style & 4 != 0 {
            style.push_str("underline");
        }
        if token.font_style & 8 != 0 {
            if token.font_style & 4 != 0 {
                style.push(' ');
            }
            style.push_str("line-through");
        }
    }

    if style.is_empty() {
        None
    } else {
        Some(style)
    }
}

pub(crate) fn hast_text_node(value: &str) -> Value {
    json!({
      "type": "text",
      "value": value,
    })
}

pub(crate) fn hast_element_node(
    tag_name: &str,
    properties: serde_json::Map<String, Value>,
    children: Vec<Value>,
    data: Option<Value>,
) -> Value {
    let mut node = serde_json::Map::new();
    node.insert("type".to_owned(), Value::String("element".to_owned()));
    node.insert("tagName".to_owned(), Value::String(tag_name.to_owned()));
    node.insert("properties".to_owned(), Value::Object(properties));
    node.insert("children".to_owned(), Value::Array(children));
    if let Some(data_value) = data {
        node.insert("data".to_owned(), data_value);
    }
    Value::Object(node)
}

pub(crate) fn parse_hast_structure(options: &Value) -> &'static str {
    match options.get("structure").and_then(Value::as_str) {
        Some("inline") => "inline",
        _ => "classic",
    }
}

pub(crate) fn parse_hast_tabindex(options: &Value) -> Option<String> {
    match options.get("tabindex") {
        Some(Value::Bool(false)) | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => Some("0".to_owned()),
    }
}

pub(crate) fn resolve_hast_root_style(options: &Value, theme: &HtmlThemeProfile) -> Option<String> {
    match options.get("rootStyle") {
        Some(Value::Bool(false)) => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Null) => theme.pre_style.clone(),
        _ => theme.pre_style.clone(),
    }
}

pub(crate) fn render_styled_hast_payload_json(
    lines: &[Vec<StyledJsonToken>],
    options_json: &str,
    theme: &HtmlThemeProfile,
    rust_state: Option<Value>,
) -> Result<String> {
    let options: Value = serde_json::from_str(options_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse codeToHast options JSON: {err}"))
    })?;
    let structure = parse_hast_structure(&options);
    let tabindex = parse_hast_tabindex(&options);
    let root_style = resolve_hast_root_style(&options, theme);

    let mut pre_properties = serde_json::Map::new();
    pre_properties.insert("class".to_owned(), Value::String(theme.pre_class.clone()));
    if let Some(style) = root_style {
        pre_properties.insert("style".to_owned(), Value::String(style));
    }
    if let Some(tabindex) = tabindex {
        pre_properties.insert("tabindex".to_owned(), Value::String(tabindex));
    }
    if let Some(meta) = options.get("meta").and_then(Value::as_object) {
        for (key, value) in meta {
            if !key.starts_with('_') {
                pre_properties.insert(key.clone(), value.clone());
            }
        }
    }

    let mut root_children = Vec::new();
    let mut code_children = Vec::new();

    for (line_index, line) in lines.iter().enumerate() {
        if line_index > 0 {
            if structure == "inline" {
                root_children.push(hast_element_node(
                    "br",
                    serde_json::Map::new(),
                    Vec::new(),
                    None,
                ));
            } else {
                code_children.push(hast_text_node("\n"));
            }
        }

        let mut line_children = Vec::new();
        for token in line {
            let mut token_properties = serde_json::Map::new();
            if let Some(style) = styled_token_style_string(token) {
                token_properties.insert("style".to_owned(), Value::String(style));
            }
            let token_node = hast_element_node(
                "span",
                token_properties,
                vec![hast_text_node(&token.content)],
                None,
            );
            if structure == "inline" {
                root_children.push(token_node);
            } else {
                line_children.push(token_node);
            }
        }

        if structure == "classic" {
            let mut line_properties = serde_json::Map::new();
            line_properties.insert("class".to_owned(), Value::String("line".to_owned()));
            code_children.push(hast_element_node(
                "span",
                line_properties,
                line_children,
                None,
            ));
        }
    }

    if structure == "classic" {
        let code_node = hast_element_node("code", serde_json::Map::new(), code_children, None);
        let pre_node = hast_element_node(
            "pre",
            pre_properties,
            vec![code_node],
            options.get("data").cloned(),
        );
        root_children.push(pre_node);
    }

    let mut root_node = serde_json::Map::new();
    root_node.insert("type".to_owned(), Value::String("root".to_owned()));
    root_node.insert("children".to_owned(), Value::Array(root_children));

    let mut payload = serde_json::Map::new();
    payload.insert("hast".to_owned(), Value::Object(root_node));
    if let Some(rust_state) = rust_state {
        payload.insert("_rustState".to_owned(), rust_state);
    }

    serde_json::to_string(&Value::Object(payload))
        .map_err(|err| Error::from_reason(format!("Failed to serialize codeToHast payload: {err}")))
}

pub(crate) fn render_styled_tokens_json(
    lines: Vec<Vec<StyledJsonToken>>,
    theme: JsonThemeProfile,
) -> Result<String> {
    // Manual JSON construction — avoids serde_json::Value heap allocations
    let mut out = String::with_capacity(lines.len() * 128);
    out.push_str("{\"tokens\":[");
    for (li, line) in lines.iter().enumerate() {
        if li > 0 {
            out.push(',');
        }
        out.push('[');
        for (ti, token) in line.iter().enumerate() {
            if ti > 0 {
                out.push(',');
            }
            out.push_str("{\"content\":\"");
            push_json_escaped(&mut out, &token.content);
            out.push_str("\",\"offset\":");
            push_usize(&mut out, token.offset_utf16);
            out.push_str(",\"color\":\"");
            out.push_str(&token.color); // pre-normalized hex, no escaping needed
            out.push_str("\",\"fontStyle\":");
            push_usize(&mut out, token.font_style as usize);
            out.push('}');
        }
        out.push(']');
    }
    out.push_str("],\"themeName\":\"");
    push_json_escaped(&mut out, &theme.theme_name);
    out.push('"');
    if let Some(fg) = &theme.fg {
        out.push_str(",\"fg\":\"");
        out.push_str(fg);
        out.push('"');
    }
    if let Some(bg) = &theme.bg {
        out.push_str(",\"bg\":\"");
        out.push_str(bg);
        out.push('"');
    }
    out.push('}');
    Ok(out)
}

pub(crate) fn render_styled_tokens_json_with_state(
    lines: Vec<Vec<StyledJsonToken>>,
    theme: JsonThemeProfile,
    final_stack: &[StateFrame],
    root_scope: Option<&str>,
) -> Result<String> {
    let mut out = String::with_capacity(lines.len() * 128);
    out.push_str("{\"tokens\":[");
    for (li, line) in lines.iter().enumerate() {
        if li > 0 {
            out.push(',');
        }
        out.push('[');
        for (ti, token) in line.iter().enumerate() {
            if ti > 0 {
                out.push(',');
            }
            out.push_str("{\"content\":\"");
            push_json_escaped(&mut out, &token.content);
            out.push_str("\",\"offset\":");
            push_usize(&mut out, token.offset_utf16);
            out.push_str(",\"color\":\"");
            out.push_str(&token.color);
            out.push_str("\",\"fontStyle\":");
            push_usize(&mut out, token.font_style as usize);
            out.push('}');
        }
        out.push(']');
    }
    out.push_str("],\"themeName\":\"");
    push_json_escaped(&mut out, &theme.theme_name);
    out.push('"');
    if let Some(fg) = &theme.fg {
        out.push_str(",\"fg\":\"");
        out.push_str(fg);
        out.push('"');
    }
    if let Some(bg) = &theme.bg {
        out.push_str(",\"bg\":\"");
        out.push_str(bg);
        out.push('"');
    }
    // Serialize state via serde (complex nested structure)
    let state_value = serialize_state_frames(final_stack, root_scope);
    out.push_str(",\"_rustState\":");
    let state_json = serde_json::to_string(&state_value)
        .map_err(|err| Error::from_reason(format!("Failed to serialize state: {err}")))?;
    out.push_str(&state_json);
    out.push('}');
    Ok(out)
}

pub(crate) fn default_theme_data(theme_name: &str) -> ThemeData {
    let fg = COLOR_DEFAULT_FG.to_owned();
    ThemeData {
        name: theme_name.to_owned(),
        fg_normalized: Arc::<str>::from(COLOR_DEFAULT_FG),
        fg,
        bg: COLOR_DEFAULT_BG.to_owned(),
        settings: Vec::new(),
    }
}

pub(crate) fn resolve_theme_data<'a>(
    theme_name: &str,
    themes: &'a HashMap<String, ThemeData>,
) -> Option<&'a ThemeData> {
    themes.get(theme_name)
}

pub(crate) fn normalize_vue_tag_end_tokens(
    lines: &mut [Vec<StyledJsonToken>],
    root_scope: Option<&str>,
    theme: &ThemeData,
) {
    if root_scope != Some("text.html.vue") {
        return;
    }

    let punctuation = resolve_token_style(
        &["text.html.vue", "punctuation.definition.tag.end.html.vue"],
        theme,
    )
    .foreground
    .unwrap_or_else(|| Arc::<str>::from("#666666"));

    for line in lines.iter_mut() {
        for token in line.iter_mut() {
            if (token.content == ">" || token.content == "/>") && token.color == theme.fg_normalized
            {
                token.color = punctuation.clone();
            }
        }
    }
}

pub(crate) fn push_normalized_token(
    out: &mut Vec<StyledJsonToken>,
    content: &str,
    offset_utf16: usize,
    color: Arc<str>,
    font_style: u8,
) {
    if content.is_empty() {
        return;
    }
    out.push(StyledJsonToken {
        content: content.to_owned(),
        content_utf16_len: content.encode_utf16().count(),
        offset_utf16,
        color,
        font_style,
        dark_color: None,
    });
}

pub(crate) fn retokenize_astro_default_token(
    token: &StyledJsonToken,
    theme: &ThemeData,
) -> Option<Vec<StyledJsonToken>> {
    if token.color != theme.fg_normalized
        || (!token.content.contains('<') && !token.content.contains('{'))
    {
        return None;
    }

    let punctuation = resolve_token_style(
        &["source.astro", "punctuation.definition.tag.begin.astro"],
        theme,
    )
    .foreground
    .unwrap_or_else(|| Arc::<str>::from("#666666"));
    let tag_name = resolve_token_style(&["source.astro", "entity.name.tag.astro"], theme)
        .foreground
        .unwrap_or_else(|| Arc::<str>::from("#4D9375"));
    let identifier = resolve_token_style(&["source.astro", "identifier"], theme)
        .foreground
        .unwrap_or_else(|| Arc::<str>::from("#BD976A"));

    let bytes = token.content.as_bytes();
    let mut pieces = Vec::new();
    let mut index = 0usize;
    let mut offset = token.offset_utf16;
    let mut in_interpolation = false;

    while index < bytes.len() {
        if bytes[index] == b'<' {
            if index + 1 < bytes.len() && bytes[index + 1] == b'/' {
                push_normalized_token(
                    &mut pieces,
                    "</",
                    offset,
                    punctuation.clone(),
                    token.font_style,
                );
                index += 2;
                offset += 2;
            } else {
                push_normalized_token(
                    &mut pieces,
                    "<",
                    offset,
                    punctuation.clone(),
                    token.font_style,
                );
                index += 1;
                offset += 1;
            }

            let start = index;
            while index < bytes.len() {
                let ch = bytes[index] as char;
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':') {
                    index += 1;
                } else {
                    break;
                }
            }
            if index > start {
                let name = &token.content[start..index];
                push_normalized_token(
                    &mut pieces,
                    name,
                    offset,
                    tag_name.clone(),
                    token.font_style,
                );
                offset += name.encode_utf16().count();
            }
            continue;
        }

        if bytes[index] == b'>' {
            push_normalized_token(
                &mut pieces,
                ">",
                offset,
                punctuation.clone(),
                token.font_style,
            );
            index += 1;
            offset += 1;
            continue;
        }

        if bytes[index] == b'{' {
            in_interpolation = true;
            push_normalized_token(
                &mut pieces,
                "{",
                offset,
                punctuation.clone(),
                token.font_style,
            );
            index += 1;
            offset += 1;
            continue;
        }

        if bytes[index] == b'}' {
            in_interpolation = false;
            push_normalized_token(
                &mut pieces,
                "}",
                offset,
                punctuation.clone(),
                token.font_style,
            );
            index += 1;
            offset += 1;
            continue;
        }

        if in_interpolation && (bytes[index] as char).is_ascii_alphabetic() {
            let start = index;
            while index < bytes.len() {
                let ch = bytes[index] as char;
                if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$') {
                    index += 1;
                } else {
                    break;
                }
            }
            let ident = &token.content[start..index];
            push_normalized_token(
                &mut pieces,
                ident,
                offset,
                identifier.clone(),
                token.font_style,
            );
            offset += ident.encode_utf16().count();
            continue;
        }

        let start = index;
        while index < bytes.len() && !matches!(bytes[index], b'<' | b'>' | b'{' | b'}') {
            if in_interpolation && (bytes[index] as char).is_ascii_alphabetic() {
                break;
            }
            index += 1;
        }
        let text = &token.content[start..index];
        push_normalized_token(
            &mut pieces,
            text,
            offset,
            token.color.clone(),
            token.font_style,
        );
        offset += text.encode_utf16().count();
    }

    Some(pieces)
}

pub(crate) fn recolor_astro_contextual_tokens(
    line: &[StyledJsonToken],
    theme: &ThemeData,
) -> Vec<StyledJsonToken> {
    let punctuation = resolve_token_style(
        &["source.astro", "punctuation.definition.tag.begin.astro"],
        theme,
    )
    .foreground
    .unwrap_or_else(|| Arc::<str>::from("#666666"));
    let tag_name = resolve_token_style(&["source.astro", "entity.name.tag.astro"], theme)
        .foreground
        .unwrap_or_else(|| Arc::<str>::from("#4D9375"));
    let identifier = resolve_token_style(&["source.astro", "identifier"], theme)
        .foreground
        .unwrap_or_else(|| Arc::<str>::from("#BD976A"));

    let mut normalized = Vec::with_capacity(line.len() + 2);
    let mut expect_tag_name = false;
    let mut expect_identifier = false;

    for token in line {
        let mut handled = false;
        let mut remaining = token.content.as_str();
        let mut offset = token.offset_utf16;

        while !remaining.is_empty() {
            if token.color == theme.fg_normalized && expect_identifier {
                let ident_len = remaining
                    .chars()
                    .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$'))
                    .map(char::len_utf8)
                    .sum::<usize>();
                if ident_len > 0 {
                    let ident = &remaining[..ident_len];
                    push_normalized_token(
                        &mut normalized,
                        ident,
                        offset,
                        identifier.clone(),
                        token.font_style,
                    );
                    offset += ident.encode_utf16().count();
                    remaining = &remaining[ident_len..];
                    expect_identifier = false;
                    handled = true;
                    continue;
                }
                expect_identifier = false;
            }

            if token.color == theme.fg_normalized && expect_tag_name {
                let tag_len = remaining
                    .chars()
                    .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':'))
                    .map(char::len_utf8)
                    .sum::<usize>();
                if tag_len > 0 {
                    let tag = &remaining[..tag_len];
                    push_normalized_token(
                        &mut normalized,
                        tag,
                        offset,
                        tag_name.clone(),
                        token.font_style,
                    );
                    offset += tag.encode_utf16().count();
                    remaining = &remaining[tag_len..];
                    expect_tag_name = false;
                    handled = true;
                    continue;
                }
                expect_tag_name = false;
            }

            if handled {
                push_normalized_token(
                    &mut normalized,
                    remaining,
                    offset,
                    token.color.clone(),
                    token.font_style,
                );
            } else {
                normalized.push(token.clone());
            }
            break;
        }

        let current = normalized.last().unwrap_or(token);
        let ends_with_punctuation = current.color == punctuation
            && (current.content.ends_with('{')
                || current.content.ends_with('<')
                || current.content.ends_with("</"));
        if ends_with_punctuation {
            expect_identifier = current.content.ends_with('{');
            expect_tag_name = current.content.ends_with('<') || current.content.ends_with("</");
        }
    }

    normalized
}

pub(crate) fn merge_astro_punctuation_sequences(
    line: &[StyledJsonToken],
    theme: &ThemeData,
) -> Vec<StyledJsonToken> {
    let punctuation = resolve_token_style(
        &["source.astro", "punctuation.definition.tag.begin.astro"],
        theme,
    )
    .foreground
    .unwrap_or_else(|| Arc::<str>::from("#666666"));

    let mut merged: Vec<StyledJsonToken> = Vec::with_capacity(line.len());

    for token in line {
        if let Some(previous) = merged.last_mut() {
            let is_contiguous =
                previous.offset_utf16 + previous.content_utf16_len == token.offset_utf16;
            let same_style = previous.color == punctuation
                && token.color == punctuation
                && previous.font_style == token.font_style
                && previous.dark_color == token.dark_color;
            let mergeable_sequence = matches!(
                (previous.content.as_str(), token.content.as_str()),
                (">", "{") | ("}", "</")
            );
            if is_contiguous && same_style && mergeable_sequence {
                previous.content.push_str(&token.content);
                previous.content_utf16_len += token.content_utf16_len;
                continue;
            }
        }
        merged.push(token.clone());
    }

    merged
}

pub(crate) fn normalize_astro_tag_tokens(
    lines: &mut [Vec<StyledJsonToken>],
    root_scope: Option<&str>,
    theme: &ThemeData,
) {
    if root_scope != Some("source.astro") {
        return;
    }

    for line in lines.iter_mut() {
        let mut normalized = Vec::with_capacity(line.len() + 2);
        for token in line.iter() {
            if let Some(parts) = retokenize_astro_default_token(token, theme) {
                normalized.extend(parts);
            } else {
                normalized.push(token.clone());
            }
        }
        let recolored = recolor_astro_contextual_tokens(&normalized, theme);
        *line = merge_astro_punctuation_sequences(&recolored, theme);
    }
}

pub(crate) fn render_json_html(
    code: &str,
    options_json: &str,
    themes: &HashMap<String, ThemeData>,
) -> Result<String> {
    let html_theme = resolve_html_theme_profile(options_json, "ferriki-json", themes);
    if html_theme.disable_token_coloring {
        return Ok(render_unstyled_html(code, &html_theme));
    }

    let fallback_light = default_theme_data(&html_theme.theme_name);
    let light_theme = resolve_theme_data(&html_theme.theme_name, themes).unwrap_or(&fallback_light);
    let options: Value = serde_json::from_str(options_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse codeToHtml options JSON: {err}"))
    })?;
    let replacements = resolve_color_replacements(&options, &html_theme.theme_name);
    let mut html_theme = html_theme;
    apply_color_replacements_to_html_theme_profile(&mut html_theme, &replacements);
    let tokens = merge_adjacent_json_punct_tokens(tokenize_json_with_ferroni(code)?);
    let mut styled = style_json_tokens(&tokens, light_theme);
    if let Some(dark_theme_name) = html_theme.dark_theme_name.as_deref() {
        if dark_theme_name == "none" {
            styled = apply_dark_theme_inherit(styled);
        } else {
            let fallback_dark = default_theme_data(dark_theme_name);
            let dark_theme = resolve_theme_data(dark_theme_name, themes).unwrap_or(&fallback_dark);
            let dark_styled = style_json_tokens(&tokens, dark_theme);
            styled = apply_dark_theme_palette(styled, &dark_styled);
        }
    }
    let default_fg = light_theme.fg.clone();
    let mut lines = styled_json_lines(&styled);
    apply_color_replacements_to_lines(&mut lines, &replacements);
    let lines = apply_render_line_options(lines, &options)
        .into_iter()
        .map(|line| merge_line_for_html(&line, &default_fg))
        .collect::<Vec<_>>();
    Ok(render_styled_html_lines(&lines, &html_theme, false))
}

pub(crate) fn render_json_tokens_json(
    code: &str,
    options_json: &str,
    themes: &HashMap<String, ThemeData>,
) -> Result<String> {
    let options: Value = serde_json::from_str(options_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse codeToTokens options JSON: {err}"))
    })?;
    let tokens = merge_adjacent_json_punct_tokens(tokenize_json_with_ferroni(code)?);
    let mut theme = resolve_json_theme(options_json, themes);
    let fallback = default_theme_data(&theme.theme_name);
    let theme_data = resolve_theme_data(&theme.theme_name, themes).unwrap_or(&fallback);
    let replacements = resolve_color_replacements(&options, &theme.theme_name);
    apply_color_replacements_to_json_theme_profile(&mut theme, &replacements);
    let styled = style_json_tokens(&tokens, theme_data);
    let mut lines = styled_json_lines(&styled);
    apply_color_replacements_to_lines(&mut lines, &replacements);
    render_styled_tokens_json(lines, theme)
}

pub(crate) fn render_json_hast_json(
    code: &str,
    options_json: &str,
    themes: &HashMap<String, ThemeData>,
) -> Result<String> {
    let html_theme = resolve_html_theme_profile(options_json, "ferriki-json", themes);
    let fallback_light = default_theme_data(&html_theme.theme_name);
    let light_theme = resolve_theme_data(&html_theme.theme_name, themes).unwrap_or(&fallback_light);
    let options: Value = serde_json::from_str(options_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse codeToHast options JSON: {err}"))
    })?;
    let replacements = resolve_color_replacements(&options, &html_theme.theme_name);
    let mut html_theme = html_theme;
    apply_color_replacements_to_html_theme_profile(&mut html_theme, &replacements);
    let tokens = merge_adjacent_json_punct_tokens(tokenize_json_with_ferroni(code)?);
    let mut styled = style_json_tokens(&tokens, light_theme);
    if let Some(dark_theme_name) = html_theme.dark_theme_name.as_deref() {
        if dark_theme_name == "none" {
            styled = apply_dark_theme_inherit(styled);
        } else {
            let fallback_dark = default_theme_data(dark_theme_name);
            let dark_theme = resolve_theme_data(dark_theme_name, themes).unwrap_or(&fallback_dark);
            let dark_styled = style_json_tokens(&tokens, dark_theme);
            styled = apply_dark_theme_palette(styled, &dark_styled);
        }
    }
    let mut lines = styled_json_lines(&styled);
    apply_color_replacements_to_lines(&mut lines, &replacements);
    let lines = apply_render_line_options(lines, &options);
    render_styled_hast_payload_json(&lines, options_json, &html_theme, None)
}

pub(crate) fn resolve_initial_stack(
    options_json: &str,
    code: &str,
    compiled: &mut CompiledGrammar,
    root_scope: Option<&str>,
    theme: &ThemeData,
) -> Result<Option<Vec<StateFrame>>> {
    // Priority: _rustState > grammarContextCode > default (None)
    if let Some(stack) = parse_initial_state_from_options(options_json) {
        return Ok(Some(stack));
    }
    if let Some(context_code) = parse_grammar_context_code(options_json) {
        if !context_code.is_empty() {
            let (_, final_stack) =
                tokenize_with_grammar_skeleton(&context_code, compiled, root_scope, theme, None)?;
            return Ok(Some(final_stack));
        }
    }
    let _ = code; // suppress unused warning
    Ok(None)
}

pub(crate) fn render_grammar_html(
    code: &str,
    options_json: &str,
    compiled: &mut CompiledGrammar,
    root_scope: Option<&str>,
    themes: &HashMap<String, ThemeData>,
) -> Result<String> {
    let options: Value = serde_json::from_str(options_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse codeToHtml options JSON: {err}"))
    })?;
    let html_theme = resolve_html_theme_profile(options_json, "ferriki-grammar", themes);
    if html_theme.disable_token_coloring {
        return Ok(render_unstyled_html(code, &html_theme));
    }

    let fallback_light = default_theme_data(&html_theme.theme_name);
    let light_theme = resolve_theme_data(&html_theme.theme_name, themes).unwrap_or(&fallback_light);
    let replacements = resolve_color_replacements(&options, &html_theme.theme_name);
    let mut html_theme = html_theme;
    apply_color_replacements_to_html_theme_profile(&mut html_theme, &replacements);
    let initial_stack =
        resolve_initial_stack(options_json, code, compiled, root_scope, light_theme)?;
    let (mut styled, _) =
        tokenize_with_grammar_skeleton(code, compiled, root_scope, light_theme, initial_stack)?;
    if let Some(dark_theme_name) = html_theme.dark_theme_name.as_deref() {
        if dark_theme_name == "none" {
            styled = apply_dark_theme_inherit(styled);
        } else {
            let fallback_dark = default_theme_data(dark_theme_name);
            let dark_theme = resolve_theme_data(dark_theme_name, themes).unwrap_or(&fallback_dark);
            let dark_initial =
                resolve_initial_stack(options_json, code, compiled, root_scope, dark_theme)?;
            let (dark_styled, _) = tokenize_with_grammar_skeleton(
                code,
                compiled,
                root_scope,
                dark_theme,
                dark_initial,
            )?;
            styled = apply_dark_theme_palette(styled, &dark_styled);
        }
    }
    let default_fg = light_theme.fg.clone();
    let mut lines = styled_json_lines(&styled);
    normalize_vue_tag_end_tokens(&mut lines, root_scope, light_theme);
    normalize_astro_tag_tokens(&mut lines, root_scope, light_theme);
    apply_color_replacements_to_lines(&mut lines, &replacements);
    let lines = apply_render_line_options(lines, &options)
        .into_iter()
        .map(|line| merge_line_for_html(&line, &default_fg))
        .collect::<Vec<_>>();
    Ok(render_styled_html_lines(&lines, &html_theme, false))
}

pub(crate) fn render_grammar_tokens_json(
    code: &str,
    options_json: &str,
    compiled: &mut CompiledGrammar,
    root_scope: Option<&str>,
    themes: &HashMap<String, ThemeData>,
) -> Result<String> {
    let options: Value = serde_json::from_str(options_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse codeToTokens options JSON: {err}"))
    })?;
    let mut theme = resolve_theme_profile(options_json, "ferriki-grammar", themes);
    let fallback = default_theme_data(&theme.theme_name);
    let theme_data = resolve_theme_data(&theme.theme_name, themes).unwrap_or(&fallback);
    let replacements = resolve_color_replacements(&options, &theme.theme_name);
    apply_color_replacements_to_json_theme_profile(&mut theme, &replacements);
    let initial_stack =
        resolve_initial_stack(options_json, code, compiled, root_scope, theme_data)?;
    let (styled, final_stack) =
        tokenize_with_grammar_skeleton(code, compiled, root_scope, theme_data, initial_stack)?;
    let mut lines = styled_json_lines(&styled);
    normalize_vue_tag_end_tokens(&mut lines, root_scope, theme_data);
    normalize_astro_tag_tokens(&mut lines, root_scope, theme_data);
    apply_color_replacements_to_lines(&mut lines, &replacements);
    render_styled_tokens_json_with_state(lines, theme, &final_stack, root_scope)
}

pub(crate) fn render_grammar_hast_json(
    code: &str,
    options_json: &str,
    compiled: &mut CompiledGrammar,
    root_scope: Option<&str>,
    themes: &HashMap<String, ThemeData>,
) -> Result<String> {
    let options: Value = serde_json::from_str(options_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse codeToHast options JSON: {err}"))
    })?;
    let html_theme = resolve_html_theme_profile(options_json, "ferriki-grammar", themes);
    let fallback_light = default_theme_data(&html_theme.theme_name);
    let light_theme = resolve_theme_data(&html_theme.theme_name, themes).unwrap_or(&fallback_light);
    let replacements = resolve_color_replacements(&options, &html_theme.theme_name);
    let mut html_theme = html_theme;
    apply_color_replacements_to_html_theme_profile(&mut html_theme, &replacements);
    let initial_stack =
        resolve_initial_stack(options_json, code, compiled, root_scope, light_theme)?;
    let (mut styled, final_stack) =
        tokenize_with_grammar_skeleton(code, compiled, root_scope, light_theme, initial_stack)?;
    if let Some(dark_theme_name) = html_theme.dark_theme_name.as_deref() {
        if dark_theme_name == "none" {
            styled = apply_dark_theme_inherit(styled);
        } else {
            let fallback_dark = default_theme_data(dark_theme_name);
            let dark_theme = resolve_theme_data(dark_theme_name, themes).unwrap_or(&fallback_dark);
            let dark_initial =
                resolve_initial_stack(options_json, code, compiled, root_scope, dark_theme)?;
            let (dark_styled, _) = tokenize_with_grammar_skeleton(
                code,
                compiled,
                root_scope,
                dark_theme,
                dark_initial,
            )?;
            styled = apply_dark_theme_palette(styled, &dark_styled);
        }
    }
    let mut lines = styled_json_lines(&styled);
    normalize_vue_tag_end_tokens(&mut lines, root_scope, light_theme);
    normalize_astro_tag_tokens(&mut lines, root_scope, light_theme);
    apply_color_replacements_to_lines(&mut lines, &replacements);
    let lines = apply_render_line_options(lines, &options);
    let rust_state = serialize_state_frames(&final_stack, root_scope);
    render_styled_hast_payload_json(&lines, options_json, &html_theme, Some(rust_state))
}
