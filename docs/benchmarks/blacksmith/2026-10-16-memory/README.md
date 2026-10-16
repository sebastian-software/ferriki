# Blacksmith process-memory capture — October 16, 2026 (UTC)

This archive preserves the original artifacts from
[workflow run 38973585782](https://github.com/sebastian-software/ferriki/actions/runs/38973585782),
measured at commit `77bd49284792fea290fcd8d6a6bfe079dee256fb` (tree
`40a10f6dd550bb1933522f30b0e2826c923c8d81`). The runtime is Ferriki 1.1.1 from
`main` at `c644653`, with the added memory harness and workflow. Comparators are
Shiki 4.5.0 with Oniguruma WASM and its JavaScript regex engine. Ferroni is 2.2.2,
Node is 24.21.0 and Rust is 1.99.1. No runtime implementation was changed for this
measurement.

- [Linux x86-64 summary](linux-x86-64/summary.md)
- [macOS ARM64 summary](macos-arm64/summary.md)
- [Method and reproduction](../../blacksmith.md#process-memory)

Each profile has one dedicated Blacksmith VM. All engines run serially on that
VM, with six fresh processes per engine and scenario and rotating engine order.
The two scenarios are 50 passes over the same 12 repository documents (600
rendered documents) and ten renders of the same generated TypeScript input
(263,063 bytes: 24 copies of the API source, separated by newlines). The shared
repository inputs total 182,371 bytes. YAML and SQL are excluded from all engines
in the memory cohort; the method records the Shiki/JS limitations. This is a
different cohort from the 14-file timing benchmark, whose data remains intact.

Each profile retains `context.json`, `memory.json`, `summary.md`,
`validation.json`, `SHA256SUMS`, and all 42 individual worker results with stderr:
36 measurements plus six HTML validation processes. Every original file is
preserved byte for byte. `memory.json` contains every RSS/V8 snapshot, output
hash, input hash, checkpoint and repetition. The context records the observed
CPU, OS, memory, source state, dependency pins, lock hashes, compiler flags,
Ferroni features, native source fingerprint and binary receipt. Every Ferriki
worker verifies the loaded addon's hash against that receipt.

Verify original artifact bytes with `shasum -a 256 -c SHA256SUMS` inside each
profile directory. From the repository root, after installing Node workspace
dependencies, run `node scripts/publish-memory-evidence.mjs --check` to validate
both captures, worker/report consistency and the derived website data. No native
build or new measurement is needed to check retained evidence.

For an exact rerun, check out the measured commit and follow the local or
Blacksmith memory instructions. Omit the current-release registry check when
replaying archived pins. A rerun on current `main` measures current fixtures and
versions instead; the raw input hashes distinguish them.

## Interpretation

All memory figures are absolute whole-process values in bytes, displayed as
MiB. Initialization and final RSS are observed after explicit V8 GC. The final
highlighter is still loaded; HTML is released between documents. The OS peak
covers startup through the final render checkpoint, including setup and GC;
it is not a render-only peak. Summaries show the median and full min–max range
over six independent processes, without baseline subtraction.

Compare engines within each host. Linux and macOS use different memory
accounting and allocators. RSS includes native and WASM resident memory, code,
caches and allocator retention; it is not a count of allocations or live Rust
bytes. Forced V8 GC does not force native allocators or WASM to return pages.
These bounded sequential workloads do not establish leak freedom, concurrent
capacity, a production RAM limit or a universal memory advantage.
