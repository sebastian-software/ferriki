# ADR 0013: Standard Assets Loaded From a Release-Pinned CDN Mirror

## Status

Accepted

Last updated: 2026-10-02

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

- **Release manifest.** Each release carries the release commit SHA and, for
  every payload, its path, SHA-256 digest, byte size and format version,
  together with the language and theme metadata (IDs, aliases,
  embedded-language references, injections). The metadata stays in the two
  binary catalog manifests; `assets/shiki/release-manifest.json` adds the
  digest, size and format version per payload path. The repository copy has no
  commit, because a file cannot contain the SHA of the commit that adds it; the
  release build writes the release commit into the packaged copies. Both ship
  inside `@ferriki/core` and inside the `ferriki` crate, so language and theme
  resolution, aliases and error messages work without network access. A test
  fails when a committed payload and the release manifest disagree.
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
- **Resolution order.** An asset is taken from the local cache when a valid
  copy is there, and otherwise from the remote base URL.
- **No offline packages.** The CDN is the only published source of payloads;
  there is no npm package and no crate that bundles the catalog. Offline and
  air-gapped use has three answers that need no extra release artifact: a
  mirror of the repository's `assets/shiki/` at the release commit behind
  `FERRIKI_ASSETS_BASE_URL`, a cache pre-populated by one online run (for
  example a CI cache or a container layer), and, in Rust, the directory and
  embedded sources over a checkout.
- **Remote fetching is on by default in Node.** Without bundled payloads,
  nothing would highlight out of the box otherwise. `createHighlighter`
  accepts `assets: { remote, baseUrl, cacheDir }`. For the shorthand functions,
  whose internal highlighter no option reaches, and for CI, the process-wide
  `FERRIKI_ASSETS_REMOTE=0` (or `false`), `FERRIKI_ASSETS_BASE_URL` and
  `FERRIKI_CACHE_DIR` apply; an explicit option wins over the environment. The
  base URL is configurable so organizations can use their own mirror. With
  remote fetching off, a missing asset fails with a typed error that names the
  remedies: allow remote assets, point the base URL at a mirror, or
  pre-populate the cache.
- **Cache location.** Node uses `node_modules/.cache/ferriki/` of the nearest
  package root, following the common `find-cache-dir` convention, and falls
  back to `$XDG_CACHE_HOME/ferriki` or `~/.cache/ferriki`. Rust uses the
  platform cache directory plus `ferriki` (`$XDG_CACHE_HOME` or `~/.cache` on
  Linux, `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows).
  `FERRIKI_CACHE_DIR` overrides the location. Both runtimes store one file per
  SHA-256 digest, written through a temporary file and a rename, so they can
  share a cache. A cached file that fails its digest is replaced by a fresh
  download. The cache is never evicted: entries are immutable and addressed by
  digest.
- **Failure handling.** An unreachable CDN or a failed download is a typed
  error. There is no retry policy.
- **Loading stays asynchronous.** Remote resolution happens only in the
  asynchronous `createHighlighter`, `getSingletonHighlighter` and
  `loadLanguage`/`loadTheme` paths, and in the one-shot functions for the
  languages and themes they are given. Synchronous factories, loads and
  highlighting never perform I/O beyond the cache and report a payload that is
  not cached as `ERR_ASSET`, naming the remedies.
- **Node transport.** An N-API async task runs the network-free Rust planner
  on the libuv thread pool. It resolves aliases and embedded languages from
  the packaged manifests, verifies existing cache entries and returns only
  missing assets with their pinned path, digest, size and URL. The JavaScript
  host uses Node's built-in `fetch` with at most six download workers per load.
  Separate loads can have more downloads in flight, while matching in-process
  cache targets share one transfer. Each request has a 60-second timeout; the
  stream enforces the release-pinned byte limit, hashes bytes as they arrive,
  and installs verified files through a temporary file and rename.
  Rust verifies the cache again when the synchronous catalog reads a payload.
  The addon does not compile the Rust HTTP or TLS stack. Node proxy and
  certificate configuration is documented in
  [`docs/asset-loading.md`](../docs/asset-loading.md).
- **Rust asset sources.** `ferriki` exposes a public `AssetSource` trait keyed
  by digest, with directory and embedded sources, and
  `StandardAssetCatalogs::from_release_manifest` for any source. The `remote`
  cargo feature adds `StandardAssetCatalogs::remote(RemoteAssets)`, which
  compiles in both catalog manifests and the release manifest and downloads
  payloads on first use. `RemoteAssets` mirrors the Node settings (`remote`,
  `base_url`, `cache_dir`, plus `commit`) and falls back to the same
  environment variables. The feature is off by default, so the library stays
  free of network code unless a consumer opts in.
- **Rust HTTP and TLS.** The `remote` feature uses the blocking `ureq` client,
  matching the synchronous `AssetSource::read`, with rustls on ring and the
  operating system's trust store (`rustls-platform-verifier`), so corporate
  certificate authorities and TLS inspection work and `HTTPS_PROXY` is
  honored. The client is compiled only outside wasm32; a wasm build needs its
  own fetch path ([ADR 0009](0009-native-only-runtime.md)).
- **Release commit in Rust.** `cargo publish` writes `.cargo_vcs_info.json`
  with the packaged commit, which for a release is the tagged release commit.
  The crate's build script reads it, so a published crate knows where its
  payloads live. A build from a checkout has no such file and must pass the
  commit explicitly.

**Implementation state.** Implemented: the release manifest and its drift
test, the Bunny pull zone, the Rust `AssetSource` trait with digest
verification, the Rust `remote` feature with the manifests shipped inside the
`ferriki` crate, and the Node path: `@ferriki/core` ships only the manifests,
the release workflow stamps the release commit into the packaged release
manifest, Rust plans and verifies payloads, and the facade downloads them with
Node's built-in fetch. Repository checks read a cache seeded from `assets/shiki/`
with downloads turned off. After publishing, `verify-npm-publish.mjs` installs
the public package, checks its commit, highlights from an empty cache, and
verifies every pinned payload on `assets.ferriki.dev` by SHA-256.

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
- Offline and air-gapped builds, and CI without network access, must
  pre-populate the cache or point the base URL at a mirror. The documentation
  and the error messages must say so.
- A default install contacts `assets.ferriki.dev`. The documentation needs a
  privacy note and the opt-out. The CDN is paid for by the maintainers'
  company; at a few hundred kilobytes per project and first use, the expected
  cost is small.
- A release publishes no additional package: one npm package plus the
  platform sidecars, and three crates, as before.
- Rust consumers that enable `remote` inherit ureq and rustls. cargo-deny sees
  `webpki-root-certs` (CDLA-Permissive-2.0) through a wasm32-only dependency of
  the platform verifier, because it checks the union of all targets;
  `deny.toml` carries a narrow exception for that crate.
- The on-disk layout of the npm package and the Rust asset API change before
  1.0. [ADR 0011](0011-ferriki-1.0-api-contract.md) and the API contract
  documents must list the new options and errors before they are frozen.
- One package per language and a bundled subset of languages are both ruled
  out.

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
