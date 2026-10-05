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
        if options.theme_entries.is_some() {
            let (result, tokenize) = phase(|| self.tokenize_with_themes(&code, options))?;
            let (data, dto) = phase(|| Ok(HtmlRenderDataWithThemes::from(result)))?;
            let lines = data.tokens.len() as u32;
            let tokens = data.tokens.iter().map(Vec::len).sum::<usize>() as u32;
            let convert = convert(&env, data)?;
            return Ok(BoundaryProfile {
                tokenize,
                dto,
                convert,
                lines,
                tokens,
            });
        }
        let (result, tokenize) = phase(|| self.tokenize(&code, options))?;
        let (data, dto) = phase(|| Ok(HtmlRenderData::from(result)))?;
        let lines = data.tokens.len() as u32;
        let tokens = data.tokens.iter().map(Vec::len).sum::<usize>() as u32;
        let convert = convert(&env, data)?;
        Ok(BoundaryProfile {
            tokenize,
            dto,
            convert,
            lines,
            tokens,
        })
    }
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
}
