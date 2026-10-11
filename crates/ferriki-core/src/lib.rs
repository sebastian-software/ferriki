//! N-API host for the pure Rust `ferriki` runtime.

mod decorations;
mod js_objects;
mod napi_api;
pub mod native_types;
#[cfg(feature = "profiling")]
mod profiling;

use napi_derive::napi;

pub use decorations::{
    NativeDecorationContinuation, NativeDecorationCursor, NativeDecorationMutation,
    NativeDecorationPlan, NativeDecorationPosition, NativeDecorationPreparation,
    NativeDecorationRange, NativeDecorationSection, NativeResolvedDecoration, decoration_sections,
    next_decoration_section, plan_decoration_mutations, split_decoration_tokens,
};
#[cfg(feature = "profiling")]
pub use profiling::{DecorationBoundaryProfile, profile_decoration_boundary};

pub use ferriki::{HighlightTokensResult, RenderOptions, TokenizeOptions, render_html};
pub use napi_api::{FerrikiHighlighter, create_highlighter};

#[napi(js_name = "ferrikiVersion")]
pub fn ferriki_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub use ferriki::__private::HighlighterCore;
