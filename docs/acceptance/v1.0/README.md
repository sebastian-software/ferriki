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

## Ardo/Ferromark rehearsal

The retained [Ardo probes](ardo/) target macOS arm64 and the frozen four-fence
homepage fixture. For 0.14.0, use a new temporary Ferromark checkout at tag
`v3.1.0`, commit `15d4716921cde05a42ce381970c3555f19efa411`, and a new export of
Ferriki `1e8d363ee01c8c60af42d78e8129b74ed22fd362`. Keep these separate from
normal development checkouts.

1. Clone Ferromark with `--depth 1 --filter=blob:none --sparse --branch v3.1.0`
   from `https://github.com/sebastian-software/ferromark.git`; sparse-check out
   `src transforms node examples benches` and verify its commit. In this
   temporary root Cargo.toml only, set the Ferriki dependency to
   `ferriki = { version = "=0.14.0", optional = true, default-features = false }`.
   Run `cargo update -p ferriki --precise 0.14.0`, `cargo fetch --locked`,
   `cargo tree -p ferromark-node -i ferriki`, and
   `cargo check -p ferromark-node --locked --offline` with a fresh
   `CARGO_TARGET_DIR`. Check all three registry crate versions, archive
   checksums and packaged VCS identities against the release, as above.
2. From the temporary `node/`, run `corepack pnpm install` and
   `corepack pnpm --filter ferromark build:native` with that same target
   directory. Its build script invokes bare `pnpm`; if unavailable, prepend a
   temporary executable shim that forwards to `corepack pnpm "$@"`.
   Pack from `node/ferromark` and `node/ferromark/npm/darwin-arm64` with
   `corepack pnpm pack --pack-destination <absolute-temp-package-directory>`.
   Retain both 3.1.0 tarballs and the native addon SHA-256. From the temporary
   Ferromark root, run `node --test node/ferromark/test/jsx-highlighting.test.mjs`.
3. Export the exact Ferriki source with `git archive <source-sha> ... | tar -x -C <new-directory>`.
   Include `homepage/`, `assets/shiki/`, `node/ferriki/package.json`, and
   `docs/benchmarks/blacksmith-comparison.json` plus
   `docs/benchmarks/shiki-comparison.json`. In the temporary homepage's
   package.json, set `pnpm.overrides` for `@ferriki/core` and
   `@ferriki/darwin-arm64` to `0.14.0`; set `ferromark` and
   `ferromark-darwin-arm64` to the absolute `file:` paths of the two rebuilt
   tarballs. Run `corepack pnpm install` there and retain the resulting lock.
4. From the temporary homepage, run `corepack pnpm exec react-router build`,
   `node scripts/verify-build.mjs`, `node scripts/verify-ardo-acceptance.mjs`,
   and `corepack pnpm run browser:check`. Copy the four retained Ardo probes
   into that same directory and run `node verify-resolution.mjs <addon-sha256>`,
   `node verify-rebuilt-theme.mjs`, and
   `node verify-rebuilt-remote.mjs <source-sha> <absolute-export-root>`.
   The last probe starts its own loopback-only, manifest-validating asset
   mirror and checks cold/warm offline behavior and missing/corrupt recovery.

Retain the command outputs, lock/manifest hashes, npm URLs and integrities,
crate checksums/VCS identities and installed binary digests. For another
release, use fresh directories, change exact dependency versions and the
source SHA together, and update the version assertions in
`verify-resolution.mjs`. The rebuilt downstream tarballs are local acceptance
artifacts; do not publish them or add permanent overrides to the homepage.
