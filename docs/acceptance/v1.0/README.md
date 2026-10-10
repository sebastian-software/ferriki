# Release acceptance probes and receipts

The parent [acceptance record](../v1.0.md) identifies the candidate commit,
CI runs, product boundaries and release decision. JSON receipts record actual
observations; they do not replace the public workflow results.

## Node regression probe

Create an empty consumer directory, copy `public-regression.mjs` into it, and
install the exact published version:

```sh
npm init --yes
npm install --save-exact --ignore-scripts @ferriki/core@0.14.0 @ferriki/vite@0.14.0
export FERRIKI_CANDIDATE_VERSION=0.14.0
export FERRIKI_CANDIDATE_SHA=1e8d363ee01c8c60af42d78e8129b74ed22fd362
unset FERRIKI_ASSETS_BASE_URL
FERRIKI_CACHE_DIR="$PWD/assets-cold" FERRIKI_ASSETS_REMOTE=1 node public-regression.mjs cold
FERRIKI_CACHE_DIR="$PWD/assets-cold" FERRIKI_ASSETS_REMOTE=0 node public-regression.mjs offline
FERRIKI_CACHE_DIR="$PWD/assets-retry" FERRIKI_ASSETS_REMOTE=1 node public-regression.mjs retry
npm audit signatures --json --include-attestations
```

The `assets-cold` and `assets-retry` directories must not exist before the
first invocation. The cold CSS shorthand loads exactly the JSON grammar and
nord theme. The offline invocation performs no fetch. Concurrent first calls
share one controlled failure, after which an explicit retry succeeds. The
probe checks the loaded native version, packaged release commit, cache sizes
and SHA-256 digests.

The all-platform signature audit separately installs all seven sidecars with
`npm install --force --ignore-scripts` so npm can verify every product
attestation on one host. That installation is for signature verification only;
it does not claim execution of other platforms' binaries. Runtime coverage
comes from the native CI matrix. In a separate empty consumer, run:

```sh
npm init --yes
npm install --force --ignore-scripts --save-exact \
  @ferriki/core@0.14.0 @ferriki/vite@0.14.0 \
  @ferriki/linux-x64-gnu@0.14.0 @ferriki/linux-arm64-gnu@0.14.0 \
  @ferriki/linux-x64-musl@0.14.0 @ferriki/linux-arm64-musl@0.14.0 \
  @ferriki/darwin-arm64@0.14.0 \
  @ferriki/win32-x64-msvc@0.14.0 @ferriki/win32-arm64-msvc@0.14.0
npm audit signatures --json --include-attestations
```

## Rust consumer probe

Copy `rust-consumer.rs` to `src/main.rs` in a fresh temporary Cargo project.
Use edition 2024, exact dependencies `ferriki = "=0.14.0"`,
`ferriki-textmate = "=0.14.0"`, and `ferriki-asset-gen = "=0.14.0"`, plus
`remote = ["ferriki/remote"]` in `[features]`.

From that new Cargo project, use fresh build directories and extract the
candidate assets from the exact tag. Replace the repository path below with
a Ferriki checkout that contains `v0.14.0`:

```bash
export CARGO_HOME="$PWD/cargo-home"
export CARGO_TARGET_DIR="$PWD/target"
mkdir assets
set -o pipefail
git -C /absolute/path/to/ferriki archive v0.14.0 assets/shiki | tar -x -C assets
cargo run -- "$PWD/assets/assets/shiki"
FERRIKI_CACHE_DIR="$PWD/remote-cache" FERRIKI_ASSETS_REMOTE=1 \
  FERRIKI_ASSETS_BASE_URL=https://assets.ferriki.dev cargo run --features remote
cargo metadata --format-version 1
```

The remote cache must be empty and `FERRIKI_TEST_COMMIT` unset. Check the
three registry dependencies in Cargo.lock and metadata, then compare their
packaged `.cargo_vcs_info.json` SHA with the release commit. Compare downloaded
cache files with the release manifest. The receipt records those identities,
checksums, sizes and the local Cargo toolchain.

For another release, change the exact versions and source SHA together and
use new consumer/cache directories. Do not reuse a warm environment as proof
of a cold start.
