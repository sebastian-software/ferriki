# Ferriki Remaining Work

This file tracks only the work that is still meaningfully open in the current
repository state.

Architectural intent lives in [`adr/`](/Users/sebastian/Workspace/oss-released/ferriki/adr).
This plan is only the execution backlog.

## Current State

Already true:

- the repository is Rust-first at the root
- all Node and compatibility infrastructure lives under [`node/`](/Users/sebastian/Workspace/oss-released/ferriki/node)
- Ferriki has one Node package under [`node/ferriki`](/Users/sebastian/Workspace/oss-released/ferriki/node/ferriki)
- Shiki compatibility is checked against the mirrored suite under [`node/compat/upstream/shiki`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki)
- the repo cutover and export mechanics are finished and removed

Not done yet:

- Ferriki is not yet fully parity-clean against the intended Shiki contract
- too much runtime behavior still leaks through transitional JS/TS layers
- old upstream-shaped packages under the mirrored workspace still exist as test infrastructure
- release hardening is incomplete

## 1. Fix Core Compatibility Gaps

Goal: make the core compatibility lane fail only on deliberate scope decisions,
not on missing functionality or transitional breakage.

Core lane means only:

- [`node/compat/upstream/shiki/packages/core/test`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki/packages/core/test)
- [`node/compat/upstream/shiki/packages/shiki/test`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki/packages/shiki/test)

It explicitly excludes optional adapter suites.

Priority items:

- restore the missing primitive/highlighter compatibility surface used by the mirrored core tests
  - `createShikiPrimitive`
  - `createShikiPrimitiveAsync`
  - any related sync/async helpers still expected by mirrored core code
- remove remaining import-resolution quirks that come from mirrored package layout rather than Ferriki behavior
- resolve or consciously classify the remaining `bundle-full` snapshot drift
  - current mirrored expectation: `350`
  - current mirrored runtime result: `346`
  - this currently reproduces in Ferriki and in the directly imported mirrored Shiki bundle code
- re-establish the intended behavior for:
  - theme loading
  - language loading and aliases
  - token outputs
  - `codeToHtml`
  - `codeToHast`
  - grammar state behavior

Exit criteria:

- [`node/package.json`](/Users/sebastian/Workspace/oss-released/ferriki/node/package.json) `test:ferriki-compat:core` fails only on real Ferriki-vs-Shiki behavior differences
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

Exit criteria:

- [`crates/ferriki-core`](/Users/sebastian/Workspace/oss-released/ferriki/crates/ferriki-core) owns runtime behavior
- JS/TS no longer contains business logic that would change highlighting results on its own

## 3. Shrink The Node Surface

Goal: make [`node/ferriki`](/Users/sebastian/Workspace/oss-released/ferriki/node/ferriki) the only supported Node product surface.

Remaining work:

- remove any remaining transitional naming or wrapper behavior that still reflects the old Shiki-shaped internals
- keep the public API Shiki-compatible where intended, but Ferriki-branded
- ensure optional adapters do not silently become core product requirements

Exit criteria:

- one obvious Node package surface
- no runtime dependency on legacy package topology

## 4. Decide Adapter Support Explicitly

Goal: stop treating historical integrations as implicit product requirements.

Separate and decide:

- core lane:
  - highlighting runtime
  - direct outputs
  - core compatibility surface
- optional adapter lanes:
  - transformers
  - markdown-it
  - rehype
  - vitepress-twoslash
  - twoslash
  - colorized-brackets
  - any further ecosystem packages

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

Exit criteria:

- no production path depends on removed JS/WASM runtime behavior
- repository structure no longer suggests multiple historical runtimes

## 6. Harden Release And Contributor Workflow

Goal: make the repo easy to build, test, and release without historical context.

Remaining work:

- finalize npm release flow for [`node/ferriki`](/Users/sebastian/Workspace/oss-released/ferriki/node/ferriki)
- decide whether and when `ferriki-core` becomes a separately published crate
- document the normal local workflow for:
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
