//! Reusable, synchronous Ferriki highlighter for Rust applications.
//!
//! The library has no Node.js or N-API dependency. Asset catalogs are loaded
//! explicitly and cached for reuse across code blocks and documents.

mod asset_catalog;
mod error;
mod highlighter;
mod render;
mod theme_data;
mod tokens;

pub use asset_catalog::{LanguageAssetCatalog, StandardAssetCatalogs, ThemeAssetCatalog};
pub use error::{Error, ErrorKind, Result};
pub use ferriki_textmate::{
    RawGrammar, RawTheme, RawThemeSetting, RawThemeStyle, parse_raw_grammar,
};
pub use highlighter::{Highlighter, HighlighterBuilder, HighlighterCore, LanguageRegistration};
pub use render::{RenderOptions, render_hast, render_html, render_html_lines};
pub use theme_data::{ThemeData, parse_theme_data};
pub use tokens::{
    HighlightThemeMetadata, HighlightThemeToken, HighlightThemeTokenStyle, HighlightToken,
    HighlightTokensResult, HighlightTokensWithThemesResult, TokenizeOptions,
};
