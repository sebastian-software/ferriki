//! N-API host for the pure Rust `ferriki` runtime.

mod napi_api;

use napi_derive::napi;

pub use ferriki::{
    HighlightTokensResult, RenderOptions, TokenizeOptions, render_hast, render_html,
};
pub use napi_api::{FerrikiHighlighter, create_highlighter};

#[napi(js_name = "ferrikiVersion")]
pub fn ferriki_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub use ferriki::__private::HighlighterCore;
