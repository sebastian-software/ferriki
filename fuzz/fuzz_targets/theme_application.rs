#![no_main]

use ferriki_fuzz::{
    MAX_THEME_INPUT_BYTES, MAX_TOKENIZER_LINE_BYTES, TOKENIZE_LIMIT_MILLIS,
    assert_token_output_invariants, bounded_utf8, grammar_with_theme,
};
use ferriki_textmate::RawTheme;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    let text = bounded_utf8(input, MAX_THEME_INPUT_BYTES);
    let (theme_json, line) = text.split_once('\n').unwrap_or((text.as_ref(), ""));

    // Invalid JSON is normal fuzzer input. The default theme keeps every input
    // flowing into registry construction, theme resolution, and tokenization.
    let theme = serde_json::from_str::<RawTheme>(theme_json).unwrap_or_default();
    let grammar = grammar_with_theme(Some(theme)).expect("theme resolution must return a result");

    let line = bounded_utf8(line.as_bytes(), MAX_TOKENIZER_LINE_BYTES);
    let result = grammar
        .tokenize_line_with_scopes(line.as_ref(), None, TOKENIZE_LIMIT_MILLIS)
        .expect("the fixed grammar regexes must tokenize without errors");
    assert_token_output_invariants(&result, line.as_ref());
});
