# Ferroni 2.1.0 and the prefilter switch

Measured on 2026-10-10 against Ferriki `75bef63` on an Apple M1 Ultra,
macOS arm64, Node 24.21.0, rustc 1.99.0. The paired comparison loads
registry Ferroni 1.8.0, 2.0.0, and 2.1.0 release addons. The last addon is
also loaded with `regexPrefilter: false` using independent highlighters.
All builds use the same release profile and local assets.

[Ferroni 2.1.0](https://github.com/sebastian-software/ferroni/releases/tag/v2.1.0)
delays prefilter construction until a scanner has served 32 searches and skips
small scanners. These changes address the scanner churn and tiny-set overhead
discussed in [issue #327](https://github.com/sebastian-software/ferroni/issues/327).
The original [2.0.0 measurements](../ferroni-2/README.md) remain a dated snapshot.

## Results

The default 2.1.0 integration reduces warm HTML runtime by 37.85% against
1.8.0 and by another 4.42% against 2.0.0. Astro's regression is reversed;
JSON retains a small residual slowdown against 1.8.0. First-use costs improve
against 2.0.0 but remain higher than 1.8.0 with automatic prefiltering.

| Output                   | 2.1.0 vs 2.0.0 | 2.1.0 vs 1.8.0 | Prefilter off vs 2.1.0 default |
| ------------------------ | -------------: | -------------: | -----------------------------: |
| All outputs              |         -3.08% |        -35.48% |                        +28.96% |
| Native HTML              |         -4.42% |        -37.85% |                        +33.11% |
| Single-theme render data |         -1.56% |        -35.01% |                        +27.70% |
| Two-theme render data    |         -3.25% |        -33.40% |                        +26.38% |

Selected large curated HTML cases from the broad run:

| Language   | 1.8.0 (ms) | 2.0.0 (ms) | 2.1.0 (ms) | Prefilter off (ms) | 2.1.0 vs 1.8.0 |
| ---------- | ---------: | ---------: | ---------: | -----------------: | -------------: |
| cpp        |     40.809 |      7.941 |      7.813 |             17.917 |        -80.90% |
| typescript |     16.822 |      7.867 |      7.793 |             13.241 |        -54.05% |
| rust       |      5.085 |      4.380 |      4.269 |              4.790 |        -16.34% |
| css        |      6.066 |      6.386 |      6.238 |              5.894 |         +2.72% |
| json       |      3.256 |      3.749 |      3.334 |              3.324 |         +2.49% |
| astro      |     15.966 |     21.140 |     15.287 |             15.276 |         -3.88% |

Disabling prefiltering increases warm HTML runtime by 33.11% overall. For
large TypeScript and C++ inputs, it increases runtime by 71.28% and 127.81%.
Keep the default for reused highlighters. CSS large HTML remains 2.72% slower
than 1.8.0; improvements are not universal.

### JSON and Astro after longer warm-up

The 40-warmup/40-round follow-up confirms the improvement in all output modes.
HTML results below use six fresh workers; range columns compare 2.1.0 to 1.8.0.

| Language / size | 1.8.0 (ms) | 2.0.0 (ms) | 2.1.0 (ms) | 2.1.0 vs 2.0.0 | 2.1.0 vs 1.8.0 | Process range vs 1.8.0 |
| --------------- | ---------: | ---------: | ---------: | -------------: | -------------: | ---------------------: |
| json / example  |      0.215 |      0.244 |      0.219 |        -10.52% |         +1.69% |       +1.00% to +4.35% |
| json / large    |      3.335 |      3.801 |      3.421 |        -10.33% |         +2.61% |       +0.28% to +2.97% |
| astro / example |      1.510 |      1.821 |      1.395 |        -23.33% |         -7.45% |      -10.11% to -6.42% |
| astro / large   |     16.253 |     21.740 |     15.616 |        -28.20% |         -3.98% |       -4.39% to -3.05% |

JSON is about 2–3% slower than 1.8.0 on the large fixture, rather than the
roughly 14% regression reported for 2.0.0. Disabling prefiltering changes its
warm HTML runtime by less than 1% in this follow-up. Astro is faster than
1.8.0 for both sizes, and disabling prefiltering does not improve warm HTML.

### First HTML render in a fresh process

Total first-use time includes addon and local asset setup. Each cell is the
median of ten fresh processes. The switch avoids prefilter construction even
if one render exceeds the scanner warm-up threshold.

Example inputs:

| Language   | 1.8.0 total (ms) | 2.0.0 total (ms) | 2.1.0 total (ms) | Prefilter off total (ms) | Off vs 2.1.0 |
| ---------- | ---------------: | ---------------: | ---------------: | -----------------------: | -----------: |
| typescript |           89.254 |          211.052 |          139.864 |                   93.197 |      -33.37% |
| cpp        |          299.941 |          584.150 |          408.259 |                  306.189 |      -25.00% |
| scss       |           59.729 |          192.073 |          104.783 |                   69.739 |      -33.44% |
| rust       |            5.330 |           10.200 |            7.542 |                    5.573 |      -26.10% |
| html       |           77.543 |          179.098 |          115.540 |                   81.511 |      -29.45% |
| json       |            3.184 |            3.774 |            3.309 |                    3.179 |       -3.93% |
| astro      |          142.747 |          315.249 |          205.543 |                  149.056 |      -27.48% |

Large inputs:

| Language   | 1.8.0 total (ms) | 2.0.0 total (ms) | 2.1.0 total (ms) | Prefilter off total (ms) | Off vs 2.1.0 |
| ---------- | ---------------: | ---------------: | ---------------: | -----------------------: | -----------: |
| typescript |          104.575 |          218.692 |          204.902 |                  105.479 |      -48.52% |
| cpp        |          334.425 |          587.336 |          476.908 |                  320.812 |      -32.73% |
| scss       |           65.938 |          199.783 |          195.228 |                   75.573 |      -61.29% |
| rust       |           10.067 |           14.393 |           14.240 |                   10.076 |      -29.25% |
| html       |           89.828 |          189.651 |          167.754 |                   93.879 |      -44.04% |
| json       |            6.361 |            7.369 |            6.671 |                    6.366 |       -4.57% |
| astro      |          160.594 |          344.189 |          280.770 |                  166.136 |      -40.83% |

Disabling prefiltering brings first-use times close to 1.8.0 in these fixtures.
It remains a workload-dependent choice: these results do not justify disabling
prefiltering globally for a reused CMS highlighter.

The host addon is 2,921,808 bytes, compared with 2,789,168 bytes for 2.0.0
(+4.76%) and 2,325,488 bytes for 1.8.0 (+25.64%).

## Measurement method

The broad paired run covers 19 supported TIOBE entries and 20 curated entries,
two sizes, and three output modes: 234 cases. Large inputs repeat a fixture
16 times. Six independent processes each use three warmup calls and 20 timed
calls per engine per case. Engine order rotates between calls. Highlighters
are reused; loading, the initial render, and output validation are outside
the timed calls. Deferred prefilter construction and dynamic scanner creation
can still happen inside timed calls. Each case checks identical JSON-visible outputs
across engines and processes.

A separate JSON/Astro run uses 40 warmup calls, 40 timed calls, and six
processes for all three output modes and both sizes. This checks whether the
new scanner warm-up policy affects the broad run's shorter warmup.

Changes are runtime changes: negative means less time. A group uses the median
of six per-process geometric means of per-case median ratios. A single case
uses the median of six per-process median ratios. Ranges are observed minima
and maxima, not confidence intervals. Absolute timings pool samples across
processes and use medians.

The fresh-process probe runs ten processes per language, size, and engine,
rotating engine order. Its timer includes addon loading, highlighter creation,
local theme/grammar loading, and the first HTML render. Node startup, fixture
I/O, disposal, and output hashing are outside the timer. These are fresh
highlighter measurements with a populated local asset cache, not cold disk or
network measurements. HTML hashes must agree across all four variants.

## API

Node factories accept `regexPrefilter: false`; the Rust highlighter builder
accepts `.with_regex_prefilter(false)`. Direct TextMate callers can use
`GrammarConfiguration::with_regex_prefilter(false)`. Defaults preserve Ferroni's
automatic policy. The setting applies to all grammars, embedded languages,
injections, anchor variants, and dynamic end/while scanners in the highlighter.
It is a creation-time choice, including the singleton's first creation, rather
than a per-highlight option. Matching and colors are unchanged.

Use automatic prefiltering for a reused CMS highlighter. Disabling it prevents
construction during a single render, which can exceed the 32-search warm-up
threshold on its own. The workload and input size determine the payoff.

## Integration and validation

- Workspace dependency floor and both Cargo lockfiles use Ferroni 2.1.0.
- Scanner configuration uses setters; `into_captures()` transfers captures
  before conversion into Ferriki's private capture shape.
- The 1.8.0 and 2.0.0 binaries are preserved from the previous comparison.
  The 2.1.0 binary includes the consuming capture adapter and public switch;
  this is an integration comparison, not an isolated Ferroni microbenchmark.
- 192 Rust tests pass with all workspace features. The scanner test verifies
  identical captures after 64 searches and checks that disabled scanners never
  build a prefilter, including anchor-dependent compilation.
- Clippy passes for all targets/features with warnings denied.
- The mandatory native compatibility gate passes. Optional upstream mirror
  skips and the unavailable optional PHP/Phiki test are recorded in its log.
- Node API checks cover explicit true/false output parity and invalid values;
  ESLint, TypeScript, formatting, ADR validation, and dependency checks pass.
- The declared Rust minimum remains the value in `Cargo.toml`; this run uses
  Rust 1.99.0 and does not certify the minimum toolchain.

## Reproduction and evidence

Build the 1.8.0 baseline at `75bef63`, save its release addon, then build the
2.0.0 integration described in the previous report/issue and save that addon.
Apply the decompressed `integration.patch.gz` to `75bef63` for this candidate, install the pinned
Node dependencies, and run `pnpm run build:native` from `node/`. Save addons
as `ferroni-1.8.0.node`, `ferroni-2.0.0.node`, and `ferroni-2.1.0.node` in one
directory. Build receipts record the binary hashes, source fingerprints,
dependency versions, features, and flags.

From `node/`, replacing `/path/to/addons` with that directory:

```sh
node scripts/bench-native-boundary-paired.mjs \
  --engine ferroni-1.8.0=/path/to/addons/ferroni-1.8.0.node \
  --engine ferroni-2.0.0=/path/to/addons/ferroni-2.0.0.node \
  --engine ferroni-2.1.0=/path/to/addons/ferroni-2.1.0.node \
  --engine prefilter-off=/path/to/addons/ferroni-2.1.0.node \
  --prefilter-off prefilter-off --processes 6 --rounds 20 \
  --themes single,multi,html --write paired.json

# Repeat with these overrides for steady-state JSON/Astro:
# --corpora curated --languages json,astro --warmups 40 --rounds 40 --write steady.json

FERRIKI_BENCH_ADDON_DIR=/path/to/addons \
  node benchmarks/curated/results/ferroni-2.1/cold-first-html.mjs
```

`paired.json.gz` and `steady.json.gz` contain every timed sample and output
hash; `cold.json` contains every fresh-process sample. `summarize.mjs`
regenerates `summary.json` from these files. Compressed logs preserve the
validation results. `SHA256SUMS` covers the evidence files.
