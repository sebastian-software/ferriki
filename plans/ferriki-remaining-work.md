# Ferriki Remaining Work

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
- the core compatibility lane passes (with `bundle.test.ts` consciously
  excluded, see item 1)
- adapter scope is decided and documented (ADR 0004/0007)
- transitional naming is resolved: the addon is `ferriki.node`, the backend
  switch is `FERRIKI_BACKEND` (with `SHIKI_BACKEND` as a deprecated alias)

Not done yet:

- the transitional JS bundle assets under `node/ferriki/dist/chunks` still
  back the JS engine path (removal decided in ADR 0009)
- the Node package source of truth is the checked-in `dist` bundle; there is
  no TS source for it in the repo
- the shipped `index.d.mts` types most of the compat surface as `any`
  (see #10); the release flow itself (multi-platform binaries via the
  shared ferramenta workflow, npm Trusted Publishing) is in place

## 1. Fix Core Compatibility Gaps

Status: largely done — the core lane passes. One classified exception remains.

Goal: make the core compatibility lane fail only on deliberate scope decisions,
not on missing functionality or transitional breakage.

Core lane means only:

- [`node/compat/upstream/shiki/packages/core/test`](../node/compat/upstream/shiki/packages/core/test)
- [`node/compat/upstream/shiki/packages/shiki/test`](../node/compat/upstream/shiki/packages/shiki/test)

It explicitly excludes optional adapter suites.

Remaining:

- resolve or consciously classify the remaining `bundle-full` snapshot drift
  - current mirrored expectation: `350`
  - current mirrored runtime result: `346`
  - this currently reproduces in Ferriki and in the directly imported mirrored Shiki bundle code
  - `bundle.test.ts` is therefore currently excluded from the core release gate until the mirrored upstream expectation is updated or the drift is otherwise explained

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
  grammars/themes ship as lazy binary catalogs, the Rust core caches after
  registration) — removing the old `dist/chunks` JS assets is tracked in
  item 5

Exit criteria:

- [`crates/ferriki-core`](../crates/ferriki-core) owns runtime behavior
- JS/TS no longer contains business logic that would change highlighting results on its own

## 3. Shrink The Node Surface

Goal: make [`node/ferriki`](../node/ferriki) the only supported Node product surface.

Remaining work:

- transitional naming is done: the addon is `ferriki.node`, backend selection
  reads `FERRIKI_BACKEND` (with `SHIKI_BACKEND` as a deprecated alias), and
  errors/symbols use the `[ferriki]`/`ferriki.*` prefixes
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
- transitional JS bundle assets under [`node/ferriki/dist`](../node/ferriki/dist)
  once the Ferriki-owned asset pipeline replaces them

Exit criteria:

- no production path depends on removed JS/WASM runtime behavior
- repository structure no longer suggests multiple historical runtimes

## 6. Harden Release And Contributor Workflow

Goal: make the repo easy to build, test, and release without historical context.

Already resolved:

- publishing goes through `publish.yml`, which delegates to the shared
  `sebastian-software/ferramenta` release workflow: release-please for
  versioning, `build:native` on five platform targets, binary
  verification, and npm Trusted Publishing
- the workspace root is `private: true`; the publishable package is
  [`node/ferriki`](../node/ferriki)
- Rust checks (fmt, clippy, tests) run in CI

Remaining work:

- replace the provisional `index.d.mts` (most exports are still typed
  `any`, see #10) — ideally by re-exporting `@shikijs/types` for the
  compat surface
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

1. Fix core compatibility gaps
2. Move remaining runtime logic into Rust
3. Shrink the Node surface
4. Decide adapter support explicitly
5. Remove obsolete runtime paths
6. Harden release and contributor workflow
