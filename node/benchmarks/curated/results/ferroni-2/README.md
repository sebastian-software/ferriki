# Ferroni 2.0.0 upgrade measurements

Measured on 2026-10-10 against Ferriki `75bef63` on an Apple M1 Ultra,
macOS arm64, Node 24.21.0, rustc 1.99.0. The baseline uses registry Ferroni
1.8.0; the candidate uses registry Ferroni 2.0.0 with its default
`dfa-prefilter` feature. Both use the same release profile and assets.

The update substantially reduces warm highlighting time, but increases the
first-highlight cost and regresses JSON and Astro workloads. It benefits
reused highlighters; it is not a universal performance improvement.

The warm JSON/Astro regressions and the secondary first-use costs are tracked in
[Ferroni issue #327](https://github.com/sebastian-software/ferroni/issues/327),
including the integration patch, reproduction steps, and raw JSON/Astro samples.

## Warm highlighting

The existing paired benchmark compares both addons in the same process with
rotating call order. Six independent processes, three warmup calls, and 20
timed calls per addon per case cover 19 supported TIOBE entries and 20 curated
entries, two sizes, and three output modes: 234 cases. Large inputs repeat
the fixture 16 times. Every case produces identical JSON-visible output
across versions and processes. Timings include output allocation and exclude
loading, compilation, and validation.

Changes below are runtime changes. Each process contributes a geometric mean
of per-case median candidate/baseline ratios; the reported value is the median
of those six means. The range is the observed minimum and maximum, not a
confidence interval.

| Output                   | Runtime change |      Process range | Cases |
| ------------------------ | -------------: | -----------------: | ----: |
| All outputs              |        -34.30% | -34.65% to -34.23% |   234 |
| Native HTML              |        -36.05% | -36.42% to -35.83% |    78 |
| Single-theme render data |        -35.18% | -35.53% to -35.08% |    78 |
| Two-theme render data    |        -31.64% | -31.93% to -31.53% |    78 |

| HTML corpus and size | Runtime change |
| -------------------- | -------------: |
| TIOBE example        |        -41.85% |
| TIOBE large          |        -43.62% |
| Curated example      |        -28.33% |
| Curated large        |        -29.71% |

Selected large curated HTML cases. Absolute times pool samples from all
processes; changes use the median per-process ratio:

| Language   | 1.8.0 (ms) | 2.0.0 (ms) | Runtime change |
| ---------- | ---------: | ---------: | -------------: |
| cpp        |     40.669 |      7.634 |        -80.89% |
| typescript |     15.877 |      7.481 |        -52.94% |
| java       |     11.093 |      4.292 |        -61.45% |
| rust       |      4.842 |      4.153 |        -14.05% |
| html       |     13.417 |      9.948 |        -25.97% |
| css        |      5.759 |      6.013 |         +5.21% |
| json       |      3.311 |      3.778 |        +14.11% |
| astro      |     15.418 |     20.605 |        +33.55% |

JSON and Astro regress by more than 5% in every process in all six of their
size/output combinations. CSS large HTML is about 5% slower (+3.94% to
+7.32% across processes). R and TOML large HTML also show smaller increases
(about 3% and 4%). This comparison does not isolate the cause from the other
Ferroni changes or the required capture adaptation.

## First highlight in a fresh process

Ten fresh Node processes per version and language, alternating version order,
measure addon loading, highlighter creation, one theme and grammar load, and
the first HTML render of the curated example. Each process loads one addon.
Node process startup itself is outside the timer; assets come from the local
cache. These are first-use costs, not filesystem-cold measurements.

| Language   | 1.8.0 total (ms) | 2.0.0 total (ms) | Ratio |
| ---------- | ---------------: | ---------------: | ----: |
| typescript |           86.925 |          206.697 | 2.38x |
| cpp        |          291.254 |          573.673 | 1.97x |
| scss       |           59.387 |          189.527 | 3.19x |
| rust       |            5.167 |           10.203 | 1.97x |
| html       |           75.258 |          175.487 | 2.33x |

The host addon grows from 2,325,488 to 2,789,168 bytes (+19.94%).

## Integration and validation

- Workspace dependency floor and both Cargo lockfiles move to Ferroni 2.0.0.
- Scanner configuration uses setters. Captures are read through `captures()`
  and copied into Ferriki's own internal capture shape.
- Public Ferriki API and declared Rust 1.94 minimum remain unchanged.
- `cargo test --workspace --all-features --locked`: 191 tests pass.
- `cargo fmt --all --check` and Clippy for all targets/features with
  `-D warnings`: pass.
- `pnpm run test:ferriki-compat:core`: passes the mandatory native compatibility
  gate and benchmark harness tests with the gate's existing exclusions.
- `cargo deny check`: passes; existing duplicate-version warnings for `syn`
  and `windows-sys` remain. The two new regex dependencies pass.

Ferroni 2.0 also lowers the default regex nesting limit. The exercised
grammars pass; custom patterns deeper than the new limit may now fail.
See the [upstream release notes](https://github.com/sebastian-software/ferroni/releases/tag/v2.0.0).

## Evidence and reproduction

- `paired.json.gz`: all warm samples, output hashes, addon hashes, and sizes.
- `summary.json`: grouped and per-case warm comparisons.
- `cold.json`: fresh-process samples and component timings.
- `baseline-build.json` and `candidate-build.json`: dependency, source,
  toolchain, profile, and addon identities.
- Compressed Rust test, native compatibility, Clippy, and cargo-deny logs.

Save each native addon after its corresponding build. Rebuild the unmodified
baseline at `75bef63` with its committed 1.8.0 lockfile; the current candidate
needs the scanner API adaptations in this change. From `node/`:

```sh
node scripts/bench-native-boundary-paired.mjs \
  --engine ferroni-1.8.0=/path/to/ferroni-1.8.0.node \
  --engine ferroni-2.0.0=/path/to/ferroni-2.0.0.node \
  --processes 6 --rounds 20 --themes single,multi,html --write paired.json
```

For the first-highlight probe, put both version-named addons in one directory
and run from the repository root:

```sh
FERRIKI_BENCH_ADDON_DIR=/path/to/addons \
  node node/benchmarks/curated/results/ferroni-2/cold-first-html.mjs
```

These measurements describe this machine and the recorded fixtures. Warm gains
do not automatically compensate for first-use costs in short-lived processes.
