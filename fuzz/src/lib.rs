use std::borrow::Cow;
use std::rc::Rc;

use ferriki_textmate::{
    Grammar, GrammarConfiguration, RawGrammar, RawTheme, SyncRegistry, TokenizeLineResultWithScopes,
};

pub const MAX_GRAMMAR_BYTES: usize = 64 * 1024;
pub const MAX_ASSET_BYTES: usize = 64 * 1024;
pub const MAX_THEME_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_TOKENIZER_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_TOKENIZER_LINE_BYTES: usize = 4 * 1024;
pub const MAX_TOKENIZER_LINES: usize = 8;
pub const TOKENIZE_LIMIT_MILLIS: u64 = 100;

pub const CONTROLLED_GRAMMAR_JSON: &str = r#"{
    "scopeName": "source.fuzz",
    "patterns": [
        { "match": "[a-zA-Z_]+", "name": "word.fuzz" },
        { "match": "[0-9]+", "name": "number.fuzz" },
        { "begin": "\"", "end": "\"", "name": "string.quoted.fuzz" }
    ]
}"#;

const CONTROLLED_THEME_JSON: &str = r##"{
    "name": "Fuzz seed theme",
    "settings": [
        { "scope": "word.fuzz", "settings": { "foreground": "#123456", "fontStyle": "bold" } },
        { "scope": ["number.fuzz", "string.quoted.fuzz"], "settings": { "foreground": "#abcdef" } }
    ]
}"##;

/// Convert arbitrary bytes to UTF-8 and cap the resulting string by byte size.
///
/// Truncation backs up to a character boundary, including when replacement
/// characters make the lossy conversion larger than the input byte slice.
pub fn bounded_utf8(input: &[u8], max_bytes: usize) -> Cow<'_, str> {
    let prefix = &input[..input.len().min(max_bytes)];
    let text = String::from_utf8_lossy(prefix);
    if text.len() <= max_bytes {
        return text;
    }

    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Cow::Owned(text[..end].to_owned())
}

pub fn controlled_theme() -> RawTheme {
    serde_json::from_str(CONTROLLED_THEME_JSON).expect("the fixed fuzz theme is valid JSON")
}

/// Build a grammar using only the bounded, fixed regexes owned by this crate.
pub fn grammar_with_theme(
    theme: Option<RawTheme>,
) -> Result<Rc<Grammar>, ferriki_textmate::ThemeError> {
    let raw_grammar: RawGrammar = serde_json::from_str(CONTROLLED_GRAMMAR_JSON)
        .expect("the fixed fuzz grammar is valid JSON");
    let mut registry = SyncRegistry::new(theme, None)?;
    registry.add_grammar(raw_grammar, Vec::new());
    registry
        .grammar_for_scope_name("source.fuzz", GrammarConfiguration::default())?
        .ok_or_else(|| unreachable!("the fixed grammar was just registered"))
}

/// Check public token offsets and the paired binary-token shape.
///
/// TextMate reports offsets in UTF-16 code units. The tokenizer appends a
/// newline internally, so the maximum output offset is one unit past the
/// supplied line's UTF-16 length.
pub fn assert_token_output_invariants(result: &TokenizeLineResultWithScopes, line: &str) {
    let max_offset = line.encode_utf16().count() + 1;
    let mut previous_start = 0;
    for token in &result.tokens {
        assert!(token.start_index <= token.end_index);
        assert!(token.end_index <= max_offset);
        assert!(token.start_index >= previous_start);
        previous_start = token.start_index;
    }

    assert!(!result.binary_tokens.is_empty());
    assert_eq!(result.binary_tokens.len() % 2, 0);
    let mut previous_binary_start = 0;
    for [start, _] in result.binary_tokens.as_chunks::<2>().0 {
        let start = *start as usize;
        assert!(start <= max_offset);
        assert!(start >= previous_binary_start);
        previous_binary_start = start;
    }

    for font in &result.fonts {
        assert!(font.start_index <= font.end_index);
        assert!(font.end_index <= max_offset);
    }
}
