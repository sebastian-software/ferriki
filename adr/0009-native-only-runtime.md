# ADR 0009: Native-Only Runtime — JS Is A Facade, WASM Is The Future Fallback

## Status

Accepted

Last updated: 2026-10-10

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
  callback dispatch and decoration edit replay for the host pipeline
  (eligible declarative calls render entirely in Rust per ADR 0008), the catalog
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
- The root highlighter entry on a platform without a binary fails at import
  with an actionable error naming
  the platform, architecture and libc. The intended answer for environments
  the prebuild matrix cannot reach, including browsers, is a future `wasm32`
  build of the Rust core, not a JS reimplementation.
- The binding loader is internal. Consumers use the documented high-level
  runtime or build-tool entries; none exposes the loader directly.
- `ferriki-core` uses NAPI-RS v3 with Node-API 8. Rust tests enable dynamic
  symbol lookup so their standalone harness can run outside Node. Highlight options,
  single- and multi-theme render data and asynchronous asset plans cross the
  boundary as typed objects. Custom grammar and theme registrations retain
  their JSON input because their open-ended schemas belong to the Rust core.
  Token results are converted by Ferriki's own writer, which defines each
  object's properties in one call with internalized keys and shares one string
  per distinct color; it measured faster than the former JSON transport
  ([`node/benchmarks/native-boundary/typed-conversion`](../node/benchmarks/native-boundary/typed-conversion/README.md)).
  The development-only `profiling` feature adds a phase profiler and a
  counting allocator; release addons never enable it.
- Native TypeScript declarations are generated from the Rust binding types
  by the NAPI-RS v3 type generator. The Ferriki-owned build, loader, platform
  registry, sidecar names and release workflow remain the source of truth;
  adopting the type generator does not adopt its package or loader conventions.

The existing seven-target matrix in
[`node/ferriki/platforms.mjs`](../node/ferriki/platforms.mjs) and the
`>=22.13.0` runtime floor in
[`node/ferriki/package.json`](../node/ferriki/package.json) are unchanged.
The crate major and the Node-API level describe different things.

The current matrix covers Linux x64 and arm64 on glibc and musl, macOS arm64,
and Windows x64 and arm64. CI builds and exercises all seven targets, and
reports each addon's size and cold `require()` time beside the latest published
sidecar without gating on them. Linux
musl builds use `cargo-zigbuild` and run their packed-consumer and native-import
checks on Alpine. Ferriki's ESM loader selects by OS, architecture and Linux
libc; for an unsupported host it prints the supported matrix, and for a
missing sidecar it suggests the package to install and includes each failed
resolution. A generated loader would need to preserve those package names and
actionable errors; no loader defect is identified. NAPI-RS uses the same broad
root-package-plus-optional-sidecars model, but adopting its `napi.targets`,
generated packages, loader and artifact conventions would need to preserve
Ferriki's current package names and ESM facade.

The NAPI-RS v3 templates cover additional targets such as macOS x64, Windows
x86, Linux ARMv7, Android, FreeBSD and WASI. Its accepted target strings are
broader than its maintained templates, and neither list is Ferriki's tested
support promise. The CLI adds cross-build helpers, but its cross-build modes
are experimental; Ferriki already builds the supported OS targets on matching
CI runners and cross-builds musl on same-architecture glibc runners. The CLI
requires Node `^20.17.0 || ^22.13.0 || >=23.5.0` at build time; this does not
raise Ferriki's `>=22.13.0` runtime floor. The v2-to-v3 migration also changes
CLI and package configuration and parts of the Rust API.

The release workflow checks the platform matrix and sidecar packages, tests
packed main and Vite consumers before publication, and verifies the npm
publication afterward. NAPI-RS's release command can warn and skip a target
whose artifact is missing, so Ferriki would still need its explicit
missing-artifact gates. The current path has no identified compatibility
defect or release-maintenance gap that justifies replacing these checks now.
See the official
[v2-to-v3 migration guide](https://napi.rs/docs/more/v2-v3-migration-guide),
[support and compatibility policy](https://napi.rs/docs/more/support-compatibility),
the [cross-build reference](https://napi.rs/docs/cli/build), and the
[release command reference](https://napi.rs/docs/cli/pre-publish).

### Build-time macro entries

The browser-safe `@ferriki/core/macro` subpath contains only a marker that
throws when it is not transformed. It imports no engine or native loader.
`@ferriki/vite` recognizes the marker at build time, and prepared HTML/CSS is
delivered to the browser; the addon contains no macro scanner. The marker
provides no browser highlighting
([ADR 0018](0018-inline-highlighting-macros.md)). The native loader remains
internal.

## Consequences

- Any operation the Rust core cannot serve is a gap to close in the Rust
  crates, not a reason to run JavaScript.
- Typed boundary results remove token and asset-plan JSON serialization and
  parsing. The private binding types preserve camelCase names, optional-field
  omission, numeric font-style bits and UTF-16 token offsets; the public Node
  and Rust contracts remain unchanged.
- Keep the existing native smoke, packed-consumer, sidecar and
  publication-verification gates required for 1.0.
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
- 2026-10-03: Deferred NAPI-RS v3 and `@napi-rs/cli` adoption because the
  current seven-target build, loader and release checks meet the 1.0 support
  contract without a demonstrated defect or maintenance gap.

- 2026-10-04: Records the inline macro build boundary and private native scanner (#211).
- 2026-10-04: Removes the native inline macro scanner and the `@ferriki/core/macro-transform` entry; macro recognition moves to `@ferriki/vite` (#216).

- 2026-10-05: Adopts NAPI-RS v3 and generated binding declarations with typed options, token results and asset plans (#217); retains the Ferriki build and loader.
- 2026-10-05: Records the optimized token-result writer, the `profiling` feature and per-target size and cold-load reporting in CI (#225).

- 2026-10-10: Records typed native decoration plans while JS retains opaque objects and callbacks (#122).

- 2026-10-10: Records the complete native declarative HTML lane without changing callback or stable Rust API commitments.
