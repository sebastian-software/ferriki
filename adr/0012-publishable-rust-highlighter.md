# ADR 0012: Publishable Rust Highlighter and External Ferromark Adapter

## Status

Accepted

Last updated: 2026-10-04

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
- Asset providers are explicit catalogs. `StandardAssetCatalogs` reads a
  directory or embedded bytes, or takes the binary manifests plus trusted
  release metadata and a digest-keyed `AssetSource`, verifying size and
  SHA-256 before it decodes a payload. The optional `remote` feature loads
  the standard payloads from the release-pinned CDN
  ([ADR 0013](0013-cdn-loaded-standard-assets.md)). No Node package path is
  part of the Rust API. Binary asset files are internal, versioned artifacts
  that must match the runtime release
  ([ADR 0015](0015-postcard-asset-codec.md)).
- Rust token offsets are UTF-8 bytes. The Node facade retains UTF-16 offsets.
- The public `Highlighter` returns owned named multi-theme tokens, aligned
  at the union of each theme's boundaries, through `highlight_with_themes`
  and `highlight_with_themes_and_options`. They reuse its catalogs and custom
  registrations and preserve the single-theme offset and error contracts.
- The N-API compatibility core lives in `ferriki::__private`, hidden from the
  Rust API documentation and exempt from semver guarantees. The catalog's
  binary manifest and asset structs are not exposed through the `ferriki` API.
- What the three crates promise under semver is set by
  [ADR 0014](0014-rust-crate-semver-surface.md).
- A highlighter is synchronous and mutable. It is reused within one thread;
  one instance per worker avoids unsafe sharing of TextMate registry state.
- Ferriki emits escaped, balanced line fragments for composable Markdown
  rendering. Ferromark owns code block structure, metadata, and fallback.
  The adapter belongs in Ferromark or a separate adapter crate, not Ferriki.
- Published Ferromark 3.1.0 adds framework-neutral JSX output and Node compile
  support for Markdown fences. Its optional Rust adapter uses `ferriki` 0.10.0,
  and its Node integration uses `@ferriki/core` 0.10.0. Ferromark 3.0.0 remains
  the earlier Rust adapter release against `ferriki` 0.7.0.
- Ferromark remains the owner of Markdown fence annotations, including its
  VitePress-style focus, highlight, and diff line behavior. Node code-comment
  transformers do not run on the Rust path. Word-level styles, copy controls,
  and collapsible supporting blocks belong to the renderer or consuming page;
  they add no Rust highlighter API.

### Release

Ferriki follows the organization's release blueprint (one product, one
version, one release signal; see Ferromark ADR-0020 and
`reference/release-please/` in sebastian-software/standards):

- `ferriki` is the repository's root Cargo package, so Release Please's native
  `rust` strategy updates the root package, all workspace members, their
  explicit path-dependency requirements and `Cargo.lock`. The npm package,
  its platform sidecars, `@ferriki/vite` and the pnpm lockfile specifiers follow
  through typed `extra-files`. The Vite package shares the product version and
  depends on the matching `@ferriki/core` version.
- The separate fuzz workspace keeps its own dependency lockfile. Typed TOML
  `extra-files` update only its local `ferriki-asset-gen` and
  `ferriki-textmate` package versions in the release PR; registry dependencies
  and the private fuzz package version stay pinned. Fuzz CI verifies that
  `cargo fetch --locked` can use the generated release candidate.
- All crates and npm product packages share one version. The crates therefore
  start at the next Ferriki release rather than at `0.1.0`, as originally
  planned.
- Merging the release pull request tags `v<version>`; `publish.yml` then
  publishes the platform packages, `@ferriki/core` and `@ferriki/vite`, and,
  through the shared `publish-crates` action, the three crates in dependency
  order: `ferriki-textmate`, `ferriki-asset-gen`, then `ferriki`. `ferriki-core`
  remains private.
- Product releases authenticate through Trusted Publishing; no long-lived
  registry token is stored in CI. The first npm package version must exist
  before its Trusted Publisher can be configured, so `@ferriki/vite` is seeded
  once with the `0.0.0-bootstrap.0` prerelease on the `bootstrap` dist-tag. The
  first product version remains available for OIDC publication with
  provenance. crates.io likewise requires each crate to exist before Trusted
  Publishing can be configured, so the first version of each crate is
  published once by hand from the release tag. The steps are in
  `docs/release-checklist.md`.
- `@ferriki/vite` includes pnpm catalog dependencies. Its release uses the
  workspace-pinned pnpm 10 pack command so catalogs become concrete, then
  npm 11 publishes the explicit tarball with OIDC authentication and provenance.

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

## History

- 2026-09-26: Accepted.
- 2026-09-27: Release section: one version and one Release Please pull request for the crates and npm.
- 2026-09-30: Asset sources verify digests (0.5.0); links the semver and codec records.
- 2026-09-30: The `remote` feature shipped (#141).
- 2026-10-01: Public named multi-theme tokens support downstream Rust renderers without the N-API bridge (#183).
- 2026-10-02: Add `@ferriki/vite` to the shared version and release, with a one-time npm Trusted Publishing bootstrap.
- 2026-10-03: Clarifies Ferromark fence annotations, its published Ferriki 0.7.0 integration, and keeps Node comment transformers and page presentation outside the Rust API (#166).
- 2026-10-03: Include the separate fuzz lockfile's local crate versions in generated release candidates; pack the Vite tarball with pnpm and publish it explicitly with npm.
- 2026-10-04: Records Ferromark 3.1.0's published JSX and Node compiler with Ferriki 0.10.0; keeps the 3.0.0 Rust integration as historical context.
