//! Run with `cargo run -p ferriki --example rust_consumer -- assets/shiki`.

use std::path::Path;

use ferriki::{Highlighter, RenderOptions, StandardAssetCatalogs, render_html_lines};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let asset_root = std::env::args().nth(1).ok_or("pass a Ferriki asset root")?;
    let assets = StandardAssetCatalogs::load_from_root(Path::new(&asset_root))?;
    let mut highlighter = Highlighter::builder()
        .with_assets(assets)
        .load_languages(["rust"])
        .load_themes(["nord"])
        .build()?;

    let result = highlighter.highlight("fn main() { println!(\"Hi\"); }", "rust", "nord")?;
    for line in render_html_lines(&result, &RenderOptions::default()) {
        println!("{line}");
    }
    Ok(())
}
