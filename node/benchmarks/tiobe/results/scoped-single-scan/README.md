# Single-scan scoped tokenization: issue #172

Measured September 30–October 1, 2026 on Apple M1 Ultra,
darwin-arm64, Node v24.21.0 and Rust 1.96.0 (LLVM 22.1.2).
All runs use Ferriki 0.7.0,
registry Ferroni 1.6.1, Shiki 4.4.3
and Prism 1.30.0, the release profile and no extra Rust flags.
This checkout uses Ferroni 1.6.1; issue #172's earlier 1.7.0 measurements are
context, not the baseline for this change.

The baseline is `0abac9c679c61d08f66f2e22eae73a61eaacb498`. The candidate is
the working-tree change that emits scope tokens and binary metadata together.
The raw reports retain distinct source/addon hashes and full build receipts.
Both candidate runs use the same source and addon. Compiler settings, Ferroni,
assets, corpus, benchmark harness, machine and comparator versions match.
The upstream mirrors, facade and grammar traversal are unchanged.

These measurements predate main's CDN asset-loading change (#170). The fix
also passes the all-feature Rust tests, Clippy, mandatory core gate and the
same 140 API capture comparisons on main `a8eecc1`. Those checks use the seeded
offline asset cache; the retained timings continue to describe the builds
identified in their original receipts.

## Direct native C++ control

Each run uses plain/scopes/scopes/plain order, with five warmup calls and 30
retained samples per leg. Timings include native JSON serialization and omit
facade processing. The fixture has 14,992 UTF-8 bytes
and 561 lines. Both output hashes match before/after;
removing scope names also reproduces the plain output exactly.

| Build   | Plain 1 ms | Scopes 1 ms | Scopes 2 ms | Plain 2 ms |
| ------- | ---------: | ----------: | ----------: | ---------: |
| Before  |     71.399 |     138.617 |     140.824 |     72.808 |
| After 1 |     66.563 |      68.514 |      68.971 |     65.670 |
| After 2 |     69.772 |      73.288 |      73.036 |     71.168 |

Scope collection previously nearly doubled scan time. The combined path has
only the remaining allocation/serialization overhead. The test counter counts
actual regex searches, including injection searches and capture retokenization;
the combined method performs exactly as many searches as either single-output
method on each configured fixture line.

## Public API and full TIOBE matrix

All three matrices measure 19 text languages × two sizes × four engines ×
two APIs: 304 timing cells per run. Every cell passes source-preservation checks.
Native and both Shiki variants match the WASM oracle for tokens and HTML;
all output hashes remain identical across runs. Scratch stays unsupported.
The default harness retains every sample, median, p95 and build provenance.
Measurements run sequentially, without concurrent builds, tests or benchmarks.

| Large C++ API | Before ms | After 1 ms | After 2 ms | Change 1 | Change 2 |
| ------------- | --------: | ---------: | ---------: | -------: | -------: |
| html          |    79.906 |     75.323 |     74.205 |   -5.73% |   -7.13% |
| tokens        |   146.599 |     73.332 |     73.626 |  -49.98% |  -49.78% |

The largest native slowdown among the 76 medians is 3.76% in
candidate run 1 and 7.75% in run 2. Token medians change by
-49.98% to -21.38% in run 1 and
-49.78% to -19.03% in run 2.
Inspect [every native cell](comparison.md), including the HTML controls.
The only cell slower by more than 5% is the Go example's HTML in run 2:
native rises from 1.025 to 1.105 ms (+7.75%), while WASM, Shiki JS and Prism
also rise by about 7–8%. The native/WASM ratio changes by less than 1%.
That shared movement is consistent with machine drift; it does not establish
a tokenizer regression. No token cell slows down in either candidate run.
These are one baseline and two candidate runs, not an alternating ABBA series;
small differences remain subject to machine drift. The direct control uses
alternating scope requests within each build. These are local workload results.
The standard Ferroni comparison command intentionally rejects changed Ferriki
sources; this report instead checks the fixed inputs and exact output hashes
while allowing the intended Ferriki source/addon change.

Separately, [140 API cases](api-before.json.gz) cover seven languages,
embedded languages, UTF-16/RTL/CRLF input, explanations, single/multiple themes,
inline/classes output and JSON-round-tripped resumed grammar state. Full
results, resumed results and serializable states have identical hashes in the
[candidate capture](api-after.json.gz).

## Correctness validation

- `cargo test --workspace` passes. The 120 mirrored vscode-textmate cases also
  compare combined scopes, binary metadata, fonts and state with both separate
  outputs; resumed combined stacks pass through the upstream state-diff adapter.
- The configured scanner-count fixture exercises captures and retokenization,
  injections, begin/end/while rules, embedded language IDs, token-type and bracket
  overrides, UTF-16 offsets, RTL boundaries and font attributes.
- Collector tests pin independent finalization, empty-line fallback, newline
  removal and equal-metadata merging while retaining distinct scope paths.
- `pnpm run test:ferriki-compat:core` passes, including native contract checks,
  multi-theme output, explanations, grammar state and class rendering.
- Rust formatting, Clippy with warnings denied, ADR checks and script lint pass.

## Raw reports and reproduction

- [Baseline matrix](matrix-before.json.gz)
- [Candidate matrix 1](matrix-after-1.json.gz)
- [Candidate matrix 2](matrix-after-2.json.gz)
- [Baseline boundary control](boundary-before.json)
- [Candidate boundary control 1](boundary-after-1.json)
- [Candidate boundary control 2](boundary-after-2.json)

From `node/`, build the revision before measuring; keep other workloads idle:

```sh
pnpm run build:native
node scripts/check-scoped-token-parity.mjs --compare benchmarks/tiobe/results/scoped-single-scan/api-before.json.gz
node scripts/bench-scoped-tokens.mjs --write /tmp/scoped-boundary.json
node scripts/bench-tiobe.mjs --write /tmp/scoped-matrix.json
node scripts/render-tiobe.mjs /tmp/scoped-matrix.json
```

Capture a new baseline with `check-scoped-token-parity.mjs --write report.json`
before changing tokenizer behavior. The matrix follows the existing
[benchmark methodology](../../README.md); the ranking and fixtures are fixed.
