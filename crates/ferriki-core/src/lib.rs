// Ferriki native core — greenfield state.
//
// The pre-re-port tokenizer (grammar interpretation, theming, rendering)
// was removed per ADR 0009 and the native-only migration plan; the last
// full state is preserved in history at commit e9c01db ("legacy-js-engine").
// The tokenizer returns as a mechanical 1:1 port of vscode-textmate on
// ferroni's Scanner API (tracked in #30). What remains here is the stable
// substrate that port builds on: the binary asset catalogs and the napi
// entry point.

mod asset_catalog;
mod highlighter;
mod napi_api;
mod render;
mod theme_data;
mod tokens;

use napi_derive::napi;

pub use asset_catalog::{LanguageAssetCatalog, StandardAssetCatalogs, ThemeAssetCatalog};
pub use highlighter::HighlighterCore;
pub use napi_api::{FerrikiHighlighter, create_highlighter};
pub use render::{RenderOptions, render_hast, render_html};
pub use theme_data::{ThemeData, parse_theme_data};
pub use tokens::{
    HighlightThemeMetadata, HighlightThemeToken, HighlightThemeTokenStyle, HighlightToken,
    HighlightTokensResult, HighlightTokensWithThemesResult, TokenizeOptions,
};

#[napi(js_name = "ferrikiVersion")]
pub fn ferriki_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
