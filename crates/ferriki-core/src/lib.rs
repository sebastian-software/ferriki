//! N-API host for the pure Rust `ferriki` runtime.

mod napi_api;

use napi_derive::napi;

pub use ferriki::{HighlightTokensResult, RenderOptions, TokenizeOptions, render_html};
pub use napi_api::{FerrikiHighlighter, create_highlighter, scan_inline_code_macros};

#[napi(js_name = "ferrikiVersion")]
pub fn ferriki_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub use ferriki::__private::HighlighterCore;
