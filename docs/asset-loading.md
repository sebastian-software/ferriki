# Standard asset loading in Node

Ferriki's Node package uses Node's built-in `fetch` to load the release-pinned
grammar and theme payloads. Node 22.13 is the package floor and includes the
global fetch API. The native planner resolves aliases and embedded grammars
from the packaged manifests, checks the digest-addressed cache, and returns
only missing payloads. Each asset has a 60-second network deadline, and each load uses
up to six download workers. Separate loads can have more downloads in flight;
matching cache targets share a transfer. Node bounds decoded response bytes to
the release-pinned size, hashes them as they arrive, and installs verified
files through a temporary file and rename. The native catalog verifies cached bytes
again when it reads them. Transient connection or response-stream failures and
HTTP 408, 429 and 5xx responses receive up to two retries, with exponential
backoff inside that same deadline. A `Retry-After` pause of at most five seconds
is honored; a longer pause fails rather than retrying early. Permanent HTTP,
certificate and integrity errors fail directly. Failed attempts remove partial
files before retrying, and overlapping loads share the complete retry operation.

The optional Rust `remote` feature applies the same attempt limits, backoff,
`Retry-After` handling and network deadline through `ureq`. Rust verifies the
received bytes before writing them to the cache. Node still uses its host
runtime for HTTP, proxy and certificate configuration; Rust's transport uses
the platform trust store.

## Protected downloads

Set `FERRIKI_ASSETS_PROTECTED=1` to select the protected default CDN, and set
`FERRIKI_DOWNLOAD_TOKEN` to the bearer token supplied for the download issuer.
This setting applies to both the Node loader and Rust's `remote` feature. A
verified cache hit or an offline load needs no token. A cache miss in protected
mode requires a token and the default asset origin; a custom mirror is rejected
and never receives the token. Without protected mode, existing public CDN and
custom-mirror behavior is unchanged.

The issuer receives the canonical asset path and release-pinned SHA-256. The
client accepts only a signed HTTPS URL for that same path and the expected size
and digest. It sends no bearer to the CDN, refuses redirects, and verifies the
download against the release manifest before caching it. Protected failures do
not retry through the public CDN; optional prepared sidecars can still fall
back to compiling the verified grammar. Protected requests do not use the
public downloader's transient retry loop.

Prepared regex packages also cache their uncompressed containers under
`decoded/<sha256>`. The first load decompresses and verifies the container,
then saves it atomically with a `.verified` receipt of its size and modification
time. A fresh process compares the recorded state before and after reading.
Unchanged files skip both
SHA-256 and decompression. Changed files, legacy entries without a receipt, and
invalid receipts require a SHA-256 check before recording the current state.
The local cache and receipts are trusted; these stat checks detect ordinary
changes rather than authenticate against malicious local modification. Ferroni
still validates archive indexes and requested records.

The cache also saves a small derived `.index-v2` file with its own verification
receipt. On subsequent loads the registry opens the complete decoded file and
reads its index into Ferroni's `PrecompiledEagerRecords` store. It reads program
and group payloads only when a static scanner requests them and imports those
records directly without assembling reduced archives, keeping Ferroni's ordinary
validation. Repeated scanner use reuses the loaded data. File state is checked
before and after record reads; changed files or read failures fall back to
source compilation. Missing or changed indexes are rebuilt once from the verified
container. No memory mapping is used.

New prepared packages also delegate identical embedded scanners to the package
that defines them. Markdown keeps its own rules and host-specific combinations;
Rust scanners come from the Rust package when Rust is registered. Required
dependencies load their packages with the host; optional fenced-code languages
are not downloaded automatically. Multiple hosts reuse the same language package.
Container version 3 marks this composition; complete version-2 roots keep their
existing root-only loading behavior. All static contexts and anchor variants
remain covered across the cooperating packages.

Embedded catalogs, old manifests and caches that cannot persist an
index retain the shared owned-container path. `preparedBytesRead` in regex
diagnostics reports indexed payload reads, excluding index bytes; zero also
applies to source modes and owned imports.

The release manifest pins both representations. A detected damaged entry is
rebuilt from the verified download when available; an unwritable cache keeps
highlighting usable without persistence. Older releases keep their original
compressed-only behavior.

Keep the complete cache directory between builds to reuse this work. Decoded
containers take more disk space. Each process still needs file I/O, file-state
checks and runtime restoration; precompilation does not remove those costs.

## Configuration

`assets.remote`, `assets.baseUrl` and `assets.cacheDir` override the matching
process settings `FERRIKI_ASSETS_REMOTE`, `FERRIKI_ASSETS_BASE_URL` and
`FERRIKI_CACHE_DIR`. Remote loading is enabled by default; set `remote: false`
or `FERRIKI_ASSETS_REMOTE=0` to require a populated cache. The default mirror
is `https://assets.ferriki.dev`.

An explicit `assets.cacheDir` takes priority over `FERRIKI_CACHE_DIR`. Without
either, Node searches upward to the nearest directory containing `package.json`;
if that directory has a `node_modules` directory, it uses
`node_modules/.cache/ferriki`, and otherwise falls back to the platform cache
without searching farther up. The cache stores one file per SHA-256 digest and reuses unchanged
payloads across releases. Set `FERRIKI_ASSETS_BASE_URL` or `assets.baseUrl` to
the root of a mirror that serves `<language-id>/<short-hash>` and
`themes/<theme-id>/<short-hash>`. The manifest verifies the complete compiled payload with SHA-256;
IDs are canonical, so aliases use the same object. Each Ferriki version keeps
its fixed catalog and hashes. Updates append new objects without changing
payloads used by older releases that use immutable Storage objects. The public
CDN rejects legacy `<commit>/assets/shiki/<path>` URLs as of October 16, 2026.
Ferriki 1.1.0 and later use the short-hash catalog. For older releases,
existing installs need a populated cache or a custom mirror. See the
[migration note](./migrations/legacy-cdn.md).

Synchronous factories, loads and highlighting read only the cache. Load
standard grammars and themes through the asynchronous API first, or prepopulate
the cache for offline use.

## Cache maintenance and permissions

### Disk layout and sizing

The cache directory holds two tiers of content-addressed files:

- `<cacheDir>/<sha256>`: release payloads — Postcard-encoded `.fkgram` and
  `.fktheme` assets, and Zstd-compressed `.fkbc` sidecars.
- `<cacheDir>/decoded/<sha256>`: decompressed prepared regex containers, plus
  their derived `<sha256>.index-v2` record indexes and small JSON `.verified`
  stat receipts (`size`, `modified_secs`, `modified_nanos`).

Prepared `.fkbc` containers expand substantially on decompression (up to ~38x
across the standard catalog, bounded by a 512 MiB per-container safety cap and a
16 MiB cap per `.index-v2` file). Size persistent CI or container volumes for
the decoded set of languages your workload actually loads rather than only the
compressed download sizes. Temporary atomic write files are renamed into place
on completion (root download temp files start with `<sha256>.` and derived-cache
temp files under `decoded/` use `.*.tmp`); any leftover temp file from a crashed
process can be deleted when idle.

### Safe pruning

- **Legacy `.index-v1` files:** Older releases wrote `decoded/<sha256>.index-v1`
  (and `.index-v1.verified`). Current runtimes read `.index-v2` only; legacy
  `.index-v1*` files can be removed safely at any time.
- **Derived `decoded/` files:** Deleting any file under `decoded/` (containers,
  `.index-v2`, or `.verified` receipts) while idle is safe (avoid deleting
  active temporary files while another process is publishing cache entries).
  Ferriki re-verifies or rebuilds decoded entries on demand from the compressed
  `<cacheDir>/<sha256>` payload, or falls back to compiling the grammar from
  source. Deleting a container's `.verified` receipt forces full SHA-256
  re-verification of that container on the next read without discarding cached
  data; deleting only an index `.verified` receipt triggers an index rebuild
  while reusing the container's valid receipt.
- **Stale release digests:** Because cache entries are named by SHA-256 digest,
  upgrading Ferriki leaves superseded digests behind so older versions can share
  one cache. Prune shared caches while idle and retain the digests required by
  every Ferriki release still sharing that directory. To reclaim space when only
  the current release is needed, remove files whose digest is not listed in the
  active `release-manifest.json` (`assets[path].sha256` at the root and
  `assets[path].decoded.sha256` under `decoded/`), or clear the cache directory
  and re-warm it during a build step.

### Multi-tenant and CI directory permissions

`.verified` receipts store file size and modification time so warm restarts can
skip repeating SHA-256 over unchanged decoded containers and reuse unchanged
derived indexes (derived indexes are checked against their stat receipts and
rebuilt on mismatch rather than SHA-256 hashed). They are a local change
detector, **not** a cryptographic authentication boundary against a user who
already has write access to `FERRIKI_CACHE_DIR`.

- Isolate `FERRIKI_CACHE_DIR` per OS user, tenant, or CI trust boundary. Do not
  point it at a shared world-writable directory (such as `/tmp` directly) or
  share a writable cache across mutually untrusted tenants.
- Restrict write access on single-user caches to the owning service account
  (for example `0700`).
- In shared containers or CI runners, pre-warm the cache during image build or a
  trusted setup step and mount it read-only (`0555`/`0444`) at runtime. An
  unwritable derived container, index, or `.verified` receipt is recoverable
  (highlighting falls back to in-memory decoding or source compilation), whereas
  a cache miss for a required grammar or theme payload still fails on a
  read-only mount.

## Environment variables

All `FERRIKI_*` asset-loading and diagnostic environment variables recognized by
`@ferriki/core` and the Rust `ferriki` crate (with the `remote` feature):

| Variable                         | Scope / Default & Accepted values                                                                                | Effect                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FERRIKI_ASSETS_REMOTE`          | Runtime; enabled by default (`0` or `false`, trimmed & case-insensitive, disables downloads)                     | Enables or disables network fetches on cache misses. Overridden by `assets.remote` (Node) or `RemoteAssets::with_remote` (Rust).                                                                        |
| `FERRIKI_ASSETS_BASE_URL`        | Runtime; `https://assets.ferriki.dev`                                                                            | Mirror base URL serving `<language-id>/<short-hash>` and `themes/<theme-id>/<short-hash>`. Overridden by `assets.baseUrl` / `with_base_url`.                                                            |
| `FERRIKI_CACHE_DIR`              | Runtime; Node: `node_modules/.cache/ferriki` under nearest `package.json` dir if present, else platform cache; Rust: `<platform>/ferriki` | Digest-addressed cache directory. Overridden by `assets.cacheDir` (Node) or `RemoteAssets::with_cache_dir` (Rust).                                                                                      |
| `FERRIKI_ASSETS_PROTECTED`       | Runtime; unset, empty/whitespace, `0`, or `false` disables; `1` or `true` enables (trimmed & case-insensitive)   | Selects the protected default CDN for cache misses (requires `FERRIKI_DOWNLOAD_TOKEN`, rejects custom mirrors). Invalid values fail when planning or attempting a download that consults this setting.  |
| `FERRIKI_DOWNLOAD_TOKEN`         | Runtime; unset (required on cache misses when `FERRIKI_ASSETS_PROTECTED=1`)                                      | Bearer token sent to the protected download issuer. Never sent to custom mirrors or CDN object URLs; unused on cache hits or offline loads.                                                             |
| `FERRIKI_RELEASE_COMMIT`         | Build-time only (`option_env!`); crates.io builds embed the 40-hex commit from `.cargo_vcs_info.json`            | Fallback commit SHA for legacy commit-routed manifests (`40` or `64` hex digits validated on URL build). Rust precedence: `RemoteAssets::commit` → manifest `commit` → compile-time `FERRIKI_RELEASE_COMMIT`; Node uses manifest `commit` → compile-time value. Not read from the running process; unused by current `language-hash-v2` catalogs. |
| `FERRIKI_PROFILE_PREPARED_PAIRS` | Runtime (diagnostic builds only, requires `ferriki-textmate` feature `prepared-load-profile`)                    | When set to any value, emits JSON lines on `stderr` for indexed prepared-record reads and insertions. No effect in ordinary release builds.                                                             |

For contributor build, cross-compilation, and test-harness variables, see
[CONTRIBUTING.md](../CONTRIBUTING.md#build-and-development-environment-variables).

## Proxies and certificates

Ferriki uses the host Node runtime's fetch and TLS configuration. Proxy and
certificate behavior therefore depends on the Node version and differs from
the optional Rust `remote` feature, which uses `ureq` with the platform
verifier. In particular, setting `HTTP_PROXY` or `HTTPS_PROXY` alone does not
configure built-in fetch on Ferriki's minimum Node version.

| Setting                               | Node support                 | Effect                                                                                                          |
| ------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NODE_USE_ENV_PROXY=1`                | 22.21+ or 24.0+              | Makes built-in fetch use the environment proxy variables, including `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`. |
| `--use-env-proxy`                     | 22.21+ or 24.5+              | Enables the same environment-proxy behavior from the Node command line.                                         |
| `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` | Supported by the 22.13 floor | Adds the PEM certificates to Node's trusted roots. Node reads this variable when the process starts.            |
| `NODE_USE_SYSTEM_CA=1`                | 22.19+ or 24.6+              | Adds system CA certificates to Node's trusted roots.                                                            |
| `--use-system-ca`                     | 22.15+ or 24.0+              | Enables system CA loading from the Node command line.                                                           |

Configure these variables before starting the Node process. On the minimum
Node 22.13 release, use `NODE_EXTRA_CA_CERTS` for a corporate certificate
authority; use a Node release with environment-proxy support or configure a
compatible proxy-aware fetch dispatcher when the network requires a proxy. Node documents current
details in its [enterprise network configuration guide](https://nodejs.org/learn/http/enterprise-network-configuration)
and [CLI reference](https://nodejs.org/api/cli.html).
