# Native declarative rendering: warmed public API comparison

Classic, single-theme HTML with declarative decorations takes 33–45% less
elapsed time for the word-range cases on this local host. Marking lines 4–10
of an 80-line sample takes 32% less time. Both operations return byte-identical
HTML to current main. The facade automatically selects the native renderer;
the existing `codeToHtml(source, { decorations, ... })` API is unchanged.

These are local Apple M1 Ultra results, not a general hardware guarantee or
an Intel/macOS CI comparison. CSS-class output and callback rendering keep
the existing pipeline; this change does not claim to accelerate those paths.

## Evidence and baseline

- Final report: [results.json](results.json), including every sample, process,
  output hash, source fingerprint, loaded-addon hash, and build receipt.
- Earlier measurement: [before-callback-guard-results.json](before-callback-guard-results.json).
  It compares `c00cbc9` against the immediately merged decoration-policy PR
  (`819deba`), before the early callback guard. It is retained as intermediate
  evidence. The final comparison includes the guard and subsequent main fixes;
  the two series do not isolate the guard's effect.
- Final baseline: `7cfb66d504b12fa42111346c28fb94a2a0ec4573` (current main,
  including #250 and the later asset, callback-contract, and release fixes).
- Final feature: `d8cc172aa48d1fd3be6a08d8f34ffe88cb3f96c6`. Its only untracked
  files at build time were these benchmark reports; runtime sources were committed.
- Host: Apple M1 Ultra, macOS arm64; Node v24.21.0; ordinary release addons built
  with Rust 1.99.0 and Ferroni 2.1.0 with `dfa-prefilter` enabled.
- Harness SHA-256: `db8313623c99befc1057cbb290ca8491fe63338b8a5da65617e3251cb5da3548`.

Both addons were built from their own worktree sources. The harness verifies
that each loaded binary matches its build receipt. No profiling allocator,
bridge instrumentation, builds, or tests ran during the final timing series.

## Method

The comparison uses reused highlighters with JavaScript and the Nord theme.
Each process warms each case with 40 renders, then records seven batches of
80 renders for four-line sources or 10 renders for 80-line sources. Three
processes per engine run sequentially in AB/BA/AB order. The table reports the
median of all 21 batch samples per case, in milliseconds per render.

The word cases decorate two or 40 ranges with string attributes, mixing token
and wrapper targets. The line-range case marks lines 4–10 for 80 lines; its
four-line counterpart marks line 4. Mixed cases include decoration callbacks
and a span transformer. Class cases call `codeToHtmlWithCss`; inline cases call
`codeToHtml`. Every HTML/CSS output hash matches between engines and runs.

| Case | Main (ms) | Native lane (ms) | Elapsed-time change |
| --- | ---: | ---: | ---: |
| 4-lines/inline/control | 0.1105 | 0.1100 | -0.5% |
| 4-lines/inline/declarative | 0.2507 | 0.1374 | -45.2% |
| 4-lines/inline/mixed | 0.2686 | 0.2710 | +0.9% |
| 4-lines/inline/line-range | 0.2198 | 0.1312 | -40.3% |
| 4-lines/classes/control | 0.6256 | 0.6301 | +0.7% |
| 4-lines/classes/declarative | 0.6681 | 0.6710 | +0.4% |
| 4-lines/classes/mixed | 0.6992 | 0.6952 | -0.6% |
| 4-lines/classes/line-range | 0.6437 | 0.6401 | -0.6% |
| 80-lines/inline/control | 1.8342 | 1.8098 | -1.3% |
| 80-lines/inline/declarative | 3.3727 | 2.2518 | -33.2% |
| 80-lines/inline/mixed | 3.7967 | 3.8538 | +1.5% |
| 80-lines/inline/line-range | 3.0903 | 2.0924 | -32.3% |
| 80-lines/classes/control | 8.6158 | 8.4891 | -1.5% |
| 80-lines/classes/declarative | 9.4694 | 9.2931 | -1.9% |
| 80-lines/classes/mixed | 10.0008 | 9.9783 | -0.2% |
| 80-lines/classes/line-range | 8.8317 | 8.8800 | +0.5% |

The four-line mixed case is 0.9% slower and the 80-line mixed case is 1.5%
slower in this series. Controls range from −1.5% to +0.7%; these small changes
should not be presented as speedups. Pure declarative improvements exceed
that drift and recur across all three processes:

| Case | Main process-median range (ms) | Native process-median range (ms) |
| --- | ---: | ---: |
| 4-lines/inline/declarative | 0.2474–0.2676 | 0.1367–0.1377 |
| 4-lines/inline/line-range | 0.2188–0.2248 | 0.1295–0.1329 |
| 80-lines/inline/declarative | 3.3465–3.3879 | 2.2451–2.3224 |
| 80-lines/inline/line-range | 3.0515–3.2425 | 2.0152–2.1283 |

## Transport and memory observations

Separate instrumentation counts one native render operation for eligible
inline declarative cases, versus four on main: tokenization, boundary splitting,
range preparation, and tree planning. Common asset resolution is excluded from
this count. Mixed cases keep six calls for four lines and 27 for 80 lines;
controls keep one. Instrumented timings are diagnostic only.

The raw report also contains five JS heap-growth samples per case and process,
with GC before each render and the result still alive. This measures coarse
allocation pressure, not retained memory, exact allocation counts, or Rust
memory. For example, the 80-line word case's median JS heap growth falls from
2,728,352 to 347,744 bytes. No Rust allocator comparison was collected for the
complete native renderer. The optional existing profiler covers only the
separate decoration bridge and must not be treated as complete render profiling.

## Compatibility and supported scope

Eligibility requires classic structure, a single named theme, inline theme
styles, plain decoration records, and string attributes. Callbacks, accessors,
proxies, custom prototypes, class arrays, other non-string values, metadata,
grammar state, multi-theme output, and CSS-class output keep the existing host
pipeline. UTF-16 slices inside surrogate pairs and lone surrogate strings keep
exact JS behavior through that pipeline. A surrogate-half range can require
one native attempt followed by tokenization in the fallback. The stable Rust
API is unchanged; this is a private Node consumer bridge.

Validation passed:

- 56 direct output comparisons against the callback pipeline, including nested
  ranges, line markers, CRLF, Unicode, root controls, token merging, and fallbacks.
- 248 frozen public decoration outputs and callback traces from the original implementation.
- The mandatory `pnpm -C node run test:ferriki-compat:core` release gate on
  the final rebased runtime, including the new rendering checks.
- Packed Vite consumers on Vite 8.0.0 and 8.3.2, TypeScript, ESLint, formatting,
  and the ADR index.
- Rust all-feature coverage: 90.17% (12,950/14,361 lines; gate: 89%), including
  renderer and binding tests. Clippy, Rustdoc warnings, and the declared Rust
  1.94.0 MSRV check passed. Rust implementation is unchanged by the subsequent
  callback guard and rebase.

## Reproduction

Build ordinary release addons in the baseline and feature worktrees. Give each
worktree its own platform sidecar even if dependency directories are shared.
Run the feature harness with no concurrent test/build process:

```sh
node node/scripts/bench-native-decorations.mjs \
  --baseline /path/to/main/node/ferriki/index.mjs \
  --write /path/to/results.json
```
