# Blacksmith measurements — October 24, 2026, prepared Eager packages

The [workflow run](https://github.com/sebastian-software/ferriki/actions/runs/40135588303)
measured the clean Ferriki 1.2.0 release at
`2b16844ed26da3d58a8198e362cd467f777bea7d`, with Ferroni 2.7.0,
Shiki 4.5.0, Prism 1.30.0, Node 24.21.0 and Rust 1.99.1. The ordinary
release addon and default prepared standard regex packages were used.
`build:native` verifies the manifest-pinned CDN payloads and seeds the offline
asset cache, including the prepared packages. Fresh processes restore those
cached resources; downloads are outside the timing boundary. The Off lane
skips prepared packages. Nonstandard TIOBE grammars registered as custom
sources do not gain standard prepared packages.

All six timing jobs, both memory jobs and the macOS merge passed. **The overall
workflow failed:** Linux corpus VMs had different CPUs, and its merge correctly
rejected that mismatch. This archive preserves each successful original shard
separately. It does not manufacture a merged Linux artifact or weaken the
workflow's CPU check. Every comparison stays within one VM; cross-corpus
numbers are not summed or divided into one headline.

| Corpus | Linux CPU | macOS CPU |
| --- | --- | --- |
| Repository | Intel Xeon | Apple M4 Pro (Virtual) |
| Curated | AMD EPYC | Apple M4 Pro (Virtual) |
| TIOBE | AMD EPYC | Apple M4 Pro (Virtual) |

## Repository timing

| Host | Default warm ms | Shiki/WASM warm ms | WASM / Ferriki | Default first use ms | Shiki/WASM first use ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Linux x86-64 | 128.554 | 311.100 | 2.4× | 876.575 | 1027.244 |
| macOS ARM64 | 118.541 | 342.751 | 2.9× | 618.306 | 1084.897 |

Warm totals sum per-file medians for 14 repository files. First use measures
imports, highlighter setup with all 14 languages and one full-corpus render,
using ten fresh processes per eligible engine with rotating engine order.
Process creation and asset downloads are excluded. This is not one-language
snippet startup. Ferriki and Shiki/WASM passed exact HTML agreement for every
file. Shiki/JS's YAML converter limitation excludes its full-corpus total;
per-file supported timings remain in the raw reports. Optional Phiki was
skipped, so this run has no PHP performance claim.

With optimization disabled, repository warm totals were 124.932 ms on Linux
and 120.234 ms on macOS; first use was 228.848 and 213.299 ms. The on/off
windows run in fixed order and their controls also move. These observations
do not isolate the effect of one configuration change.

## Complete language tables and raw timing evidence

Each link contains both default and Off per-language tables. Each directory
also preserves both original JSON reports, raw samples, logs, build receipt,
validation result and `ORIGINAL_SHA256SUMS`.

| Host | Repository | Curated (20 formats) | TIOBE (19 supported ranks) |
| --- | --- | --- | --- |
| Linux x86-64 | [table](timings/linux-x86-64/comparison/summary.md) | [table](timings/linux-x86-64/curated/summary.md) | [table](timings/linux-x86-64/tiobe/summary.md) |
| macOS ARM64 | [table](timings/macos-arm64/comparison/summary.md) | [table](timings/macos-arm64/curated/summary.md) | [table](timings/macos-arm64/tiobe/summary.md) |

Checksums apply to original decompressed bytes. Reports and process logs are
losslessly compressed with gzip; context, summary and validation files keep
their original bytes. The archived shard reader validates original hashes,
HTML gates, raw samples, source/build cleanliness, source revision, input
locks and binary receipts before public data is generated.

The [comparison with October 16](comparison-with-october-16.md) retains old and
new medians for every supported curated and TIOBE workload. It describes two
dated captures, not a controlled regression test: runtime revisions, grammar
assets, hardware placement and OS caches can differ. Repository source files
also changed between captures. The previous 3.3× / 4.1× warm headline becomes
2.4× / 2.9× here; no improvement from prepared packages alone can be inferred.

## Process memory

The [Linux](memory/linux-x86-64/summary.md) and
[macOS](memory/macos-arm64/summary.md) memory captures preserve all worker
results, original `SHA256SUMS`, combined reports, contexts and validation.
Each scenario uses six fresh processes per engine in rotating order, after
separate exact HTML SHA-256 and byte-length checks. RSS includes the complete
Node process, native code, WASM, inputs and allocator retention. Peak is the OS
high-water mark through the final rendering checkpoint, not render-only
allocation. V8 GC does not force native allocators to return resident pages.

| Host / workload | Ferriki final RSS MiB | Shiki/WASM final RSS MiB | Ferriki peak MiB | Shiki/WASM peak MiB |
| --- | ---: | ---: | ---: | ---: |
| Linux / 12 languages × 50 passes | 689.0 | 454.8 | 750.7 | 459.8 |
| macOS / 12 languages × 50 passes | 1071.3 | 451.9 | 1073.2 | 457.0 |
| Linux / large TypeScript × 10 | 151.4 | 333.8 | 172.5 | 345.1 |
| macOS / large TypeScript × 10 | 205.6 | 304.9 | 207.3 | 319.5 |

The 12-language cohort excludes YAML and SQL for the documented shared-engine
compatibility reasons. The separate single-language workload repeats the
TypeScript API file to at least 256 KiB. Neither loads the whole grammar
catalog: requested roots and their dependencies are loaded. After rendering,
Ferriki's RSS was 51–137% higher than Shiki/WASM for the repository cohort,
and 33–55% lower for large TypeScript. Compare engines within each host;
Linux and macOS account for RSS differently. These sequential workloads do
not establish leaks, concurrency capacity or production memory limits.

## Regenerate published values

From the repository root:

```sh
node scripts/publish-blacksmith-evidence.mjs
node scripts/publish-memory-evidence.mjs
mise run readme:write
node scripts/publish-blacksmith-evidence.mjs --check
node scripts/publish-memory-evidence.mjs --check
```

The homepage build runs both evidence checks. The older October 16 archives
remain unchanged for their recorded revisions. The [workflow guide](../../blacksmith.md)
describes the measurement budgets and reproduction commands.
