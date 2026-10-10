//! Reusable, synchronous Ferriki highlighter for Rust applications.
//!
//! The library has no Node.js or N-API dependency. Asset catalogs are loaded
//! explicitly and cached for reuse across code blocks and documents.

mod asset_catalog;
mod asset_settings;
mod asset_source;
mod decorations;
mod error;
mod highlighter;
mod node_assets;
#[cfg(all(feature = "remote", not(target_arch = "wasm32")))]
mod remote;
mod render;
mod theme_data;
mod tokens;

pub use asset_catalog::StandardAssetCatalogs;
pub use asset_source::{
    AssetDigest, AssetMetadata, AssetSource, DirectoryAssetSource, EmbeddedAssetSource,
};
pub use error::{Error, ErrorKind, Result};
pub use ferriki_asset_gen::{ReleaseAsset, ReleaseManifest};
pub use ferriki_textmate::{
    BacktrackingRisk, BacktrackingWarning, FontStyle, ParseRawGrammarError, RawGrammar, RawTheme,
    RawThemeScope, RawThemeSetting, RawThemeStyle, StandardTokenType, parse_raw_grammar,
};
/// Implementation bridge for Ferriki's N-API host, exempt from semver guarantees.
#[doc(hidden)]
pub mod __private {
    pub use crate::decorations::{
        DecorationCursor, DecorationMutation, DecorationNode, DecorationPlan, DecorationPosition,
        DecorationRange, DecorationSection, DecorationSlice, DecorationSource, DecorationTarget,
        DecorationToken, ResolvedDecoration, ResolvedPosition, decoration_sections,
        next_decoration_section, plan_decoration_mutations, split_decoration_tokens,
    };
    pub use crate::highlighter::HighlighterCore;
    pub use crate::node_assets::{NodeAssetHost, NodeAssetOptions, PlannedAsset};
    #[cfg(all(feature = "remote", not(target_arch = "wasm32")))]
    pub use crate::remote::RemoteAssetHost;
    pub use crate::tokens::{
        HighlightThemeMetadata, HighlightThemeToken, HighlightThemeTokenStyle,
        HighlightTokensWithThemesResult,
    };
}
pub use highlighter::{HighlightedLines, Highlighter, HighlighterBuilder, LanguageRegistration};
#[cfg(all(feature = "remote", not(target_arch = "wasm32")))]
pub use remote::{DEFAULT_ASSETS_BASE_URL, RemoteAssets};
pub use render::{
    HtmlWithCss, RenderOptions, StyleMode, render_hast, render_html, render_html_lines,
    render_html_with_css,
};
pub use theme_data::{ThemeData, parse_theme_data};
pub use tokens::{
    HighlightThemeMetadata, HighlightThemeToken, HighlightThemeTokenStyle, HighlightToken,
    HighlightTokensResult, HighlightTokensWithThemesResult, TokenizeOptions,
};
