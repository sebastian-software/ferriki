# Ferriki Rust-First Repo Implementation Plan

Goal: transform the current Shiki-shaped repository into a Rust-first project with one Ferriki Rust crate and one public npm package (`ferriki`), while preserving Shiki-compatible Node API coverage through the existing JavaScript/TypeScript tests that still define the core highlighting contract.

## Phase 0 - Freeze the contract

- [ ] Inventory the public API surface that `ferriki` must keep:
  - [ ] `createHighlighter`
  - [ ] `codeToHtml`
  - [ ] `codeToTokens`
  - [ ] related grammar/theme registration and state behavior
- [ ] Inventory all tests that currently define this contract.
- [ ] Tag tests as:
  - [ ] keep unchanged
  - [ ] keep with harness-only rewiring
  - [ ] delete because they exist only for JS/WASM engines
- [ ] Freeze naming decisions:
  - [ ] Rust crate name: `ferroni`
  - [ ] npm package name: `ferriki`
  - [ ] internal crate name: `ferriki-core`
- [ ] Write down the explicit removal list so cleanup is intentional, not ad hoc.

Exit criteria:

- there is a single written compatibility contract
- every relevant existing test has a migration disposition

## Phase 1 - Establish the new repository topology

- [x] Add a top-level Cargo workspace as the primary repository root.
- [x] Create or normalize:
  - [x] `crates/ferriki-core`
  - [x] `node/ferriki`
- [x] Keep `ferroni` external rather than repository-owned.
- [ ] Move build and release ownership toward the Rust workspace first.
- [x] Reduce the root JavaScript workspace into a dedicated `node/` area that supports the single npm package and compatibility tests only.
- [ ] Decide whether `node/pnpm-workspace.yaml` remains temporarily as migration scaffolding or is collapsed further.

Exit criteria:

- the repository layout communicates “Rust project first”
- Node package placement is singular and obvious

## Phase 2 - Consolidate the npm surface

- [ ] Make `node/ferriki` the only supported Node package.
- [ ] Port the existing native-loader and addon build flow into `node/ferriki`.
- [ ] Rename package exports, errors, docs, and metadata from Shiki to Ferriki.
- [ ] Keep only the minimum TypeScript needed for:
  - [ ] addon loading
  - [ ] API exports
  - [ ] compatibility adapters
  - [ ] test bootstrapping
- [ ] Treat framework integrations and host-package adapters as optional layers, not as the primary product surface.
- [ ] Remove multi-backend routing from the product surface once migration verification is sufficient.

Exit criteria:

- there is one npm package
- its public API is Shiki-compatible but Ferriki-branded

## Phase 3 - Move runtime behavior fully into Rust

- [ ] Audit `packages/shiki-rust/src/index.ts` and related glue for remaining business logic.
- [ ] Move grammar orchestration into `ferriki-core`.
- [ ] Move theme handling into `ferriki-core`.
- [ ] Move grammar state and stack serialization into `ferriki-core`.
- [ ] Move direct render pipelines into `ferriki-core` so outputs like HTML are defined natively rather than through mandatory JS post-processing.
- [ ] Keep Node-side code free of policy and fallback logic that belongs in Rust.
- [ ] Define a clear native interface from `node/ferriki` into `ferriki-core`.
- [ ] Add Rust-first tests for every behavior moved out of TypeScript.

Exit criteria:

- TypeScript no longer contains substantive highlighter/runtime logic
- Rust is the only source of truth for runtime behavior

## Phase 4 - Reattach the compatibility suite

- [ ] Repoint existing Shiki tests to `ferriki` with the smallest possible harness changes.
- [ ] Preserve test files and assertions 1:1 wherever practical for the core highlighting contract.
- [ ] Separate compatibility tests from product-specific Node smoke tests.
- [ ] Split optional framework and ecosystem adapters into non-core lanes so they do not define the Ferriki product boundary by accident.
- [ ] Delete tests that validate:
  - [ ] `engine-javascript`
  - [ ] `engine-oniguruma`
  - [ ] WASM loaders or wasm-inlined exports
  - [ ] any public surface Ferriki intentionally no longer supports
- [ ] Add a dedicated command for running the compatibility suite against `ferriki`.

Exit criteria:

- compatibility claims are backed by the original test corpus
- removed runtimes are not kept alive artificially through test scaffolding

## Phase 5 - Delete obsolete structure

- [ ] Remove obsolete packages under `packages/` after parity is secured.
- [ ] Remove production WASM assets, loaders, and exports.
- [ ] Remove old release scripts and workspace publish paths that target the previous monorepo.
- [ ] Update CI to focus on:
  - [ ] Rust tests
  - [ ] Node package tests
  - [ ] compatibility suite
- [ ] Update README and contributor docs to describe the new architecture only.

Exit criteria:

- the old Shiki package topology is gone
- the repository reads cleanly without migration context

## Phase 6 - Release hardening

- [ ] Define crate release flow for `ferroni`.
- [ ] Define npm release flow for `ferriki`.
- [ ] Verify local dev ergonomics:
  - [ ] build native addon
  - [ ] run Rust tests
  - [ ] run Node tests
  - [ ] run compatibility suite
- [ ] Add CI gates that prevent reintroduction of JS/WASM runtime paths.
- [ ] Add a short migration note for any consumers moving from Shiki-branded artifacts to Ferriki.

Exit criteria:

- both public products are releasable independently
- developer workflow is obvious and documented

## Cross-Cutting Rules

- [ ] No new runtime behavior lands in TypeScript unless it is strictly binding-related.
- [ ] No new production WASM path is introduced.
- [ ] No cleanup step is considered complete until tests move with it.
- [ ] Compatibility tests stay close to upstream Shiki form unless a test only covers removed functionality.

## Suggested Execution Order

1. Phase 0 contract freeze
2. Phase 1 repository topology
3. Phase 2 single npm package consolidation
4. Phase 3 Rust runtime extraction
5. Phase 4 compatibility suite rewiring
6. Phase 5 deletion of obsolete structure
7. Phase 6 release hardening

## First Concrete Work Items

- [x] Create the top-level Cargo workspace manifest.
- [x] Decide the final split between external `ferroni` and in-repo `ferriki-core`.
- [x] Create `node/ferriki` as the canonical package location.
- [ ] Enumerate all current tests referencing `engine-javascript`, `engine-oniguruma`, `wasm`, or `SHIKI_BACKEND`.
- [ ] Produce a migration matrix mapping each test file to keep, rewire, or delete.
- [ ] Audit `packages/shiki-rust/src/index.ts` into:
  - [ ] binding-only logic
  - [ ] portability glue worth deleting
  - [ ] real runtime logic that must move to Rust
