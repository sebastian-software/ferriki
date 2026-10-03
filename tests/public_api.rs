use std::path::Path;

use ferriki::{
    BacktrackingRisk, ErrorKind, FontStyle, HighlightTokensWithThemesResult, Highlighter,
    LanguageRegistration, RenderOptions, StandardAssetCatalogs, TokenizeOptions, parse_raw_grammar,
    parse_theme_data, render_html, render_html_lines,
};

fn assets() -> StandardAssetCatalogs {
    StandardAssetCatalogs::load_from_root(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/assets/shiki"
    )))
    .expect("fixture assets")
}

#[test]
fn multi_theme_tokens_merge_different_boundaries_and_keep_utf8_offsets() {
    let mut highlighter = Highlighter::builder().build().expect("highlighter");
    let grammar = parse_raw_grammar(
        r#"{"scopeName":"source.sample","patterns":[{"match":"foo","name":"keyword.sample"},{"match":"bar","name":"string.sample"}]}"#,
        Some("sample.json"),
    )
    .expect("grammar");
    highlighter
        .register_language(LanguageRegistration::new("sample", grammar))
        .expect("grammar registration");
    for (name, source) in [
        (
            "light-theme",
            r##"{"colors":{"editor.foreground":"#111111","editor.background":"#ffffff"},"tokenColors":[{"scope":"string.sample","settings":{"foreground":"#ff0000","fontStyle":"italic"}}]}"##,
        ),
        (
            "dark-theme",
            r##"{"colors":{"editor.foreground":"#eeeeee","editor.background":"#000000"},"tokenColors":[{"scope":"keyword.sample","settings":{"foreground":"#00ff00","fontStyle":"bold"}}]}"##,
        ),
    ] {
        highlighter
            .register_theme(parse_theme_data(name, source).expect("theme"))
            .expect("registration");
    }

    let code = "😀foo bar\r\n\r\n😀bar\n";
    let light = highlighter
        .highlight(code, "sample", "light-theme")
        .expect("light");
    let dark = highlighter
        .highlight(code, "sample", "dark-theme")
        .expect("dark");
    assert_ne!(
        light.tokens[0]
            .iter()
            .map(|token| &token.content)
            .collect::<Vec<_>>(),
        dark.tokens[0]
            .iter()
            .map(|token| &token.content)
            .collect::<Vec<_>>()
    );

    let themes = [("light", "light-theme"), ("dark", "dark-theme")];
    let result = highlighter
        .highlight_with_themes(code, "sample", &themes)
        .expect("multi-theme");
    assert_eq!(result.tokens.len(), 4);
    assert!(result.tokens[1].is_empty());
    assert!(result.tokens[3].is_empty());
    assert_eq!(
        result.tokens[0]
            .iter()
            .map(|token| token.content.as_str())
            .collect::<Vec<_>>(),
        ["😀", "foo", " ", "bar"]
    );
    assert_eq!(result.tokens[2][0].offset, "😀foo bar\r\n\r\n".len());
    assert_eq!(
        result
            .themes
            .iter()
            .map(|theme| theme.color.as_str())
            .collect::<Vec<_>>(),
        ["light", "dark"]
    );
    assert_eq!(result.themes[0].foreground, light.foreground);
    assert_eq!(result.themes[1].background, dark.background);
    assert_eq!(
        result.tokens[0][1].variants["dark"].font_style,
        Some(FontStyle::BOLD)
    );
    assert_eq!(
        result.tokens[0][3].variants["light"].font_style,
        Some(FontStyle::ITALIC)
    );
    for (line_index, line) in result.tokens.iter().enumerate() {
        for token in line {
            assert_eq!(
                &code[token.offset..token.offset + token.content.len()],
                token.content
            );
            for (key, single) in [("light", &light), ("dark", &dark)] {
                let source = single.tokens[line_index]
                    .iter()
                    .find(|source| {
                        source.offset <= token.offset
                            && source.offset + source.content.len()
                                >= token.offset + token.content.len()
                    })
                    .expect("covering token");
                assert_eq!(token.variants[key].color, source.color);
                assert_eq!(token.variants[key].font_style, source.font_style);
            }
        }
    }
    // Owned results remain readable after the highlighter is reused and dropped.
    let detailed = highlighter
        .highlight_with_themes_and_options(
            code,
            "sample",
            &themes,
            &TokenizeOptions::default()
                .with_include_scopes(true)
                .with_preserve_scope_boundaries(true)
                .with_include_token_type(true),
        )
        .expect("metadata");
    assert!(detailed.tokens[0][1].scope_names.is_some());
    assert!(detailed.tokens[0][1].token_type.is_some());
    let empty = highlighter
        .highlight_with_themes("", "sample", &themes)
        .expect("empty input");
    assert_eq!(empty.tokens, vec![vec![]]);
    let one = highlighter
        .highlight_with_themes(code, "sample", &themes[..1])
        .expect("one theme");
    assert_eq!(one.tokens[0].len(), light.tokens[0].len());
    drop(highlighter);
    let json = serde_json::to_string(&result).expect("serialize");
    assert!(json.contains("\"fontStyle\":2"));
    assert_eq!(
        serde_json::from_str::<HighlightTokensWithThemesResult>(&json).expect("deserialize"),
        result
    );
}

#[test]
fn highlighter_exposes_lazy_advisory_backtracking_warnings() {
    let mut highlighter = Highlighter::builder().build().expect("highlighter");
    let grammar = parse_raw_grammar(
        r#"{"scopeName":"source.diagnostics","patterns":[{"match":"([0-9]+(_?))+(\\.)([0-9]+)","name":"constant.numeric.risky"},{"match":"[a-z]+","name":"word.clean"}]}"#,
        Some("diagnostics.json"),
    )
    .expect("grammar");
    highlighter
        .register_language(LanguageRegistration::new("diagnostics", grammar))
        .expect("grammar registration");
    highlighter
        .register_theme(parse_theme_data("diagnostics-theme", "{}").expect("theme"))
        .expect("theme registration");

    assert_eq!(
        highlighter.backtracking_warnings("diagnostics").unwrap(),
        Some(vec![])
    );
    assert_eq!(highlighter.backtracking_warnings("missing").unwrap(), None);

    highlighter
        .highlight("123.45 clean", "diagnostics", "diagnostics-theme")
        .expect("first highlight");
    let warnings = highlighter
        .backtracking_warnings("diagnostics")
        .unwrap()
        .expect("registered language");
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].grammar_scope_name, "source.diagnostics");
    assert_eq!(warnings[0].rule, "constant.numeric.risky");
    assert_eq!(warnings[0].pattern, r"([0-9]+(_?))+(\.)([0-9]+)");

    highlighter
        .highlight("99.1 clean", "diagnostics", "diagnostics-theme")
        .expect("second highlight");
    assert_eq!(
        highlighter.backtracking_warnings("diagnostics").unwrap(),
        Some(warnings)
    );
}

#[test]
fn warning_snapshots_reset_after_grammar_and_theme_cache_invalidation() {
    let mut highlighter = Highlighter::builder().build().expect("highlighter");
    let grammar = parse_raw_grammar(
        r#"{"scopeName":"source.lifecycle","patterns":[{"begin":"BEGIN","end":"(a+)+$","name":"meta.risky"},{"match":"[a-z]+","name":"word.clean"}]}"#,
        Some("lifecycle.json"),
    )
    .expect("grammar");
    highlighter
        .register_language(LanguageRegistration::new("lifecycle", grammar))
        .expect("grammar registration");
    highlighter
        .register_theme(parse_theme_data("light", "{}").expect("light theme"))
        .expect("light theme registration");
    highlighter
        .register_theme(parse_theme_data("dark", "{}").expect("dark theme"))
        .expect("dark theme registration");

    highlighter
        .highlight("BEGIN", "lifecycle", "light")
        .expect("initial risky highlight");
    assert_eq!(
        highlighter
            .backtracking_warnings("lifecycle")
            .unwrap()
            .expect("registered language")
            .len(),
        1
    );

    let unrelated = parse_raw_grammar(
        r#"{"scopeName":"source.unrelated","patterns":[{"match":"x","name":"word"}]}"#,
        Some("unrelated.json"),
    )
    .expect("unrelated grammar");
    highlighter
        .register_language(LanguageRegistration::new("unrelated", unrelated))
        .expect("unrelated grammar registration");
    assert_eq!(
        highlighter.backtracking_warnings("lifecycle").unwrap(),
        Some(vec![])
    );
    highlighter
        .highlight("ordinary", "lifecycle", "light")
        .expect("clean highlight after grammar invalidation");
    assert_eq!(
        highlighter.backtracking_warnings("lifecycle").unwrap(),
        Some(vec![])
    );
    highlighter
        .highlight("BEGIN", "lifecycle", "light")
        .expect("rediscover after grammar invalidation");
    assert_eq!(
        highlighter
            .backtracking_warnings("lifecycle")
            .unwrap()
            .expect("registered language")
            .len(),
        1
    );

    highlighter
        .highlight("ordinary", "lifecycle", "dark")
        .expect("clean highlight after theme activation");
    assert_eq!(
        highlighter.backtracking_warnings("lifecycle").unwrap(),
        Some(vec![])
    );
    highlighter
        .highlight("BEGIN", "lifecycle", "dark")
        .expect("rediscover after theme activation");
    assert_eq!(
        highlighter
            .backtracking_warnings("lifecycle")
            .unwrap()
            .expect("registered language")
            .len(),
        1
    );
}

#[test]
fn dynamic_end_backreferences_report_resolved_risk_and_authored_pattern() {
    let mut highlighter = Highlighter::builder().build().expect("highlighter");
    let grammar = parse_raw_grammar(
        r#"{
            "scopeName":"source.dynamic",
            "patterns":[
                {
                    "begin":"BEGIN (.)",
                    "end":"(\\1|a)+Z",
                    "name":"meta.dynamic-risky",
                    "$vscodeTextmateLocation":{"filename":"dynamic.json","line":8,"char":2}
                },
                {
                    "begin":"CLEAN (.)",
                    "end":"(\\1|a)+Z",
                    "name":"meta.dynamic-clean"
                }
            ]
        }"#,
        Some("dynamic.json"),
    )
    .expect("grammar");
    highlighter
        .register_language(LanguageRegistration::new("dynamic", grammar))
        .expect("grammar registration");
    highlighter
        .register_theme(parse_theme_data("dynamic-theme", "{}").expect("theme"))
        .expect("theme registration");

    highlighter
        .highlight("BEGIN a", "dynamic", "dynamic-theme")
        .expect("overlapping captured end pattern");
    let warnings = highlighter
        .backtracking_warnings("dynamic")
        .unwrap()
        .expect("registered language");
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].grammar_scope_name, "source.dynamic");
    assert_eq!(warnings[0].rule, "meta.dynamic-risky");
    assert_eq!(
        warnings[0].rule_location.as_deref(),
        Some("dynamic.json:8:2")
    );
    assert_eq!(warnings[0].pattern, r"(\1|a)+Z");
    assert_eq!(warnings[0].risk, BacktrackingRisk::OverlappingAlternation);

    highlighter
        .highlight("CLEAN b", "dynamic", "dynamic-theme")
        .expect("non-overlapping captured end pattern");
    assert_eq!(
        highlighter.backtracking_warnings("dynamic").unwrap(),
        Some(warnings)
    );
}

#[test]
fn multi_theme_api_reuses_standard_assets_and_typed_errors() {
    let mut highlighter = Highlighter::builder()
        .with_assets(assets())
        .build()
        .expect("highlighter");
    let themes = [("light", "github-light-default"), ("dark", "nord")];
    for _ in 0..2 {
        let result = highlighter
            .highlight_with_themes("let value = \"😀\";\n", "rs", &themes)
            .expect("standard assets and alias");
        assert_eq!(result.themes[1].name, "nord");
        assert_eq!(result.tokens.len(), 2);
    }
    assert_eq!(
        highlighter
            .highlight_with_themes("code", "unknown", &themes)
            .unwrap_err()
            .kind(),
        ErrorKind::UnknownLanguage
    );
    assert_eq!(
        highlighter
            .highlight_with_themes("code", "rust", &[("light", "nord"), ("dark", "unknown")])
            .unwrap_err()
            .kind(),
        ErrorKind::UnknownTheme
    );
    for invalid in [
        &[][..],
        &[("", "nord")][..],
        &[("light", "nord"), ("light", "nord")][..],
    ] {
        assert_eq!(
            highlighter
                .highlight_with_themes("code", "rust", invalid)
                .unwrap_err()
                .kind(),
            ErrorKind::Theme
        );
    }

    let missing = StandardAssetCatalogs::from_embedded(
        include_bytes!("../assets/shiki/languages/manifest.fkindex"),
        [],
        include_bytes!("../assets/shiki/themes/manifest.fkindex"),
        [],
    )
    .expect("catalogs without payloads");
    let mut offline = Highlighter::builder()
        .with_assets(missing)
        .build()
        .expect("offline highlighter");
    assert_eq!(
        offline
            .highlight_with_themes("code", "rust", &themes)
            .unwrap_err()
            .kind(),
        ErrorKind::AssetIo
    );
}

#[test]
fn catalogs_are_sendable_and_enumerate_without_binary_types() {
    fn assert_send<T: Send>() {}
    assert_send::<StandardAssetCatalogs>();
    let catalogs = assets();
    assert!(catalogs.language_ids().any(|id| id == "rust"));
    assert!(catalogs.theme_ids().any(|id| id == "nord"));
    assert_eq!(catalogs.resolve_language("rs"), Some("rust"));
}

#[test]
fn reusable_rust_api_exposes_byte_offsets_and_balanced_line_html() {
    let mut highlighter = Highlighter::builder()
        .with_assets(assets())
        .load_languages(["rust"])
        .load_themes(["nord"])
        .build()
        .expect("highlighter");

    let code = "😀\nlet value = \"<tag>&\";\n";
    let highlighted = highlighter.highlight(code, "rust", "nord").expect("tokens");
    assert_eq!(highlighted.tokens.len(), 3);
    assert_eq!(highlighted.tokens[1][0].offset, "😀\n".len());
    let lines = render_html_lines(&highlighted, &RenderOptions::default());
    assert_eq!(lines.len(), 3);
    assert!(lines[1].contains("&#x3C;tag>&#x26;"), "{}", lines[1]);
    assert!(!lines[1].contains("<tag>"));
    assert!(!lines[1].contains("<code>"));
    assert_eq!(lines[2], "");

    let second = highlighter
        .highlight("fn main() {}", "rust", "nord")
        .expect("reuse");
    assert!(render_html(&second, &RenderOptions::default()).contains("<pre"));
    let direct = highlighter
        .highlight_html_lines(code, "rust", "nord", &RenderOptions::default())
        .expect("direct line HTML");
    assert_eq!(direct.lines, lines);
    assert_eq!(direct.foreground, highlighted.foreground);
    assert_eq!(direct.background, highlighted.background);
    assert_eq!(direct.theme_name, "nord");
}

#[test]
fn unknown_names_have_typed_errors_for_fallback() {
    let mut highlighter = Highlighter::builder()
        .with_assets(assets())
        .build()
        .expect("highlighter");
    let language = highlighter
        .highlight("code", "not-a-language", "nord")
        .expect_err("unknown language");
    assert_eq!(language.kind(), ErrorKind::UnknownLanguage);
    let theme = highlighter
        .highlight("code", "rust", "not-a-theme")
        .expect_err("unknown theme");
    assert_eq!(theme.kind(), ErrorKind::UnknownTheme);
}

#[test]
fn custom_rust_registrations_work_without_standard_assets() {
    let mut highlighter = Highlighter::builder().build().expect("empty highlighter");
    let grammar = parse_raw_grammar(
        r#"{"scopeName":"source.sample","patterns":[{"match":"foo","name":"keyword.sample"}]}"#,
        Some("sample.json"),
    )
    .expect("grammar");
    highlighter
        .register_language(
            LanguageRegistration::new("sample", grammar).with_aliases(["smp".to_owned()]),
        )
        .expect("language registration");
    let theme = parse_theme_data(
        "sample-theme",
        r##"{"name":"sample-theme","tokenColors":[{"scope":"keyword.sample","settings":{"foreground":"#ff0000"}}]}"##,
    )
    .expect("theme");
    highlighter
        .register_theme(theme)
        .expect("theme registration");

    let result = highlighter
        .highlight("foo", "smp", "sample-theme")
        .expect("highlight alias");
    assert_eq!(result.tokens[0][0].content, "foo");

    let empty_theme = parse_theme_data("", "{}").expect("theme data");
    let error = highlighter
        .register_theme(empty_theme)
        .expect_err("empty theme name");
    assert_eq!(error.kind(), ErrorKind::InvalidRegistration);
}

#[test]
fn class_output_reuses_theme_context_through_the_public_rust_api() {
    let mut highlighter = Highlighter::builder()
        .with_assets(assets())
        .build()
        .expect("highlighter");
    let output = highlighter
        .highlight_html_with_css(
            "\"hello😀\"\n{\"message\":\"hello😀\"}",
            "json",
            "monokai",
            &RenderOptions::default(),
        )
        .expect("class output");
    assert!(output.html.starts_with("<pre class=\"ferriki monokai"));
    assert!(!output.html.contains(" style="));
    assert!(output.html.contains("scope-meta-structure-dictionary-json"));
    assert!(output.html.contains("leaf-string-quoted-double-json"));
    assert_eq!(output.html.matches("hello😀").count(), 2);
    assert!(output.css.contains("#E6DB74"));
    assert!(output.css.contains("#CFCFC2"));
}
