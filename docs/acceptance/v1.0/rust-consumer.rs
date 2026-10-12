use ferriki::{Highlighter, RenderOptions, StandardAssetCatalogs, render_html, render_html_lines};

#[cfg(feature = "remote")]
use ferriki::RemoteAssets;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Refer to the other two public crates as a consumer, not just as transitive deps.
    assert!(ferriki_asset_gen::FORMAT_VERSION > 0);
    let _ = ferriki_textmate::FontStyle::NOT_SET;

    let assets = if cfg!(feature = "remote") {
        remote_assets()?
    } else {
        let root = std::env::args()
            .nth(1)
            .ok_or("pass the assets/shiki directory")?;
        StandardAssetCatalogs::load_from_root(std::path::Path::new(&root))?
    };
    let mut highlighter = Highlighter::builder()
        .with_assets(assets)
        .load_languages(["rust"])
        .load_themes(["nord", "github-light-default"])
        .build()?;

    let code = "let emoji = \"😀\";\nlet comparison = 1 < 2;\n";
    let expected = ["let emoji = \"😀\";", "let comparison = 1 < 2;", ""];
    let starts = [0, expected[0].len() + 1, code.len()];
    let result = highlighter.highlight(code, "rust", "nord")?;
    assert_eq!(result.tokens.len(), expected.len());
    for (line, (wanted, start)) in result.tokens.iter().zip(expected.iter().zip(starts)) {
        assert_eq!(
            line.iter()
                .map(|token| token.content.as_str())
                .collect::<String>(),
            *wanted
        );
        let mut byte = start;
        for token in line {
            assert_eq!(token.offset, byte, "Rust API offsets are UTF-8 bytes");
            byte += token.content.len();
        }
        assert_eq!(byte, start + wanted.len());
    }

    let options = RenderOptions::default();
    let lines = render_html_lines(&result, &options);
    assert_eq!(lines.len(), expected.len());
    assert!(lines[0].contains("😀"));
    assert!(lines[1].contains("&#x3C;"), "{lines:?}");
    assert!(!lines[1].contains(" < "));
    let html = render_html(&result, &options);
    assert!(html.contains("<pre") && html.contains("<code"));
    let direct = highlighter.highlight_html_lines(code, "rust", "nord", &options)?;
    assert_eq!(direct.lines, lines);
    assert_eq!(direct.theme_name, "nord");

    let themed = highlighter.highlight_with_themes(
        code,
        "rust",
        &[("light", "github-light-default"), ("dark", "nord")],
    )?;
    assert_eq!(themed.tokens.len(), expected.len());
    for (line, (wanted, start)) in themed.tokens.iter().zip(expected.iter().zip(starts)) {
        assert_eq!(
            line.iter()
                .map(|token| token.content.as_str())
                .collect::<String>(),
            *wanted
        );
        let mut byte = start;
        for token in line {
            assert_eq!(token.offset, byte);
            assert!(token.variants.contains_key("light"));
            assert!(token.variants.contains_key("dark"));
            byte += token.content.len();
        }
        assert_eq!(byte, start + wanted.len());
    }
    assert_eq!(themed.themes[0].name, "github-light-default");
    assert_eq!(themed.themes[1].name, "nord");

    let plain = highlighter.highlight("hi 😀 <&", "text", "nord")?;
    assert_eq!(
        plain.tokens[0]
            .iter()
            .map(|t| t.content.as_str())
            .collect::<String>(),
        "hi 😀 <&"
    );
    assert!(render_html_lines(&plain, &options)[0].contains("&#x3C;&#x26;"));

    println!("PASS: unicode UTF-8 offsets, text, Rust tokens, escaped HTML, two themes");
    Ok(())
}

#[cfg(feature = "remote")]
fn remote_assets() -> Result<StandardAssetCatalogs, Box<dyn std::error::Error>> {
    let commit = std::env::var("FERRIKI_TEST_COMMIT").ok();
    Ok(StandardAssetCatalogs::remote(
        RemoteAssets::default().with_commit(commit),
    )?)
}

#[cfg(not(feature = "remote"))]
fn remote_assets() -> Result<StandardAssetCatalogs, Box<dyn std::error::Error>> {
    unreachable!("remote assets are only used when the remote feature is enabled")
}
