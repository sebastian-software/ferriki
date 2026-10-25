# Prepared assets: persistent decoded cache

Local diagnostic, October 25, 2026. This measures whether preserving decoded
packages makes a new process cheaper to initialize. It does not replace the
retained [Blacksmith policy comparison](../../blacksmith/2026-10-25-regex-modes/README.md).

The old cache kept compressed downloads. Every process read and verified them,
decompressed their full contents, and then opened Ferroni's program/group pair.
The Node planner also verified compressed bytes before the catalog verified
them again. The new cache saves the decoded container on its first use. A
fresh process checks availability during planning, then reads and verifies the
decoded bytes once before opening the pair. SHA-256 verification remains in
place; decompression moves to the first cache fill. The registry's slice importer
also avoids a temporary copy of the complete container into an Arc.

[`sha2` 0.11](https://github.com/RustCrypto/hashes/blob/sha2-v0.11.1/sha2/CHANGELOG.md)
supplies runtime ARM64 SHA acceleration in portable builds. An
additional BLAKE3 cache-verification experiment was slower on this host and
was rejected. It is not a production dependency.

## Boundary and controls

- Apple M1 Ultra, 20 cores, 64 GiB RAM, macOS Darwin 27.0.0, Node 24.22.0,
  Rust 1.99.0; optimized native addon, ordinary release profile and no custom
  target CPU flags. See `builds.json` for binary and Rust-source identities.
- Five fresh processes per mode, scenario and candidate, in rotating serial
  order. The same frozen JS facade and input strings serve both addons.
  `inputs.json.gz` stores the exact inputs, including source-file hashes.
- The repository cohort contains twelve documents and twelve requested grammar
  roots. SQL and YAML are excluded. The second cohort contains one TypeScript
  document expanded to 265,165 bytes. Runtime diagnostics require exactly twelve
  and one prepared archives respectively, actual loaded groups, and no invalid
  groups or assembly fallbacks. Source controls must open no archives.
- Compressed payloads are pre-populated outside the timer. Only requested roots
  and their dependencies load at runtime. `assets.json` pins the unchanged
  payloads: 38.93 MiB compressed / 467.43 MiB decoded for twelve roots, and
  3.21 MiB / 51.49 MiB for TypeScript alone. Complete static coverage is retained.
- Setup includes the asynchronous highlighter factory, local asset planning,
  verified reads, grammar/theme loading and archive opening. First render is
  separate. Module import and total import-through-first-render are recorded
  too. Process creation, corpus reads, downloads and package generation are
  outside the timer. No other builds or tests run during measurement.
- First-fill samples start with no decoded files and include decompression,
  decoded verification and disk-cache writes. Warm-cache samples start in a
  new process after an untimed process populated that scenario's decoded cache.
  Filesystem pages may be warm; this is not a physical disk cold-start test.
- Execution samples follow five warmup passes and contain ten complete render
  passes per process. Every mode/candidate produces the same complete HTML
  hashes; repeated rendering preserves those hashes. Summaries use the median
  process result (the upper median of ten execution passes within each process),
  with raw samples retained. Timing noise is not a regression
  threshold.

## Results

The committed `results.json.gz` contains startup phases, execution samples,
output hashes and runtime diagnostics. The separate rejected experiment is
retained as `rejected-blake3.json.gz`.
It used BLAKE3 1.8.7 with default features and a release-pinned decoded BLAKE3
digest in addition to the SHA-256 filename. Reads, cache layout, engine and
workloads stayed the same; no parallel hashing or custom target flags were used.

<!-- results:start -->

All values are milliseconds. Parentheses show the minimum–maximum across five processes.

| Workload         | Cache state                       |                  Setup |           First render | Import through first render |
| ---------------- | --------------------------------- | ---------------------: | ---------------------: | --------------------------: |
| repository       | Before: compressed cache          | 568.09 (558.68–595.23) | 227.06 (220.78–240.62) |      801.44 (784.82–841.12) |
| repository       | After: first decoded fill         | 842.91 (672.11–970.33) | 231.42 (226.31–264.56) |    1088.99 (909.14–1201.65) |
| repository       | After: decoded cache, new process | 383.22 (365.11–397.82) | 233.12 (219.39–279.15) |      622.43 (590.11–678.94) |
| large-typescript | Before: compressed cache          |    62.21 (60.82–67.89) | 316.38 (311.89–347.94) |      382.93 (379.64–421.36) |
| large-typescript | After: first decoded fill         |    85.78 (74.92–97.53) | 309.63 (298.44–327.17) |      399.83 (378.52–430.79) |
| large-typescript | After: decoded cache, new process |    48.50 (46.50–51.79) | 311.55 (299.63–327.49) |      364.50 (353.50–385.59) |

Setup falls by **32.5%** for the twelve-root cohort and **22.0%** for TypeScript.
These figures compare warm decoded caches in new processes with the previous
compressed-only cache; they do not include network transfers.

| Workload         | Mode     | Before setup | After setup | Before execution/pass | After execution/pass |
| ---------------- | -------- | -----------: | ----------: | --------------------: | -------------------: |
| repository       | off      |        16.45 |       11.65 |                127.78 |               128.37 |
| repository       | auto     |        16.52 |       11.73 |                 72.17 |                71.79 |
| repository       | eager    |        16.27 |       11.43 |                 71.47 |                73.59 |
| repository       | prepared |       568.09 |      383.22 |                122.58 |               123.30 |
| large-typescript | off      |        10.10 |        7.71 |                234.97 |               241.61 |
| large-typescript | auto     |        10.09 |        7.40 |                213.76 |               214.00 |
| large-typescript | eager    |        10.36 |        7.53 |                220.74 |               216.45 |
| large-typescript | prepared |        62.21 |       48.50 |                305.88 |               291.01 |

Source-control execution changes range from −1.9% to +3.0% in this capture.
The earlier independent capture (`replicate-a.json.gz`) is retained too; its
prepared setup medians were 573.68 → 384.39 ms and 60.99 → 49.19 ms. Its first-fill
medians were 694.24 ms and 76.90 ms, illustrating greater variability when writing
the derived cache. The final-build table above is not merged with that capture.

<!-- results:end -->

Decoded caching reduces repeat setup work. The first fill can cost more than
the previous compressed-only load because it also verifies and writes the
decoded file. Retaining the cache amortizes that work across builds. Each
process still reads a larger file, checks its SHA-256, allocates program/group
storage and restores the runtime. These measurements do not establish
Source-Off startup parity or a Shiki startup advantage.

Ferroni's [October 24 startup evidence](https://github.com/sebastian-software/ferroni/tree/9e6470dfaa4ec7d1ef39a7a3b537c3a3571a0779/benches/diagnostics/textmate-startup-20261024)
uses a different package boundary: its producer first tokenizes the fixed
document three times and exports encountered groups. Ferriki's standard
packages enumerate every static scanner group, including unused document paths.
The upstream loader includes bounded decompression and integrity checks but
excludes file I/O. Its initialization figures therefore do not predict this
full-package, file-backed workload. Ferroni's earlier in-memory archive tests
have a narrower boundary again.

The loader change does not improve scanner execution. Prepared remains slower
than source Eager on these two workloads, including TypeScript without SQL.
That difference already exists in the baseline and is separate from transport
decompression. It needs its own engine-level investigation; a loader speedup
must not be presented as execution parity.

## Reproduction

Materialize assets and build both native addons with the normal project build.
Save the baseline addon before rebuilding the candidate. Copy `node/ferriki`
to a temporary facade directory, including its top-level `.mjs` files, `src`,
package metadata and asset manifests. Both addons use the same facade and
the candidate release manifest; the baseline ignores additive decoded metadata.
Replace only that temporary facade's `native.mjs` with:

```js
import { createRequire } from "node:module";
export function loadFerrikiNativeBinding() {
  return createRequire(import.meta.url)(process.env.FERRIKI_BENCH_ADDON);
}
export function tryLoadFerrikiNativeBinding() {
  return loadFerrikiNativeBinding();
}
```

The production facade has no addon override. Extract the frozen inputs, then
run from the repository root:

```sh
gzip -dc docs/benchmarks/precompiled-patterns/decoded-cache/inputs.json.gz > /tmp/startup-inputs.json
node docs/benchmarks/precompiled-patterns/decoded-cache/reproduce.mjs \
  /tmp/frozen-facade /tmp/startup-inputs.json /tmp/baseline.node /tmp/candidate.node \
  assets/standard /tmp/startup-results.json
```

The runner creates and removes its own temporary cache. It verifies the
transport bytes when seeding that cache, creates decoded entries through the
actual highlighter, and times all requested modes in separate processes.
