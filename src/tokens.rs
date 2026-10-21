use ferriki_textmate::{EncodedTokenAttributes, FontStyle, StandardTokenType};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ops::Range;

use crate::{Error, ErrorKind, Result};

#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct TokenizeOptions {
    /// Best-effort per-line budget in milliseconds. Ferriki checks it between
    /// tokenizer matching passes and after each synchronous pass returns; a
    /// regex search cannot be interrupted and may run past the budget. `0`
    /// disables the time limit.
    pub time_limit_millis: u64,
    pub max_line_length: usize,
    pub include_token_type: bool,
    pub include_scopes: bool,
    /// Retains grammar boundaries even when adjacent tokens have equal styles.
    pub preserve_scope_boundaries: bool,
}

impl Default for TokenizeOptions {
    fn default() -> Self {
        Self {
            time_limit_millis: 500,
            max_line_length: 0,
            include_token_type: false,
            include_scopes: false,
            preserve_scope_boundaries: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct HighlightToken {
    pub content: String,
    pub offset: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_style: Option<FontStyle>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub token_type: Option<StandardTokenType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_names: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct HighlightTokensResult {
    pub tokens: Vec<Vec<HighlightToken>>,
    #[serde(rename = "fg")]
    pub foreground: String,
    #[serde(rename = "bg")]
    pub background: String,
    pub theme_name: String,
}

/// The Rust `Highlighter` returns token offsets in UTF-8 bytes. The internal
/// Node compatibility core keeps UTF-16 offsets for the JavaScript API.
pub(crate) fn convert_token_offsets_to_utf8<'a>(
    offsets: impl IntoIterator<Item = &'a mut usize>,
    input: &str,
) -> Result<()> {
    let map = utf16_to_byte_map(input);
    for offset in offsets {
        *offset = map.get(*offset).ok_or_else(|| {
            Error::new(
                ErrorKind::Internal,
                "Token offset exceeds the highlighted source.",
            )
        })?;
    }
    Ok(())
}

/// Owned style for one named theme variant of a token.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct HighlightThemeTokenStyle {
    /// Resolved foreground color, absent for unstyled plain text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// TextMate font-style bits, absent for unstyled plain text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_style: Option<FontStyle>,
}

/// A source segment aligned across all requested themes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct HighlightThemeToken {
    /// Owned source text for this segment, excluding line endings.
    pub content: String,
    /// UTF-8 byte position in the full input when returned by `Highlighter`.
    pub offset: usize,
    /// Styles keyed by the caller's variant names, in lexical key order.
    pub variants: BTreeMap<String, HighlightThemeTokenStyle>,
    /// Token type from the first requested theme, when enabled.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub token_type: Option<StandardTokenType>,
    /// Scope path from the first requested theme, when enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_names: Option<Vec<String>>,
}

/// Resolved metadata for a requested theme variant.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct HighlightThemeMetadata {
    /// Caller-provided variant key (for example `light`), rather than a CSS color.
    pub color: String,
    /// Registered theme name.
    pub name: String,
    /// Default foreground color for the code block.
    pub foreground: String,
    /// Default background color for the code block.
    pub background: String,
}

/// Owned tokens and theme metadata for multi-theme highlighting.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct HighlightTokensWithThemesResult {
    /// One vector per source line, including trailing empty lines.
    pub tokens: Vec<Vec<HighlightThemeToken>>,
    /// Theme metadata in the caller's request order.
    pub themes: Vec<HighlightThemeMetadata>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn token_from_metadata(
    line: &str,
    utf16_map: &Utf16ToByteMap,
    range: Range<usize>,
    line_offset: usize,
    metadata: u32,
    color_map: &[String],
    include_token_type: bool,
    scope_names: Option<Vec<String>>,
) -> Option<HighlightToken> {
    let start_index = range.start;
    let end_index = range.end;
    if start_index >= end_index {
        return None;
    }
    let start_byte = utf16_map.get(start_index)?;
    let end_byte = utf16_map.get(end_index)?;
    let attributes = EncodedTokenAttributes::new(metadata);
    Some(HighlightToken {
        content: line.get(start_byte..end_byte)?.to_owned(),
        offset: line_offset + start_index,
        color: Some(
            color_map
                .get(attributes.foreground() as usize)
                .cloned()
                .unwrap_or_default(),
        ),
        font_style: Some(attributes.font_style()),
        token_type: include_token_type.then_some(attributes.token_type()),
        scope_names,
    })
}

pub(crate) enum Utf16ToByteMap {
    Ascii(usize),
    Unicode(Vec<usize>),
}

impl Utf16ToByteMap {
    pub(crate) fn get(&self, index: usize) -> Option<usize> {
        match self {
            Self::Ascii(length) => (index <= *length).then_some(index),
            Self::Unicode(offsets) => offsets.get(index).copied(),
        }
    }
}

pub(crate) fn utf16_to_byte_map(input: &str) -> Utf16ToByteMap {
    // ASCII positions are already byte positions, including the end boundary.
    if input.is_ascii() {
        return Utf16ToByteMap::Ascii(input.len());
    }
    let mut map = Vec::with_capacity(input.encode_utf16().count() + 1);
    for (byte_index, character) in input.char_indices() {
        map.push(byte_index);
        if character.len_utf16() == 2 {
            map.push(byte_index);
        }
    }
    map.push(input.len());
    Utf16ToByteMap::Unicode(map)
}

pub(crate) fn split_lines(input: &str) -> Vec<(&str, usize)> {
    if input.is_empty() {
        return vec![("", 0)];
    }

    let mut lines = Vec::new();
    let mut start_byte = 0;
    let mut start_utf16 = 0;
    for (newline_byte, _) in input.match_indices('\n') {
        let line_end = if newline_byte > start_byte
            && input.as_bytes().get(newline_byte - 1) == Some(&b'\r')
        {
            newline_byte - 1
        } else {
            newline_byte
        };
        lines.push((&input[start_byte..line_end], start_utf16));
        start_utf16 += input[start_byte..=newline_byte].encode_utf16().count();
        start_byte = newline_byte + 1;
    }
    lines.push((&input[start_byte..], start_utf16));
    lines
}

impl TokenizeOptions {
    /// Sets `time_limit_millis`.
    #[must_use]
    pub fn with_time_limit_millis(mut self, value: u64) -> Self {
        self.time_limit_millis = value;
        self
    }
    /// Sets `max_line_length`.
    #[must_use]
    pub fn with_max_line_length(mut self, value: usize) -> Self {
        self.max_line_length = value;
        self
    }
    /// Sets `include_token_type`.
    #[must_use]
    pub fn with_include_token_type(mut self, value: bool) -> Self {
        self.include_token_type = value;
        self
    }
    /// Retains full scope paths and theme-independent grammar boundaries.
    #[must_use]
    pub fn with_preserve_scope_boundaries(mut self, value: bool) -> Self {
        self.preserve_scope_boundaries = value;
        self
    }
    /// Sets `include_scopes`.
    #[must_use]
    pub fn with_include_scopes(mut self, value: bool) -> Self {
        self.include_scopes = value;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_shiki_tokenization_limits() {
        assert_eq!(
            TokenizeOptions::default(),
            TokenizeOptions {
                time_limit_millis: 500,
                max_line_length: 0,
                include_token_type: false,
                include_scopes: false,
                preserve_scope_boundaries: false,
            }
        );
    }

    #[test]
    fn splits_crlf_lines_with_global_utf16_offsets() {
        assert_eq!(
            split_lines("😀a\r\nb\n"),
            vec![("😀a", 0), ("b", 5), ("", 7)]
        );
    }

    #[test]
    fn maps_utf16_offsets_to_utf8_boundaries() {
        for (input, expected) in [
            ("", &[0][..]),
            ("ab\t\n", &[0, 1, 2, 3, 4]),
            ("é界", &[0, 2, 5]),
            ("a😀b", &[0, 1, 1, 5, 6]),
            ("e\u{301}", &[0, 1, 3]),
            ("🦀\r\nx", &[0, 0, 4, 5, 6, 7]),
        ] {
            let map = utf16_to_byte_map(input);
            for (index, byte) in expected.iter().enumerate() {
                assert_eq!(map.get(index), Some(*byte), "{input:?} at {index}");
            }
            assert_eq!(map.get(expected.len()), None, "{input:?}");
            assert_eq!(map.get(usize::MAX), None, "{input:?}");
        }
    }

    #[test]
    fn converting_offsets_preserves_bounds_checks_for_ascii_and_unicode() {
        for input in ["abc", "a😀b"] {
            let end = input.encode_utf16().count();
            let mut offsets = [0, end];
            convert_token_offsets_to_utf8(offsets.iter_mut(), input).expect("valid offsets");
            assert_eq!(offsets, [0, input.len()]);
            let mut invalid = [end + 1];
            assert!(convert_token_offsets_to_utf8(invalid.iter_mut(), input).is_err());
        }
    }

    #[test]
    fn typed_token_fields_keep_the_numeric_json_shape() {
        let token = HighlightToken {
            content: "fn".to_owned(),
            offset: 0,
            color: Some("#81A1C1".to_owned()),
            font_style: Some(FontStyle::ITALIC | FontStyle::BOLD),
            token_type: Some(StandardTokenType::Comment),
            scope_names: None,
        };
        let json = serde_json::to_string(&token).expect("serialize");
        assert_eq!(
            json,
            r##"{"content":"fn","offset":0,"color":"#81A1C1","fontStyle":3,"type":1}"##
        );
        assert_eq!(
            serde_json::from_str::<HighlightToken>(&json).expect("deserialize"),
            token
        );
        assert!(
            serde_json::from_str::<HighlightToken>(r#"{"content":"","offset":0,"type":4}"#)
                .is_err()
        );
    }
}
