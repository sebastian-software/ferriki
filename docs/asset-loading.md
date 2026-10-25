# Standard asset loading in Node

Ferriki's Node package uses Node's built-in `fetch` to load the release-pinned
grammar and theme payloads. Node 22.13 is the package floor and includes the
global fetch API. The native planner resolves aliases and embedded grammars
from the packaged manifests, checks the digest-addressed cache, and returns
only missing payloads. Each request has a 60-second timeout, and each load uses
up to six download workers. Separate loads can have more downloads in flight;
matching cache targets share a transfer. Node bounds decoded response bytes to
the release-pinned size, hashes them as they arrive, and installs verified
files through a temporary file and rename. The native catalog verifies cached bytes
again when it reads them. Failed downloads are not retried.

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
either, Ferriki uses `node_modules/.cache/ferriki` under the nearest package
root that has a `node_modules` directory, then falls back to the platform
cache. The cache stores one file per SHA-256 digest and reuses unchanged
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
