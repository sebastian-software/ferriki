# Rust syntect comparison

These captures compare complete HTML-highlighting calls for syntect 5.3.0
using `regex-onig` and `regex-fancy`, and Ferriki 0.13.0. They describe this
host and corpus; they are not output-parity tests, regex-engine microbenchmarks,
or speedup claims.

Captured October 10, 2026, on an Apple M1 Ultra (`aarch64-apple-darwin`) with
`rustc 1.99.0 (b940084d7 2026-09-28)`. All six reports record source revision
`64fb59358009095dc8998080a23d3b80597d6d2e` with a clean worktree, the same
locked comparison dependencies, and the same Ferriki asset release manifest.
This is the shared Ferriki 0.13.0 base runtime before the scanner-cache work
tracked in issue #230; these captures do not include that change.
The engine order was `syntect-onig`, `syntect-fancy`, `ferriki-only` in round A
and `ferriki-only`, `syntect-fancy`, `syntect-onig` in round B. Captures ran
serially from 12:13:35 to 12:14:08 UTC.

## Corpus and syntax resolution

The fixture files are from Ferroni commit
[`0136c99d3aad9aad9eeaa025692124e94420153d`](https://github.com/sebastian-software/ferroni/tree/0136c99d3aad9aad9eeaa025692124e94420153d/benches).
The harness resolved each document's exact extension in syntect 5.3.0's
bundled default syntax set. No fallback or substitute grammar was used.

| Fixture | Resolved syntect syntax |
| --- | --- |
| Java | Java |
| C++ | C++ |
| CSS | CSS |
| HTML | HTML |
| JSON | JSON |
| Markdown | Markdown |
| Python | Python |
| Ruby | Ruby |
| Rust | Rust |
| Shell | Bourne Again Shell (bash) |
| YAML | YAML |

These nine formats from the pinned 20-format Ferriki corpus were explicitly
excluded because their exact extensions did not resolve to a non-plain syntax
in syntect's bundled default set: Astro (`astro`), Svelte (`svelte`), Swift
(`swift`), TSX (`tsx`), Vue (`vue`), MDX (`mdx`), SCSS (`scss`), TOML (`toml`),
and TypeScript (`ts`). Their fixture hashes and reasons are in every report.
The two support-probe outputs and complete default syntax-name list are
retained as `probe-onig.txt` and `probe-fancy.txt`; both probes produced the
same result.

## Timings

All values below are milliseconds. The raw JSON retains nanosecond samples and
per-capture summaries. Setup is the median of ten fresh-engine setup samples in
each round. Each first-use language value is the median of 20 samples (ten per
round) for that document. Each warmed value is the median of 60 samples (30
per round) for that document. Values are reported separately for each engine;
there is no cross-engine ratio or aggregate.

### Fresh-engine setup

| Engine | Round A | Round B |
| --- | ---: | ---: |
| syntect `regex-onig` | 0.593 | 0.607 |
| syntect `regex-fancy` | 0.659 | 0.660 |
| Ferriki | 0.598 | 0.622 |

### First corpus pass

“First use” means the first corpus pass on a fresh in-process engine instance.
Engine setup is measured separately; process startup and cold operating-system
caches are excluded. Each call includes the high-level HTML-rendering API and
its own grammar/theme behavior.

| Language | syntect `regex-onig` | syntect `regex-fancy` | Ferriki |
| --- | ---: | ---: | ---: |
| Java | 2.065 | 15.391 | 12.314 |
| C++ | 7.445 | 71.530 | 365.327 |
| CSS | 1.393 | 6.011 | 49.253 |
| HTML | 9.744 | 58.601 | 100.346 |
| JSON | 0.355 | 1.269 | 2.852 |
| Markdown | 3.063 | 58.863 | 118.916 |
| Python | 4.306 | 27.838 | 23.360 |
| Ruby | 2.628 | 20.382 | 83.645 |
| Rust | 3.544 | 25.590 | 5.585 |
| Shell (bash) | 2.276 | 25.439 | 10.790 |
| YAML | 0.855 | 7.369 | 3.449 |

### Warmed reuse

The warmed lane uses a separate engine instance, five untimed corpus warmups,
then 30 timed renders per document in each round. Document order rotates. Each
cell is the median across both rounds.

| Language | syntect `regex-onig` | syntect `regex-fancy` | Ferriki |
| --- | ---: | ---: | ---: |
| Java | 0.678 | 1.289 | 0.449 |
| C++ | 1.123 | 3.016 | 0.890 |
| CSS | 0.812 | 1.892 | 0.611 |
| HTML | 0.886 | 2.034 | 0.891 |
| JSON | 0.302 | 0.273 | 0.296 |
| Markdown | 0.433 | 3.189 | 0.597 |
| Python | 1.566 | 3.546 | 0.545 |
| Ruby | 0.985 | 2.552 | 0.379 |
| Rust | 0.682 | 1.796 | 0.368 |
| Shell (bash) | 0.706 | 2.144 | 0.517 |
| YAML | 0.534 | 1.875 | 0.293 |

The engines use different grammars, themes, scope mappings, and output
contracts. Syntect rendered with its bundled `base16-ocean.dark` theme through
`highlighted_html_for_string`; Ferriki used its bundled `nord` theme through
`Highlighter::highlight` and `render_html`. Before timing, each engine was
checked for source preservation and highlighted span markup. HTML and colors
were not compared for equality. The inputs are a common subset, not equivalent
highlighting work.

## Receipts

| Engine | Cargo feature | Binary SHA-256 |
| --- | --- | --- |
| syntect `regex-onig` | `syntect-onig` | `fee150079baa50b62a324685f7250a5b44a7090a97e19fa3ca0a0165d08dd892` |
| syntect `regex-fancy` | `syntect-fancy` | `cfdafadadb23217c26267300959ae6ee5a594fbee509a0fde4c507dfff642841` |
| Ferriki | `ferriki-only` | `991aec2e5985de1b866fd6a272cdd2a24b7055bb882db5e8a136f331f09dcadd` |

Each report contains the same binary hash before and after its run, and every
report marks all 20 fixture files unchanged. They also retain the resolved
syntax names, source hashes, per-document raw samples and order, release
profile, Rust flags, target, lockfile hash, and asset-manifest hash. The report
copies in this directory preserve the per-report timing and identity fields;
byte-for-byte command output is under [`raw-generated/`](raw-generated/).

The first generator version formatted syntect target-directory names as
`/tmp/ferriki-syntect-syntect-onig` and
`/tmp/ferriki-syntect-syntect-fancy` in `build.cargo_command`. Those strings
were incorrect: the actual isolated build directories were
`/tmp/ferriki-syntect-onig` and `/tmp/ferriki-syntect-fancy`, as shown in the
preparation commands and verified binary hashes. The Ferriki target path was
correct. In the report copies above, only `build.cargo_command` was normalized
to the actual command used; all original JSON bytes are retained in
`raw-generated/`. No timing samples, binary hashes, input hashes, source
revision, or validation fields were changed. The harness formatter was fixed
after capture for future runs; the six reports continue to identify the clean
source revision that produced the measured binaries. Clippy-only cleanups to
the build-script flag normalization, HTML entity decoder, and median parity
check were also made afterward; these changes preserve measured behavior and
were not used to produce the captures.

The build used Cargo's release profile with `opt-level=3`, `debug=false`,
`strip=symbols`, `lto=fat`, and `codegen-units=1`; no custom Rust flags were
supplied. The feature-specific target directories, lockfile, source revision,
and binary hashes are recorded in the receipts. `SHA256SUMS` covers the
reports, raw reports, probes, and this summary.
