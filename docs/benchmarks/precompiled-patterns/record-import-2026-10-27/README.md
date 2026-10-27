# Ferroni 2.8 record imports

This capture separates the Ferroni version update from adopting its new
record-backed import API. The candidate removes runtime subset archive
construction while preserving existing CDN packages and selective reads.
Two controlled Blacksmith captures reproduce a Linux corpus startup reduction
of 7–11% and a TypeScript reduction of 9–12% when using direct imports.
The version bump alone does not provide that gain. Tiny cases and macOS
controls vary; this is not a universal performance claim.

## Compared builds

- Baseline: Ferroni 2.7.2 and the existing subset-pair adapter at
  `512c43053ec125c01218eea3baeb6d1ec859f914`.
- Version only: the same runtime source with the candidate's Ferroni 2.8.0
  manifest and lockfile.
- Records: Ferroni 2.8.0 with direct record insertion at
  `53c02bdb87726ea916175169bef28aac98d3e768`.

The [Blacksmith capture](https://github.com/sebastian-software/ferriki/actions/runs/40419008705)
builds all three variants on each host with the same toolchain and flags.
Separate paired comparisons isolate the version update and the import API.
Each comparison rotates five samples per lane across the fourteen-file corpus
and TypeScript, Markdown and Rust alone. Off, Auto, Eager and Prepared remain
separate lanes. Every child verifies the loaded addon's SHA-256 and checks HTML
agreement. The facade and input bytes stay fixed within a comparison.

Startup includes module import, highlighter creation and the first complete
render in a fresh process. Local downloaded and decoded assets, including each
variant's derived index, are populated outside those timers. The separate
`after-first-fill` lane includes decompression and local index generation,
with compressed transport bytes already cached. It is excluded from the
warm-disk-cache startup comparisons. Reuse includes rendering and allocation
on an existing highlighter after five warmup renders; each process retains ten
timed samples. Downloads and process creation are outside these boundaries.

The candidate uses a version-2 local index containing Ferroni's own record
manifest and container section offsets. Existing version-1 indexes remain
untouched. The new index is generated once from the verified decoded container;
no transport archive or CDN object is regenerated.

## Blacksmith: first paired capture

Run 40419008705 completed successfully on AMD EPYC Linux x86-64 and Apple M4
Pro (Virtual) macOS ARM64. All 720 measured paired processes use the expected
native binary, produce matching HTML within each scenario and report zero
invalid prepared groups or assembly fallbacks.

The following table isolates direct imports: both sides use Ferroni 2.8.0.
Values are medians of five fresh processes in milliseconds.

| Host | Prepared workload | Subset pairs | Direct records | Change |
| --- | --- | ---: | ---: | ---: |
| linux-x86-64 | repository | 260.79 | 231.05 | -11.4% |
| linux-x86-64 | typescript | 42.05 | 36.84 | -12.4% |
| linux-x86-64 | markdown | 11.93 | 11.71 | -1.9% |
| linux-x86-64 | rust | 18.47 | 20.32 | +10.0% |
| macos-arm64 | repository | 197.19 | 193.42 | -1.9% |
| macos-arm64 | typescript | 32.59 | 30.24 | -7.2% |
| macos-arm64 | markdown | 12.35 | 11.38 | -7.8% |
| macos-arm64 | rust | 16.88 | 17.13 | +1.5% |

Linux corpus startup falls by 29.74 ms and TypeScript by 5.22 ms in this
capture. macOS corpus improvement is only 3.77 ms, with overlapping ranges.
Linux Rust is 1.84 ms higher: startup samples span 17.95–20.25 ms before and
17.89–21.60 ms after. Its setup and first-render medians do not increase;
module import and scheduling variation affect this small total. The repeated capture below checks whether these observations reproduce.

Corpus payload reads remain 38,445,730 bytes with 258 loaded groups on both
sides and hosts. The separate instrumented record probe supplies 2,234 records;
Linux read/lookup/file-check time is 13.35 ms and insertion is 0.27 ms. These
clocks perturb execution and include different work from the previous pair
assembly clocks. They must not be treated as a controlled speedup comparison.

The separate version-only comparison retains the old adapter:

| Host | Corpus mode | Ferroni 2.7.2 startup | Ferroni 2.8.0 startup | 2.7.2 reuse | 2.8.0 reuse |
| --- | --- | ---: | ---: | ---: | ---: |
| linux-x86-64 | off | 226.54 | 225.43 | 122.71 | 123.25 |
| linux-x86-64 | auto | 376.21 | 375.97 | 89.19 | 89.45 |
| linux-x86-64 | eager | 469.82 | 469.95 | 90.01 | 89.66 |
| linux-x86-64 | prepared | 249.35 | 255.76 | 83.27 | 81.57 |
| macos-arm64 | off | 207.48 | 207.83 | 120.38 | 120.52 |
| macos-arm64 | auto | 318.19 | 311.95 | 80.61 | 80.10 |
| macos-arm64 | eager | 380.25 | 393.93 | 79.54 | 81.08 |
| macos-arm64 | prepared | 203.83 | 203.99 | 75.86 | 76.71 |

The version bump alone shows no consistent startup win. Linux source-mode
corpus startup medians stay within 0.5%; macOS Eager rises 3.6%, while Auto
falls 2.0%. Source controls in the import comparison also vary despite not
using the changed adapter. Five samples do not establish equivalence or prove
every small apparent regression. Corpus Prepared reuse changes from 80.15 to
80.93 ms on Linux and 75.52 to 76.32 ms on macOS in the import comparison.
There is no demonstrated warm-execution gain from removing startup assembly.

## Repeated Blacksmith capture

[Run 40420127484](https://github.com/sebastian-software/ferriki/actions/runs/40420127484)
repeats the same commit, inputs, builds and comparison protocol on new runners
of the same CPU classes. Treat each run as its own paired comparison; do not
pool absolute timings across VMs. All 720 additional paired processes pass
native identity, HTML and diagnostic checks.

| Host | Prepared workload | Subset pairs | Direct records | Change |
| --- | --- | ---: | ---: | ---: |
| linux-x86-64 | repository | 250.93 | 232.44 | -7.4% |
| linux-x86-64 | typescript | 40.72 | 36.89 | -9.4% |
| linux-x86-64 | markdown | 11.68 | 11.68 | +0.0% |
| linux-x86-64 | rust | 18.49 | 18.41 | -0.4% |
| macos-arm64 | repository | 212.98 | 191.90 | -9.9% |
| macos-arm64 | typescript | 35.11 | 31.57 | -10.1% |
| macos-arm64 | markdown | 11.19 | 12.61 | +12.7% |
| macos-arm64 | rust | 17.00 | 20.16 | +18.6% |

The Linux corpus and TypeScript gains reproduce. The earlier Linux Rust
increase does not: 18.49 to 18.41 ms here. Markdown is unchanged on Linux.
macOS corpus and TypeScript also improve, but small cases remain inconsistent.
Rust on the second macOS VM rises from 17.00 to 20.16 ms startup and 5.94 to
6.82 ms reuse. Its unchanged source Auto and Eager controls also show higher
reuse (6.06 to 6.84 ms and 5.95 to 6.67 ms). This capture cannot isolate an
import-specific warm regression; it also cannot establish equivalence. The
first virtual macOS run and local M1 diagnostic show much smaller Rust changes.

Version-only Linux source startup stays within 1.2% in this repeat; source
reuse stays within 0.6%. macOS source startup and reuse fluctuate in both
directions, including an Eager startup decrease after the increase in run one.
Version-only corpus Prepared startup is 260.03 to 267.10 ms on Linux and
202.66 to 224.30 ms on macOS. There is no consistent version-only startup win.

The latest complete mode comparison uses the candidate build in each lane:

| Host | Off startup | Auto startup | Eager startup | Prepared startup | Eager reuse | Prepared reuse |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| linux-x86-64 | 222.47 | 366.08 | 458.01 | 232.44 | 85.71 | 81.82 |
| macos-arm64 | 211.55 | 326.03 | 380.88 | 191.90 | 81.49 | 79.16 |

Corpus Prepared reuse remains close across the import variants: 81.40 to
81.82 ms on Linux and 78.61 to 79.16 ms on macOS in the repeat. The benefit
is primarily fresh-process restoration; already constructed scanners continue
to reuse their existing search machinery.

## Local diagnostic

Apple M1 Ultra, macOS ARM64, Rust 1.99.0. This diagnostic compares the two
Ferroni 2.8.0 builds. Values are medians of five fresh processes in milliseconds.
The dirty build receipts preserve the actual source and binary hashes.

| Prepared workload | Subset pairs | Direct records |
| --- | ---: | ---: |
| Fourteen-file corpus startup | 293.93 | 275.54 |
| TypeScript startup | 49.29 | 43.33 |
| Markdown startup | 16.91 | 18.00 |
| Rust startup | 24.10 | 23.96 |
| Corpus reuse | 104.22 | 106.57 |

Both corpus variants read 38,445,730 payload bytes, decode 258 prepared groups,
and report zero invalid groups or assembly fallbacks. Direct imports remove
the overlapping program-image construction identified in the
[previous profile](../indexed-production-profile-2026-10-26/README.md), rather
than reducing coverage or reading fewer programs. These local observations
are diagnostic; small differences and noisy controls need care.

## Validation

- Workspace all-feature tests: 285 passed, one ignored diagnostic.
- Native rebuild and mandatory core compatibility gate passed, including
  41 benchmark contracts and one skipped contract.
- Clippy with warnings denied, rustfmt, Rust 1.94 workspace and private-probe
  checks, focused ESLint, workflow checks and ADR checks passed.
- Existing tests retain later-context coverage, cooperating package behavior,
  corruption and file-change fallback, and repeated-read reuse.

## Post-capture CI maintenance

PR #338 also updates Zstd from 0.13.3 to 0.14.3, zstd-safe to 8.2.0 and
zstd-sys to 2.1.2 after the advisory gate reported RUSTSEC-2026-0391,
RUSTSEC-2026-0398, RUSTSEC-2026-0403 and RUSTSEC-2026-0410. The bundled codec
remains Zstd 1.5.7. Existing transport packages stay unchanged. The fuzz lockfile
also pins Ferroni 2.8.0. Workspace tests, native compatibility, Clippy, MSRV and
cargo-deny pass after this maintenance.

The benchmark receipts retain the exact pre-maintenance dependency versions
and source revision. The measured warm-disk-cache startup path does not repeat
transport decompression; these captures remain evidence for their pinned build.

## Retained evidence

Run/host folders retain every original artifact file, including both paired
reports, ordinary timings, phase logs, inputs and build receipts. All four ZIP
digests were checked against GitHub metadata before extraction.

The local folder retains the raw paired report, inputs, per-process log,
frozen loader/driver and all three build receipts. Gzip wrappers use a zero
timestamp; JSON content and measured samples are preserved.
