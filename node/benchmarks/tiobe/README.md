# TIOBE workloads for Ferroni optimization

This benchmark lives in Ferriki because full syntax highlighting needs the
TextMate interpreter, asset catalog, renderer and Node boundary. Its primary
purpose is to compare **Ferroni changes on a fixed Ferriki build** and find
language-specific regressions or optimization candidates. It does not measure
isolated regex execution time.

The current runner measures the public HTML path only. Reports under
[`results/`](results/README.md) are dated archives from the former Node token
API and remain evidence for their recorded revisions; their token timings do
not describe the current API or a current performance promise.

The language selection is the [TIOBE September 2026 top 20](https://www.tiobe.com/tiobe-index/),
retrieved September 30, 2026 and pinned in `manifest.json`. Updating the ranking
is a separate corpus change; never update it during an engine comparison.
Scratch remains rank 15 with an explicit unsupported reason: these engines have
no source-text grammar for its block-based language. Highlighting Scratch's
project JSON would measure JSON, so it is not substituted. All other ranks have
original examples, with explicit dialects and grammar IDs in the manifest.

## Run

From `node/`, with the repository's pinned pnpm version:

```sh
pnpm install --ignore-scripts
pnpm run build:compat
pnpm run build:native
pnpm run check:bench-tiobe
pnpm run bench:tiobe --write /tmp/tiobe-baseline.json
node scripts/render-tiobe.mjs /tmp/tiobe-baseline.json > /tmp/tiobe-baseline.md
```

Keep the machine idle during measurements. Do not run builds, tests or other
benchmarks concurrently. The contract check uses minimal samples and must not
be interpreted as a performance result. `--help` lists measurement controls;
`--language rust --sizes large` narrows a follow-up to one workload.

The [manual Blacksmith workflow](../../../docs/benchmarks/blacksmith.md) runs
these workloads and the curated and repository corpora on the same Linux x86-64
and macOS ARM64 runner profiles as Ferroni. `--regex-prefilter on|off` selects
the Ferriki factory option and records it in the report's method.

## Compare Ferroni experiments

Keep each Ferroni experiment on its own branch and commit. Keep Ferriki on the
same commit, and keep compiler, flags, fixtures, assets, theme and comparator
versions fixed. First build and measure the baseline. Then rebuild the addon
using an absolute path to the experimental Ferroni checkout:

```sh
FERRIKI_FERRONI_PATH=/absolute/path/to/ferroni-experiment pnpm run build:native
pnpm run check:bench-tiobe
pnpm run bench:tiobe --write /tmp/tiobe-candidate.json
node scripts/compare-tiobe.mjs /tmp/tiobe-baseline.json /tmp/tiobe-candidate.json
```

`FERRIKI_FERRONI_PATH` is a build-only Cargo patch, not a runtime backend switch.
The checkout's crate version must satisfy the existing Ferroni requirement.
The build runs a targeted offline Cargo update so an existing lockfile cannot
silently keep using the registry version, and verifies the resolved source.
Preserve the baseline lockfile and restore it before rebuilding the registry
baseline; do not commit an experiment's local resolution into Ferriki.

The build writes an ignored `.benchmark-build.json` receipt with resolved
Ferroni version, source, enabled features, local commit/dirty status and Rust
source hash, Ferriki commit/source hash, compiler/flags, lockfile hash and addon
SHA-256. The benchmark resolves the same native candidates as the facade and
refuses a receipt whose hash differs from the loaded addon. Rebuild after edits;
changing a lockfile or environment variable cannot change an already-built
binary. The report retains both build-time and run-time Git status.

The comparison rejects different workloads, harnesses, assets, machines,
comparator versions, Ferriki commits/sources or compiler settings. It reports
HTML percentage changes per language and size, sorted with the largest
regressions first. Positive means slower. Failed, timed-out or output-changing
cases remain explicit exclusions, never speedups. Repeat comparisons in
baseline/candidate/candidate/baseline order and inspect raw samples and tails
before attributing a small difference to a patch. An individual report is a
local observation, not a portable performance guarantee.

## Workloads and fairness

- `example` highlights one complete, readable order-processing example. It
  includes language-appropriate types, control flow, collections, comments,
  strings, numbers and escaping. Languages supporting Unicode strings include
  non-ASCII text. Examples are highlighting fixtures; compiling every language
  is not a benchmark prerequisite.
- `large` concatenates 16 complete copies to exercise hundreds of lines and
  sustained scanning. It is a synthetic source document, not a claim that the
  duplicated compilation units form a runnable application. Bytes, lines,
  copy count and source SHA-256 are retained for both sizes.
- Ferriki uses the native release addon backed by Ferroni. Shiki uses its pinned
  upstream version with either Oniguruma WASM or the strict JavaScript regex
  engine. JavaScript's forgiving conversion is never enabled. Native assets
  are local, with remote fetching disabled; no network belongs in timed work.
- Every language runs in a fresh child process; the parent runs languages
  sequentially. The configured timeout bounds imports, grammar compilation,
  validation and measurement. A timeout invalidates the language as a whole,
  including any already-completed cells; it is not assigned to a guessed engine.
- Setup/import/grammar compilation is recorded separately for diagnostics,
  in a fixed engine order. It is **not** a fair cold-start benchmark and is
  excluded from warm timings. Corpus loading and output validation are also
  outside timing. Highlighters are reused and disposed at the end.
- Before timing, every engine must preserve the source in parsed HTML and
  produce highlighted spans. Ferriki and both Shiki variants record exact HTML
  parity against Shiki WASM. Mismatches may still be timed for diagnosis, but
  are marked and excluded from Ferroni speedup comparisons.
- Prism's own component loader includes grammar dependencies. Its output uses
  independent regex grammars and class-based HTML. TextMate engines produce
  themed HTML with a `pre`/`code` wrapper. Identical coloring, output size or
  highlighting fidelity is not claimed. There is no DOM insertion, layout, CSS
  application or language autodetection.
- HTML measurements include tokenization, escaping and rendering. Five warmup
  calls precede each measurement; engine order rotates every round. Profile a
  slow language before changing Ferroni.
  Defaults require 30 rounds and target a shared duration of 300 ms times the
  number of timed engines, up to 1,000 rounds;
  slow cases can exceed the time budget to meet minimum samples. The parent
  timeout is the hard bound. Results are consumed after timing. Every individual
  duration, median, p95, min/max and median-derived MiB/s is retained. No
  fastest-run selection or TIOBE-weighted aggregate score is published.
- Completed language rows are checkpointed to `--write` after every worker.
  Exit zero means a report was produced; inspect row/cell status for failures.
  `check:bench-tiobe` is the strict executable correctness gate for this corpus.

The existing real-repository benchmark in `scripts/bench-shiki-comparison.mjs`
remains complementary: it includes embedded-language documents and startup
workloads outside these top-20 examples. This corpus alone cannot rule out all
regex or highlighting regressions.

## Profile one workload

`profile-tiobe.mjs` checks source preservation and exact Shiki HTML parity,
warms the selected HTML workload, then repeats it for a bounded duration. Its
stdout includes raw diagnostic timings, workload identity and the native build
receipt. Setup and validation happen before the stderr ready marker.

```sh
node scripts/profile-tiobe.mjs --language cpp --seconds 15
node scripts/profile-tiobe.mjs --language cpp --boundary native --seconds 15
```

The `--boundary native` option profiles Ferriki's direct native HTML call;
the default profiles the public Node facade. Both use the same rendered output
and exact HTML validation before timing.

For readable Rust stacks, rebuild with symbols and line tables using Cargo's
profile overrides, then use an installed sampling profiler, for example:

```sh
CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=none \
  pnpm run build:native
samply record --save-only --unstable-presymbolicate -o /tmp/cpp-html.json.gz \
  node scripts/profile-tiobe.mjs --language cpp --seconds 15
```

Keep profiler results separate from timing comparisons. Build receipts record
`CARGO_PROFILE_*` overrides, and comparisons reject different settings. Restore
the ordinary release profile and rebuild before collecting timing measurements.
On macOS, the built-in `sample` tool can attach after the ready marker:
`sample <pid> 10 1 -file /tmp/cpp.sample.txt`.
