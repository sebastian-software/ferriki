use ferriki_textmate::EncodedTokenAttributes;
use serde::{Deserialize, Serialize};
use std::ops::Range;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenizeOptions {
    pub time_limit_millis: u64,
    pub max_line_length: usize,
    pub include_token_type: bool,
}

impl Default for TokenizeOptions {
    fn default() -> Self {
        Self {
            time_limit_millis: 500,
            max_line_length: 0,
            include_token_type: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightToken {
    pub content: String,
    pub offset: usize,
    pub color: String,
    pub font_style: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightTokensResult {
    pub tokens: Vec<Vec<HighlightToken>>,
    pub foreground: String,
    pub background: String,
    pub theme_name: String,
}

pub(crate) fn token_from_metadata(
    line: &str,
    utf16_map: &[usize],
    range: Range<usize>,
    line_offset: usize,
    metadata: u32,
    color_map: &[String],
    include_token_type: bool,
) -> Option<HighlightToken> {
    let start_index = range.start;
    let end_index = range.end;
    if start_index >= end_index {
        return None;
    }
    let start_byte = *utf16_map.get(start_index)?;
    let end_byte = *utf16_map.get(end_index)?;
    let attributes = EncodedTokenAttributes::new(metadata);
    Some(HighlightToken {
        content: line.get(start_byte..end_byte)?.to_owned(),
        offset: line_offset + start_index,
        color: color_map
            .get(attributes.foreground() as usize)
            .cloned()
            .unwrap_or_default(),
        font_style: attributes.font_style().bits(),
        token_type: include_token_type.then_some(attributes.token_type() as u8),
    })
}

pub(crate) fn utf16_to_byte_map(input: &str) -> Vec<usize> {
    let mut map = Vec::with_capacity(input.encode_utf16().count() + 1);
    for (byte_index, character) in input.char_indices() {
        map.push(byte_index);
        if character.len_utf16() == 2 {
            map.push(byte_index);
        }
    }
    map.push(input.len());
    map
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_crlf_lines_with_global_utf16_offsets() {
        assert_eq!(
            split_lines("😀a\r\nb\n"),
            vec![("😀a", 0), ("b", 5), ("", 7)]
        );
    }

    #[test]
    fn maps_utf16_offsets_to_utf8_boundaries() {
        assert_eq!(utf16_to_byte_map("a😀b"), vec![0, 1, 1, 5, 6]);
    }
}
