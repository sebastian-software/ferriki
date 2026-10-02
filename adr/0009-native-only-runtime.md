# ADR 0009: Native-Only Runtime — JS Is A Facade, WASM Is The Future Fallback

## Status

Accepted

Last updated: 2026-10-02

## Context

Ferriki started from a Shiki-shaped workbench so the upstream test suite
stayed runnable 1:1 while behavior was ported selectively. That transition
had left two artifacts in the published package that contradicted the
Rust-first goal of ADR 0001:

- the full vendored Shiki JS engine shipped (the bundled entry plus
  ~300 chunk files of JS grammars/themes), reachable via
  `FERRIKI_BACKEND=js` and used as the fallback on platforms without a
  native binary
- the native path was wired through a parity adapter that first constructed
  the complete JS highlighter and then delegates to the Rust core — the
  Rust engine hung off the JS scaffolding, not the other way
  around

With multi-platform prebuilds shipping through the release pipeline, and
with the Rust stack (including Ferroni) able to target `wasm32`, the JS engine
no longer had a justification as a product component.

## Decision

Ferriki is a native-only runtime. The published package executes highlighting
exclusively in the Rust core.

- JavaScript remains a thin host: addon loading, public API wiring, standard
  asset transport through Node's built-in `fetch` (ADR 0013), hast-level
  transformation (transformers and decorations per ADR 0008), the catalog
  projection, and the type surface.
- The bundled JS engine and `FERRIKI_BACKEND=js` are removed. The
  native-boundary check in the core gate forbids the removed runtime paths from
  returning.
- The strict upstream mirror under `node/compat/upstream` is unaffected: it is
  a development-only test oracle, never shipped, and remains the measure of
  Shiki compatibility.

### Distribution

- `@ferriki/core` contains the facade, types and catalog metadata and no native
  addon. Each supported target gets a `@ferriki/<platform>` sidecar package,
  declared as an optional dependency with the same version, so a package
  manager installs only the host's addon.
- The supported targets, including the libc for Linux, are listed in
  `node/ferriki/platforms.mjs`, which the release matrix and the packed
  consumer checks read. glibc and musl Linux are separate targets, because a
  musl host cannot load a glibc addon. Targets without a hosted CI runner, such
  as macOS on Intel, are not shipped.
- A platform without a binary fails at import with an actionable error naming
  the platform, architecture and libc. The intended answer for environments
  the prebuild matrix cannot reach, including browsers, is a future `wasm32`
  build of the Rust core, not a JS reimplementation.
- The binding loader is internal. Consumers import `@ferriki/core` only.

## Consequences

- Any operation the Rust core cannot serve is a gap to close in the Rust
  crates, not a reason to run JavaScript.
- Adding a target means a sidecar package, a release matrix entry and a row in
  `platforms.mjs`; removing one is a breaking change.
- Environments outside the matrix, and browsers, have no supported runtime
  until a `wasm32` build exists.

## History

- 2026-07-26: Accepted. The JS engine, its bundle assets, `FERRIKI_BACKEND`
  and the fork-era tokenizer were torn down the same day; 0.3.0 was the first
  release without them.
- 2026-09-30: Rewritten to the current state. Records the `@ferriki` scope and
  sidecars (0.4.0), musl and Windows arm64 targets, the dropped macOS Intel
  target and the internal loader.
- 2026-10-02: Records Node's built-in fetch as the standard-asset transport;
  Rust continues to plan and verify release-pinned assets.
