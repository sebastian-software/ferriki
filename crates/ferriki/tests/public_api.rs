use std::path::Path;

use ferriki::{
    ErrorKind, Highlighter, LanguageRegistration, RenderOptions, StandardAssetCatalogs,
    parse_raw_grammar, parse_theme_data, render_html, render_html_lines,
};

fn assets() -> StandardAssetCatalogs {
    StandardAssetCatalogs::load_from_root(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../assets/shiki"
    )))
    .expect("fixture assets")
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
        .register_language(LanguageRegistration {
            id: "sample".to_owned(),
            grammar,
            aliases: vec!["smp".to_owned()],
            inject_to: Vec::new(),
        })
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
