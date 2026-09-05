# Ferriki Remaining Work

> Historical execution ledger. Evidence date: 2026-09-05. The GitHub
> epics/issues are the delivery source of truth; this file records context and
> points to successor issues rather than claiming live status.

This file tracks only the work that is still meaningfully open in the current
repository state.

Architectural intent lives in [`adr/`](../adr).
This plan is only the execution backlog.

## Current State

Already true:

- the repository is Rust-first at the root
- all Node and compatibility infrastructure lives under [`node/`](../node)
- Ferriki has one Node package under [`node/ferriki`](../node/ferriki)
- Shiki compatibility is checked against the mirrored suite under [`node/compat/upstream/shiki`](../node/compat/upstream/shiki)
- the repo cutover and export mechanics are finished and removed
- the Ferriki-owned asset pipeline exists: `crates/ferriki-asset-gen` generates
  the binary catalogs under [`assets/shiki`](../assets/shiki), and the core
  loads standard assets lazily at render time
- the core compatibility lane passes, including the pinned Shiki bundle smoke
  tests; legacy capture and repository-array grammar forms are normalized at
  the raw-grammar boundary (#12)
- adapter scope is decided and documented (ADR 0004/0007)
- transitional naming is resolved: the addon is `ferriki.node`; the
  compatibility harness uses `FERRIKI_HONEST_ALIAS=1` for native routing

Open work is tracked by the current GitHub backlog, including public npm
availability and sidecars (#15, #52), and the Ferromark/Ardo adoption path
(#14, #18, #38). The old JS bundle/chunk runtime
and placeholder-only package described by earlier migration snapshots are no
longer present.

The public API source-of-truth lane now lives under [`node/ferriki/src`](../node/ferriki/src):
`api.mts` is compiled to `api.d.mts`, and the package-root runtime/type entry
points are generated wrappers checked for drift in CI. The remaining API work
is tracked by the accepted contract document and its focused checks; future
additions require a new contract decision.

## 1. Fix Core Compatibility Gaps

Status: complete — the core lane passes, including the bundle smoke tests.

Goal: make the core compatibility lane fail only on deliberate scope decisions,
not on missing functionality or transitional breakage.

Core lane means only:

- [`node/compat/upstream/shiki/packages/core/test`](../node/compat/upstream/shiki/packages/core/test)
- [`node/compat/upstream/shiki/packages/shiki/test`](../node/compat/upstream/shiki/packages/shiki/test)

It explicitly excludes optional adapter suites.

The audit found and fixed two grammar-shape incompatibilities that the old
exclusion concealed: capture arrays in `jinja` and repository rule arrays in
`racket`. `bundle-full` (364 languages) and `bundle-web` (96 languages) are now
mandatory core-gate tests.

Exit criteria:

- [`node/package.json`](../node/package.json) `test:ferriki-compat:core` fails only on real Ferriki-vs-Shiki behavior differences
- no failures remain that are caused purely by workspace/module plumbing

## 2. Move Remaining Runtime Logic Into Rust

Goal: make Rust the semantic source of truth, not just the execution engine.

Remaining direction:

- audit the remaining TS layer for behavior that still decides runtime semantics
- move native ownership of:
  - grammar orchestration
  - theme application
  - state serialization
  - render-path decisions
  - fallback behavior that still exists for parity reasons in JS
- keep only:
  - addon loading
  - public API wiring
  - compatibility-only harness glue
- already moved into the native path:
  - `colorReplacements`
  - `mergeWhitespaces`
  - `mergeSameStyleTokens`
  - `codeToHast` rendering and render options
  - the Vue/Astro renderer fallbacks are removed
- done: the Ferriki-owned asset pipeline replaced the bundle-driven asset
  layer for the native path
  (see [`ferriki-asset-pipeline-implementation-plan.md`](ferriki-asset-pipeline-implementation-plan.md);
  grammars/themes ship as lazy binary catalogs, and the Rust core caches after
  registration)

Exit criteria:

- [`crates/ferriki-core`](../crates/ferriki-core) owns runtime behavior
- JS/TS no longer contains business logic that would change highlighting results on its own

## 3. Shrink The Node Surface

Goal: make [`node/ferriki`](../node/ferriki) the only supported Node product surface.

Remaining work:

- transitional naming is done: the addon is `ferriki.node` and errors/symbols
  use the `[ferriki]`/`ferriki.*` prefixes; `FERRIKI_HONEST_ALIAS` is a
  compatibility-harness switch, not a product backend selector
- keep the public API Shiki-compatible where intended, but Ferriki-branded
- ensure optional adapters do not silently become core product requirements

Exit criteria:

- one obvious Node package surface
- no runtime dependency on legacy package topology

## 4. Decide Adapter Support Explicitly

Status: done — ADR 0004 and ADR 0007 record the adapter decisions, the
adapter lanes are outside the release gate, and ADR 0008 assigns
`decorations` and `transformers` to the JS layer.

Goal: stop treating historical integrations as implicit product requirements.

Separate and decide:

- core lane:
  - highlighting runtime
  - direct outputs
  - core compatibility surface
- native-vs-JS boundary (decided in ADR 0008):
  - `decorations`
  - `transformers`
- optional adapter lanes:
  - transformers
  - twoslash
  - colorized-brackets
  - any further ecosystem packages

Already decided out of scope:

- `markdown-it`
- `rehype`
- `vitepress-twoslash`

Reason:

- these are adapters on top of Ferriki outputs such as `codeToHtml` and `codeToHast`
- they do not define the highlighting runtime itself
- they can live outside Ferriki without weakening the core product

For each optional lane:

- keep and support
- keep as best-effort compatibility
- or remove from Ferriki scope

Exit criteria:

- adapter support is a deliberate product choice
- CI and docs match that choice

## 5. Remove Obsolete Runtime Paths

Goal: stop carrying dead architecture.

Remove when replacement coverage is in place:

- JS regex engine assumptions
- Oniguruma/WASM runtime paths
- obsolete compatibility shims that only existed during the migration
- old package-topology references that are no longer part of the product
- any future compatibility-only artifacts must not become a production
  runtime path; the native asset catalogs are the only shipped runtime data

Exit criteria:

- no production path depends on removed JS/WASM runtime behavior
- repository structure no longer suggests multiple historical runtimes

## 6. Harden Release And Contributor Workflow

Goal: make the repo easy to build, test, and release without historical context.

Already resolved:

- publishing goes through the repository-owned `publish.yml`: release-please
  versioning, `build:native` on five platform targets, sidecar verification,
  npm Trusted Publishing, public registry/provenance verification, and a clean
  consumer install
- the workspace root is `private: true`; the publishable package is
  [`node/ferriki`](../node/ferriki)
- Rust checks (fmt, clippy, tests) run in CI

Remaining work:

- decide whether and when `ferriki-core` becomes a separately published crate
- add a CONTRIBUTING.md documenting the normal local workflow:
  - Rust checks
  - native build
  - core compatibility lane
  - optional adapter lanes
- add CI rules that keep removed runtime paths from creeping back in

Exit criteria:

- the happy path is documented and reproducible
- release mechanics match the actual product boundaries

## Suggested Order

1. Finish the accepted 1.0 API issues (#45, #47, #50, #51)
2. Harden release and packaging (#52–#54)
3. Validate the Ferromark/Ardo integration contract (#55)
4. Keep docs and compatibility gates synchronized (#56–#57)
