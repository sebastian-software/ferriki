//! Highlights a snippet with payloads from the release-pinned CDN.
//!
//! ```sh
//! cargo run --example remote_assets --features remote
//! ```
//!
//! The embedded `language-hash-v2` catalog always addresses payloads by content
//! hash (`<id>/<short-hash>` and `themes/<id>/<short-hash>`) regardless of
//! mirror URL, so no commit argument is needed for either published crates or
//! repository checkouts (commit-based paths on `assets.ferriki.dev` were
//! retired). `FERRIKI_ASSETS_BASE_URL`, `FERRIKI_CACHE_DIR` and
//! `FERRIKI_ASSETS_REMOTE` apply as documented on `RemoteAssets`.
//! `RemoteAssets::with_commit` takes effect only when a catalog manifest itself
//! uses legacy commit-routed storage.

use ferriki::{Highlighter, RemoteAssets, RenderOptions, StandardAssetCatalogs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let settings = RemoteAssets::default();
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
