# Why Prepared startup costs more on the Linux runner

October 25, 2026. Both profiling jobs passed in [workflow
40238997955](https://github.com/sebastian-software/ferriki/actions/runs/40238997955),
commit `ec2ff1d76536a992da26979d3913f82bb26862d1`. The normal addon uses registry
Ferroni 2.7.2 with no phase clocks. A separate private Rust probe attributes archive
read/open costs; its shared dependency versions match production.

## Finding

The main extra loader cost is reading full decoded containers into each new process. The
fourteen requested roots contain **469.34 MiB**. Reading them takes **148.38 ms on this
Linux VM** and **48.43 ms on this macOS VM** in the normal-reader probe. Opening and
indexing their shared Ferroni views then takes **13.64 / 11.52 ms**. Shared ownership
removed program/group section copies; it did not remove the initial full-file reads or
allocation of their buffers.

Linux OS counters show zero filesystem input and zero major page faults in a separate
probe. Most CPU time is kernel time, with about 122,000 minor faults as buffer pages
become resident. This supports page allocation and copying from the filesystem page
cache as the main read cost. It does not establish that Linux storage devices are slow,
or isolate operating system, architecture, allocator and VM effects from each other.

## Ordinary addon phases

Median milliseconds across five fresh processes per mode. Inputs are read before import
timing. Factory setup and the first complete fourteen-document render are separate. Each
column is a median, so the columns need not sum to the independently calculated total.

| Host | Mode | Factory setup | First render | Import through first HTML |
| --- | --- | ---: | ---: | ---: |
| Linux | off | 16.41 | 271.81 | 304.50 |
| Linux | auto | 15.90 | 521.28 | 541.25 |
| Linux | eager | 13.95 | 618.69 | 640.17 |
| Linux | prepared | 230.02 | 347.06 | 606.01 |
| macOS | off | 9.41 | 206.68 | 221.35 |
| macOS | auto | 9.16 | 313.85 | 327.35 |
| macOS | eager | 9.58 | 394.24 | 408.55 |
| macOS | prepared | 70.42 | 175.54 | 250.94 |

In this separate Linux VM, Prepared first use is slightly faster than Eager (606 versus
640 ms), whereas the earlier headline capture was slightly slower (470 versus 446 ms).
The old capture remains unchanged. Source controls also move substantially between VMs.
The portable conclusion is that full-container restoration can consume the compilation
savings; the exact crossover depends on the workload and runner.

## Isolated archive readers

Each fresh probe process retains all fourteen opened archives until its measurements
finish. Five processes per reader rotate their order. The reference variants do not
change the production loader.

| Host | Reader | Read + allocation | Open + index |
| --- | --- | ---: | ---: |
| Linux | Production bounded Take<File> shape | 148.38 | 13.64 |
| Linux | Direct File::read_to_end reference | 157.67 | 15.14 |
| Linux | Zeroed bounded buffer + read_exact reference | 153.79 | 15.09 |
| macOS | Production bounded Take<File> shape | 48.43 | 11.52 |
| macOS | Direct File::read_to_end reference | 50.72 | 11.75 |
| macOS | Zeroed bounded buffer + read_exact reference | 48.15 | 11.60 |

Neither reader replacement establishes a useful improvement. The direct file reference
also lacks the production reader's explicit byte limit, so it is not a proposed
replacement. Keep the bounded production reader.

The largest requested package is Markdown at **261.22 MiB**, including its complete
static dependency/injection coverage. Its median read is **75.98 ms on Linux / 27.35 ms
on macOS**. TypeScript, JavaScript, HTML and PHP add about 192 MiB. The loader requests
fourteen roots, not the entire catalog; all package coverage remains intact.

## Linux OS and engine diagnostics

Separate uninstrumented OS runs use the production-shaped reader. One records **0.22 s
system time**, **0.01 s user time**, **0.23 s wall time**, **122,337 minor faults**,
**zero major faults**, and **zero filesystem inputs**, with 4 KiB pages. These are
whole-process counters from an additional run, not a decomposition of the five-process
median above.

A separate strace run records 35 read calls and two pread64 calls for the entire probe,
including startup and input JSON. The reader already performs a small number of bulk
reads; this is not evidence for a tiny-read syscall bottleneck.

Opt-in engine clocks are collected only after normal measurements, using a separate
probe build. Their exclusive opening phases total about **3.94 ms program indexes + 6.77
ms group indexes + 6.25 ms program-binding checksums** on Linux; macOS is **2.67 + 3.28
+ 4.63 ms**. Instrumentation changes timings. Opening does not include lazy record
decoding or scanner construction during the first document. The ordinary addon above
retains those costs in its first-render measurement.

## Consequence

The next substantial loader improvement needs to avoid making all decoded payload bytes
resident at startup: indexed, on-demand record reads or a file-backed representation
with a valid lifetime contract. Complete packages can remain on the CDN and on disk.
Ferroni's current shared-byte API retains contiguous byte images; it solves extra
section copies, while a safe lazy file reader needs another storage boundary. The
earlier immutable-file mapping experiment remains diagnostic only. This investigation
enables no production file mapping and changes no runtime policy.

## Evidence and reproduction

Both jobs retain the same input hashes and Rust source fingerprint. All forty
normal-addon process results have identical complete HTML hashes across policies,
exactly fourteen archives in Prepared and zero in source modes, with zero invalid groups
and zero assembly-error fallbacks. The parent verifies every decoded digest, byte size
and persisted size/mtime receipt outside timers. No download, decompression, first fill
or SHA-256 verification is charged again to the unchanged-file read path.

Thirty normal reader processes and two separately instrumented opening runs are
retained. Ordinary addon and normal probe binary identities are recorded. Linux
OS/strace runs remain separate. Filesystem pages may be warm. These are fresh processes,
not physical-disk cold starts. These new VMs and phase boundaries do not replace the
[headline capture](../../blacksmith/2026-10-25-shared-storage/README.md) or its website
tables. SQL stays in the cohort without separate investigation.

Run the existing Blacksmith workflow with suite `startup-profile` and platform `both`.
The [probe guide](../../../../benchmarks/prepared-startup-profile/README.md) records its
boundaries. JSON files are losslessly compressed. `capture.json` retains original
artifact ZIP digests; `SHA256SUMS` covers the retained bytes.
