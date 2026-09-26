# ADR 0012: Publishable Rust Highlighter and External Ferromark Adapter

## Status

Accepted

## Context

Ferriki's runtime originally lived in the `ferriki-core` N-API crate. Rust
consumers such as Ferromark could not depend on it without the Node binding,
and asset loading was implicitly tied to the Node release layout. The adapter
ownership decision in [ADR 0007](0007-adapter-integrations-stay-outside-ferriki.md)
still applies.

## Decision

- `ferriki-textmate` is the publishable grammar and theme engine.
- `ferriki-asset-gen` is the publishable versioned asset codec.
- `ferriki` is the publishable reusable highlighter. It owns asset catalogs,
  lazy loading, themed tokens, escaped Rust HTML rendering, and typed errors.
- `ferriki-core` is the unpublished N-API adapter over the same Rust runtime.
- Asset providers are explicit catalogs backed by a directory or embedded
  bytes. No Node package path is part of the Rust API. Binary asset files are
  internal, versioned artifacts that must match the runtime release.
- Rust token offsets are UTF-8 bytes. The Node facade retains UTF-16 offsets.
- A highlighter is synchronous and mutable. It is reused within one thread;
  one instance per worker avoids unsafe sharing of TextMate registry state.
- Ferriki emits escaped, balanced line fragments for composable Markdown
  rendering. Ferromark owns code block structure, metadata, and fallback.
  The adapter belongs in Ferromark or a separate adapter crate, not Ferriki.

The three library crates start at version `0.1.0` and are published in
dependency order: `ferriki-textmate`, `ferriki-asset-gen`, then `ferriki`.
`ferriki-core` remains private. The existing npm release workflow is kept
separate until crates.io credentials or trusted publishing are configured.
The first Rust release requires that setup and a package/consumer check; the
Rust API is not represented as already published by this decision.

## Consequences

- Ferromark can highlight through a public Rust dependency with no N-API path.
- Node and Rust share grammar, theme, tokenization, and HTML behavior while
  retaining platform-appropriate offset conventions.
- Applications choose whether to ship all assets, a subset, or their own
  grammars and themes. Lazy catalogs keep unused assets out of runtime memory.
- Updating the binary format requires regenerating the asset bundle and
  updating the format version. The format itself is not a stable public API.
- The default Ferromark crate keeps its zero-cost path without a Ferriki
  dependency; integration is explicitly opt-in.
