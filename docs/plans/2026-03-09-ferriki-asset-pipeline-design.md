# Ferriki Asset Pipeline Design

Date: 2026-03-09

## Goal

Replace the transitional Shiki-JS bundle assets under
[`node/ferriki/dist`](/Users/sebastian/Workspace/oss-released/ferriki/node/ferriki/dist)
with a Ferriki-owned asset pipeline that is:

- Rust-first
- lazy-loading
- compatible with Shiki-derived standard data
- equally capable of handling shipped assets and user-registered assets

## Decision Summary

Ferriki will not use mirrored Shiki JavaScript chunks as its product runtime
truth.

Instead:

- Shiki remains the upstream source for standard grammars, language metadata,
  aliases, embedded-language metadata, and standard themes.
- Ferriki converts those upstream inputs into its own asset format.
- The converted assets live under
  [`assets/shiki/`](/Users/sebastian/Workspace/oss-released/ferriki/assets/shiki).
- The Rust core loads those assets lazily and caches compiled results.
- External themes and grammars remain first-class via `registerTheme(...)` and
  `registerGrammar(...)`, including through the Node binding.

## Asset Model

Ferriki uses one shared asset infrastructure with two separate catalogs:

- `assets/shiki/languages/`
- `assets/shiki/themes/`

Each catalog contains:

- many small per-item binary files
- a small manifest describing the available items

This avoids eager loading of a large standard catalog while keeping the shipped
data self-contained and platform-robust.

The standard use case is expected to touch only a few languages and themes in a
given process. The asset model therefore optimizes for:

- small baseline memory usage
- fast lookup by id/alias
- lazy decode and compile
- stable caching after first load

## Data Flow

1. Shiki is mirrored into
   [`node/compat/upstream/shiki`](/Users/sebastian/Workspace/oss-released/ferriki/node/compat/upstream/shiki)
   through the existing sync flow.
2. A Rust generator crate reads the mirrored language and theme packages.
3. The generator emits Ferriki-owned assets under
   [`assets/shiki/`](/Users/sebastian/Workspace/oss-released/ferriki/assets/shiki).
4. [`crates/ferriki-core`](/Users/sebastian/Workspace/oss-released/ferriki/crates/ferriki-core)
   uses manifests plus embedded bytes to lazy-load and compile requested
   grammars and themes.
5. The Node package exposes the standard Shiki-compatible API, but no longer
   depends on Shiki chunk files as the catalog source of truth.

## Runtime Behavior

### Standard assets

Standard assets are shipped with Ferriki but are not eagerly activated.

- Manifests and asset bytes belong to the product.
- Decoding happens only when a language or theme is requested.
- Compiled runtime structures stay in Rust caches after first use.

### External assets

External assets are not second-class.

- User themes are supported through the same conceptual path as shipped themes.
- User grammars are supported through the same conceptual path as shipped
  grammars.
- The public extension points remain `registerTheme(...)` and
  `registerGrammar(...)`.

## Packaging Direction

Ferriki should prefer Rust-native packaging over filesystem-dependent runtime
lookups.

That means:

- shipped manifests and per-item asset bytes are part of the Rust-side product
- assets are decoded lazily, not eagerly loaded into runtime structures
- cross-platform behavior does not depend on fragile install-time file layout

## Non-Goals

This design does not require:

- embedding every standard grammar/theme into eager runtime state
- keeping the old `dist/chunks/*.mjs` layout alive as a long-term catalog
- treating built-in themes as conceptually different from user themes
- keeping JS regex, WASM, or bundle-era runtime paths for product behavior

## Testing Requirements

The asset pipeline must be covered by dedicated tests:

- generator determinism tests
- binary roundtrip tests
- decode stability tests
- semantic parity tests ensuring the same asset yields the same usable runtime
  data after repeated read/decode cycles
- existing core compatibility tests

## Migration Shape

1. Introduce a Rust asset generator crate.
2. Generate Ferriki-owned theme and language assets from the mirrored Shiki
   packages.
3. Add lazy Rust loaders and caches for both catalogs.
4. Point the Node-facing standard catalog at Ferriki assets instead of
   `node/ferriki/dist/chunks`.
5. Remove transitional JS bundle assets once parity and packaging are covered.
