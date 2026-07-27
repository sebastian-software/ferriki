use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ferriki_textmate::{
    apply_state_stack_diff, diff_state_stacks_ref_eq, Grammar, GrammarConfiguration,
    GrammarProvider, GrammarStore, RawGrammar, StateStack, Theme,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTest {
    desc: String,
    grammars: Vec<String>,
    grammar_path: Option<String>,
    grammar_scope_name: Option<String>,
    #[serde(default)]
    grammar_injections: Vec<String>,
    lines: Vec<RawTestLine>,
}

#[derive(Deserialize)]
struct RawTestLine {
    line: String,
    tokens: Vec<RawToken>,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
struct RawToken {
    value: String,
    scopes: Vec<String>,
}

#[test]
fn matches_first_mate_tokenization_oracle() {
    assert_tokenization_suite(&oracle_root().join("test-cases/first-mate/tests.json"));
}

fn assert_tokenization_suite(test_location: &Path) {
    let tests: Vec<RawTest> =
        serde_json::from_slice(&fs::read(test_location).expect("oracle suite should be readable"))
            .expect("oracle suite should deserialize");

    for test in tests {
        perform_test(test_location, &test);
    }
}

fn perform_test(test_location: &Path, test: &RawTest) {
    let fixture_root = test_location
        .parent()
        .expect("oracle suite must have a parent directory");
    let mut store = GrammarStore::new();
    let mut inferred_scope_name = None;

    for grammar_path in &test.grammars {
        let content = fs::read_to_string(fixture_root.join(grammar_path))
            .expect("oracle grammar should be readable");
        let raw_grammar: RawGrammar =
            serde_json::from_str(&content).expect("JSON oracle grammar should deserialize");
        if test.grammar_scope_name.is_none() && test.grammar_path.as_deref() == Some(grammar_path) {
            inferred_scope_name = Some(raw_grammar.scope_name.clone());
        }
        store.insert(raw_grammar);
    }

    let grammar_scope_name = test
        .grammar_scope_name
        .as_ref()
        .or(inferred_scope_name.as_ref())
        .expect("oracle test must identify its root grammar");
    if !test.grammar_injections.is_empty() {
        store.set_injections(grammar_scope_name, test.grammar_injections.clone());
    }
    let raw_grammar = store
        .lookup(grammar_scope_name)
        .expect("oracle root grammar should be loaded");
    let grammar = Grammar::new(
        &raw_grammar,
        &store,
        Theme::create_from_raw_theme(None, None).unwrap(),
        GrammarConfiguration::default(),
    );
    let mut previous_state: Option<Arc<StateStack>> = None;

    for test_line in &test.lines {
        let result = grammar
            .tokenize_line(&test_line.line, previous_state.clone(), 0)
            .unwrap_or_else(|error| {
                panic!(
                    "tokenizing {:?} in {:?} failed: {error}",
                    test_line.line, test.desc
                )
            });
        let actual_tokens: Vec<_> = result
            .tokens
            .iter()
            .map(|token| RawToken {
                value: substring_utf16(&test_line.line, token.start_index, token.end_index),
                scopes: token.scopes.clone(),
            })
            .collect();
        let expected_tokens: Vec<_> = test_line
            .tokens
            .iter()
            .filter(|token| test_line.line.is_empty() || !token.value.is_empty())
            .map(|token| RawToken {
                value: token.value.clone(),
                scopes: token.scopes.clone(),
            })
            .collect();

        assert_eq!(
            actual_tokens, expected_tokens,
            "tokenizing {:?} in {:?} with stack {}",
            test_line.line, test.desc, result.rule_stack
        );

        previous_state = Some(if let Some(previous_state) = previous_state {
            let diff = diff_state_stacks_ref_eq(&previous_state, &result.rule_stack);
            apply_state_stack_diff(Some(previous_state), &diff)
                .expect("state diff should preserve a tokenization stack")
        } else {
            result.rule_stack
        });
    }
}

fn substring_utf16(value: &str, start: usize, end: usize) -> String {
    let units: Vec<_> = value
        .encode_utf16()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect();
    String::from_utf16_lossy(&units)
}

fn oracle_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../node/compat/upstream/vscode-textmate")
}
