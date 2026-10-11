# Native decoration policy: compatibility and local costs

I measured the implementation for #122 against the original JS decoration
policy, using reusable highlighters with warm assets and grammars. The optimized
implementation reduces native allocation work. Large inline examples improve
against the original JS policy in this series; small examples retain a fixed
boundary cost. These measurements do not establish a general speed claim.

## Method and provenance

The host was Apple M1 Ultra / macOS arm64, Node v24.21.0, Rust 1.99.0,
with Ferroni 2.1.0 and its default prefilter. Timing addons were ordinary release
builds, without `profiling`. The harness verifies the hash of the addon actually
loaded against each build receipt. I retained three separate reports:

- [results.json](results.json): the initial migration at `1d7c704`, before the
  optimizations. The later `4460b75` fix only changes malformed-coordinate error
  handling; measured successful rendering paths are unchanged.
- [optimization-results.json](optimization-results.json): direct comparison of
  PR revision `4460b75` with optimized revision `3321dcd`.
- [optimized-migration-results.json](optimized-migration-results.json): the
  optimized revision compared again with the original JS decoration policy.

Each report retains source and binary fingerprints, compiler flags, receipts,
fixture hashes, all raw samples, and output hashes. Both optimized series use
one ordinary addon built from clean revision `3321dcd`. For the direct
comparison, I preserved the pre-optimization addon and receipt in a separate
checkout before rebuilding. Its receipt identifies `1d7c704`; the only subsequent
runtime change at `4460b75` maps malformed-coordinate errors.

The original JS facade is at `f9cfb0745c99805e40af51c872d2178e99ad221c`.
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
matches its baseline.

## Optimized public rendering versus the original JS policy

| Case | Baseline, ms | Optimized native policy, ms | Change |
| --- | ---: | ---: | ---: |
| 4-lines/inline/control | 0.1068 | 0.1081 | +1.2% |
| 4-lines/inline/declarative | 0.2253 | 0.2417 | +7.2% |
| 4-lines/inline/mixed | 0.2321 | 0.2544 | +9.6% |
| 4-lines/classes/control | 1.2157 | 1.2227 | +0.6% |
| 4-lines/classes/declarative | 1.2124 | 1.2485 | +3.0% |
| 4-lines/classes/mixed | 1.2376 | 1.2820 | +3.6% |
| 80-lines/inline/control | 1.7682 | 1.7859 | +1.0% |
| 80-lines/inline/declarative | 3.7739 | 3.3992 | -9.9% |
| 80-lines/inline/mixed | 3.9553 | 3.7753 | -4.6% |
| 80-lines/classes/control | 22.3238 | 22.3168 | -0.0% |
| 80-lines/classes/declarative | 24.1076 | 23.6329 | -2.0% |
| 80-lines/classes/mixed | 24.2512 | 24.2877 | +0.2% |

Small inline overhead remains about 16–22 microseconds per render, or 7–10%
here. The 80-line inline medians improve by 4.6–9.9%. No-decoration controls
range from approximately 0% to +1.2%. CSS-class changes range from -2.0% to
+3.6%; I do not use these low single-digit differences as a general speed claim.

For the large declarative inline case, the three process medians span
3.7687–3.7922 ms for the original JS policy and 3.3700–3.4289 ms for the
optimized policy. For large mixed inline rendering they span 3.9485–3.9682 ms
and 3.7387–3.7775 ms respectively. These ranges describe observed variation,
not confidence intervals. The raw reports retain every process and batch.
These fixtures and one host cannot predict every language, range density,
nesting pattern, or callback workload. No CI speed threshold is introduced.

## What the three optimizations change

- Prepare sorted, deduplicated split boundaries once per render, rather than
  once per line. Binary search skips boundaries before each token and traversal
  stops at that token's end; token order need not be monotonic.
- Emit token slices directly into the packed output buffer. Reuse token metadata
  and graph traversal buffers within a native call, and reserve plan output from
  the section count. No persistent cache retains user objects or callback state.
- Group the contiguous sections emitted by Rust in one JS pass, instead of
  filtering the full section list once per decoration.

The direct pre-optimization comparison is below. Its baseline is the existing
native-policy PR, not the original JS implementation.

| Case | Baseline, ms | Optimized native policy, ms | Change |
| --- | ---: | ---: | ---: |
| 4-lines/inline/control | 0.1099 | 0.1085 | -1.3% |
| 4-lines/inline/declarative | 0.2512 | 0.2456 | -2.2% |
| 4-lines/inline/mixed | 0.2660 | 0.2614 | -1.7% |
| 4-lines/classes/control | 1.2480 | 1.2166 | -2.5% |
| 4-lines/classes/declarative | 1.2790 | 1.2434 | -2.8% |
| 4-lines/classes/mixed | 1.3293 | 1.2691 | -4.5% |
| 80-lines/inline/control | 1.8328 | 1.7636 | -3.8% |
| 80-lines/inline/declarative | 3.5863 | 3.4068 | -5.0% |
| 80-lines/inline/mixed | 3.8931 | 3.7655 | -3.3% |
| 80-lines/classes/control | 22.5488 | 22.4777 | -0.3% |
| 80-lines/classes/declarative | 23.8266 | 23.5681 | -1.1% |
| 80-lines/classes/mixed | 25.0439 | 24.4177 | -2.5% |

Decoration cases improve by 1.1–5.0% in this direct series, but unchanged
controls also improve by 0.3–3.8%. This series does not isolate a reliable
additional end-to-end speedup from measurement variation. The simpler traversal
and lower allocation work are the stronger results of these optimizations.

The counting allocator provides a separate, deterministic allocation comparison
for the same inputs. The pre-optimization values come from the initial report;
the optimized values come from the direct comparison. Counts include Rust
policy and plan/output-buffer construction, not V8 allocations.

| Case | Policy allocations before / after | Policy bytes before / after |
| --- | ---: | ---: |
| 4-lines/inline/declarative | 94 / 71 | 15734 / 11574 |
| 4-lines/inline/mixed | 102 / 80 | 15558 / 11270 |
| 4-lines/classes/declarative | 103 / 76 | 21798 / 16582 |
| 4-lines/classes/mixed | 112 / 86 | 21494 / 16150 |
| 80-lines/inline/declarative | 1449 / 890 | 363464 / 219784 |
| 80-lines/inline/mixed | 1598 / 1058 | 374184 / 234344 |
| 80-lines/classes/declarative | 1610 / 971 | 464264 / 299464 |
| 80-lines/classes/mixed | 1774 / 1154 | 494952 / 333992 |

Large declarative inline policy allocations fall from 1,449 to 890 (38.6%), and
allocated bytes fall from 363,464 to 219,784 (39.5%). Its separate instrumented
policy time falls from 0.1176 to 0.0645 ms. Instrumented timings include counting
allocator overhead and are not release end-to-end timings.

## Separate boundary and allocation diagnostics

A separate `profiling` addon measures input conversion, native policy including
plan DTO construction, and output conversion. The table below uses the optimized
migration report and aggregates a render's extra decoration calls, excluding the
existing token/render-data boundary. It reports medians of 27 diagnostic samples
across the three current workers.

| Case | Calls | Input, ms | Policy, ms | Output, ms | Rust allocations: input / policy / output |
| --- | ---: | ---: | ---: | ---: | --- |
| 4-lines/inline/declarative | 3 | 0.0066 | 0.0042 | 0.0075 | 7 / 71 / 4 |
| 4-lines/inline/mixed | 5 | 0.0083 | 0.0042 | 0.0083 | 9 / 80 / 4 |
| 4-lines/classes/declarative | 3 | 0.0067 | 0.0045 | 0.0070 | 7 / 76 / 4 |
| 4-lines/classes/mixed | 5 | 0.0084 | 0.0052 | 0.0087 | 9 / 86 / 4 |
| 80-lines/inline/declarative | 3 | 0.0993 | 0.0632 | 0.1131 | 7 / 890 / 80 |
| 80-lines/inline/mixed | 26 | 0.1142 | 0.0730 | 0.1249 | 37 / 1058 / 80 |
| 80-lines/classes/declarative | 3 | 0.0959 | 0.0745 | 0.1133 | 7 / 971 / 80 |
| 80-lines/classes/mixed | 26 | 0.1134 | 0.0815 | 0.1258 | 37 / 1154 / 80 |

A declarative render still adds three calls: token splitting, range/section
preparation, and tree planning. Mixed cases add continuation and plan calls
around callbacks; sections between callbacks are batched, and each plan
transports only the lines it can touch. These optimizations do not change
callback stages or the number of crossings. Numeric buffers avoid one N-API
object per token or node. Rust selects ranges and wrapping; JS replays edits on
existing objects and retains opaque properties and callback references.

The counting allocator reports Rust heap allocations and reallocations, not V8
allocations. Output buffers are allocated during policy work and transferred to
V8 during conversion. Raw reports also retain allocated bytes, instrumented
call times, metadata word counts, and five V8 heap-growth samples with the result
alive after a full GC. Heap growth is a coarse allocation-pressure diagnostic,
not an exact allocation count or retained-memory guarantee; it includes host
tree creation, slicing, edit replay, and serialization. The phase table excludes
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
  --write /path/to/new-results.json
```

The ordinary addons and profiling addon are independently fingerprinted. Omitting
`--profiling-addon` retains release timings and host diagnostics without the
phase table. Constructor/startup costs are excluded from this warm-call test.
