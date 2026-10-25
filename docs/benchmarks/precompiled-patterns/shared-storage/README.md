# Shared prepared-archive storage

October 25, 2026. This is a measured upstream API proposal and downstream
integration prototype. The production baseline is Ferriki commit
`04c447e0eeb71d371e2ee0ab08103e6828913efe`, with Ferroni 2.7.1 and the
[size/mtime cache](../stat-cache/README.md). The proposed owned-container
import needs a Ferroni release containing the new API. The mapping variant
is a separate diagnostic for immutable fixtures, not a proposed default for
ordinary mutable caches.

## Implementation

The [Ferroni change](https://github.com/sebastian-software/ferroni/commit/3aa3f00611ebfad6cf5352f66f218912463aaec3)
adds `PrecompiledBytes` with checked relative views and `from_shared_bytes`
constructors. Programs and groups can retain one host-owned allocation.
Existing `from_bytes` signatures, wire versions, export byte slices, lazy
validation, checksums and fallback behavior remain available. The library
adds no dependencies, filesystem access or unsafe code.

The safe Ferriki integration consumes the decoded `Vec<u8>` directly.
Program and group views share that allocation instead of copying its sections
into separate `Arc<[u8]>` buffers. This preserves the existing file read,
size/mtime verification policy and complete static coverage. Two new tests
check retained allocation addresses and the owned raw-program import.

`consumer-shared.patch.gz` contains this integration against the exact Ferriki
baseline. `consumer-mapped.patch.gz` is the separate frozen-cache diagnostic.
Its direct engine-type adapter and temporary memmap dependency are diagnostic
glue, not a proposed Ferriki public API.

## Prepared-only replication

The broad first comparison contained large loading pauses, so a second,
focused comparison repeats all four Prepared lanes with unchanged binaries.
These forty processes form a separate capture; their samples are not merged
with or substituted into the original hundred-process comparison. All values
below are median milliseconds across five fresh processes.

| Workload | Variant | Setup | Import through first complete HTML | Repeated render |
| --- | --- | ---: | ---: | ---: |
| repository | Published 2.7.1 baseline | 140.88 | 314.36 | 60.74 |
| repository | New API, original copying importer | 141.68 | 316.21 | 61.06 |
| repository | New API, safe owned importer | 95.45 | 272.69 | 61.05 |
| repository | Immutable-file mapping diagnostic | 33.91 | 208.78 | 61.12 |
| large-typescript | Published 2.7.1 baseline | 22.58 | 160.70 | 114.05 |
| large-typescript | New API, original copying importer | 22.65 | 165.26 | 112.48 |
| large-typescript | New API, safe owned importer | 17.23 | 153.54 | 113.99 |
| large-typescript | Immutable-file mapping diagnostic | 10.40 | 146.44 | 112.40 |

The safe owned importer reduces setup by **32.2%** for twelve selected roots
and **23.7%** for TypeScript. Time through first HTML improves by **13.3%**
and **4.5%**. Repeated rendering differs by at most 0.5% in this replication.
The original copying importer with the new API tracks baseline setup within
0.6%, separating the effect of changing byte ownership from the API itself.

## Broad comparison and observed variance

The first capture also includes source Off, Auto and Eager controls.
All rows are retained here for context; all one hundred raw process outputs
remain in `primary-results.json.gz`.

| Workload | Variant | Mode | Setup | Import through first complete HTML | Repeated render |
| --- | --- | --- | ---: | ---: | ---: |
| repository | Published 2.7.1 | Off | 11.32 | 240.84 | 124.03 |
| repository | Published 2.7.1 | Auto | 11.45 | 389.19 | 70.03 |
| repository | Published 2.7.1 | Eager | 12.70 | 484.32 | 69.98 |
| repository | Published 2.7.1 | Prepared | 197.37 | 397.88 | 63.92 |
| repository | Safe owned importer | Off | 17.09 | 247.25 | 125.60 |
| repository | Safe owned importer | Auto | 11.58 | 396.84 | 71.08 |
| repository | Safe owned importer | Eager | 11.96 | 487.98 | 70.42 |
| repository | Safe owned importer | Prepared | 105.07 | 290.99 | 64.88 |
| repository | New API, copying importer | Prepared | 179.12 | 374.41 | 65.44 |
| repository | Mapping diagnostic | Prepared | 40.13 | 232.85 | 62.45 |
| large-typescript | Published 2.7.1 | Off | 7.66 | 262.09 | 232.34 |
| large-typescript | Published 2.7.1 | Auto | 7.49 | 276.49 | 200.07 |
| large-typescript | Published 2.7.1 | Eager | 7.46 | 279.58 | 200.50 |
| large-typescript | Published 2.7.1 | Prepared | 23.14 | 162.18 | 113.21 |
| large-typescript | Safe owned importer | Off | 7.51 | 260.94 | 231.98 |
| large-typescript | Safe owned importer | Auto | 7.21 | 280.65 | 202.77 |
| large-typescript | Safe owned importer | Eager | 7.59 | 284.06 | 205.59 |
| large-typescript | Safe owned importer | Prepared | 18.47 | 164.05 | 114.37 |
| large-typescript | New API, copying importer | Prepared | 30.51 | 175.14 | 116.68 |
| large-typescript | Mapping diagnostic | Prepared | 10.59 | 151.65 | 114.63 |

This capture has a 767.9 ms baseline repository setup outlier and a 478.3 ms
copying-control outlier. Source-Off repository setup medians are 11.32 ms
for baseline and 17.09 ms for the owned build. A separate rotating, factory-only
check uses twenty fresh processes per baseline/copying/owned variant, with no
rendering: its medians are **11.61 / 11.52 / 11.48 ms**. The original observations
and the follow-up are both retained; the follow-up measures a narrower boundary.

All 140 full-render processes produce identical complete HTML per workload,
with zero invalid groups or assembly-error fallbacks. Source controls open
no archives. Mapping diagnostics require exactly twelve and one mapped
archives; other variants require zero mapped archives. Counters are read
outside timers.

## What the mapping experiment means

The mapping diagnostic avoids bulk reads and archive copies while keeping
all rules in the package. It reaches **33.91 / 10.40 ms** setup and
**208.78 / 146.44 ms** through first HTML in the replication. Ferroni still
opens indexes, checks program binding and validates requested records.

The harness copies only the twelve requested decoded roots into a private
fixture directory, verifies them before timing, preserves mtimes and marks
data files read-only. No process writes, truncates or replaces those files
while any child retains a view. The mapping owner outlives its archive views.
One isolated unsafe mapping operation is present in this diagnostic patch.

A production file-backed path needs an enforceable immutable-file lifetime
or a fallible record-reader API. A matching mtime at open does not guarantee
immutability for the lifetime of a memory map. The safe owned importer has
no such file-lifetime requirement. No mapped-cache policy is enabled by this
Ferriki evidence change.

## Measurement contract

- Same M1 Ultra host as the preceding captures: 20 cores, 64 GiB RAM, Darwin
  27, Node 24.22.0, Rust 1.99.0. Ordinary release profile with fat LTO, one
  codegen unit and no custom CPU flags. No builds or tests run during timing.
- Same frozen facade, inputs and unchanged packages as the previous cache
  captures. Twelve selected repository documents/roots exclude SQL and YAML;
  large TypeScript requests one root. Complete static grammar coverage remains
  on disk. Twelve roots total 467.43 MiB decoded; TypeScript alone is 51.49 MiB.
- Compressed objects, decoded files and receipts are populated outside timers.
  Each process creates a fresh highlighter; filesystem pages may be warm.
  Network downloads, first decoded fill and process launch are outside timers.
- Factory setup, first complete render and module-import-through-first-render
  are separate. Five warmup renders precede ten timed complete renders. The
  execution summary is the median of each process's upper median of ten passes.
  Source input hashes and complete output equality are checked outside timers.
- Primary: 100 processes, five per lane/workload, rotating serial order.
  Replication: 40 processes, the four Prepared variants only. Factory-only
  Source-Off follow-up: 60 additional processes. Keep captures separate.
- Baseline and candidate build receipts identify all native artifacts. The
  three local API consumers use the identical Ferroni source hash. The actual
  compatibility-gate build is separate and uses identical owned-import source.
  These are local diagnostic results, not new Blacksmith or Shiki measurements.

## Validation and reproduction

- Ferroni: 577 library tests, nine public prepared-archive tests, twelve
  no-DFA archive tests, documentation tests, Rust 1.94 check, all-feature
  Clippy with warnings denied, warning-free rustdoc, formatter, cargo-deny
  against the local advisory database, workflow/README checks and Node/V8
  execution of the frozen native archive through both importers on Wasm.
- Ferriki safe importer: **280 Rust tests passed**, one ignored diagnostic;
  all-feature Clippy passed; the mandatory native compatibility gate passed
  with a native rebuild and 40 passing benchmark contracts (one skipped).
  The gate uses the same local override for all Cargo subprocesses.
- Native mapping is only a controlled fixture experiment. It is not included
  in the safe importer's production-style compatibility claim.

Build baseline commit `04c447e` normally in an isolated checkout. For the
owned candidate, apply the decompressed `consumer-shared.patch.gz`, run
`cargo fmt --all`, and build with `FERRIKI_FERRONI_PATH` pointing to the
Ferroni commit linked above. For checks that invoke Cargo themselves, add
the same `[patch.crates-io.ferroni]` path to that isolated checkout's local
`.cargo/config.toml`; do not change published dependency requirements.

Freeze the facade and diagnostic addon override as described in the
[original cache reproduction](../decoded-cache/README.md). `compare.py` takes
these positional arguments: repository, frozen facade, inputs JSON, populated
transport cache, baseline addon, artifact directory and output JSON. Put the
`legacy.node`, `shared.node` and `mapped.node` prototypes in the artifact
directory. Add `--prepared-only` for the replication. The harness creates its
own frozen cache; ordinary caches must never be used as mutable mapped inputs.

The exact executed build/measurement drivers and Source-Off follow-up scripts
are archived separately. `build-*.json.gz`, both consumer patches, the
Ferroni patch, inputs, raw samples and check logs are retained. `SHA256SUMS`
covers every evidence file except itself. Earlier reports retain their values.
