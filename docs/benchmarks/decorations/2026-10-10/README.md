# Native decoration policy: compatibility and local costs

I measured the implementation for #122 against the original JS decoration
policy, using reusable highlighters with warm assets and grammars. The
migration establishes native ownership; the results do not justify a general
speed claim. Large inline examples improve in this series, while small inline
examples retain a fixed overhead. CSS-class results stay within a few percent
in this series.

## Method and provenance

The host was Apple M1 Ultra / macOS arm64, Node v24.21.0, Rust 1.99.0,
with Ferroni 2.1.0 and its default prefilter. Both timing addons were ordinary
release builds, without `profiling`. The harness verifies the hash of the addon
actually loaded against each build receipt. [results.json](results.json)
retains source and binary fingerprints, compiler flags, receipts, fixture hashes,
all raw samples, and output hashes. The current receipt identifies implementation commit `1d7c704` and fingerprints
its source. A later follow-up maps malformed numeric-field errors to
`ERR_USAGE` and extends validation tests; the measured successful rendering
paths remain unchanged.

The baseline facade is at `f9cfb0745c99805e40af51c872d2178e99ad221c`.
Its addon receipt identifies `19a363a20927ad52c5222daa16d86796056ce2ce`;
there is no Rust or dependency diff between those revisions, nor a runtime
diff from the baseline facade to main `695e5f6e` before this change.

Each worker creates one JavaScript highlighter and renders a four-line or
80-line snippet containing identifiers, calls, Unicode, and HTML metacharacters.
Declarative cases decorate one identifier on every second line: two or 40
ranges, alternating token and forced-wrapper targets. Mixed cases additionally
run a span transformer and a decoration callback on every fifth range. Control
cases have neither. Each case warms up 40 times and records seven batches of
80 or ten renders. Three independent processes per engine run sequentially in
AB / BA / AB order, without concurrent tests or builds. Values below are medians
of 21 batch averages in milliseconds per render. Every HTML/CSS output hash
matches the baseline.

## Public rendering

| Case                         | Original JS policy, ms | Native policy, ms | Change |
| ---------------------------- | ---------------------: | ----------------: | -----: |
| 4-lines/inline/control       |                 0.1098 |            0.1093 |  -0.4% |
| 4-lines/inline/declarative   |                 0.2326 |            0.2481 |  +6.7% |
| 4-lines/inline/mixed         |                 0.2335 |            0.2695 | +15.4% |
| 4-lines/classes/control      |                 1.2333 |            1.2356 |  +0.2% |
| 4-lines/classes/declarative  |                 1.2286 |            1.2623 |  +2.7% |
| 4-lines/classes/mixed        |                 1.2568 |            1.2892 |  +2.6% |
| 80-lines/inline/control      |                 1.8395 |            1.8185 |  -1.1% |
| 80-lines/inline/declarative  |                 3.8609 |            3.5550 |  -7.9% |
| 80-lines/inline/mixed        |                 4.0690 |            3.9079 |  -4.0% |
| 80-lines/classes/control     |                22.6227 |           22.5348 |  -0.4% |
| 80-lines/classes/declarative |                24.2179 |           24.1714 |  -0.2% |
| 80-lines/classes/mixed       |                24.9857 |           24.4767 |  -2.0% |

Small inline overhead is about 15–36 microseconds per render, or 7–15% here.
The 80-line inline medians improve by 4.0–7.9%. No-decoration controls range
from -1.1% to +0.2%. CSS-class changes range from -2.0% to +2.7%; I do not
use these low single-digit differences as a general speed claim. These
fixtures and one host cannot predict every language, range density, nesting
pattern, or callback workload. No CI speed threshold is introduced.

## Separate boundary and allocation diagnostics

A separate `profiling` addon measures input conversion, native policy including
plan DTO construction, and output conversion. These diagnostic timings are
not the release end-to-end timings above. The table aggregates a render's extra
decoration calls, excluding the existing token/render-data boundary. It reports
medians of 27 diagnostic samples across the three current workers.

| Case                         | Calls | Input, ms | Policy, ms | Output, ms | Rust allocations: input / policy / output | Rust allocated bytes: input / policy / output |
| ---------------------------- | ----: | --------: | ---------: | ---------: | ----------------------------------------- | --------------------------------------------- |
| 4-lines/inline/declarative   |     3 |    0.0069 |     0.0051 |     0.0073 | 7 / 94 / 4                                | 1192 / 15734 / 320                            |
| 4-lines/inline/mixed         |     5 |    0.0086 |     0.0054 |     0.0087 | 9 / 102 / 4                               | 1192 / 15558 / 320                            |
| 4-lines/classes/declarative  |     3 |    0.0066 |     0.0055 |     0.0073 | 7 / 103 / 4                               | 1192 / 21798 / 320                            |
| 4-lines/classes/mixed        |     5 |    0.0090 |     0.0064 |     0.0091 | 9 / 112 / 4                               | 1192 / 21494 / 320                            |
| 80-lines/inline/declarative  |     3 |    0.0974 |     0.1176 |     0.1152 | 7 / 1449 / 80                             | 23840 / 363464 / 6400                         |
| 80-lines/inline/mixed        |    26 |    0.1205 |     0.1287 |     0.1336 | 37 / 1598 / 80                            | 23840 / 374184 / 6400                         |
| 80-lines/classes/declarative |     3 |    0.0982 |     0.1435 |     0.1141 | 7 / 1610 / 80                             | 23840 / 464264 / 6400                         |
| 80-lines/classes/mixed       |    26 |    0.1190 |     0.1532 |     0.1296 | 37 / 1774 / 80                            | 23840 / 494952 / 6400                         |

A declarative render adds three calls: token splitting, range/section preparation,
and tree planning. Mixed cases add continuation and plan calls around callbacks;
sections between callbacks are batched, and each plan transports only the lines
it can touch. Numeric buffers avoid one N-API object per token or node. Rust
selects ranges and wrapping; JS replays edits on existing objects and retains
opaque properties and callback references.

The counting allocator reports Rust heap allocations and reallocations, not V8
allocations. Output buffers are allocated during policy work and transferred to
V8 during conversion. The raw report also retains instrumented call times and
metadata word counts, plus five V8 heap-growth samples with the result alive
after a full GC. Heap growth is a coarse allocation-pressure diagnostic, not an
exact allocation count or retained-memory guarantee; it includes host tree
creation, slicing, edit replay, and serialization. The phase table excludes
that host work and later garbage collection. It cannot be subtracted from
release totals to claim an exact host cost.

## Compatibility and reproduction

The core gate runs `check:decorations`, which compares 248 public HTML/CSS
outputs and callback traces with a frozen pre-migration fixture. It covers
nesting, overlap errors, negative columns, CRLF, Unicode and surrogate boundaries,
empty/trailing lines, preprocess/token/HAST mutations, shared nodes and arrays,
callback replacements, changed resolved bounds and wrapping, retained identities,
and partial edits before errors. The binding also rejects malformed numeric
records and cycles. Non-finite and fractional coordinates now fail with
`ERR_USAGE`; they are not treated as supported index positions.

The Rust API decision is recorded in [ADR 0008](../../../../adr/0008-transformers-and-decorations-stay-in-js.md)
and [ADR 0014](../../../../adr/0014-rust-crate-semver-surface.md): these are typed
internal primitives for the existing Node consumer, not a new stable Rust HAST
or callback API. Transformer contract work remains in #241.

Build the ordinary addon with `pnpm -C node run build:native`. For diagnostics,
build `ferriki-core` separately with `--release --features profiling`, keeping
its type-definition folder and copied addon separate from the published addon.
Then run from the repository root:

```sh
node node/scripts/bench-native-decorations.mjs \
  --baseline /path/to/baseline/node/ferriki/index.mjs \
  --profiling-addon /path/to/ferriki-profiling.node \
  --write docs/benchmarks/decorations/2026-10-10/results.json
```

The ordinary addons and profiling addon are independently fingerprinted. Omitting
`--profiling-addon` retains release timings and host diagnostics without the
phase table. Constructor/startup costs are excluded from this warm-call test.
