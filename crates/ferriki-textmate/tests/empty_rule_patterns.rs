use std::rc::Rc;

use ferriki_textmate::{
    Grammar, GrammarConfiguration, SyncRegistry, TokenizeLineResult, parse_raw_grammar,
};

fn grammar(source: &str) -> Rc<Grammar> {
    let raw = parse_raw_grammar(source, Some("empty-patterns.json")).unwrap();
    let scope_name = raw.scope_name.clone();
    let mut registry = SyncRegistry::new(None, None).unwrap();
    registry.add_grammar(raw, vec![]);
    registry
        .grammar_for_scope_name(&scope_name, GrammarConfiguration::default())
        .unwrap()
        .unwrap()
}

fn token_spans(result: &TokenizeLineResult) -> Vec<(usize, usize, Vec<&str>)> {
    result
        .tokens
        .iter()
        .map(|token| {
            (
                token.start_index,
                token.end_index,
                token.scopes.iter().map(String::as_str).collect(),
            )
        })
        .collect()
}

fn assert_quoted_line_and_following_word(grammar: &Grammar) {
    let first = grammar.tokenize_line("'axb' after", None, 0).unwrap();
    // Token boundaries and scopes match the pinned vscode-textmate 9.3.2 oracle.
    assert_eq!(
        token_spans(&first),
        [
            (0, 1, vec!["source.test", "string.quoted.single"]),
            (1, 2, vec!["source.test", "string.quoted.single"]),
            (
                2,
                3,
                vec!["source.test", "string.quoted.single", "constant.x"],
            ),
            (3, 4, vec!["source.test", "string.quoted.single"]),
            (4, 5, vec!["source.test", "string.quoted.single"]),
            (5, 6, vec!["source.test"]),
            (6, 11, vec!["source.test", "word"]),
        ]
    );
    assert!(!first.stopped_early);

    let second = grammar
        .tokenize_line("next", Some(first.rule_stack), 0)
        .unwrap();
    assert_eq!(token_spans(&second), [(0, 4, vec!["source.test", "word"])]);
    assert!(!second.stopped_early);
}

#[test]
fn empty_match_falls_through_to_include_patterns_without_stopping_the_line() {
    let grammar = grammar(
        r#"{
            "scopeName": "source.test",
            "patterns": [
                {
                    "begin": "'",
                    "end": "'",
                    "name": "string.quoted.single",
                    "patterns": [
                        { "match": "", "name": "never" },
                        {
                            "match": "",
                            "patterns": [{ "match": "x", "name": "constant.x" }]
                        }
                    ]
                },
                { "match": "\\w+", "name": "word" }
            ]
        }"#,
    );

    assert_quoted_line_and_following_word(&grammar);
}

#[test]
fn empty_match_falls_through_to_begin_end() {
    let grammar = grammar(
        r#"{
            "scopeName": "source.test",
            "patterns": [
                {
                    "match": "",
                    "begin": "'",
                    "end": "'",
                    "name": "string.quoted.single",
                    "patterns": [{ "match": "x", "name": "constant.x" }]
                },
                { "match": "\\w+", "name": "word" }
            ]
        }"#,
    );

    assert_quoted_line_and_following_word(&grammar);
}

#[test]
fn empty_while_uses_end_and_releases_the_string_state() {
    let grammar = grammar(
        r#"{
            "scopeName": "source.test",
            "patterns": [
                {
                    "begin": "'",
                    "while": "",
                    "end": "'",
                    "name": "string.quoted.single",
                    "patterns": [{ "match": "x", "name": "constant.x" }]
                },
                { "match": "\\w+", "name": "word" }
            ]
        }"#,
    );

    assert_quoted_line_and_following_word(&grammar);
}

#[test]
fn empty_begin_remains_a_valid_zero_width_pattern() {
    let grammar = grammar(
        r#"{
            "scopeName": "source.test",
            "patterns": [{
                "begin": "",
                "end": "$",
                "name": "meta.line",
                "patterns": [{ "match": "x", "name": "constant.x" }]
            }]
        }"#,
    );
    let first = grammar.tokenize_line("axb", None, 0).unwrap();
    assert_eq!(
        token_spans(&first),
        [
            (0, 1, vec!["source.test", "meta.line"]),
            (1, 2, vec!["source.test", "meta.line", "constant.x"]),
            (2, 3, vec!["source.test", "meta.line"]),
        ]
    );
    assert!(!first.stopped_early);

    let second = grammar
        .tokenize_line("next", Some(first.rule_stack), 0)
        .unwrap();
    assert_eq!(
        token_spans(&second),
        [
            (0, 2, vec!["source.test", "meta.line"]),
            (2, 3, vec!["source.test", "meta.line", "constant.x"]),
            (3, 4, vec!["source.test", "meta.line"]),
        ]
    );
    assert!(!second.stopped_early);
}
