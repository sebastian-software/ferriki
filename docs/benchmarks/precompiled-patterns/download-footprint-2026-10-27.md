# Grammar downloads and prepared scanner overhead

Recorded October 27, 2026 from the release-pinned `assets/catalog.json` and
`assets/grammars/sources.json`. The [machine-readable capture](download-footprint-2026-10-27.json)
retains both input hashes, every asset descriptor, source definition hash and
exact byte count. These are payload sizes, not timing measurements.

The native asset planner was called in Source Off and Prepared modes with
fresh, empty caches, the same requested languages and no themes. Every grammar
path agrees between modes. Required embeddings and injections are included;
optional code-fence languages are not requested. Planned sizes and digests
match the release manifest. Materialized normalized JSON definitions match
their source lock hashes. No downloads were needed to read the plan.

Decimal kB and MB; rounded values below, exact bytes in the capture.

| Requested roots | Required packages | Normalized JSON definitions | Grammar-only CDN payload | Extra prepared scanners | Total prepared CDN payload | Total / grammar-only |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Rust | 1 | 31.2 kB | 18.0 kB | 40.4 kB | 58.3 kB | 3.2× |
| Python | 1 | 118.6 kB | 78.4 kB | 249.9 kB | 328.3 kB | 4.2× |
| TypeScript | 7 | 764.9 kB | 539.1 kB | 4.11 MB | 4.65 MB | 8.6× |
| Markdown | 1 | 94.8 kB | 61.1 kB | 1.91 MB | 1.97 MB | 32.2× |
| Astro | 11 | 1.07 MB | 763.1 kB | 5.42 MB | 6.19 MB | 8.1× |
| TypeScript + Rust + Markdown | 9 | 890.9 kB | 618.2 kB | 6.06 MB | 6.68 MB | 10.8× |

“Grammar-only” means Ferriki's existing unoptimized `.fkgram` representation,
not raw TextMate JSON. “Extra prepared scanners” counts the compressed `.fkbc`
programs and automata; Prepared retains the grammar payloads and adds these
files. Normalized JSON is a separate source-size reference, not a network
comparison with Shiki, gzip or Brotli. HTTP headers and additional transport
encoding are excluded.

The disk cache also retains decoded scanner containers and local indexes, so
its footprint is larger than the downloaded payload. Persistent caches reuse
unchanged content; changed content or incompatible formats can require new
downloads. The combined example deduplicates shared dependencies. It does not
add the three independent totals, and no row loads the entire catalog.

The tradeoff is additional transfer and disk space in exchange for reusing
static regex preparation across processes. The fresh-process timings on the
[benchmark page](https://ferriki.dev/evidence/benchmarks#four-regex-policies)
use populated download and decoded caches, so they exclude this initial cost.

The catalog contains 67 standard entries for languages and formats plus 27
support grammars for embeddings and injections, for 94 grammar entries in all.
