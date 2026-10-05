# napi-rs 3 boundary measurement

Measured October 5, 2026 on an Apple M1 Pro, darwin-arm64, Node 24.15.0. The baseline is the napi-rs 2 release build from `99c8cb7`; the final build contains this PR's typed boundary. Both use the existing workspace release profile and the same standard assets.

**The original performance gate is not met:** single-theme token results still regress, and the raw addon grows by 2.23%. On October 5, 2026, the maintainer accepted these measured trade-offs for merging #224 and deferred profiling, optimization and all-platform size/load measurements to #225. All seven native smoke builds passed CI; the other six sidecar sizes and load times remain unmeasured.

## Token boundary

Each corpus includes every language with an available fixture (19 TIOBE, 20 curated), at example and large sizes, with single and two-theme results: 156 cases. Each case uses five warmups and ten measured calls; the existing 500 ms tokenization limit is retained. Baseline option encoding is outside the timer, while result parsing is inside it. Both result allocation and typed conversion are timed. Large inputs use the corpus harness's 16-copy fixture.

| Corpus / themes | Baseline sum of medians (ms) | Typed sum of medians (ms) | Change | Geometric mean change |
| --- | ---: | ---: | ---: | ---: |
| tiobe / single | 250.774 | 254.477 | +1.48% | +3.23% |
| tiobe / multi | 4216.020 | 4163.461 | -1.25% | -0.73% |
| curated / single | 233.308 | 238.463 | +2.21% | +3.49% |
| curated / multi | 7252.443 | 7244.782 | -0.11% | +0.41% |

All 156 token output SHA-256 hashes match exactly, including optional field omission and property order. These sequential local measurements are descriptive, not a statistical claim of equivalence.

## HTML corpora and Shiki comparison

| Suite | Baseline Ferriki sum of medians (ms) | Typed Ferriki sum of medians (ms) | Change |
| --- | ---: | ---: | ---: |
| tiobe (38 cases) | 259.394 | 259.950 | +0.21% |
| curated (40 cases) | 249.414 | 269.348 | +7.99% |
| Shiki comparison (14 documents) | 76.032 | 76.762 | +0.96% |

All 78 corpus HTML hashes match between revisions. TIOBE retains its explicit missing-fixture entry. HTML corpus timing uses five warmups, a 300 ms per-engine budget, 30–1,000 rounds and rotating engine order. The Shiki comparison uses five warmups, at least 30 samples and 1,500 ms per document, plus ten cold processes per engine.

The final Shiki comparison totals are Ferriki 76.762 ms, Shiki WASM 232.129 ms and Shiki JS 246.292 ms. All three preserve source text for 14/14 documents. Cross-engine visual output agreement is unavailable in these reports; no visual-equivalence claim is made. Phiki is skipped because PHP is unavailable.

The 14 comparison inputs were frozen before editing the facade and are archived in `comparison-inputs.tar.gz`. This avoids benchmarking different source documents after the code changes. The raw metadata reports a dirty source tree because migration sources were already being edited while the baseline addon and facade were retained; `nativeBuild` identifies the actual binaries used by the HTML corpora.

## Loading and size

| darwin-arm64 | Baseline | Typed | Change |
| --- | ---: | ---: | ---: |
| Cold require median (30 fresh processes) | 1.136542 ms | 1.139105 ms | +0.23% |
| Raw addon | 2274592.000000 bytes | 2325312.000000 bytes | +2.23% |

Cold require measures only native `require()` inside each child process, excluding process creation. The first load has a roughly 260 ms outlier in both builds; all raw samples are retained. The remaining platform sizes and load times have not been measured locally.

## Reproduce

Run from `node/` after installing dependencies and rebuilding the corresponding native revision:

```sh
node scripts/bench-native-token-boundary.mjs --typed --write tokens-final.json
pnpm run bench:tiobe --write tiobe-final.json
pnpm run bench:curated --write curated-final.json
mkdir -p /tmp/ferriki-comparison-inputs
tar -xzf benchmarks/native-boundary/napi-v3/comparison-inputs.tar.gz -C /tmp/ferriki-comparison-inputs
FERRIKI_BENCH_CORPUS_ROOT=/tmp/ferriki-comparison-inputs pnpm run bench:comparison --write comparison-final.json
```

For the napi-rs 2 baseline, use this token harness with the old native binding and facade and omit `--typed`. The compressed JSON reports preserve all samples and validation metadata. Do not run other CPU-intensive verification concurrently.
