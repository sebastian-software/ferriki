# Indexed production startup: Linux investigation

The production reader remains unchanged. A 256 KiB program-read cache was
tested and rejected: the controlled Linux comparison showed no startup gain
while reading 36% more payload bytes. The opt-in diagnostic clocks and the
identity-checked comparison harness remain available for further investigation.

## Repeated ordinary entry points

The first two runs use the existing per-record reader. Their only changes add
separate diagnostic probes; the ordinary addon has no phase clocks. Each mode
uses five fresh processes and the same fourteen-file corpus, with a populated
local asset cache. Import through the first complete render is the startup
boundary; downloads, first decompression and process creation are excluded.

| Run | Linux CPU | Off | Auto | Eager | Prepared |
| --- | --- | ---: | ---: | ---: | ---: |
| [40307123062](https://github.com/sebastian-software/ferriki/actions/runs/40307123062) | Intel Xeon | 237.79 ms | 396.45 ms | 487.29 ms | 268.85 ms |
| [40308181232](https://github.com/sebastian-software/ferriki/actions/runs/40308181232) | AMD EPYC | 224.57 ms | 369.13 ms | 463.82 ms | 252.21 ms |

The earlier 548.70/359.17 ms Prepared/Off capture did not reproduce in these
runs. That does not prove the gap is always 28–31 ms: later long comparisons
also exhibit large runner variation. Absolute cross-run timings are not an
optimization result, and the CPU model strings do not establish identical VMs.
Historical captures remain unchanged.

## Production-path phase clocks

The new Rust probe uses `NodeAssetHost` and `HighlighterCore`, including the
actual indexed cache provider, requested language registration and HTML
renderer. It no longer infers production costs from the separate bulk-reader
reference. Three fresh processes per mode record setup and per-document first
and second renders. All probe HTML hashes match ordinary Node output.

In run 40308181232, median Linux pair-assembly phase totals are:

| Adapter phase | Time |
| --- | ---: |
| Metadata and subset index | 1.38 ms |
| Program reads and copies | 19.66 ms |
| Reduced-pair binding checksum | 3.00 ms |
| Group reads | 5.36 ms |
| Ferroni pair opening | 6.03 ms |

Across 274 requested pairs, constructed program images total 78,532,496 bytes.
These are assembled images, not CDN downloads. Programs shared by several
scanner lists can occur in more than one image. Individual program records
are already read once per source; assembled pairs and decoded engine objects
are retained for reuse.

Ferroni's separate clocks also identify program decoding, portable decoding
and validation. Pair-opening clocks overlap nested Ferroni phases: do not add
both sets as independent costs. Instrumentation perturbs execution; these
clocks locate work, while ordinary release runs provide comparative timings.

## Rejected chunked-reader candidate

The candidate cached 256 KiB spans within the prefilter-enabled program range.
It kept group reads on demand, record checksums, engine validation and file-state
checks. No archive, catalog or CDN changes were made. Boundary and corruption
tests passed, as did the workspace and mandatory native compatibility checks.

The [valid paired run](https://github.com/sebastian-software/ferriki/actions/runs/40311393577)
compares the per-record reader from `3e72dcd7adb11bac895cd56d34ebcaec4f501b74`
with the candidate on the same VM, using the same compiler, dependencies,
facade, catalogs and inputs. Only the indexed-reader source changes between
native builds. Both variants receive an untimed prepared-cache fill before
each measured warm-cache start. Five samples per lane rotate serially.

| Prepared scenario | Linux before | Linux candidate | macOS before | macOS candidate |
| --- | ---: | ---: | ---: | ---: |
| Fourteen-file corpus | 454.26 ms | 455.31 ms | 215.44 ms | 198.76 ms |
| TypeScript alone | 83.13 ms | 91.09 ms | 37.08 ms | 36.23 ms |
| Markdown alone | 23.14 ms | 27.30 ms | 12.07 ms | 12.15 ms |
| Rust alone | 34.43 ms | 32.24 ms | 19.34 ms | 17.99 ms |

Linux corpus reuse is 133.36/134.95 ms before/candidate. Payload reads rise
from 38,445,730 to 52,326,454 bytes (36.66 to 49.90 MiB), excluding unchanged
indexes. All source modes open no prepared archives. The unaffected source
controls vary substantially, including roughly 25% for repository Auto and
30% for single-language Eager; five samples do not establish equivalence or
prove every apparent single-language regression.

The candidate gives no convincing Linux improvement for its extra reads.
The macOS observation does not justify making this a global default. Keep
per-record caching. More substantial reductions may require a direct shared
record-import API to avoid constructing overlapping program images; that is
a hypothesis requiring a prototype and measured benefit, not a promised gain.

## Measurement controls and rejected attempt

The corrected `node/scripts/compare-indexed-readers.mjs` freezes the facade and
its native loader in a disposable directory. Each child checks that the
requested native module is actually loaded and records its SHA-256, computed
outside the timer. The parent verifies that hash against the assigned binary.
All 360 measured paired processes produce matching HTML within their scenario,
with zero invalid groups or assembly fallbacks. First-fill rows are retained
separately and are excluded from the table above.

The paired rows from run **40309956682 are invalid**. That attempted comparison
used the stock facade, which ignored the historical driver's addon override,
and filled only the candidate cache after smaller first-fill scenarios.
Different filenames and hashes of binary files did not prove that different
binaries were loaded. Its apparent large improvements must not be used.
Ordinary and diagnostic measurements in that run remain separately readable.

The historical reproduction script remains byte-identical. The corrected
adapter saves its frozen loader and driver beside the new results. It fills
both baseline and candidate caches symmetrically.

## Retained evidence

`capture.json` identifies all four runs, original artifact ZIP digests and the
rejected comparison. Every ZIP was checked against GitHub's SHA-256 before
retention. Run/host folders preserve every artifact file as a deterministic
gzip wrapper, including inputs, native build receipts, ordinary samples,
phase clocks, OS probes, paired rows and the corrected frozen harness.
`SHA256SUMS` covers the retained files. No earlier evidence is overwritten.
