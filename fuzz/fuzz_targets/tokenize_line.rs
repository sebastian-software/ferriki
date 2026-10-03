#![no_main]

use std::cell::OnceCell;
use std::rc::Rc;

use ferriki_fuzz::{
    MAX_TOKENIZER_INPUT_BYTES, MAX_TOKENIZER_LINE_BYTES, MAX_TOKENIZER_LINES,
    TOKENIZE_LIMIT_MILLIS, assert_token_output_invariants, bounded_utf8, controlled_theme,
    grammar_with_theme,
};
use ferriki_textmate::Grammar;
use libfuzzer_sys::fuzz_target;

thread_local! {
    static GRAMMAR: OnceCell<Rc<Grammar>> = const { OnceCell::new() };
}

fuzz_target!(|input: &[u8]| {
    let text = bounded_utf8(input, MAX_TOKENIZER_INPUT_BYTES);
    GRAMMAR.with(|slot| {
        let grammar = slot.get_or_init(|| {
            grammar_with_theme(Some(controlled_theme()))
                .expect("the controlled grammar and theme must compile")
        });

        let mut previous_state = None;
        for line in text.split('\n').take(MAX_TOKENIZER_LINES) {
            let line = bounded_utf8(line.as_bytes(), MAX_TOKENIZER_LINE_BYTES);
            let result = grammar
                .tokenize_line_with_scopes(line.as_ref(), previous_state, TOKENIZE_LIMIT_MILLIS)
                .expect("the fixed grammar regexes must tokenize without errors");
            assert_token_output_invariants(&result, line.as_ref());
            previous_state = Some(result.rule_stack);
        }
    });
});
