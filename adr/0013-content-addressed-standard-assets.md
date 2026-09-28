# ADR 0013: Content-Addressed Standard Assets Served From a CDN

## Status

Proposed

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

Standard assets become content-addressed, immutable files that are served from
a CDN. No release package bundles grammar or theme payloads; every release ships
only a small manifest that pins them.

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
  `@ferriki/core` and inside the `ferriki` crate, so language and theme
  resolution, aliases and error messages work without network access.
- **No bundled payloads.** `@ferriki/core` contains the JavaScript facade, the
  types and the manifest, but no grammar or theme payloads.
- **Asset package as CDN origin and offline source.** One additional npm
  package, `@ferriki/assets`, contains every content-addressed file of the
  release. It is published once per release, not once per language. npm CDNs
  such as jsDelivr serve its files individually and immutably, which makes it
  the default remote origin. Installing it makes the whole catalog available
  offline.
- **Resolution order.** An asset is taken from the first source that has it: an
  installed `@ferriki/assets`, the local cache, and then the remote base URL.
  Remote bytes are verified against the manifest digest before they are decoded
  or cached; a mismatch is a typed error and is never cached. A payload whose
  format version does not match the runtime is a typed error as well.
- **Remote fetching is on by default in Node.** Without bundled payloads,
  nothing would highlight out of the box otherwise. An option and an
  environment variable turn it off for offline, air-gapped or
  privacy-sensitive environments. With remote fetching off, a missing asset
  fails with a typed error that names the remedies: install `@ferriki/assets`,
  pre-populate the cache, or allow remote assets. The base URL is configurable
  so organizations can use a mirror.
- **Loading stays asynchronous.** Remote resolution happens only in the
  asynchronous `createHighlighter` and `loadLanguage`/`loadTheme` paths.
  Synchronous highlighting never performs I/O and reports an unloaded language
  as it does today.
- **Rust asset sources.** The private `AssetStore` enum becomes a public
  `AssetSource` trait keyed by digest. `ferriki` provides directory and
  embedded sources, and a `remote` cargo feature provides a verified, caching
  remote source. The feature is off by default, so the library stays free of
  network code unless a consumer opts in. A `ferriki-assets` crate embeds the
  full catalog for Rust consumers that want everything offline, so crates.io
  consumers have a supported way to get the standard assets.

## Consequences

- `@ferriki/core` shrinks from 9.0 MB to roughly 225 KB, plus the platform
  addon. A Ferromark combination package carries no catalog either and uses
  the same sources.
- Each release additionally publishes `@ferriki/assets` and the `ferriki-assets`
  crate. The release checks must prove that every manifest digest resolves to a
  file in both and that the CDN URLs of a published release answer with the
  expected bytes.
- By default, the first use of any language or theme needs network access to
  the CDN, and adds download latency. After that the cache and immutable file
  names make it free.
- Offline and air-gapped builds, and CI without network access, must install
  `@ferriki/assets` or pre-populate the cache. The documentation and the error
  messages must say so.
- Remote fetching introduces a cache directory, cache eviction, and a privacy
  note, because a default install contacts a CDN. The CDN becomes part of the
  supported runtime path, and its availability and integrity become a release
  concern; the digest check covers integrity.
- The on-disk layout of the npm package and the Rust asset API change before
  1.0. [ADR 0011](0011-ferriki-1.0-api-contract.md) and the API contract
  documents must list the new options and errors before they are frozen.
- One package per language and a bundled subset of languages are both ruled
  out.
