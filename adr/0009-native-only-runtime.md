# ADR 0009: Native-Only Runtime — JS Is A Facade, WASM Is The Future Fallback

## Status

Accepted

## Context

Ferriki started from a Shiki-shaped workbench so the upstream test suite
stayed runnable 1:1 while behavior was ported selectively. That transition
left two artifacts in the published package that contradict the Rust-first
goal of ADR 0001:

- the full vendored Shiki JS engine still ships (the bundled entry plus
  ~300 chunk files of JS grammars/themes), reachable via
  `FERRIKI_BACKEND=js` and used as the fallback on platforms without a
  native binary
- the native path is wired through a parity adapter that first constructs
  the complete JS highlighter and then delegates to the Rust core — the
  Rust engine currently hangs off the JS scaffolding, not the other way
  around

With multi-platform prebuilds (linux-x64/arm64, darwin-x64/arm64,
win32-x64) shipping through the release pipeline, and with the Rust stack
(including Ferroni) able to target `wasm32`, the JS engine no longer has a
justification as a product component.

## Decision

Ferriki is a native-only runtime. This describes the target state the
cut-over release ships; until then the deprecated JS engine remains in
the package solely as the fallback for platforms without a binary.

- Target state: the published package executes highlighting exclusively
  in the Rust core. JavaScript remains only as a thin facade: addon
  loading, public API wiring, hast-level transformation (transformers and
  decorations per ADR 0008), and the type surface.
- The bundled JS engine is deprecated as of this decision and will be
  removed once the multi-platform binaries have shipped in a published
  release. `FERRIKI_BACKEND=js` is deprecated with it and will be removed
  in the same step.
- Platforms without a native binary fail with a clear, actionable error.
  The intended answer for environments the prebuild matrix cannot reach —
  including browsers — is a future `wasm32` build of the Rust core, not a
  JS reimplementation.
- The strict upstream mirror under `node/compat/upstream` is unaffected:
  it is a development-only test oracle, never shipped, and remains the
  measure of Shiki compatibility.

## Consequences

- Issue #10 is reframed: the Node layer's missing TypeScript source is
  not recovered from the historical bundle — the facade the end state
  needs is written fresh, validated against the mirrored compat suites.
- The parity adapter inverts: `createHighlighter` and the shorthand
  functions call the native binding directly; any operation the Rust core
  cannot serve is a gap to close in `crates/ferriki-core`, not a reason to
  run JS.
- The legacy JS bundle assets (issue #11) and the JS engine paths are
  removed in the cut-over release, with a CI guard that keeps removed
  runtime paths from returning.
- Removing the fallback is a breaking change for platforms outside the
  prebuild matrix and is shipped as a deliberate minor release while
  Ferriki is pre-1.0.
- Per-platform sidecar packages become practical once the tarball no
  longer needs the JS engine as a universality guarantee.
