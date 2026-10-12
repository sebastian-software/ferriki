//! Boundary profiler, compiled only with `--features profiling` (#225). It
//! times the phases of one token call separately and counts Rust heap
//! allocations; `node/scripts/profile-native-boundary.mjs` drives it. Release
//! addons never contain this module or its counting allocator.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;

use napi::bindgen_prelude::ToNapiValue;
use napi::{Env, Result, check_status, sys};
use napi_derive::napi;

use crate::FerrikiHighlighter;
use crate::native_types::*;

struct Counting;

static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

// SAFETY: Every call forwards unchanged to the system allocator.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, block: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count(size);
        unsafe { System.realloc(block, layout, size) }
    }

    unsafe fn dealloc(&self, block: *mut u8, layout: Layout) {
        unsafe { System.dealloc(block, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn count(size: usize) {
    ALLOCATIONS.fetch_add(1, Relaxed);
    BYTES.fetch_add(size as u64, Relaxed);
}

/// Wall time and Rust heap allocations of one phase.
#[napi(object, object_from_js = false)]
pub struct BoundaryPhase {
    pub ms: f64,
    pub allocations: f64,
    pub bytes: f64,
}

#[napi(object, object_from_js = false)]
pub struct BoundaryProfile {
    /// Grammar and theme work in `HighlighterCore`.
    pub tokenize: BoundaryPhase,
    /// Moving the Rust result into the private boundary types.
    pub dto: BoundaryPhase,
    /// Creating the JavaScript result, excluding its later garbage collection.
    pub convert: BoundaryPhase,
    pub lines: u32,
    pub tokens: u32,
}

fn phase<T>(run: impl FnOnce() -> Result<T>) -> Result<(T, BoundaryPhase)> {
    let allocations = ALLOCATIONS.load(Relaxed);
    let bytes = BYTES.load(Relaxed);
    let started = Instant::now();
    let value = run()?;
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok((
        value,
        BoundaryPhase {
            ms,
            allocations: (ALLOCATIONS.load(Relaxed) - allocations) as f64,
            bytes: (BYTES.load(Relaxed) - bytes) as f64,
        },
    ))
}

/// Converts inside a temporary handle scope, so repeated profiling calls do
/// not keep every result alive until the callback returns.
fn convert<T: ToNapiValue>(env: &Env, value: T) -> Result<BoundaryPhase> {
    let env = env.raw();
    let mut scope = ptr::null_mut();
    check_status!(unsafe { sys::napi_open_handle_scope(env, &mut scope) })?;
    let result = phase(|| unsafe { T::to_napi_value(env, value) });
    check_status!(unsafe { sys::napi_close_handle_scope(env, scope) })?;
    Ok(result?.1)
}

enum Converted {
    Single(HtmlRenderData),
    Multi(HtmlRenderDataWithThemes),
}

/// The Rust-side phases of one call, before any JavaScript value exists.
struct RustPhases {
    data: Converted,
    tokenize: BoundaryPhase,
    dto: BoundaryPhase,
    lines: u32,
    tokens: u32,
}

fn counts<T>(lines: &[Vec<T>]) -> (u32, u32) {
    (
        lines.len() as u32,
        lines.iter().map(Vec::len).sum::<usize>() as u32,
    )
}

impl FerrikiHighlighter {
    fn rust_phases(&self, code: &str, options: NativeTokenOptions) -> Result<RustPhases> {
        if options.theme_entries.is_some() {
            let (result, tokenize) = phase(|| self.tokenize_with_themes(code, options))?;
            let (data, dto) = phase(|| Ok(HtmlRenderDataWithThemes::from(result)))?;
            let (lines, tokens) = counts(&data.tokens);
            return Ok(RustPhases {
                data: Converted::Multi(data),
                tokenize,
                dto,
                lines,
                tokens,
            });
        }
        let (result, tokenize) = phase(|| self.tokenize(code, options))?;
        let (data, dto) = phase(|| Ok(HtmlRenderData::from(result)))?;
        let (lines, tokens) = counts(&data.tokens);
        Ok(RustPhases {
            data: Converted::Single(data),
            tokenize,
            dto,
            lines,
            tokens,
        })
    }
}

#[napi]
impl FerrikiHighlighter {
    /// Runs one `getHtmlRenderData` call, or `getHtmlRenderDataWithThemes`
    /// when `themeEntries` is present, and reports each phase.
    #[napi(js_name = "profileTokenBoundary")]
    pub fn profile_token_boundary(
        &self,
        env: Env,
        code: String,
        options: NativeTokenOptions,
    ) -> Result<BoundaryProfile> {
        let phases = self.rust_phases(&code, options)?;
        let convert = match phases.data {
            Converted::Single(data) => convert(&env, data)?,
            Converted::Multi(data) => convert(&env, data)?,
        };
        Ok(BoundaryProfile {
            tokenize: phases.tokenize,
            dto: phases.dto,
            convert,
            lines: phases.lines,
            tokens: phases.tokens,
        })
    }
}

/// Diagnostic phases for the private decoration bridge. Input conversion is
/// measured explicitly; JS arena creation and replay remain host-side work.
#[napi(object, object_from_js = false)]
pub struct DecorationBoundaryProfile {
    pub input: BoundaryPhase,
    pub policy: BoundaryPhase,
    pub output: BoundaryPhase,
}

#[napi(object)]
pub(crate) struct DecorationSplitInput {
    pub source: String,
    pub ranges: Vec<crate::decorations::NativeDecorationRange>,
    pub lines: Vec<napi::bindgen_prelude::Float64Array>,
}

#[napi(object)]
pub(crate) struct DecorationRangeInput {
    pub source: String,
    pub ranges: Vec<crate::decorations::NativeDecorationRange>,
}

#[napi(object)]
pub(crate) struct DecorationPlanInput {
    pub nodes: napi::bindgen_prelude::Float64Array,
    pub lines: Vec<u32>,
    pub sections: Vec<crate::decorations::NativeDecorationSection>,
}

#[napi(object)]
pub(crate) struct DecorationNextInput {
    pub range: crate::decorations::NativeResolvedDecoration,
    pub decoration: u32,
    pub always_wrap: bool,
    pub cursor: crate::decorations::NativeDecorationCursor,
}

#[napi(js_name = "profileDecorationBoundary")]
pub fn profile_decoration_boundary(
    env: Env,
    operation: String,
    value: napi::Unknown<'_>,
) -> Result<DecorationBoundaryProfile> {
    if value.get_type()? != napi::ValueType::Object {
        return Err(napi::Error::new(
            napi::Status::InvalidArg,
            "Expected a decoration input object",
        ));
    }
    // SAFETY: The value is an object in the current callback's environment.
    // The generated FromNapiValue implementations validate its typed fields.
    let (input, policy, output) = match operation.as_str() {
        "split" => {
            let (input, input_phase) = phase(|| unsafe { value.cast::<DecorationSplitInput>() })?;
            let (result, policy) = phase(|| {
                crate::decorations::split_decoration_tokens(input.source, input.ranges, input.lines)
            })?;
            (input_phase, policy, convert(&env, result)?)
        }
        "prepare" => {
            let (input, input_phase) = phase(|| unsafe { value.cast::<DecorationRangeInput>() })?;
            let (result, policy) =
                phase(|| crate::decorations::decoration_sections(input.source, input.ranges))?;
            (input_phase, policy, convert(&env, result)?)
        }
        "next" => {
            let (input, input_phase) = phase(|| unsafe { value.cast::<DecorationNextInput>() })?;
            let (result, policy) = phase(|| {
                crate::decorations::next_decoration_section(
                    input.range,
                    input.decoration,
                    input.always_wrap,
                    input.cursor,
                )
            })?;
            (input_phase, policy, convert(&env, result)?)
        }
        "plan" => {
            let (input, input_phase) = phase(|| unsafe { value.cast::<DecorationPlanInput>() })?;
            let (result, policy) = phase(|| {
                crate::decorations::plan_decoration_mutations(
                    input.nodes,
                    input.lines,
                    input.sections,
                )
            })?;
            (input_phase, policy, convert(&env, result)?)
        }
        _ => {
            return Err(napi::Error::new(
                napi::Status::InvalidArg,
                "Unknown decoration profiling operation",
            ));
        }
    };
    Ok(DecorationBoundaryProfile {
        input,
        policy,
        output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_count_rust_allocations() {
        let (value, measured) = phase(|| Ok(vec![0_u8; 64])).expect("phase");
        assert_eq!(value.len(), 64);
        assert!(measured.allocations >= 1.0);
        assert!(measured.bytes >= 64.0);
        assert!(measured.ms >= 0.0);
    }

    #[test]
    fn rust_phases_cover_single_and_multi_theme_calls() {
        let highlighter = crate::napi_api::tests::standard_highlighter();
        let mut options = NativeTokenOptions {
            lang: "javascript".into(),
            theme: "nord".into(),
            tokenize_time_limit: Some(0.0),
            ..Default::default()
        };
        let single = highlighter
            .rust_phases("const x = 1\nlet y", options.clone())
            .expect("single");
        assert!(matches!(single.data, Converted::Single(_)));
        assert_eq!(single.lines, 2);
        assert!(single.tokens >= 4);
        assert!(single.tokenize.allocations > 0.0);
        options.theme_entries = Some(vec![
            ThemeEntry {
                color: "dark".into(),
                name: "nord".into(),
            },
            ThemeEntry {
                color: "light".into(),
                name: "github-light".into(),
            },
        ]);
        let multi = highlighter
            .rust_phases("const x = 1", options)
            .expect("multi");
        assert!(matches!(multi.data, Converted::Multi(_)));
        assert_eq!(multi.lines, 1);
        assert!(multi.dto.allocations > 0.0);
    }
}
