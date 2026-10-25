# Prepared startup and execution profile

October 25, 2026. The remaining gap has two different causes. Ferriki pays to
read, authenticate and copy a complete prepared archive at startup. Execution
loses most of its time in one portable Ferroni prefilter for inline HTML.
Rebuilding only that group as ordinary source Eager removes the execution gap
in the full TypeScript workload. That change is a diagnostic experiment, not
a shipped exception for those five patterns.

This is a local investigation on an Apple M1 Ultra with Ferroni 2.7.0. SQL is
excluded. It does not replace the retained Blacksmith tables or establish
performance on other machines. Production sources are unchanged by this
investigation. Temporary instrumentation and experiments are retained as
patches, with binary identities and commands in [capture.json](capture.json).

## Startup: the decoded cache works, but its contents are large

Five fresh processes read already populated decoded caches. Filesystem pages
can be warm; this is not a physical storage cold-cache measurement. The
standalone [open harness](repro/src/main.rs) mirrors the bulk steps in the
production loader: read the raw container, check its pinned size and SHA-256,
copy its program/group slices into owned Arcs, and open the Ferroni pair.
Ferroni's `scanner-load-profile` feature subdivides the last step. No Zstd
decompression occurs in this measurement.

Medians across five processes, in milliseconds. Phase medians are computed
separately, so their sum is approximate.

| Operation                                 | TypeScript, one root | Repository, twelve roots |
| ----------------------------------------- | -------------------: | -----------------------: |
| Read decoded bytes                        |                 7.47 |                    71.55 |
| Verify decoded SHA-256                    |                24.96 |                   230.54 |
| Copy program/group bytes into Arcs        |                 5.24 |                    42.18 |
| Open Ferroni indexes and binding checksum |                 2.25 |                    15.41 |
| Approximate total                         |                39.92 |                   359.68 |

TypeScript's transport is 3.21 MiB, but its decoded container is 51.49 MiB.
The twelve requested roots use 467.43 MiB decoded. The selected assets and
inputs are pinned in the adjacent [decoded-cache evidence](../decoded-cache/README.md).
The loader authenticates all decoded bytes before use, even though individual
programs and groups decode lazily. TypeScript carries 1,075 programs and 375
groups; this workload actually restores 246 programs and 32 groups.

About 63% of the TypeScript bulk-open budget is the outer SHA-256 check.
Ferroni's actual index opening is about 6%. Its TypeScript index costs are
roughly 0.54 ms for programs, 0.60 ms for groups and 1.08 ms for their binding
checksum in the third process. See `decoded-open.json.gz` for every process,
asset size and phase, including the slower first read.

In the full Node comparison below, Prepared setup is 47.86 ms versus 7.26 ms
for source Eager. The approximately 40 ms difference agrees with this bulk
profile. The shared factory work, themes, grammar decoding, and JS import are
outside the isolated bulk-open phases. The expensive full-file check on every
new process is Ferriki's current cache policy, not an intrinsic cost of
restoring a Ferroni group. Any change to that policy needs an explicit
integrity contract; this investigation retains it.

## Execution: one five-pattern group explains the gap

Two symbolized release addons were sampled at 1,000 Hz with samply 0.13.1.
Each run warms five full renders, then renders for fifteen seconds. The
analysis excludes samples before the recorded `steadyEpochMs`. Both modes
produce the same full HTML hash. The input is the frozen 265,165-byte
`large-typescript` document used by the earlier cache experiment.

| On-CPU sample category               | Source Eager | Prepared |
| ------------------------------------ | -----------: | -------: |
| Ferroni portable interpreter         |           0% |    51.5% |
| regex-automata hybrid implementation |        32.6% |       0% |
| Other Ferroni frames                 |        40.3% |    28.4% |
| Other TextMate frames                |        23.3% |    17.2% |
| Remaining frames                     |         3.8% |     2.9% |

These categories are mutually exclusive, assigned from the innermost matching
stack family in `analyze.py`. They are relative on-CPU shares, not wall-time
components. The runs contain 15,062 and 15,227 steady-state samples. Search
inside Ferroni accounts for 72.2% of Source Eager samples and 79.5% of Prepared
samples. Tokenization accounts for over 96% in both. HTML rendering and the
Node boundary are outside that dominant stack.

Prepared's largest leaf is `portable::Machine::transition` (26.8% self,
51.1% inclusive). `Machine::intern` has 5.0% self and 19.5% inclusive samples;
hashing the portable state keys is part of that work. These percentages
overlap and must not be added together.

Temporary per-scanner timers identify the group. All 35 static scanners use
Eager policy in both modes; Prepared really loads 32 groups, with no invalid
groups, dynamic scanners or assembly fallbacks. Ordered pattern lists and
options agree. The [five hot patterns](hot-patterns.json) recognize inline
HTML/SVG/template annotations and interpolation delimiters. This injection
scanner is consulted at many token positions, even when the document has no
matching inline HTML.

| Scanner                           | Calls per document | Source Eager search | Prepared search |
| --------------------------------- | -----------------: | ------------------: | --------------: |
| Five-pattern inline-HTML group    |             61,490 |           100.61 ms |       180.12 ms |
| Next hottest, ten patterns        |             61,490 |            26.80 ms |        25.67 ms |
| Next hottest, twenty-two patterns |             12,386 |             7.14 ms |         7.16 ms |
| Next hottest, 111 patterns        |             11,572 |             7.00 ms |         6.77 ms |

These diagnostic averages include the initial render, five warmup renders
and measured renders: twenty passes for Source Eager and seventeen for
Prepared. Timers perturb execution. They locate the cause; the uninstrumented
comparison below measures its effect. Raw constructor and final scanner
statistics are retained in the two compressed scanner logs and
`scanner-summary.json.gz`.

The five-pattern group's overlapping candidate cache clears about 51 times
per document in Source Eager and 165 times in Prepared. Both remain active in
the integrated run. The portable representation still builds lazy transition
states during execution, repeatedly discards them at its cache bound, then
interprets NFA instructions and hashes state vectors to recreate them.
The archive does not persist learned DFA transition caches.

## Causal control in the full application

The [ablation patch](ablation.patch.gz) rebuilds only that five-pattern group
with `Scanner::with_config(..., Eager)`. All other Prepared groups, package
reads and validation remain in place. This is deliberately a narrow
diagnostic, not a proposed pattern-name policy.

Five fresh processes per lane run serially in rotating order. Each process
warms five renders and records ten. Values below are the median process
result; execution uses the upper median of ten passes. Every complete HTML
hash agrees across all fifteen processes. The experimental lane restores
31 groups; normal Prepared restores 32. Neither has invalid groups or
assembly fallbacks.

| Full TypeScript workflow             |    Setup | First render | Import through first render | Repeated render |
| ------------------------------------ | -------: | -----------: | --------------------------: | --------------: |
| Source Eager                         |  7.26 ms |    265.01 ms |                   280.38 ms |       198.89 ms |
| Prepared                             | 47.86 ms |    293.55 ms |                   347.42 ms |       277.00 ms |
| Prepared, rebuild only the hot group | 48.43 ms |    217.44 ms |                   281.53 ms |       195.16 ms |

The isolated change removes 81.84 ms from a repeated render, or 29.5% of
Prepared's elapsed time. It also brings time through first HTML back to the
source Eager range in this workload. The larger setup cost remains. All raw
times, including an initial 334 ms setup outlier in the experimental lane,
are retained in `ablation-results.json.gz`; no process was discarded.

## Ferroni-only reproduction

The [standalone replay](repro/src/bin/replay.rs) has no Ferriki, Node, HTML
renderer, CDN, hashing or decompression in its search timer. It uses the five
patterns, exports a minimal prepared pair with Ferroni 2.7.0 and reloads that
pair. `queries.json.gz` contains the exact 61,490 query texts, UTF-16 start
positions, options and expected results captured from one full render. All
are negative searches, across 259 distinct subject strings. Every result is
checked against the capture before timing.

The replay preconstructs one `OnigString` per query and reuses it across
passes. Its subject lifetimes and pattern-cache context differ from the full
tokenizer. It is a separate control, and its ratio is not the application's
slowdown. Five rotating fresh processes per lane each warm five passes and
time twenty; medians of process medians are:

| Standalone query replay | Elapsed per 61,490 queries | Final state                                                       |
| ----------------------- | -------------------------: | ----------------------------------------------------------------- |
| Source Off              |                   16.01 ms | No prefilter                                                      |
| Source Eager            |                   15.82 ms | Inefficient prefilter retired                                     |
| Prepared Eager          |                  233.94 ms | Prefilter active, 4,289 candidate-cache clears over all 26 passes |

Prepared loads exactly one group and reports no invalid groups. This
reproduces the problem inside Ferroni. The published 2.7.0 crate's portable
`Machine::intern` clears and rebuilds caches at its bound. The portable
`scan_candidates` branch returns before the ordinary hybrid path's
`search_update` and give-up handling; portable `search` also returns a match
option without the ordinary hybrid error/give-up result. That explains the
missing retirement in this replay. The ordinary source path's retirement is
workload-dependent; it did not retire in the integrated full-application run.

Source inspection used the installed, published crate. Its `.cargo_vcs_info`
pins commit `9e6470dfaa4ec7d1ef39a7a3b537c3a3571a0779`.
The relevant files are `src/dfa_prefilter/portable.rs` (`Machine::intern`,
`Machine::transition`, `Portable::search`, `Portable::scan`) and
`src/dfa_prefilter.rs` (`search_in`, `scan_candidates`).

## What to improve

Ferroni's portable transition/cache behavior and efficiency fallback are the
first execution targets. The full-application ablation establishes the
affected group without changing global policy. Raising a memory bound is
not an established requirement or the only possible remedy.

Ferriki's separate startup target is the amount of archive data read,
authenticated and copied before a small subset is used. Complete static
coverage, a whole-container digest and owned whole-archive buffers currently
make a small source grammar turn into a large startup read. A smaller
independently verifiable loading unit could reduce that cost while preserving
coverage. No format or cache-trust decision is made here.

Across all 35 encountered scanner constructions, diagnostic load scopes
measure about 51.21 ms for source Eager and 9.25 ms for Prepared. Prepared is
already cheaper at restoring the used scanners. The current loss comes
from bulk archive handling and the particular runtime prefilter path, not
from recompiling every optimized regex after a cache hit.

## Reproduce and inspect

All commands below start at the repository root. Extract inputs outside timed
regions. The standalone project pins its resolved dependencies in its lockfile.

```sh
profile=docs/benchmarks/precompiled-patterns/detailed-profile-2026-10-25
gzip -dc "$profile/queries.json.gz" > /tmp/ferriki-profile-queries.json
cargo run --release --locked --manifest-path "$profile/repro/Cargo.toml" --bin replay -- source "$profile/hot-patterns.json" /tmp/ferriki-profile-queries.json
cargo run --release --locked --manifest-path "$profile/repro/Cargo.toml" --bin replay -- prepared "$profile/hot-patterns.json" /tmp/ferriki-profile-queries.json
cargo run --release --locked --manifest-path "$profile/repro/Cargo.toml" --bin replay -- off "$profile/hot-patterns.json" /tmp/ferriki-profile-queries.json
python3 "$profile/analyze.py"
```

`eager.json.gz` and `prepared.json.gz` are the original samply profiles.
Their compressed `.syms.json.gz` sidecars preserve native symbols without
shipping a profiling addon. Decompress a symbol sidecar next to its profile
before opening the profile in samply. `analyze.py` reads the compressed
sidecars directly and prints the steady-state aggregation.

For full Node captures, reuse the frozen facade, inputs and cache setup in
the [decoded-cache reproduction](../decoded-cache/README.md). Build a
symbolized release addon with the command in `capture.json`, point the frozen
facade's `FERRIKI_BENCH_ADDON` at it, set `FERRIKI_PROFILE_CACHE` to the populated
cache, and invoke the recorded samply command. `capture-workload.mjs` preserves
the exact executed script. `workload.mjs` adds
`FERRIKI_PROFILE_FROZEN_ROOT` to relocate its frozen facade and inputs.
The three compressed patches preserve scanner timing instrumentation, query capture and
the single-group ablation. Decompress a patch with `gzip -dc` and apply one experiment at a time to the recorded
repository commit, then build a separate addon. None is applied to production.

`SHA256SUMS` covers every retained artifact except itself.
