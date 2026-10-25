# Ferroni 2.7.1: portable prefilter fix

October 25, 2026. Ferroni 2.7.1 fixes the portable prefilter problem isolated in
[the earlier profile](../detailed-profile-2026-10-25/README.md) and reported as
[upstream #465](https://github.com/sebastian-software/ferroni/issues/465).
The [upstream fix](https://github.com/sebastian-software/ferroni/commit/f1e0955a2e9a9a74c3ee635531fe58c4fef32fd2)
counts cache efficiency and propagates give-up through candidate walks and
forward/reverse search, allowing an inefficient portable filter to retire.

The workspace now requires Ferroni 2.7.1. The release and fuzz lockfiles change
only Ferroni's version and checksum. Existing downloaded packages and decoded
caches remain valid: archive versions, the reviewed asset catalog and all
payload identities are unchanged. No grammar-specific runtime workaround is
needed. The optional startup diagnostic also derives its reported Ferroni
version from the workspace lockfile instead of naming 2.7.0 unconditionally.

## Controlled full-application comparison

Both ordinary release addons use fat LTO, one codegen unit, stripped symbols
and no custom CPU flags. The frozen JS facade, exact input strings, grammar
packages and theme are shared. Build receipts and executable hashes are in
`build-270.json.gz`, `build-271.json.gz` and `full-results.json.gz`.

The host is an Apple M1 Ultra, 20 cores, 64 GiB, macOS ARM64 / Darwin 27.0.0,
Node 24.22.0 and Rust 1.99.0. No other builds or tests ran during timing.
This is local evidence, separate from the historical Blacksmith VM captures.

The two frozen workloads are twelve selected repository documents with twelve
requested grammar roots, and one 265,165-byte TypeScript document with one
requested root. SQL and YAML are excluded. Inputs and package identities are
retained in the adjacent [decoded-cache evidence](../decoded-cache/README.md).
Only requested roots and required dependencies load; this does not load the
complete grammar catalog.

Each version, policy and workload runs in five fresh processes: 80 processes
in rotating serial order. Every process warms five complete renders, then
times ten. Execution summaries use the median of five process upper medians.
All complete HTML hashes agree within each workload, across all modes and
versions. Source modes open no archives. Prepared restores exactly twelve
archives / 236 groups for the repository workload, or one archive / 32 groups
for TypeScript, with no invalid groups or assembly-error fallbacks.

<!-- execution:start -->

| Workload         | Policy   |  2.7.0 |  2.7.1 | Runtime change |
| ---------------- | -------- | -----: | -----: | -------------: |
| repository       | off      | 120.28 | 121.35 |         +0.89% |
| repository       | auto     |  66.46 |  68.95 |         +3.75% |
| repository       | eager    |  66.76 |  67.05 |         +0.44% |
| repository       | prepared | 115.56 |  61.54 |        -46.75% |
| large-typescript | off      | 224.82 | 226.80 |         +0.88% |
| large-typescript | auto     | 196.52 | 196.36 |         -0.08% |
| large-typescript | eager    | 196.07 | 196.93 |         +0.44% |
| large-typescript | prepared | 277.00 | 112.34 |        -59.45% |

<!-- execution:end -->

All values are milliseconds per complete render. Lower is faster. The primary
source-Auto repository result is retained as measured; the longer paired
follow-up below examines that small difference separately.

## Startup remains a separate question

Decoded caches are populated before measured processes. Downloads, package
generation, cache filling, process creation and input reads are outside the
timer. Setup includes the asynchronous factory, local planning, verified
asset reads and archive opening. Total startup includes module import and
the first complete HTML render. Filesystem pages may be warm.

<!-- startup:start -->

| Prepared workload | 2.7.0 setup | 2.7.1 setup | 2.7.0 through first HTML | 2.7.1 through first HTML |
| ----------------- | ----------: | ----------: | -----------------------: | -----------------------: |
| repository        |      376.00 |      374.55 |                   604.10 |                   547.61 |
| large-typescript  |       47.26 |       47.15 |                   346.41 |                   186.77 |

<!-- startup:end -->

Prepared's TypeScript total startup improves substantially and is below source
Eager's 269.54 ms in this run. Its pure setup still costs about 47 ms, compared
with 6.84 ms for source Eager. The twelve-root Prepared total remains above
source Eager's 463.55 ms. Reading, authenticating and copying complete archives
continues to cost time. This update fixes execution; it does not change that
loading policy or establish startup parity for every workload.

## Standalone scanner replay

The unchanged five-pattern scanner harness from the original issue runs once
with 2.7.0 and once with 2.7.1. There are five fresh processes for each of
Off, source Eager and Prepared in both versions: 30 processes, in rotating
serial order. Each validates all 61,490 captured queries, warms five passes,
then times twenty. Every query has the expected negative result. The summary
is the median of five process medians.

<!-- replay:start -->

| Standalone lane |  2.7.0 | 2.7.1 |
| --------------- | -----: | ----: |
| off             |  15.50 | 15.53 |
| source          |  15.56 | 15.58 |
| prepared        | 228.40 | 15.52 |

<!-- replay:end -->

Every Prepared process loads one group with no invalid groups. In 2.7.0 the
prefilter remains active after 4,289 candidate-cache clears over all 26 passes.
In 2.7.1 it reports `built: false, retired: true`, as source Eager does. The
microbenchmark ratio describes this extracted negative-query workload; it is
not the application's speedup. Subject construction, export, package opening
and validation are outside the search timer. The original and updated
standalone manifests, lockfiles and source are retained in the earlier report
and `repro-271/` respectively.

## Source-Auto follow-up

The primary repository Auto result rises from 66.46 to 68.95 ms (+3.75%).
Its five process medians and every sample remain in `full-results.json.gz`.
A separate alternating comparison uses twenty warmup renders and thirty timed
renders, with five fresh processes per version. It also records per-document
timings and checks the complete HTML. The longer-warmup comparison gives
**68.38 ms with 2.7.0 and 68.02 ms with 2.7.1** (-0.53%).

That follow-up does not reproduce a sustained source-Auto slowdown after the
longer warmup. Its warmup and sample count differ from the primary comparison,
so it does not replace the original result. Both captures are retained.
The other five primary source-policy execution comparisons differ by less
than 1% at the median. These are observed local differences, not universal
regression thresholds.

## Validation and reproduction

- `cargo test --workspace --all-features --locked`: passed, including prepared
  asset equivalence and remote-cache checks.
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`:
  passed.
- `pnpm run test:ferriki-compat:core`: passed, including the native rebuild,
  actual compatibility checks and benchmark-contract tests.
- `cargo check --manifest-path fuzz/Cargo.toml --locked --bins`: passed.
- `cargo deny check --disable-fetch all`: all checks passed against the existing
  local advisory database. Existing duplicate-dependency warnings remain.
- All 80 primary comparison processes, ten Auto follow-up processes and thirty
  standalone replay processes passed their output and archive-use checks.

The checked-in `compare.py` invokes the existing diagnostic worker. Supply
the frozen facade directory, frozen inputs JSON, 2.7.0 addon, 2.7.1 addon,
populated asset cache and output path in that order. The facade uses the
diagnostic addon override described in the
[original reproduction](../decoded-cache/README.md). `auto-recheck.mjs` takes
the facade's `index.mjs`, inputs JSON, cache, baseline addon, candidate addon
and output path. These overrides are confined to the diagnostic facade.

To rerun the standalone candidate from the repository root:

```sh
profile=docs/benchmarks/precompiled-patterns/ferroni-2.7.1
original=docs/benchmarks/precompiled-patterns/detailed-profile-2026-10-25
gzip -dc "$original/queries.json.gz" > /tmp/ferroni-inline-html-queries.json
cargo run --release --locked --manifest-path "$profile/repro-271/Cargo.toml" --bin replay -- prepared "$original/hot-patterns.json" /tmp/ferroni-inline-html-queries.json
```

`capture.json` records the boundaries, versions, upstream fix and validation.
Raw process outputs, progress logs and check logs are compressed alongside it.
`SHA256SUMS` covers every retained file except itself. Earlier evidence remains
available with its original version and measurements.
