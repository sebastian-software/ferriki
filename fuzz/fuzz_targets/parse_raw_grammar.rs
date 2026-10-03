#![no_main]

use ferriki_fuzz::{MAX_GRAMMAR_BYTES, bounded_utf8};
use ferriki_textmate::parse_raw_grammar;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: &[u8]| {
    let content = bounded_utf8(input, MAX_GRAMMAR_BYTES);
    let trimmed = content.trim_start();
    let file_path = if trimmed.starts_with("<plist") || trimmed.starts_with("<?xml") {
        "grammar.tmLanguage"
    } else {
        "grammar.json"
    };

    // Parse errors are expected for arbitrary input. Do not catch panics: a
    // panic in the parser must remain a libFuzzer finding.
    let _ = parse_raw_grammar(&content, Some(file_path));
});
