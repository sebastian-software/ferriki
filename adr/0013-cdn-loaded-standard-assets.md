# ADR 0013: Standard Assets Loaded From a Release-Pinned CDN Mirror

## Status

Accepted

Last updated: 2026-10-13

## Context

[ADR 0006](0006-lazy-shiki-asset-loading.md) made standard grammars and themes
lazily loaded data, and [ADR 0012](0012-publishable-rust-highlighter.md) made
asset providers explicit catalogs backed by a directory or embedded bytes. Both
still assume that every consumer receives the complete standard catalog.

That assumption now dominates the package size. Measured on the 0.4 releases:

- `@ferriki/core` packs 9.0 MB of files once the duplicated Linux addon is gone.
  8.8 MB of that are grammar and theme payloads (261 grammars, 66 themes). The
  manifests add 119 KB and the JavaScript, types and docs 106 KB. The platform
  addon adds about 2.4 MB.
- The catalog is heavily skewed. `emacs-lisp` alone is 770 KB and `cpp` is
  465 KB. A theme is about 11 KB. A typical project uses a handful of languages
  and one or two themes.
- The `ferriki` crate ships no assets. Rust consumers on crates.io have no
  supported way to obtain them other than copying `assets/standard` from this
  repository.
- A native Ferromark + Ferriki combination package would have to carry the full
  catalog, which makes it several times larger than Ferromark itself.

One package per language, as Shiki's `@shikijs/langs-*` layout suggests, would
multiply the release matrix by more than 300 packages. That is not acceptable
for a project that already publishes eight npm packages and three crates per
release.

Every release commit already contains the generated payloads under
`assets/standard/`. GitHub serves any file of a public repository by ref and path
from `raw.githubusercontent.com`, for a tag and for a commit SHA alike. Verified
for `assets/shiki/languages/typescript.fkgram`: both refs of the 0.4.0 release
return the committed bytes. The same host cannot serve a blob by its hash
alone (404), and the REST API that can is rate-limited. `raw.githubusercontent.com`
also sends only `Cache-Control: max-age=300`, so it is an origin, not a CDN.

The binary asset format is internal and versioned. A release must never load a
payload written for an incompatible format version.

## Decision

Standard grammar and theme data lives in Bunny Storage, served through
`assets.ferriki.dev`. Git owns the selection, provenance, patches, license
notices, and the small reviewed `assets/catalog.json` lock. Original sources,
normalized JSON, binary payloads, and generated catalog indexes are ignored
local build artifacts, not committed repository data.

- **Immutable objects.** Grammar objects use `<canonical-language-id>/<sha256>`;
  themes use `themes/<theme-id>/<sha256>`. SHA-256 covers every byte of the
  original source, normalized source, or compiled payload. Equal bytes reuse
  an object. Changed bytes use a new name. Aliases resolve to the canonical ID.
- **Pinned catalogs.** Each package/crate version carries its fixed catalog,
  payload digests, sizes, and binary format versions. The release manifest's
  `storageLayout: "language-hash-v1"` selects digest URLs. Its optional `commit`
  records release provenance and does not choose the new object's location.
  The absent layout retains legacy `<commit>/assets/shiki/<path>` URLs.
- **Offline compilation.** Rust's build script encodes the reviewed catalog
  metadata into `OUT_DIR` through `ferriki-asset-gen`. Compiling a crate requires
  neither Node nor downloads. Node generates the same tiny indexes from the
  lock when preparing its package. Both packages exclude source/payload data.
- **Materialization.** `scripts/materialize-assets.mjs` verifies cached files
  or loads immutable objects for repository tests and regeneration. Sources
  retain pinned upstream URLs and hashes as reconstruction inputs. The initial
  migration records a fixed Ferriki snapshot for existing theme sources and
  payloads; explicit bootstrap mode seeds storage before the new origin exists.
  Every reconstruction is checked against the accepted digest and size.
- **Sync and publication.** ADR 0020's weekly/manual workflow prepares sources,
  converts and compiles them, checks native compatibility and output agreement,
  then uploads original/normalized sources and payloads. It opens an update PR
  containing metadata and license changes. Normalized source diffs and the full
  candidate remain downloadable review artifacts. New files reach consumers
  when a release adopts the reviewed catalog, not when upstream moves.
- **Append-only uploader.** `scripts/publish-assets.mjs` preflights the complete
  local upload set. It reads any existing storage object and skips matching
  bytes. A mismatch or failed request stops publication; it never deletes or
  repairs a published object. New uploads are downloaded again and verified.
  Redirects are rejected, and the zone key is sent only to Bunny's Storage API.
- **Release gate.** Before either registry publishes, the release-source gate
  materializes the accepted snapshot and verifies its immutable storage objects.
  Public npm verification checks every payload through the CDN by SHA-256 and
  size. Package/crate version updates remain owned by Release Please.
- **Hosting and migration.** A Storage Zone origin override handles
  hash paths. The default GitHub origin keeps released commit-based URLs working. Access rules
  permit only the legacy asset paths and canonical ID/full-hash paths; successful
  immutable responses have a one-year cache lifetime. The hostname stays
  `assets.ferriki.dev`, so the provider can change without changing clients.
- **Caching and integrity.** Downloads are verified before decoding or caching.
  The local cache uses one file per digest and deduplicates across releases.
  Size, digest, or format mismatches fail and are never cached. Node uses its
  built-in fetch with six workers and a 60-second timeout; the optional Rust
  `remote` feature uses ureq/rustls and the platform trust store. Existing
  proxy, certificate, cache-location, and download-limit behavior is unchanged.
- **Offline use.** Synchronous loading reads only the populated cache. Prewarm
  the cache, supply a mirror through `FERRIKI_ASSETS_BASE_URL`, or use Rust's
  directory/embedded asset sources. Remote loading is enabled by default in
  Node and opt-in through Rust's `remote` feature. The documented opt-out is
  `FERRIKI_ASSETS_REMOTE=0`; missing offline data names the available remedies.

## Consequences

- Git reviews configuration, pins, hashes, metadata, and patches rather than
  thousands of imported or generated lines. Payload availability depends on
  the storage/CDN, with upstream reconstruction available to maintainers.
- Existing objects must remain available for the lifetime of released versions.
  Storage cleanup requires explicit analysis of every released catalog. The
  automatic updater never performs garbage collection or changes active catalogs.
- Maintainer publication needs a zone-specific Actions secret and non-sensitive
  zone/endpoint variables. Consumer installs need no Bunny credentials.
- The fixed source/payload snapshots can be reproduced and checked independently
  of current upstream heads. Developer tests materialize data before execution;
  ordinary Rust compilation remains network-free.
- No language/theme packages or extra runtime dependencies are introduced.
  First use still downloads only the requested languages, dependencies, and
  themes. The dated 0.4 package-size measurements above remain historical evidence.

## History

- 2026-09-28: Proposed.
- 2026-09-29: Accepted.
- 2026-09-30: Records the release manifest layout (0.6.x), the Node option and environment variable names decided in #141, and the shipped `AssetSource` trait (0.5.0).
- 2026-09-30: CDN only: the `@ferriki/assets` package and the `ferriki-assets`
  crate are dropped; offline use goes through a mirror or a pre-populated
  cache. Records the Rust `remote` feature: ureq with the OS trust store, the
  cache layout, and the release commit from `.cargo_vcs_info.json`.
- 2026-09-30: Node path: payloads dropped from `@ferriki/core`, downloads run in
  Rust through an N-API async task, the release workflow stamps the commit, and
  the sync/async boundary is recorded.
- 2026-10-01: The post-publish CDN check is in place; ADR 0013 is fully implemented.
- 2026-10-02: Node uses built-in fetch for bounded, digest-checked downloads;
  Rust keeps manifest planning and cache verification, while the optional Rust
  `remote` feature retains its independent ureq transport.
- 2026-10-12: Clarifies that catalog curation (ADR 0020) preserves CDN-only payload delivery.

- 2026-10-13: Moves sources and payloads out of Git into immutable Bunny Storage
  objects keyed by canonical language/theme ID and full content hash. Retains
  reviewed metadata locks, offline crate compilation, and legacy release URLs (#152).
