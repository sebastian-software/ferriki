# Indexed local reads and archive sharing evidence

Commit `77882ed249ea09aef6b915f63fe9b1352c58474f` adds on-demand reads from
complete decoded archives. [Both Blacksmith profiles passed](https://github.com/sebastian-software/ferriki/actions/runs/40284771387).
This fixes local file access; it does **not** reduce CDN package sizes.

## Production startup diagnostic

Five fresh processes per mode render the same fourteen-file repository corpus.
Downloads, first cache fill and process creation are outside the timers. Inputs
are read before the import timer. Full HTML hashes agree across all forty
processes, both hosts and all four modes. Inputs match across hosts. Every
Prepared process opens fourteen root packages, loads 258 groups and reports zero
invalid groups or assembly fallbacks. Source modes open/read no prepared packages.

The complete decoded packages total 469.34 MiB. Prepared reads **45.79 MiB** of
program/group payloads, plus **3.29 MiB** of indexes, on both hosts. Program bytes
are read once per file source and group records once per requested list.

| Host | Mode | Setup (ms) | First render (ms) | Import through first render (ms) | Reuse (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| Linux AMD EPYC | Off | 10.60 | 221.64 | 236.95 | 131.62 |
| Linux AMD EPYC | Auto | 10.51 | 376.03 | 390.97 | 90.14 |
| Linux AMD EPYC | Eager | 10.68 | 470.91 | 486.24 | 90.06 |
| Linux AMD EPYC | Prepared | 14.98 | 249.44 | 269.01 | 86.70 |
| macOS M4 Pro (Virtual) | Off | 9.72 | 217.25 | 231.07 | 134.47 |
| macOS M4 Pro (Virtual) | Auto | 11.44 | 330.53 | 345.73 | 86.51 |
| macOS M4 Pro (Virtual) | Eager | 9.99 | 411.03 | 425.90 | 85.02 |
| macOS M4 Pro (Virtual) | Prepared | 18.23 | 263.69 | 287.60 | 80.46 |

Each column is a separate median. Reuse is the median of per-process warm
medians. These are diagnostic boundaries, not the website headline benchmark.
The separate Rust reader/phase probe still reads complete archives as a
reference for the former loader; it does not measure indexed production I/O.

The [earlier profile](../linux-startup-2026-10-25/README.md) used different VMs
and slightly different repository inputs. In particular, the new macOS
Prepared total is higher than that earlier profile; do not describe both hosts
as a measured startup improvement over the previous reader. The current
same-run Prepared/Eager comparison is 269/486 ms on Linux and 288/426 ms on macOS.

## Frozen-input local comparison

The existing `decoded-cache/reproduce.mjs` driver compares baseline and candidate
addons through one frozen facade and input file. Five rotating samples per
lane run on an Apple M1 Ultra, Darwin 27.0.0, Node 24.22.0. Baseline binary
SHA-256 is `60bec701033f3f5f7b2a8c44506a7184b05ac1bfb74a8e5401525e5b386f865d`.
Candidate identity, inputs and all output hashes are retained in the raw report.
The candidate matches the Rust source digest in its build receipt; the receipt
was generated before committing the implementation. No other local checks ran
during this final measurement.

| Mode | Baseline first use (ms) | Indexed first use (ms) | Baseline reuse (ms) | Indexed reuse (ms) |
| --- | ---: | ---: | ---: | ---: |
| Off | 275.40 | 273.68 | 152.38 | 153.46 |
| Auto | 428.75 | 434.63 | 106.61 | 106.50 |
| Eager | 536.73 | 534.60 | 106.87 | 106.28 |
| Prepared | 333.99 | 289.70 | 100.31 | 100.90 |

Prepared setup falls from 99.36 to 18.68 ms; first render rises from 227.33 to
265.62 ms because record I/O and reduced-pair validation move to scanner demand.
The total improves by about 13%. These five-sample observations do not establish
statistical equivalence for source lanes or a universal platform improvement.

The candidate's first-fill lane takes 940.82 ms through first render, including
decompression, authentication, index creation and owned import. This one-time
work is deliberately separate. No baseline first-fill lane was measured.

## Identical data across language packages

The independent size probe compares each host archive with its declared
transitive embedded-language packages. Program identity includes the serialized
compile key and body SHA-256. Group identity includes ordered program-key
SHA-256 values and body SHA-256, preserving duplicates and order. It compares
opaque records; it does not infer sharing from similar regex text.

| Host package | Decoded package (MiB) | Group records (MiB) | Identical group records in dependencies (MiB) | Identical program records (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Markdown | 261.22 | 233.98 | 218.25 | 24.31 |
| Astro | 74.30 | 64.20 | 58.78 | 9.56 |
| HTML | 46.29 | 37.00 | 36.71 | 8.64 |

These are opportunities for package delegation, **not** measured compressed
download savings or a new package format. The host may still need programs in
its unique combined scanners. A dependency can itself contain redundant data;
ownership must avoid recursively delegating a record without a concrete owner.

## Retained evidence

`linux-x86-64/` and `macos-arm64/` preserve all artifact files as deterministic
gzip wrappers. `capture.json` records the original ZIP SHA-256 digests, verified
against GitHub metadata before extraction. `local/` retains the frozen-input
comparison, build receipt and independent sharing probe/result. `SHA256SUMS`
covers the retained bytes; historical captures remain unchanged.
