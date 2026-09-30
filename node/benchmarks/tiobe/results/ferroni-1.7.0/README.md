# Ferroni 1.7.0 baseline and C++ investigation

Measured September 30, 2026 on Apple M1 Ultra, darwin-arm64, Node 24.21.0,
Rust 1.96.0, Ferriki 0.7.0, Shiki 4.4.3 and Prism 1.30.0. The question is
whether the existing decimal optimizer changes these real highlighting
workloads, and where the reproducible C++ slowdown spends CPU time.

## Fixed builds and full-corpus comparison

All four full runs used Ferriki commit
`859a5f79c1be38214c3418efd2c7a8963051f554`, the unchanged September corpus,
the same assets and the ordinary release profile: fat LTO, one codegen unit,
no extra Rust flags or Cargo profile overrides. Runs were sequential, without
concurrent agent builds, tests or other benchmarks. Unrelated host activity
was not controlled. Each run retains every sample and its build receipt.

- **A / off:** merged Ferroni 1.7.0,
  `de320966e9734a59b4af6e7d4ae063fd4dc7bd48`.
- **B / on:** diagnostic Ferroni branch `codex/tiobe-backtracking-on`,
  commit `3192dff`, based on A. Its only source change passes `true` instead
  of `false` from `Scanner::with_config` to the existing compiler. This is
  an experimental build configuration, not a proposal to change the public
  default or merge this branch.

The order was A1, B1, B2, A2. Both builds passed the full corpus correctness
gate before their first measurement. All 19 textual languages, both sizes,
all four engines and both APIs completed in every run. Native and both Shiki
variants preserved exact HTML and token parity. Scratch remains explicitly
unsupported. There were no timeouts or output-changing cases.

Local Cargo patches temporarily change `Cargo.lock` during build resolution;
this is visible in the build receipt. The original tracked lockfile was
restored before measurement. Ferroni sources were clean, and the resolved
local revision, source hash and binary hash were verified by the harness.
The transient resolution was not committed to Ferriki.

| Order | Configuration | Raw report                     |
| ----- | ------------- | ------------------------------ |
| A1    | off           | [off-1.json.gz](off-1.json.gz) |
| B1    | on            | [on-1.json.gz](on-1.json.gz)   |
| B2    | on            | [on-2.json.gz](on-2.json.gz)   |
| A2    | off           | [off-2.json.gz](off-2.json.gz) |

Use the existing renderer for all 304 timing cells per run. The retained
[first pair](pair-1.json), [second pair](pair-2.json),
[off repeat](off-repeat.json) and [on repeat](on-repeat.json) are generated
with the guarded comparator. Every comparison includes all 76 native cells
and excludes only Scratch. [abba-summary.csv](abba-summary.csv) puts the
four medians and both pair deltas side by side for each cell.

Same-build median changes ranged from -4.63% to +15.05% for A and -4.76% to
+6.19% for B. The off/on deltas ranged from -5.41% to +9.12% in the first
pair and -11.93% to +5.54% in the second. These observations do not establish
a general speedup or regression from enabling the optimizer. PHP's large
HTML result was lower in both pairs, but needs a focused repeated comparison
and evidence of an applied rewrite before assigning that change to the
optimizer. V and PureScript, the original targeted cases, are outside the
TIOBE top 20; their focused compiler benchmarks remain necessary.

## Reproducible C++ gap

The large C++ fixture is 16 copies, 14,992 UTF-8 bytes and 561 lines. Medians
below include the respective public API's complete work, in milliseconds.

| Run | Native HTML | WASM HTML | Native tokens | WASM tokens |
| --- | ----------: | --------: | ------------: | ----------: |
| A1  |      80.287 |    57.531 |       137.966 |      51.405 |
| B1  |      82.102 |    59.726 |       145.412 |      55.938 |
| B2  |      79.472 |    57.037 |       141.356 |      53.345 |
| A2  |      80.676 |    58.326 |       145.276 |      54.882 |

Native tokens remained 2.60–2.68 times the WASM median. The off/on token
change was +5.40% in the first pair and -2.70% in the second. This is a
strong investigation target, not evidence that the decimal optimizer solves
or causes the C++ gap. These are complete highlighting measurements, not a
standalone Ferroni-versus-Oniguruma comparison.

## Native scopes diagnostic

Four unprofiled five-second runs on A used the ordinary release build,
five warmups and native token calls in plain/scopes/scopes/plain order.
They include tokenization, JSON serialization and N-API string transfer,
and omit public-facade parsing and metadata processing. All runs passed
source and exact token/HTML parity checks, ignoring the additional native
scope-name fields when comparing ordinary tokens.

| Run | Scope paths | Median ms | Samples | Raw report                                         |
| --- | ----------- | --------: | ------: | -------------------------------------------------- |
| 1   | no          |    72.495 |      69 | [native-plain-1.json.gz](native-plain-1.json.gz)   |
| 2   | yes         |   140.134 |      36 | [native-scopes-1.json.gz](native-scopes-1.json.gz) |
| 3   | yes         |   142.250 |      36 | [native-scopes-2.json.gz](native-scopes-2.json.gz) |
| 4   | no          |    72.043 |      70 | [native-plain-2.json.gz](native-plain-2.json.gz)   |

The public token API requests scopes for serializable grammar state even
when callers omit explanation metadata. `HighlighterCore::tokenize` then
runs both `Grammar::tokenize_line` and `Grammar::tokenize_line2` for each
nonempty line. The normal HTML path runs only the second pass. Scope-enabled
native calls took about 1.93–1.97 times the plain native calls here.
Dropping scopes changes the work and is not a production optimization.
A future single-pass implementation must preserve scope paths, token metadata,
capture handling and grammar-state behavior.

## Warmed CPU profiles

The same A sources were rebuilt with
`CARGO_PROFILE_RELEASE_DEBUG=line-tables-only` and
`CARGO_PROFILE_RELEASE_STRIP=none`. These overrides are retained in each
diagnostic build receipt. They are excluded from timing comparisons.

Samply 0.13.1 could not attach because its binary lacked macOS entitlements.
The installed `/usr/bin/sample` succeeded without changing signing or host
settings. [record-cpu.py](record-cpu.py) launched a validated, warmed
20-second workload and attached only after its ready marker, sampling for
10 seconds at a requested 1 ms interval. Setup, grammar compilation and
validation were outside the sampled window. The analysis uses only the Node
main thread; worker-thread idle samples are excluded.

| Inclusive sampled subtree | Tokens |   HTML |
| ------------------------- | -----: | -----: |
| Native API                | 97.50% | 98.71% |
| Any Ferroni frame         | 89.01% | 84.23% |
| RegSet                    | 88.55% | 83.84% |
| `match_at_impl`           | 80.27% | 75.73% |
| `search_fallback_entry`   | 61.61% | 56.38% |
| Scope `tokenize_line`     | 52.72% |  0.00% |
| Binary `tokenize_line2`   | 42.99% | 89.05% |

These inclusive categories overlap and must not be added together. They are
CPU sample shares, not wall-clock decompositions or predictions of a patch's
speedup. The token profile has 7,395 main-thread samples; HTML has 7,508.

Retained evidence:

- [Token CPU profile](cpp-tokens.sample.txt.gz) and its
  [workload/build receipt](cpp-tokens.profile.json.gz).
- [HTML CPU profile](cpp-html.sample.txt.gz) and its
  [workload/build receipt](cpp-html.profile.json.gz).
- [Computed CPU summary](cpu-summary.json), including Ferroni exclusive-frame
  counts, and [analysis script](summarize-cpu.py).

The engine remains the dominant CPU consumer even after accounting for the
duplicate scope pass. For Ferroni, the next experiment should capture the
expensive C++ fallback scanner batches and subjects into a focused regression
benchmark, identify the costly regex paths, then try one guarded compiler or
scanner optimization. The duplicate Ferriki pass is a separate measured
opportunity. JSON and facade changes have much less headroom in these profiles.

## Reproduce and inspect

From `node/`:

```sh
node scripts/render-tiobe.mjs benchmarks/tiobe/results/ferroni-1.7.0/off-1.json.gz
node scripts/compare-tiobe.mjs \
  benchmarks/tiobe/results/ferroni-1.7.0/off-1.json.gz \
  benchmarks/tiobe/results/ferroni-1.7.0/on-1.json.gz
python3 benchmarks/tiobe/results/ferroni-1.7.0/summarize-cpu.py \
  benchmarks/tiobe/results/ferroni-1.7.0/cpp-tokens.sample.txt.gz \
  benchmarks/tiobe/results/ferroni-1.7.0/cpp-html.sample.txt.gz
```

Build the selected clean Ferroni revision through `FERRIKI_FERRONI_PATH`,
run `check:bench-tiobe`, then use the default `bench:tiobe --write` command
for each full run. Keep the fixed Ferriki revision and rebuild when switching
Ferroni revisions. Restore the tracked lockfile after each local-patch build.
For CPU recording, use the symbol-profile overrides above and run
`python3 benchmarks/tiobe/results/ferroni-1.7.0/record-cpu.py tokens /tmp/cpp.sample.txt`
on macOS. Restore the normal release profile and rebuild after profiling.
