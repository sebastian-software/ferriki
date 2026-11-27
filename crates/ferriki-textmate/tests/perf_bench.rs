use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use ferriki_textmate::__oracle::{GrammarProvider, GrammarStore};
use ferriki_textmate::{
    Grammar, GrammarConfiguration, RawTheme, RawThemeScope, RawThemeSetting, RawThemeStyle,
    StateStack, Theme, parse_raw_grammar,
};

fn oracle_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node/compat/upstream/vscode-textmate")
}

fn sample_theme(primary: &str, keyword: &str, string: &str, comment: &str) -> Theme {
    let raw = RawTheme::default()
        .with_name(Some("bench".to_owned()))
        .with_settings(vec![
            RawThemeSetting::default().with_settings(Some(
                RawThemeStyle::default()
                    .with_foreground(Some(primary.to_owned()))
                    .with_background(Some("#1e1e1e".to_owned())),
            )),
            RawThemeSetting::default()
                .with_scope(Some(RawThemeScope::Array(vec![
                    "keyword".to_owned(),
                    "storage.type".to_owned(),
                    "storage.modifier".to_owned(),
                ])))
                .with_settings(Some(
                    RawThemeStyle::default()
                        .with_foreground(Some(keyword.to_owned()))
                        .with_font_style(Some("bold".to_owned())),
                )),
            RawThemeSetting::default()
                .with_scope(Some(RawThemeScope::String("string".to_owned())))
                .with_settings(Some(
                    RawThemeStyle::default().with_foreground(Some(string.to_owned())),
                )),
            RawThemeSetting::default()
                .with_scope(Some(RawThemeScope::String("comment".to_owned())))
                .with_settings(Some(
                    RawThemeStyle::default()
                        .with_foreground(Some(comment.to_owned()))
                        .with_font_style(Some("italic".to_owned())),
                )),
            RawThemeSetting::default()
                .with_scope(Some(RawThemeScope::String(
                    "meta.function entity.name.function".to_owned(),
                )))
                .with_settings(Some(
                    RawThemeStyle::default().with_foreground(Some("#dcdcaa".to_owned())),
                )),
            RawThemeSetting::default()
                .with_scope(Some(RawThemeScope::String("constant.numeric".to_owned())))
                .with_settings(Some(
                    RawThemeStyle::default().with_foreground(Some("#b5cea8".to_owned())),
                )),
        ]);
    Theme::create_from_raw_theme(Some(&raw), None).expect("bench theme should compile")
}

fn js_corpus_lines(repeat_blocks: usize) -> Vec<String> {
    let block = [
        "// TODO: compute weighted score with inline comments and expressions",
        "export class TokenProcessor extends BaseProcessor {",
        "  constructor(config = { limit: 4096, strict: true, mode: 'fast' }) {",
        "    super(config);",
        "    this.cache = new Map();",
        "    this.pattern = /^(?:foo|bar)[0-9]+\\s*$/gi;",
        "  }",
        "  async processBatch(items, { prefix = '{{item}}', offset = 0 } = {}) {",
        "    const results = [];",
        "    for (let i = 0; i < items.length; i += 1) {",
        "      const entry = items[i];",
        "      if (!entry || entry.disabled === true) continue;",
        "      const score = (entry.weight * 1.5 + offset) / Math.max(1, entry.count);",
        "      const label = `${prefix}-${i}: ${entry.name || 'unnamed'} (${score.toFixed(2)})`;",
        "      results.push({ id: i, label, score, active: score >= 10.5 });",
        "    }",
        "    return results.filter((row) => row.active).map((row) => row.label);",
        "  }",
        "}",
        "/* Multi-line block comment describing edge cases",
        " * across line boundaries for state stack continuation.",
        " */",
    ];
    let mut lines = Vec::with_capacity(block.len() * repeat_blocks);
    for _ in 0..repeat_blocks {
        for line in block {
            lines.push(line.to_owned());
        }
    }
    lines
}

fn load_js_grammar(with_injections: bool) -> Grammar {
    let fixture_root = oracle_root().join("test-cases/suite1/fixtures");
    let content = fs::read_to_string(fixture_root.join("javascript.json"))
        .expect("javascript grammar should be readable");
    let raw = parse_raw_grammar(&content, Some("javascript.json"))
        .expect("javascript grammar should deserialize");
    let mut store = GrammarStore::new();
    let scope_name = raw.scope_name.clone();
    store.insert(raw);

    if with_injections {
        let injection_raw = parse_raw_grammar(
            r#"{
                "scopeName": "source.js.todo.injection",
                "injectionSelector": "R:comment, L:string.quoted.single",
                "patterns": [
                    { "match": "\\b(TODO|FIXME|NOTE)\\b", "name": "keyword.other.todo" },
                    { "match": "\\{\\{[^}]+\\}\\}", "name": "variable.other.template" }
                ]
            }"#,
            Some("injection.json"),
        )
        .expect("injection grammar should parse");
        let inj_scope = injection_raw.scope_name.clone();
        store.insert(injection_raw);
        store.set_injections(&scope_name, vec![inj_scope]);
    }

    let root = store.lookup(&scope_name).expect("root grammar loaded");
    let config = GrammarConfiguration::default()
        .with_initial_language_id(1)
        .with_balanced_bracket_selectors(Some(vec!["*".to_owned()]));
    Grammar::new(
        &root,
        &store,
        sample_theme("#d4d4d4", "#569cd6", "#ce9178", "#6a9955"),
        config,
    )
    .expect("grammar should compile")
}

#[test]
#[ignore = "manual release throughput benchmark"]
fn bench_textmate_hot_loop() {
    let lines = js_corpus_lines(200); // 4,400 lines
    let line_count = lines.len();

    // Warm up grammars & scanners
    let grammar = load_js_grammar(false);
    let grammar_inj = load_js_grammar(true);
    let dark = Arc::new(sample_theme("#d4d4d4", "#569cd6", "#ce9178", "#6a9955"));
    let light = Arc::new(sample_theme("#24292e", "#d73a49", "#032f62", "#6a737d"));
    let themes = [Arc::clone(&dark), Arc::clone(&light)];

    const BLOCK_LINES: usize = 22;
    let mut state: Option<Arc<StateStack>> = None;
    let mut block_tokens = 0usize;
    for line in &lines[..BLOCK_LINES] {
        let res = grammar.tokenize_line2(line, state, 0).unwrap();
        block_tokens += res.tokens.len() / 2;
        state = Some(res.rule_stack);
    }
    assert_eq!(
        state.as_ref().expect("block must produce state").depth,
        1,
        "one JS corpus block must return to root grammar state (not get stuck inside a string)"
    );
    assert!(
        block_tokens * 200 > 20_000,
        "JS corpus must emit realistic token counts (got {} per block)",
        block_tokens
    );

    let mut inj_state: Option<Arc<StateStack>> = None;
    let mut saw_todo_injection = false;
    let mut saw_template_injection = false;
    for line in &lines[..BLOCK_LINES] {
        let res = grammar_inj.tokenize_line(line, inj_state, 0).unwrap();
        assert!(
            !res.stopped_early,
            "warmup injection line must not stop early"
        );
        for token in &res.tokens {
            if token
                .scopes
                .iter()
                .any(|scope| scope == "keyword.other.todo")
            {
                saw_todo_injection = true;
            }
            if token
                .scopes
                .iter()
                .any(|scope| scope == "variable.other.template")
            {
                saw_template_injection = true;
            }
        }
        inj_state = Some(res.rule_stack);
    }
    assert_eq!(
        inj_state.as_ref().expect("block must produce state").depth,
        1,
        "one JS corpus block with injections must return to root grammar state"
    );
    assert!(
        saw_todo_injection,
        "injection benchmark corpus must exercise the R:comment TODO injection"
    );
    assert!(
        saw_template_injection,
        "injection benchmark corpus must exercise the L:string.quoted.single template injection"
    );

    // Warm up remaining scanners and multi-theme path
    for line in &lines[..44] {
        let _ = grammar
            .tokenize_line_with_themes(line, None, &themes, false, 0)
            .unwrap();
    }

    const RUNS: usize = 5;

    let bench = |name: &str, f: &dyn Fn() -> usize| {
        let mut best_ms = f64::MAX;
        let mut total_tokens = 0usize;
        for _ in 0..RUNS {
            let start = Instant::now();
            total_tokens = f();
            let ms = start.elapsed().as_secs_f64() * 1_000.0;
            if ms < best_ms {
                best_ms = ms;
            }
        }
        assert!(
            total_tokens > 20_000,
            "{name} emitted unexpectedly few tokens ({total_tokens})"
        );
        let lines_per_sec = (line_count as f64) / (best_ms / 1_000.0);
        eprintln!(
            "{name:<36} best={best_ms:7.2} ms  ({lines_per_sec:9.0} lines/s, tokens={total_tokens})"
        );
    };

    bench("js tokenize_line2 (limit=0)", &|| {
        let mut state: Option<Arc<StateStack>> = None;
        let mut count = 0;
        for line in &lines {
            let res = grammar.tokenize_line2(line, state, 0).unwrap();
            assert!(!res.stopped_early, "benchmark line must not stop early");
            count += res.tokens.len() / 2;
            state = Some(res.rule_stack);
        }
        count
    });

    bench("js tokenize_line2 (limit=500ms)", &|| {
        let mut state: Option<Arc<StateStack>> = None;
        let mut count = 0;
        for line in &lines {
            let res = grammar.tokenize_line2(line, state, 500).unwrap();
            assert!(!res.stopped_early, "benchmark line must not stop early");
            count += res.tokens.len() / 2;
            state = Some(res.rule_stack);
        }
        count
    });

    bench("js tokenize_with_scopes (500ms)", &|| {
        let mut state: Option<Arc<StateStack>> = None;
        let mut count = 0;
        for line in &lines {
            let res = grammar.tokenize_line_with_scopes(line, state, 500).unwrap();
            assert!(!res.stopped_early, "benchmark line must not stop early");
            count += res.tokens.len();
            state = Some(res.rule_stack);
        }
        count
    });

    bench("js tokenize_with_themes x2 (500ms)", &|| {
        let mut state: Option<Arc<StateStack>> = None;
        let mut count = 0;
        for line in &lines {
            let res = grammar
                .tokenize_line_with_themes(line, state, &themes, false, 500)
                .unwrap();
            assert!(!res.stopped_early, "benchmark line must not stop early");
            count += res.binary_tokens[0].len() / 2;
            state = Some(res.rule_stack);
        }
        count
    });

    bench("js+injections line2 (limit=500ms)", &|| {
        let mut state: Option<Arc<StateStack>> = None;
        let mut count = 0;
        for line in &lines {
            let res = grammar_inj.tokenize_line2(line, state, 500).unwrap();
            assert!(!res.stopped_early, "benchmark line must not stop early");
            count += res.tokens.len() / 2;
            state = Some(res.rule_stack);
        }
        count
    });
}
