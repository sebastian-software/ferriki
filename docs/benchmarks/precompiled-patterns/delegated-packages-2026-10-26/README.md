# Cooperating language package sizes

The generator now delegates identical foreign scanners to the language that
defines them. Host-specific combinations stay local. This changes package
contents and downloads, independently of the earlier indexed-reader improvement.
See [ADR 0022](../../../../adr/0022-cooperating-prepared-language-packages.md).

## Measured downloads

Both columns use the same 94 grammar packages, theme data and Ferroni 2.7.2.
They preserve full static preparation across cooperating packages. All grammar
and theme descriptors are identical. Sizes below are compressed `.fkbc` payloads,
in decimal MB; they exclude HTTP headers, grammar/theme files and cache indexes.

| Package | Complete root package | Cooperating package | Reduction |
| --- | ---: | ---: | ---: |
| Markdown | 25.907 MB | 1.908 MB | 92.6% |
| Astro | 6.474 MB | 0.521 MB | 92.0% |
| HTML | 3.378 MB | 0.438 MB | 87.0% |
| TypeScript | 3.364 MB | 0.752 MB | 77.6% |
| JavaScript | 3.327 MB | 0.768 MB | 76.9% |
| All 94 packages | 274.444 MB | 35.349 MB | 87.1% |

The complete decoded catalog falls from 3,464,972,600 to 550,919,667 bytes.
This is disk-cache data size, not a process-memory target or a measured RSS claim.
Small intrinsic-only packages can remain the same size; the container marker
also changes their digests. These figures do not describe startup or execution
speed. Different hosts can still need different combined scanners.

Markdown alone does not download all optional code-fence languages. When Rust
is explicitly registered, Markdown reuses its package. Required dependencies,
such as those of Vue, load their own packages. Multiple host grammars reuse those
downloads. The total row counts each catalog package once; it is not a claim that
every application downloads the entire catalog.

## Construction and validation

`SyncRegistry::precompile_pattern_packages` collects intrinsic signatures first,
then prepares and filters one complete host at a time. Delegation requires equal
ordered serialized program keys and equal portable record bytes. Root-owned
groups never delegate; unmatched foreign contexts stay local. Retain every own
static program in both prefilter settings and all programs needed by local groups.

An independent implementation that first compressed the expanded packages
produced the same complete release descriptor set as the final implementation,
which avoids that intermediate compression. `node scripts/publish-assets.mjs
--check` verifies the resulting 506 immutable source/payload objects against the
reviewed lock. New objects use container version 3; complete version-2 imports
remain supported.

The Rust tests compare full and delegated token output and actual group loading
for host-dependent `$base` rules, both memory imports and indexed files. The
standard curated/TIOBE fixture comparison and mandatory native compatibility
gate pass with the generated catalog. Source Off/Auto/Eager remain separate
policies. Required and optional dependency planning have distinct checks.

## Retained evidence

`before-release.json.gz` and `after-release.json.gz` preserve the complete release
manifests as deterministic gzip wrappers. `sizes.json` contains every before/after
descriptor and exact totals. SHA-256 digests authenticate the original compressed
and decoded payloads. Historical timing captures remain unchanged; these new size
figures must not be presented as an update to their timing results.

## Startup and reuse checks

[Both production startup profiles passed](https://github.com/sebastian-software/ferriki/actions/runs/40294106961)
on `a84c87c6488e6f55c53e93d3bcb651d8421c5328`. Five fresh processes per mode
render the same fourteen requested languages and their required dependencies.
All forty complete HTML outputs and both input files agree. Prepared opens 24
cooperating packages out of 94, loads the same 258 prepared groups as the earlier
complete-root implementation, and reports zero invalid groups or assembly
fallbacks. Source modes open no prepared packages.

The requested packages now total **123.26 MiB decoded**. Actual indexed payload
reads are **36.66 MiB**, plus **1.89 MiB** of indexes. Earlier complete roots totaled
469.34 MiB for the same fourteen requested languages. Required packages are
counted separately now; optional languages remain absent.

| Host | Mode | Setup (ms) | First render (ms) | Import through first render (ms) | Reuse (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| Linux Intel Xeon | Off | 17.49 | 334.65 | 359.17 | 279.62 |
| Linux Intel Xeon | Auto | 21.81 | 884.10 | 915.34 | 221.26 |
| Linux Intel Xeon | Eager | 21.88 | 951.48 | 981.79 | 233.59 |
| Linux Intel Xeon | Prepared | 36.70 | 485.76 | 548.70 | 192.16 |
| macOS M4 Pro (Virtual) | Off | 10.31 | 211.42 | 226.19 | 125.65 |
| macOS M4 Pro (Virtual) | Auto | 11.01 | 337.90 | 352.75 | 81.37 |
| macOS M4 Pro (Virtual) | Eager | 10.11 | 399.95 | 414.33 | 82.29 |
| macOS M4 Pro (Virtual) | Prepared | 12.75 | 205.48 | 224.79 | 77.57 |

Columns are independent medians; reuse is a median of per-process warm medians.
Downloads, first fill, input reads and process creation are outside the timers.
The Linux runner is **Intel Xeon**, whereas the previous profile was AMD EPYC.
Do not interpret absolute cross-run changes as a regression or improvement.
These are same-run policy comparisons, not replacement website headline data.
The separate bulk-reader probe remains a reference, not production indexed I/O.

A frozen-input local comparison uses one baseline facade/catalog and one
candidate facade/catalog, identical raw grammars, one shared populated cache and
five rotating fresh-process samples per lane on an Apple M1 Ultra, Darwin
27.0.0, Node 24.22.0. Every output hash agrees. No local checks ran concurrently.

| Mode | Complete-root first use (ms) | Delegated first use (ms) | Complete-root reuse (ms) | Delegated reuse (ms) |
| --- | ---: | ---: | ---: | ---: |
| Off | 284.78 | 287.04 | 158.76 | 158.57 |
| Auto | 463.51 | 462.41 | 112.98 | 111.44 |
| Eager | 576.24 | 579.14 | 112.11 | 111.30 |
| Prepared | 349.33 | 297.75 | 104.69 | 105.14 |

The observed source-lane differences are small; five samples do not establish
statistical equivalence. Prepared setup falls from 107.45 to 19.54 ms, and total
first use falls about 15%, with comparable warmed execution in this local case.
The candidate receipt and both addon hashes are retained in `local/`.

## CDN publication

The [assets-only workflow](https://github.com/sebastian-software/ferriki/actions/runs/40293043184)
rebuilt the locked objects on Linux, checked their identities, uploaded immutable
objects and verified the public CDN. Package-release jobs were skipped. The old
objects remain available to existing consumers.

`capture.json` identifies both successful workflows and the original startup
artifact ZIP digests. The complete Linux/macOS artifact files are retained as
deterministic gzip wrappers, including separate bulk-read and phase probes.
`local/` retains all paired samples, inputs, reproduction code and the candidate
build receipt. `SHA256SUMS` covers the retained files.
