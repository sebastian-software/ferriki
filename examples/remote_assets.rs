//! Highlights a snippet with payloads from the release-pinned CDN.
//!
//! ```sh
//! cargo run --example remote_assets --features remote -- <release-commit>
//! ```
//!
//! A published crate knows its release commit; a build from a checkout passes
//! one explicitly. `FERRIKI_ASSETS_BASE_URL`, `FERRIKI_CACHE_DIR` and
//! `FERRIKI_ASSETS_REMOTE` apply as documented on `RemoteAssets`.

use ferriki::{Highlighter, RemoteAssets, RenderOptions, StandardAssetCatalogs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let settings = RemoteAssets::default().with_commit(std::env::args().nth(1));
    let mut highlighter = Highlighter::builder()
        .with_assets(StandardAssetCatalogs::remote(settings)?)
        .load_languages(["rust"])
        .load_themes(["nord"])
        .build()?;
    let highlighted = highlighter.highlight_html_lines(
        "fn main() {}",
        "rust",
        "nord",
        &RenderOptions::default(),
    )?;
    println!("{}", highlighted.lines.join("\n"));
    Ok(())
}
