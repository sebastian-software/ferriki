# Ferriki 1.3.0 and Ferroni 2.8 on Blacksmith

Measured October 27, 2026 at `ee1ad3a881544112f659c4b3d83eddca263bfd02` in
[the successful full workflow](https://github.com/sebastian-software/ferriki/actions/runs/40473534100).
All six timing jobs, two timing merges and two independent memory jobs passed.
The manual inputs were `suite=all`, `platform=both`. Every build uses registry
Ferroni 2.8.0, Node 24.21.0 and Rust 1.99.1. The comparator preflight confirmed
Shiki 4.5.0 and Prism 1.30.0 were current stable releases when the run started.

The release includes delegated language packages, persistent decoded caches,
file-state verification reuse and direct Ferroni prepared-record imports.
Source Off, Source Auto, Source Eager and Prepared retain separate identities.
Only requested languages and their dependencies load. No catalog-wide loading
is added to these workloads.

## Repository timing

Milliseconds; lower is faster. Reused values sum per-document medians for the
fourteen-file repository corpus on one VM. First use includes module imports,
highlighter setup and the complete first render in ten fresh processes. The
asset and decoded caches are populated before timing. Downloads, first cache
fill and process creation are excluded; a fresh process still restores the
requested records from disk.

| Host / phase | Source Off | Source Auto | Source Eager | Prepared | Shiki WASM |
| --- | ---: | ---: | ---: | ---: | ---: |
| Linux x86-64 / reused | 121.554 | 85.080 | 85.402 | 81.121 | 303.549 |
| Linux x86-64 / first use | 224.610 | 368.633 | 476.549 | 227.895 | 954.098 |
| macOS ARM64 / reused | 134.790 | 87.390 | 88.340 | 84.108 | 367.890 |
| macOS ARM64 / first use | 206.392 | 318.520 | 388.980 | 194.824 | 1072.396 |

Prepared first use takes **52.2% less time than Source Eager on Linux** and
**49.9% less on macOS**. It takes 1.5% more time than Source Off on Linux and
5.6% less on macOS. Reused rendering takes about 5% less time than Source Eager
on both profiles. Against Shiki WASM, Prepared is **3.7× / 4.4× faster on reuse**
and **4.2× / 5.5× faster on first use** for Linux/macOS. These factors describe
this workload and these VMs, not total build time or universal speedups.

All four native policies match Shiki WASM's HTML for all fourteen files.
Shiki JS supports thirteen; YAML prevents a complete-corpus JS total. Curated
and TIOBE retain every supported native/Shiki HTML gate and the Prism control
with its independent grammars. SQL remains in the raw timing corpus without
further investigation. Phiki is optional and was skipped: its dependencies
were absent on Linux, and PHP was unavailable on macOS. This capture makes no
new Phiki comparison.

## Process memory

Final whole-process RSS in MiB, after explicit V8 GC; medians of six isolated
processes per engine and workload. Repository: twelve files rendered fifty
times (600 documents), excluding YAML and SQL for every contender. Large
TypeScript: ten renders of the same generated input. Every process passes its
HTML check. Raw samples retain initialization, all checkpoints, lifetime peak
RSS, minima and maxima. No memory target is implied, and this bounded reuse
measurement does not establish leak freedom or production capacity.

| Host / workload | Source Off | Source Auto | Source Eager | Prepared | Shiki WASM | Shiki JS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Linux / repository | 141.3 | 253.4 | 256.0 | 243.0 | 441.7 | 343.8 |
| Linux / large TypeScript | 86.6 | 102.5 | 103.9 | 102.9 | 308.6 | 287.0 |
| macOS / repository | 143.2 | 272.2 | 273.6 | 249.0 | 450.8 | 332.5 |
| macOS / large TypeScript | 85.2 | 102.9 | 103.9 | 101.3 | 328.4 | 294.9 |

Prepared uses about **45% less final RSS than Shiki WASM** for the repository
workload on both hosts, and **67–69% less** for large TypeScript. It is also
5–9% below Source Eager on the repository workload in this capture. RSS includes
Node, Rust, WASM and allocator retention; it does not isolate native allocation.

## Historical checks and limits

The [October 25 shared-storage capture](../2026-10-25-shared-storage/README.md)
remains unchanged. Prepared first use changes from 469.832 to 227.895 ms on
Linux and 277.198 to 194.824 ms on macOS across these captures. Those differences
combine several changes and do not isolate Ferroni 2.8 or the record-import API.
The [paired startup profiles](../../precompiled-patterns/record-import-2026-10-27/README.md)
provide the controlled API comparison separately.

The repository corpus follows current source. Four of its fourteen input
hashes changed since October 25: `src/highlighter.rs` (59,026 to 60,964 bytes),
`node/ferriki/src/api.mts` (12,052 to 12,152), `node/package.json` (7,713 to 7,764),
and `Cargo.toml` (4,951 bytes in both). These totals cannot establish a source
regression against the previous release. Linux Source Eager first use is 6.8%
higher in this capture; macOS is 14.0% lower. Reused source totals on macOS are
6–11% higher, while Shiki WASM is 8.8% higher. These observations remain visible
rather than being classified as proven regressions or dismissed as noise.

All 156 curated/TIOBE language/size input hashes across both profiles match
the previous capture. The median per-case change for Source Off/Auto/Eager is
between -2.8% and -0.9%, depending on host and mode; there is no broad slowdown
across those fixed cases. Individual outliers remain: Linux Astro is 9–18%
slower across source modes; the macOS Markdown example is 64–72% slower across
source modes, with Shiki WASM also 37% slower. These are separate VMs and short
cases. A causal regression claim requires a repeated paired comparison with
fixed grammars, inputs, toolchain and machine. No such release control is
claimed by this full run.

## Retained evidence and publication

`artifacts.json` records all ten GitHub artifact IDs and ZIP digests. Every
original download was checked against its GitHub SHA-256 digest before
extraction. `timings/<profile>/<corpus>` retains each original shard;
`merged/<profile>` retains both original merged artifacts, including the
per-corpus contexts. Timing JSON, logs and summaries are losslessly gzipped with a fixed mtime;
each original `SHA256SUMS` still verifies uncompressed bytes.
`memory/<profile>` retains every original worker report, log and checksum.
The root `SHA256SUMS` covers the stored evidence files, artifact metadata and
capture metadata. It excludes this explanatory README and itself.

The website's policy summary, all 156 policy language/size rows and the policy
memory tables use this capture. The dated older tables and archives remain
available. Each corpus uses its own VM, and contenders share that VM; no timing
total pools independent corpus VMs.

Run `node scripts/publish-regex-mode-evidence.mjs --check` to validate the six
shards, both memory captures, original checksums, HTML gates, provenance and
generated compact report. The homepage build runs this gate. The browser check
also verifies the rendered policy summary, language values, memory ranges and
keyboard access to every table column.
