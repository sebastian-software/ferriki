# ADR 0013: Content-Addressed Standard Assets With a Bundled Core Set

## Status

Proposed

## Context

[ADR 0006](0006-lazy-shiki-asset-loading.md) made standard grammars and themes
lazily loaded data, and [ADR 0012](0012-publishable-rust-highlighter.md) made
asset providers explicit catalogs backed by a directory or embedded bytes. Both
still assume that every consumer receives the complete standard catalog.

That assumption now dominates the package size. Measured on the 0.4 releases:

- `@ferriki/core` unpacks to 9.3 MB once the duplicated Linux addon is gone.
  8.8 MB of that is the standard catalog: 261 grammar files and 66 themes.
  The platform addon adds about 2.4 MB.
- The catalog is heavily skewed. `emacs-lisp` alone is 770 KB and `cpp` is
  465 KB, while about 23 common languages (JavaScript/TypeScript, CSS, HTML,
  JSON, YAML, Markdown, shell, Python, Rust, Go, Java, C/C++, SQL, and a few
  more) add up to about 1.6 MB. A theme is about 11 KB.
- The `ferriki` crate ships no assets. Rust consumers on crates.io have no
  supported way to obtain them other than copying `assets/shiki` from this
  repository.
- A native Ferromark + Ferriki combination package would have to carry the full
  catalog, which makes it several times larger than Ferromark itself.

One package per language, as Shiki's `@shikijs/langs-*` layout suggests, would
multiply the release matrix by more than 300 packages. That is not acceptable
for a project that already publishes eight npm packages and three crates per
release.

The binary asset format is internal and versioned. A release must never load a
payload written for an incompatible format version.

## Decision

Standard assets become content-addressed, immutable files. Every release ships
a small manifest that pins them, bundles a core set, and resolves the rest
through explicit asset sources.

- **Content addressing.** The asset generator names each grammar and theme
  payload by the SHA-256 digest of its bytes, for example
  `f1/f1c3…9a.fkgram`, under a directory for the asset format version. A file
  never changes once published. Identical payloads keep their name across
  releases, so unchanged grammars are not downloaded again, and different
  releases can use different versions of the same grammar or theme side by
  side.
- **Release manifest.** Each release carries a manifest that maps every
  language ID, alias and theme ID to its digest, byte size and format version,
  together with the metadata the manifests already hold (aliases,
  embedded-language references, injections). The manifest ships inside
  `@ferriki/core` and inside the `ferriki` crate, so it is always available
  offline.
- **Bundled core set.** `@ferriki/core` bundles a small, documented core set of
  common languages and themes (about 1.6 MB), chosen in this repository and
  covered by the compatibility checks. Everything else is resolved on demand.
- **Complete offline package.** One additional npm package, `@ferriki/assets`,
  contains every content-addressed file of the release. It is published once
  per release, not once per language. Installing it makes the whole catalog
  available offline. The same package is the default remote origin, because
  npm CDNs such as jsDelivr serve its files individually and immutably.
- **Resolution order.** An asset is taken from the first source that has it:
  the bundled core set, an installed `@ferriki/assets`, the local cache, and
  only then a remote base URL. Remote bytes are verified against the manifest
  digest before they are decoded or cached; a mismatch is a typed error and is
  never cached. A payload whose format version does not match the runtime is a
  typed error as well.
- **Remote fetching is explicit.** Nothing is downloaded unless the caller
  enables it or configures a base URL, in Node (option or environment
  variable) and in Rust (a cargo feature). Without it, a missing language fails
  with a typed error that names both remedies: install `@ferriki/assets` or
  enable remote assets. The base URL is configurable so organizations can use
  a mirror.
- **Loading stays asynchronous.** Remote resolution happens only in the
  asynchronous `createHighlighter` and `loadLanguage`/`loadTheme` paths.
  Synchronous highlighting never performs I/O and reports an unloaded language
  as it does today.
- **Rust asset sources.** The private `AssetStore` enum becomes a public
  `AssetSource` trait keyed by digest. `ferriki` provides directory and
  embedded sources; an optional feature provides a verified, caching remote
  source. The core highlighter itself stays free of network code. A
  `ferriki-assets` crate embeds the core set, or the full catalog behind a
  feature, so crates.io consumers have a supported way to get the standard
  assets.

## Consequences

- `@ferriki/core` shrinks from 9.3 MB to roughly 2 MB of JavaScript, manifest
  and core assets, plus the platform addon. A Ferromark combination package can
  embed the same core set instead of the full catalog.
- Each release additionally publishes `@ferriki/assets` and the `ferriki-assets`
  crate. The release checks must prove that every manifest digest resolves to a
  file in both, and that the core set is complete.
- A language outside the core set now needs either the extra package or a
  network fetch on first use. Offline and air-gapped builds must install
  `@ferriki/assets` or pre-populate the cache; the documentation and the error
  messages must say so.
- The first use of a remote asset adds download latency. After that the cache
  and immutable file names make it free.
- Remote fetching introduces a cache directory, cache eviction, and a privacy
  note, because a build contacts a CDN when it is enabled.
- The on-disk layout of the npm package and the Rust asset API change before
  1.0. [ADR 0011](0011-ferriki-1.0-api-contract.md) and the API contract
  documents must list the new options and errors before they are frozen.
- One package per language is ruled out.
