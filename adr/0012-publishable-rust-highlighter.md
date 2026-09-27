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
- The N-API compatibility core is hidden from the Rust API documentation. The
  catalog's binary manifest and asset structs are not exposed through the
  `ferriki` API.
- A highlighter is synchronous and mutable. It is reused within one thread;
  one instance per worker avoids unsafe sharing of TextMate registry state.
- Ferriki emits escaped, balanced line fragments for composable Markdown
  rendering. Ferromark owns code block structure, metadata, and fallback.
  The adapter belongs in Ferromark or a separate adapter crate, not Ferriki.

### Release (amended 2026-09-27)

Ferriki follows the organization's release blueprint (one product, one
version, one release signal; see Ferromark ADR-0020 and
`reference/release-please/` in sebastian-software/standards):

- `ferriki` is the repository's root Cargo package, so Release Please's native
  `rust` strategy updates the root package, all workspace members, their
  explicit path-dependency requirements and `Cargo.lock`. The npm package,
  its platform sidecars and the pnpm lockfile specifiers follow through typed
  `extra-files`.
- All crates and the npm package share one version. The crates therefore start
  at the next Ferriki release rather than at `0.1.0`, as originally planned.
- Merging the release pull request tags `v<version>`; `publish.yml` then
  publishes npm and, through the shared `publish-crates` action, the three
  crates in dependency order: `ferriki-textmate`, `ferriki-asset-gen`, then
  `ferriki`. `ferriki-core` remains private.
- Both registries authenticate through Trusted Publishing; no long-lived
  registry token is stored. crates.io only offers Trusted Publishing for an
  existing crate, so the very first version of each crate is published once by
  hand from the release tag, then the trusted publisher is configured. The
  steps are in `docs/release-checklist.md`.

## Consequences

- Ferromark can highlight through a public Rust dependency with no N-API path.
- Node and Rust share grammar, theme, tokenization, and HTML behavior while
  retaining platform-appropriate offset conventions.
- Applications choose whether to ship all assets, a subset, or their own
  grammars and themes. Borrowed embedded bytes avoid copying the bundle to the
  heap at construction, and lazy catalogs decode only used assets.
- Updating the binary format requires regenerating the asset bundle and
  updating the format version. The format itself is not a stable public API.
- The default Ferromark crate keeps its zero-cost path without a Ferriki
  dependency; integration is explicitly opt-in.
