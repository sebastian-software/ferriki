# ADR 0013: Standard Assets Loaded From a Release-Pinned CDN Mirror

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

Every release commit already contains the generated payloads under
`assets/shiki/`. GitHub serves any file of a public repository by ref and path
from `raw.githubusercontent.com`, for a tag and for a commit SHA alike. Verified
for `assets/shiki/languages/typescript.fkgram`: both refs of the 0.4.0 release
return the committed bytes. The same host cannot serve a blob by its hash
alone (404), and the REST API that can is rate-limited. `raw.githubusercontent.com`
also sends only `Cache-Control: max-age=300`, so it is an origin, not a CDN.

The binary asset format is internal and versioned. A release must never load a
payload written for an incompatible format version.

## Decision

No release package bundles grammar or theme payloads. Ferriki downloads them
itself, on demand, from a CDN that mirrors the repository at the release commit,
and verifies every file against a digest that the release pins.

- **Release manifest.** Each release carries a manifest with the release commit
  SHA and, for every language ID, alias and theme ID, the payload path, SHA-256
  digest, byte size and format version, together with the metadata the
  manifests already hold (aliases, embedded-language references, injections).
  The manifest ships inside `@ferriki/core` and inside the `ferriki` crate, so
  language and theme resolution, aliases and error messages work without
  network access.
- **No bundled payloads.** `@ferriki/core` contains the JavaScript facade, the
  types and the manifest, but no grammar or theme payloads.
- **CDN as a 1:1 mirror of the repository.** The default base URL is
  `https://assets.ferriki.dev`. It maps request paths 1:1 onto
  `https://raw.githubusercontent.com/sebastian-software/ferriki`, so a payload
  URL is `https://assets.ferriki.dev/<release-commit>/assets/shiki/languages/typescript.fkgram`.
  Ferriki builds these URLs from the manifest and always uses the commit SHA,
  never a tag, because commits cannot be moved. A tag in place of the commit
  works for manual access.
- **Hosting.** `assets.ferriki.dev` is a Bunny pull zone owned by the
  maintainers' company, with `raw.githubusercontent.com/sebastian-software/ferriki`
  as origin and a CNAME at the `ferriki.dev` registrar. The pull zone overrides
  the origin cache lifetime to at least a year, which is safe because every URL
  is pinned to an immutable commit. An edge rule serves only paths below
  `/<ref>/assets/shiki/`. Because clients know only the own hostname, the
  provider or the origin can change without breaking released versions.
- **Integrity and deduplication.** Downloaded bytes are verified against the
  manifest digest before they are decoded or cached; a mismatch is a typed
  error and is never cached. The local cache is keyed by that digest, so a
  payload that did not change between releases is not downloaded again even
  though its URL contains a different commit. A payload whose format version
  does not match the runtime is a typed error as well.
- **Resolution order.** An asset is taken from the first source that has it: an
  optional installed `@ferriki/assets` package, the local cache, and then the
  remote base URL. `@ferriki/assets` holds every payload of the release and
  exists for offline and air-gapped use; installing it is never required.
- **Remote fetching is on by default in Node.** Without bundled payloads,
  nothing would highlight out of the box otherwise. An option and an
  environment variable turn it off, and the base URL is configurable so
  organizations can use their own mirror. With remote fetching off, a missing
  asset fails with a typed error that names the remedies: install
  `@ferriki/assets`, pre-populate the cache, or allow remote assets.
- **Cache location.** Node uses `node_modules/.cache/ferriki/` of the nearest
  package root, following the common `find-cache-dir` convention, and falls
  back to `$XDG_CACHE_HOME/ferriki` or `~/.cache/ferriki`. Rust uses the
  platform cache directory. An environment variable overrides the location.
  The cache is never evicted: entries are immutable and addressed by digest.
- **Failure handling.** An unreachable CDN or a failed download is a typed
  error. There is no retry policy.
- **Loading stays asynchronous.** Remote resolution happens only in the
  asynchronous `createHighlighter` and `loadLanguage`/`loadTheme` paths.
  Synchronous highlighting never performs I/O and reports an unloaded language
  as it does today.
- **Rust asset sources.** The private `AssetStore` enum becomes a public
  `AssetSource` trait keyed by digest. `ferriki` provides directory and
  embedded sources, and a `remote` cargo feature provides the verified, caching
  CDN source with the same URL scheme. The feature is off by default, so the
  library stays free of network code unless a consumer opts in. A
  `ferriki-assets` crate embeds the full catalog for Rust consumers that want
  everything offline.

## Consequences

- `@ferriki/core` shrinks from 9.0 MB to roughly 225 KB, plus the platform
  addon. A Ferromark combination package carries no catalog either and uses
  the same sources.
- No new artifact is needed for the default path: the payloads stay where the
  asset pipeline already commits them, and the release commit pins them. The
  repository must stay public, and release commits must never be rewritten or
  garbage-collected, because released versions resolve their assets through
  them.
- The release checks must prove that the manifest digests match the files at
  the release commit, and after publishing, that the CDN URLs of the release
  answer with the expected bytes.
- By default, the first use of any language or theme needs network access to
  `assets.ferriki.dev` and adds download latency. After that the cache makes it
  free. On a CDN cache miss, availability also depends on GitHub.
- Offline and air-gapped builds, and CI without network access, must install
  `@ferriki/assets`, pre-populate the cache, or point the base URL at a mirror.
  The documentation and the error messages must say so.
- A default install contacts `assets.ferriki.dev`. The documentation needs a
  privacy note and the opt-out. The CDN is paid for by the maintainers'
  company; at a few hundred kilobytes per project and first use, the expected
  cost is small.
- Each release additionally publishes the optional `@ferriki/assets` package
  and the `ferriki-assets` crate.
- The on-disk layout of the npm package and the Rust asset API change before
  1.0. [ADR 0011](0011-ferriki-1.0-api-contract.md) and the API contract
  documents must list the new options and errors before they are frozen.
- One package per language and a bundled subset of languages are both ruled
  out.
