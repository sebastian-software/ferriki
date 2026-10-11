# Per-render scope and style memoization (#240)

This bounded experiment evaluates the Node class-output path on current main
`695e5f6e9d3538135832016591293266a6de7a1d`, including the shared scanner cache
from #235. The measured Node API constructs its class tree in JavaScript after
native tokenization; it does not call the Rust class renderer. No Rust runtime,
grammar, theme, output contract, or public API changes are part of this experiment.

## Findings

Repeated scope expansion is the main avoidable cost in this path. The diagnostic
large fixtures make 43,973–83,344 prefix calls for only 21–170 distinct scopes.
Scope counters attribute about 80–144 ms per render to expansion, while style
hashing takes about 5–7 ms for thousands of occurrences of 4–10 distinct styles.
These times include instrumentation overhead. The ordinary Inspector captures
also sample scope preparation heavily; JIT attribution varies by language.

The scope cache is shared by token classes and ancestor wrappers within one
`renderTransformedHast` call. It caches only derived class arrays and wrapper
strings for each exact scope string. It does not cache paths or modify their
order/repetition. A separate style-text-to-name Map belongs to one stylesheet
extraction. CSS hashes, sorting, selectors, and emitted HTML remain unchanged.
Inline renders allocate neither cache. Highlighter construction allocates
neither cache; both are created only during class rendering.

The first four-process ablation gives these geometric mean latency changes
across the six languages. Negative means less time; ranges describe the four
process estimates, not confidence intervals.

| Output / size                 | Scope only | Style only | Combined | Extra gain from style after scope |
| ----------------------------- | ---------: | ---------: | -------: | --------------------------------: |
| Single-theme classes, example |    -58.40% |     -2.75% |  -60.75% |                            -5.65% |
| Single-theme classes, large   |    -66.62% |     -2.35% |  -69.43% |                            -8.38% |
| Multi-theme classes, example  |    -50.82% |     -1.99% |  -52.90% |                            -4.06% |
| Multi-theme classes, large    |    -58.58% |     -2.06% |  -60.62% |                            -4.93% |

Style-only example results are noisier (single-theme process range -5.98% to
+2.36%). After scope caching, its additional gain is consistent in all four
processes: -4.56% to -7.02% for single-theme examples and -7.65% to -9.58% for
single-theme large fixtures. This supports retaining both caches together.

Large single-theme median render times from the ablation:

| Language   | Baseline ms | Combined ms |
| ---------- | ----------: | ----------: |
| TypeScript |      162.15 |       53.55 |
| TSX        |      237.01 |       68.42 |
| HTML       |      176.75 |       58.03 |
| C++        |      161.91 |       46.47 |
| JSON       |      186.47 |       44.73 |
| Astro      |      147.92 |       54.52 |

Ordinary inline and inline-with-transformer group medians change by -0.67% to
+0.35% in this ablation. The largest process group deviation is +2.14%; there
is no consistent inline regression in these measurements. Native inline source
and the addon are identical; the transformed inline renderer adds one condition
that bypasses the scope cache.

The independent four-process repetition on the final formatted runtime confirms
the result. Each cell is the median process geometric mean; brackets show the
four process estimates' range.

| Output / size                    | Final candidate latency change |
| -------------------------------- | -----------------------------: |
| Single-theme classes, example    |     -59.99% [-61.19%, -58.55%] |
| Single-theme classes, large      |     -69.25% [-69.39%, -69.03%] |
| Multi-theme classes, example     |     -52.18% [-52.31%, -51.99%] |
| Multi-theme classes, large       |     -60.16% [-60.64%, -60.10%] |
| Inline, example                  |        +0.05% [-1.22%, +2.30%] |
| Inline, large                    |        -0.09% [-0.71%, +1.68%] |
| Inline with transformer, example |        +0.01% [-2.69%, +1.15%] |
| Inline with transformer, large   |        -0.13% [-1.30%, +0.41%] |

Keep both caches for the measured Node path. This does not establish a speedup
for the separate Rust class renderer, unseen grammars, other machines, or browser
rendering. The already large class HTML and DOM remain just as large.

## Construction and memory

The full populated scope caches retain approximately 26–197 KiB per copy on
this V8 version; median population time is 0.16–1.4 ms for 21–170 scopes. The
extra style lookup Map retains 192–528 bytes for 4–10 styles, excluding shared
style/digest strings and baseline CSS rule storage. Both cache sizes depend on
distinct values within the current block. These single-theme corpus costs
include the batch array slots and should not be generalized to custom grammars
that produce many unique scopes. The costs are already included in throughput
measurements; these isolated construction timings are not subtracted from them.

After 250 discarded TSX example renders with full GC between 50-call batches,
the baseline heap changes from 8,490,008 to 8,519,728 bytes and the candidate
from 9,281,624 to 9,273,624 bytes. The candidate's batch snapshots fluctuate
within approximately 72 KiB rather than growing with calls. This short check
supports the intended per-call lifetime; it is not a general leak proof or a
peak-heap measurement. The absolute heaps include different loaded JS modules,
JIT state, and native handles and are not an incremental-cache comparison.

The retained-heap harness clears a global holding array and yields to the
event loop before each GC, keeping measured values explicitly alive until the
second GC. A positive control retains about 80,000 bytes per 10,000-element
array. Two initial synchronous attempts produced implausible near-zero medians
because stale references survived in the measurement stack. They are excluded;
the corrected control and all five raw deltas per case are in `memory.json`.

## Method and retained evidence

- `phases-baseline.json` retains nine measured calls after five warmups for each
  of the existing TypeScript, TSX, HTML, C++, JSON, and Astro examples and large
  fixtures. Large means 16 source copies, including Astro's persistent state
  across copies. Phase counters are diagnostic, with their overhead included.
- `cpu-*.json` retains separate two-second Inspector captures of the ordinary,
  uninstrumented baseline's large class render. Inspector's synchronous native
  callback is opaque; these profiles are not a Rust tokenizer breakdown.
- `ablation.json` compares baseline, scope-only, style-only, and combined
  facades in four sequential fresh processes, with five warmups and 12 samples
  per engine and case. Engine order rotates within every round and process.
- `repeat.json` repeats baseline versus the final combined candidate in four
  fresh processes with the same warmup/sample policy.
- Each comparison covers 48 cases: six languages, two sizes, and single-theme
  classes, multi-theme classes, ordinary inline, and inline with a transformer.
  Exact HTML/CSS equality, source preservation, and ordinary inline equality
  with the pinned Shiki oracle run before timing. `parity.json` adds transformed
  edge cases, theme defaults, styles, decorations, escaping, and nested renders.
- `memory.json` measures populated cache construction and full-GC retained
  heap deltas separately, plus heap after discarded renders. The style Map
  measurement shares existing keys/digests and excludes baseline CSS rules.
  Serialized cache payload bytes are a volume proxy, not heap usage.
- Build receipts, runtime source fingerprints, fixture hashes, dependency
  lockfiles, asset identities, native addon identity, and raw samples are
  retained in the JSON files. `harness/` contains the measured source and
  baseline renderer copies. All facades load the same ordinary release addon;
  no profiling feature, alternate allocator, or compiler override is enabled.

The phase and ablation capture used `harness/measure.measured.mjs`; the final
repetition used `harness/measure.final.measured.mjs`. Their SHA-256 values match
the corresponding reports. Later lint-only harness changes wrap top-level
execution in `main`, use template strings, and send progress to stderr. The
runtime source snapshots likewise retain the original and final candidate
bytes separately. `memory.measured.mjs` is the corrected memory capture source.
`path-redactions.json` maps capture and retained-file hashes for local path
redactions. Original files remain in the ignored local cache. Sample arrays,
numeric measurements, CPU frames, and source/addon hashes are unchanged.
`SHA256SUMS` covers the retained files.

Run on an Apple M1 Ultra, Darwin 27.0.0, Node v24.21.0, rustc 1.99.0, Ferriki
0.13.0, and Ferroni 2.1.0. Workloads run sequentially; no builds or other CPU
profiling overlap the throughput runs. This desktop is not a dedicated runner;
power mode, thermal state, and unrelated background work are not controlled.
The process ranges are descriptive, not confidence intervals or portability
claims. Output bytes and DOM size remain unchanged.

## Validation

The mandatory `pnpm run test:ferriki-compat:core` passed, including the honest
native Shiki checks, class output, transformer/decorator behavior, multiple
themes, source preservation, and benchmark comparison tests. TypeScript checks,
focused lint, the 17 additional parity scenarios, and formatting checks passed.
Logs and exit codes are retained under `validation/`.

The first core gate stopped at an existing main mismatch: the API-contract
check expected `colorReplacements` to be "Deferred", while the contract already
calls it "Non-goal" (#190). The check now follows the documented decision;
no API behavior changed. The next sandboxed gate reached the local asset mirror
test but could not listen on `127.0.0.1`; the final gate ran with local server
access and passed. The rebuilt release addon still matches the measured addon
SHA-256. Formatter/linter exceptions preserve raw records and measurement-time
source snapshots, following the existing Prism evidence convention.

No ADR statement or durable architecture decision changes here. Existing dated
performance evidence remains historical.

## Reproduction

Use the repository-pinned pnpm version, prepare the ordinary release addon,
then run from the repository root. Snapshot creation restores the archived
baseline class renderer even when the working tree contains the candidate.
The native addon symlink currently selects this measured macOS arm64 host.

```sh
cd node
pnpm install --frozen-lockfile
pnpm run build:native
cd ..
python3 node/benchmarks/curated/results/render-memoization/harness/prepare.py baseline
python3 node/benchmarks/curated/results/render-memoization/harness/prepare.py diagnostic
python3 node/benchmarks/curated/results/render-memoization/harness/prepare.py scope-only
python3 node/benchmarks/curated/results/render-memoization/harness/prepare.py style-only
python3 node/benchmarks/curated/results/render-memoization/harness/prepare.py candidate
node node/benchmarks/curated/results/render-memoization/harness/measure.mjs --mode profile --engines baseline,diagnostic --write phases-baseline.json
node node/benchmarks/curated/results/render-memoization/harness/measure.mjs --engines baseline,scope-only,style-only,candidate --processes 4 --rounds 12 --write ablation.json
node node/benchmarks/curated/results/render-memoization/harness/measure.mjs --engines baseline,candidate --processes 4 --rounds 12 --write repeat.json
node --expose-gc node/benchmarks/curated/results/render-memoization/harness/memory.mjs
node node/benchmarks/curated/results/render-memoization/harness/parity.mjs
python3 node/benchmarks/curated/results/render-memoization/harness/summarize.py
cd node
pnpm run test:ferriki-compat:core
```

The first default-pnpm build attempt stopped before compiling because the
environment selected pnpm 11. An offline install with that version failed on
missing policy metadata. Using pinned pnpm 10.28.2 restored the dependencies
from the local store. The first diagnostic launch could not resolve the addon
from the copied facade; adding a symlink to the measured sidecar fixed the
snapshot. These attempts produced no retained timing samples.
