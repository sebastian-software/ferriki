# Ferriki Asset Pipeline Implementation Plan

Status: phases 1–4 are implemented. Phase 5 (removing the transitional
`dist/chunks` bundle truth) is still open.

## Goal

Replace the transitional JS bundle catalog with Ferriki-owned lazy-loaded asset
catalogs for languages and themes.

## Phase 1: Generator Skeleton

- add [`crates/ferriki-asset-gen`](../crates/ferriki-asset-gen)
- define Ferriki asset schemas for:
  - language manifest
  - theme manifest
  - per-language binary payload
  - per-theme binary payload
- add roundtrip tests for the binary format

## Phase 2: Import From Raw Upstream Data

- mirror raw language and theme inputs under
  [`assets/upstream/`](../assets/upstream)
  from `textmate-grammars-themes`
- read grammar/theme JSON from that upstream mirror
- supplement missing aliases and embedded-language metadata from
  [`node/compat/upstream/shiki`](../node/compat/upstream/shiki)
- generate Ferriki-owned outputs under
  [`assets/shiki/languages`](../assets/shiki/languages)
  and
  [`assets/shiki/themes`](../assets/shiki/themes)
- add deterministic golden tests for generated manifests and sample assets

## Phase 3: Rust Lazy Loaders

- add language asset loader in
  [`crates/ferriki-core`](../crates/ferriki-core)
- add theme asset loader in
  [`crates/ferriki-core`](../crates/ferriki-core)
- keep catalogs separate, but use shared infrastructure where useful
- cache decoded and compiled runtime structures after first load

## Phase 4: Connect Standard Highlighter Flow

- make standard language/theme lookup use Ferriki manifests
- keep `registerTheme(...)` and `registerGrammar(...)` as explicit extension
  points
- ensure the Node binding exposes those registration APIs clearly

## Phase 5: Remove Transitional Bundle Truth

- stop treating
  [`node/ferriki/dist`](../node/ferriki/dist)
  as the standard catalog source
- reduce or remove `dist/chunks/*.mjs` once the Ferriki asset pipeline replaces
  them
- keep only the minimal Node runtime surface needed for the supported package

## Validation

- `cargo test` for asset roundtrip and loader tests
- targeted Node tests for standard theme/language loading
- `pnpm run test:ferriki-compat:core`
