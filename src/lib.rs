//! Reusable, synchronous Ferriki highlighter for Rust applications.
//!
//! The library has no Node.js or N-API dependency. Asset catalogs are loaded
//! explicitly and cached for reuse across code blocks and documents.

mod asset_catalog;
mod asset_source;
mod error;
mod highlighter;
mod render;
mod theme_data;
mod tokens;

pub use asset_catalog::StandardAssetCatalogs;
pub use asset_source::{
    AssetDigest, AssetMetadata, AssetSource, DirectoryAssetSource, EmbeddedAssetSource,
};
pub use error::{Error, ErrorKind, Result};
pub use ferriki_textmate::{
    FontStyle, ParseRawGrammarError, RawGrammar, RawTheme, RawThemeScope, RawThemeSetting,
    RawThemeStyle, StandardTokenType, parse_raw_grammar,
};
/// Implementation bridge for Ferriki's N-API host, exempt from semver guarantees.
#[doc(hidden)]
pub mod __private {
    pub use crate::highlighter::HighlighterCore;
    pub use crate::tokens::{
        HighlightThemeMetadata, HighlightThemeToken, HighlightThemeTokenStyle,
        HighlightTokensWithThemesResult,
    };
}
pub use highlighter::{HighlightedLines, Highlighter, HighlighterBuilder, LanguageRegistration};
pub use render::{RenderOptions, render_hast, render_html, render_html_lines};
pub use theme_data::{ThemeData, parse_theme_data};
pub use tokens::{HighlightToken, HighlightTokensResult, TokenizeOptions};
