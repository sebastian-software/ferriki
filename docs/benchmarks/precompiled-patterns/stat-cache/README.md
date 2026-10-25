# Prepared cache: reuse verification by file state

Local controlled diagnostic, October 25, 2026. Both addons use Ferroni 2.7.1.
This isolates Ferriki's decoded-cache loading change from the
[earlier Ferroni upgrade](../ferroni-2.7.1/README.md) and the historical
[Blacksmith captures](../../blacksmith/2026-10-25-decoded-cache/README.md).

## Cache policy

The first decoded fill still verifies the compressed download and the decoded
container against their release-pinned SHA-256 identities. It atomically writes
the decoded file and a small `.verified` receipt with its byte size and
modification time, including nanoseconds. A fresh process compares that state
before and after reading the file. Matching state skips Ferriki's SHA-256 work;
Ferroni's index, binding and requested-record validation remains unchanged.

A changed file, absent receipt or malformed receipt requires SHA-256 again.
Successful verification renews the receipt. Detected corruption removes the
derived data and receipt, then uses the existing verified-transport repair or
optional source fallback. Receipt write failures remain optional. Old manifests
without decoded identities keep the compressed path. Existing decoded caches
without receipts pay one full verification before reusing the recorded state.

This deliberately trusts the local cache and its receipts. Size and mtime are
change detectors, not authentication against malicious local writes or proof
against undetected storage corruption. Copies that preserve size and mtime
can reuse the receipt across build runners; inode and ctime are intentionally
excluded. Timestamp precision changes can cause one extra verification.

No CDN objects, grammar coverage, archive formats or regex policies change.
Off, Auto and Eager retain their source-only paths. All static prepared
scanner lists remain available, including rules absent from these documents.

## Measurement

- Same M1 Ultra host, 20 cores and 64 GiB RAM as the previous diagnostics;
  Darwin 27, Node 24.22.0, Rust 1.99.0, native ARM64. Ordinary release profile
  with fat LTO, one codegen unit and no custom CPU flags. Build receipts retain
  exact binary, dependency and source identities.
- Five fresh processes for each workload, addon, policy and cache state:
  **100 measured processes**. Order rotates serially. No builds or tests run
  alongside these timings.
- The same frozen facade, input strings and unchanged prepared payloads serve
  both addons. The twelve-root repository workload excludes SQL and YAML.
  Large TypeScript requests one root. This does not load every grammar.
  Inputs and payload identities are shared with the
  [decoded-cache diagnostic](../decoded-cache/README.md).
- Populated-cache measurements follow an untimed candidate process that
  creates verification receipts. First-fill processes receive compressed cache
  files only; downloads and seeding are outside the timer. First fill includes
  decompression, SHA-256 and both data/receipt persistence. Filesystem pages
  may be warm; this is not a physical disk cold-start measurement.
- Setup covers the highlighter factory, asset planning, local reads and pair
  opening. First render is separate. Total startup includes module import
  through complete first HTML. Process launch, input reads, network transfers
  and asset generation are outside timers.
- Each process performs five warmup renders and ten timed complete renders.
  Execution summaries use the upper median of ten passes within a process,
  then the median across five processes. Other phase summaries use medians
  across the five processes. Raw samples and ranges remain available.
- Every complete HTML hash must agree across candidates and policies. Runtime
  diagnostics require exactly twelve/one Prepared archives, actual group
  loading, zero invalid groups and zero assembly-error fallbacks. Source
  controls must open no prepared archives.

<!-- results:start -->

All values are milliseconds; medians of five fresh processes.

| Prepared workload | Before setup | After setup | Before first HTML | After first HTML |
| --- | ---: | ---: | ---: | ---: |
| repository | 393.92 | 149.31 | 578.01 | 334.38 |
| large-typescript | 49.67 | 23.13 | 194.88 | 167.06 |

Populated-cache setup falls by **62.1%** for twelve selected roots and **53.4%** for TypeScript alone.
First HTML improves by **42.1%** and **14.3%** respectively. Complete HTML
hashes agree in all 100 processes, with zero invalid groups or assembly fallbacks.

Repeated Prepared rendering is **66.01 → 66.71 ms** for the repository and
**119.71 → 118.56 ms** for TypeScript (within 1.1% in this capture).

| First decoded fill | Before setup | After setup | Before first HTML | After first HTML |
| --- | ---: | ---: | ---: | ---: |
| repository | 716.86 | 733.10 | 914.08 | 922.47 |
| large-typescript | 77.12 | 78.12 | 220.18 | 224.94 |

First-fill setup is +2.3% / +1.3% here. It still includes decompression, SHA-256
and persistence, now including the small receipt. These costs are amortized by
subsequent starts; the change does not claim cheaper first fill.

| Source control | Mode | Before setup | After setup | Before execution | After execution |
| --- | --- | ---: | ---: | ---: | ---: |
| repository | off | 11.87 | 11.49 | 126.37 | 129.37 |
| repository | auto | 11.12 | 11.86 | 68.93 | 70.93 |
| repository | eager | 11.25 | 11.06 | 71.63 | 73.29 |
| large-typescript | off | 7.63 | 7.19 | 244.66 | 236.73 |
| large-typescript | auto | 8.39 | 7.38 | 222.36 | 205.40 |
| large-typescript | eager | 7.73 | 7.37 | 215.05 | 207.72 |

Source execution medians vary from -7.6% to +2.9% in this capture.
Those paths do not use the decoded cache and contain no policy or engine changes.
The five-process observations and their raw samples remain evidence rather than
an assertion of exact timing equality or a universal regression threshold.

Loading still reads complete containers and copies them into Ferroni-owned
program/group storage. Setup remains above the source controls: about 149 versus
11 ms for twelve roots, and 23 versus 7 ms for TypeScript. The comparison does
not establish source-Off loading parity or a Shiki startup advantage.

<!-- results:end -->

## Reproduction and checks

`compare.py` invokes the existing `decoded-cache/reproduce.mjs` worker. Supply
the frozen facade directory, inputs JSON, baseline addon, candidate addon,
populated asset-cache directory and output JSON path in that order. Create the
frozen facade and diagnostic-only addon override as described in the
[original reproduction](../decoded-cache/README.md). The retained inputs are
unchanged; `inputs.json.gz` also stores them here.

The baseline is commit `05bdea9e755501a3b0df0b2b257f408f6c0e5144`. The
candidate's build receipt records the same parent with the reviewed file-state
implementation in its working tree. Both use the normal release build.
`capture.json` pins both binary hashes, metadata and measurement boundaries.

Validation passed: 278 Rust tests (one ignored diagnostic), workspace Clippy
with warnings denied, rustfmt, the mandatory native compatibility gate and
its 40 passing benchmark contracts (one skipped), the focused benchmark-mode
contracts, ADR validation and the homepage build with its page/link checks.

The exploratory parallel SHA-block implementation is preserved separately in
`exploratory-*` artifacts. Its pins authenticate every decoded block, and it
was measured before adopting local file-state reuse. Those samples use their
own candidate and manifest and are not mixed into the current comparison.

`SHA256SUMS` covers every retained file except itself. Earlier timing tables
and raw captures keep their original versions and meanings.
