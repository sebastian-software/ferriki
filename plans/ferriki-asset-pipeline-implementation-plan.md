# Ferriki Asset Pipeline Implementation Plan

## Goal

Replace the transitional JS bundle catalog with Ferriki-owned lazy-loaded asset
catalogs for languages and themes.

## Phase 1: Generator Skeleton

- add [`crates/ferriki-asset-gen`](/Users/sebastian/Workspace/oss-released/ferriki/crates/ferriki-asset-gen)
- define Ferriki asset schemas for:
  - language manifest
  - theme manifest
  - per-language binary payload
  - per-theme binary payload
- add roundtrip tests for the binary format

## Phase 2: Import From Mirrored Shiki Data

- read language inputs from
  [`node/compat/upstream/shiki/packages/langs`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki/packages/langs)
- read theme inputs from
  [`node/compat/upstream/shiki/packages/themes`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki/packages/themes)
- generate Ferriki-owned outputs under
  [`assets/shiki/languages`](/Users/sebastian/Workspace/oss-released/ferriki/assets/shiki/languages)
  and
  [`assets/shiki/themes`](/Users/sebastian/Workspace/oss-released/ferriki/assets/shiki/themes)
- add deterministic golden tests for generated manifests and sample assets

## Phase 3: Rust Lazy Loaders

- add language asset loader in
  [`crates/ferriki-core`](/Users/sebastian/Workspace/oss-released/ferriki/crates/ferriki-core)
- add theme asset loader in
  [`crates/ferriki-core`](/Users/sebastian/Workspace/oss-released/ferriki/crates/ferriki-core)
- keep catalogs separate, but use shared infrastructure where useful
- cache decoded and compiled runtime structures after first load

## Phase 4: Connect Standard Highlighter Flow

- make standard language/theme lookup use Ferriki manifests
- keep `registerTheme(...)` and `registerGrammar(...)` as explicit extension
  points
- ensure the Node binding exposes those registration APIs clearly

## Phase 5: Remove Transitional Bundle Truth

- stop treating
  [`node/ferriki/dist`](/Users/sebastian/Workspace/oss-released/ferriki/node/ferriki/dist)
  as the standard catalog source
- reduce or remove `dist/chunks/*.mjs` once the Ferriki asset pipeline replaces
  them
- keep only the minimal Node runtime surface needed for the supported package

## Validation

- `cargo test` for asset roundtrip and loader tests
- targeted Node tests for standard theme/language loading
- `pnpm run test:ferriki-compat:core`
