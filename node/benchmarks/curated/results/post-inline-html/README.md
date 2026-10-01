# Bounded profiling after direct inline HTML: October 1, 2026

Two independent experiments start from Ferriki 0.8.1 / Ferroni 1.8.0. The
borrowed-escaping candidate is accepted; the single-buffer style candidate is
rejected. The accepted candidate retains **20/20 wins against the faster Shiki
backend** at both sizes in both complete repetitions. No engine expression,
opcode, compiler flag, unsafe block or public API changes are included.

Across the 20 format-specific paired median changes, borrowed escaping reduces
HTML time by 7.3% / 9.0% for examples and 5.2% / 6.6% for large inputs in the
two comparisons. These are medians of per-format changes, not a weighted
aggregate highlighting throughput. Four cells increase by at most 3.2% in the
first comparison; all four improve in the second. No regression repeats.

All eight complete public matrices are retained, including the rejected
experiment. Neither timed matrices nor unfavorable cells were discarded.
Both experiments compare all 80 HTML/token cells per paired/repeat comparison
with explicit Ferriki isolation and zero exclusions.

## Accepted: borrow strings that need no escaping

`escape_html` and `escape_attribute` return a borrowed `Cow<str>` when no
substitution is required. Necessary escaping uses the original replacements,
including quotes, Unicode and literal entity-looking text. The structural
HAST serializer still returns owned output. The change is concentrated in
`src/render.rs`; Node/N-API routing and all public return types remain intact.

| Format     | Example time reduction vs. control | Large time reduction vs. control | Large / best Shiki |
| ---------- | ---------------------------------: | -------------------------------: | -----------------: |
| TypeScript |                          5.5–11.5% |                         4.4–6.1% |        0.383–0.385 |
| TSX        |                           9.3–9.5% |                         6.5–6.5% |        0.366–0.370 |
| Rust       |                         10.4–15.2% |                         7.0–9.7% |        0.266–0.266 |
| CSS        |                          2.7–15.2% |                        4.9–12.6% |        0.614–0.642 |
| HTML       |                           6.0–6.3% |                        -0.1–6.5% |        0.405–0.408 |
| C++        |                          5.7–15.8% |                         3.6–6.5% |        0.759–0.770 |
| Swift      |                           8.2–9.1% |                         4.7–7.0% |        0.408–0.415 |
| Java       |                           3.0–7.8% |                         5.2–6.3% |        0.550–0.558 |
| Markdown   |                          9.2–11.0% |                         4.9–7.1% |        0.386–0.388 |
| TOML       |                           6.9–6.9% |                         8.1–8.4% |        0.652–0.657 |
| YAML       |                           6.6–6.8% |                         6.1–7.1% |        0.536–0.540 |
| JSON       |                          9.3–10.7% |                        9.6–10.6% |        0.552–0.555 |
| Astro      |                         11.0–13.3% |                         3.8–7.1% |        0.347–0.356 |
| Svelte     |                          4.3–16.0% |                        -1.3–6.7% |        0.344–0.346 |
| Ruby       |                          6.6–11.4% |                         2.8–8.7% |        0.198–0.200 |
| Python     |                          -3.2–3.9% |                         2.3–6.4% |        0.273–0.274 |
| Vue        |                         -0.8–13.3% |                         2.2–8.3% |        0.278–0.282 |
| MDX        |                           6.4–8.8% |                         4.8–5.0% |        0.398–0.400 |
| SCSS       |                           5.5–8.6% |                         5.9–6.2% |        0.562–0.563 |
| Bash       |                          7.5–10.8% |                         5.4–6.4% |        0.467–0.467 |

A negative reduction denotes a slowdown in that pair. C++ gains should not be
attributed entirely to the escaping helper: its profile spends little time in
rendering, and timings can also reflect ordinary variation and linked-code effects.
The retained measurements establish end-to-end behavior for this corpus and
machine, rather than isolating a per-function speedup or proving universal gains.

## Rejected: single-buffer token styles

The separate branch `codex/inline-style-buffer`, implementation commit
`6fa268997d0dc8912291f5f971158d5f04025ae1`, assembles CSS declarations into one
allocation instead of joining owned parts. Both candidate repetitions retain
20/20 wins, but the median large-input gain is only 1.6% / 2.9%, with uneven
example results. Short Swift regresses by 6.8% / 7.6%, Rust by 8.6% / 5.6% and
CSS by 13.8% / 5.2%. That tradeoff does not justify adoption in this final round.
Its full reports, source/build receipts and successful parity gates remain under
`style/`. None of that candidate's production code is included in this PR.

## Corrected CPU profiles

Four public, warmed `codeToHtml` large workloads use the same curated fixtures,
theme and assets as the matrices. Each runs for 20 seconds, with a 10-second
macOS `sample` capture after validation and five warm calls. A separate release
build enables line tables and disables stripping; its timings are diagnostic
and are not used for performance claims.

| Format | Ferroni | Renderer | Token styles | String replace |
| ------ | ------: | -------: | -----------: | -------------: |
| cpp    |   86.5% |     2.1% |         0.6% |           0.5% |
| css    |   30.8% |    19.4% |         5.8% |           5.8% |
| toml   |   20.4% |    20.7% |         6.5% |           6.5% |
| tsx    |   59.4% |     9.6% |         2.9% |           2.7% |

All columns are inclusive shares of main-thread samples and overlap. The
renderer share falls to about 20% in CSS/TOML after avoiding the HAST tree;
C++ instead spends about 87% in Ferroni, predominantly the VM. CSS/TOML still
show about 6% in repeated string replacement. VM cost spans many execution
steps; this bounded round does not introduce a speculative VM redesign.

The initial profiler invocation exposed a build-helper bug: Cargo built in the
requested custom target directory, but the Node builder copied the old default
artifact. The initial address mapping therefore used a different binary UUID
and is excluded (`profiles/initial-attempt/status.json`). All reported CPU
figures come from the corrected captures. The exact loaded profile binary hash,
Mach-O UUID, receipt and capture output are checked against the symbol-bearing
artifact; all four corrected outputs pass exact token/HTML parity. The raw and
symbolized captures, summary script and explicit artifact-selection driver are
retained. Native symbols were available directly in the corrected captures;
no address replacements were necessary.

Subsequent separate commit `5e9ab9160cefc11bcf47e87d1f9766015a59c578` fixes the
Node builder to use `cargo metadata`'s `target_directory` and records
`CARGO_PROFILE_*` overrides in receipts. This correction is subsequent to the
timed candidate and does not contribute to its measured gain. Default and
custom symbol-enabled target selection are verified in the final gate logs.

## Measurement contract

- Control: clean Ferriki main/release commit
  `b50eddbfd45e8505023486eb2f0581d446bb3754` (0.8.1), including merged #174 and
  #175. No duplicate scoped-token scan or intermediate inline HAST tree remains.
- Accepted measured candidate:
  `25cc596da7aa93ffe93af9a55c471e0a98ede8a4`; its only difference from the
  control is `src/render.rs`, including tests. It is independent of the rejected
  style branch and contains no combined or third performance experiment.
- Both variants resolve the same locked registry Ferroni 1.8.0, with the same
  checksum, compiler, features, profile and build flags. Ordinary native builds
  have no `CARGO_PROFILE_*`, `RUSTFLAGS` or target overrides. The driver rejects
  unexpected overrides and lock changes. Build receipts identify the binary
  actually copied and its source, rather than inferring provenance from the
  measurement checkout. Source and addon hashes are retained.
- The same clean control checkout runs every matrix, swapping only each
  variant's addon and receipt. Compiled binaries are omitted; restoration is
  verified byte-for-byte in `finally`. No builds, tests or profiles overlap
  timed matrices. The profile build is separate and restored before timing.
- For each experiment: full control/candidate curated parity gates, then ABBA
  order control-1, candidate-1, candidate-2, control-2. Warm reused highlighters,
  rotating engine order, one fresh worker per format, sequential formats,
  300 ms budget per engine/API and at least 30 samples. Raw timings retain
  output allocation; setup and correctness validation are outside timing.
- Apple M1 Ultra, Darwin arm64, Node 24.21.0, Shiki 4.4.3, Prism 1.30.0;
  `github-dark`. Fixtures/embedded languages remain byte-identical to the fixed
  20-format corpus. `large` repeats complete fixtures 16 times and represents
  synthetic highlighting traffic, not a runnable application.
- Primary boundary: warmed `codeToHtml(code, { lang, theme })` with inline
  styles. Tokens are diagnostic. CSS classes, transformers and other advanced
  HAST routes are unmeasured; their output semantics are protected by the core
  gate. Prism's Astro/Svelte/Vue/MDX cells remain explicitly unsupported.
- The second driver's clean-state guard stopped once on an empty diagnostic
  file before any build or timed matrix. The file was moved out, the checkout
  restored, and the complete comparison restarted. The preflight status is
  retained under `escaping/preflight/`; zero timed matrices were discarded.

## Reproduction and closure

From this PR checkout, strictly recompute each complete comparison:

```sh
node node/benchmarks/curated/results/post-inline-html/summarize.mjs \
  "$PWD" node/benchmarks/curated/results/post-inline-html/style
node node/benchmarks/curated/results/post-inline-html/summarize.mjs \
  "$PWD" node/benchmarks/curated/results/post-inline-html/escaping
```

`compare.py` retains the exact historical driver. Adapt its absolute checkout
and output paths to fresh directories, prepare comparator packages and the
ordinary baseline addon as documented in the corpus README, and pass the
candidate root and a new output directory. Use the pinned commits above and
keep the measurement runner fixed on the control. `profiles/` retains the
corrected historical profiling adapter and its absolute paths; prepare the
separate symbol-enabled library and ordinary baseline addon before running it.
The now-fixed Node helper can directly select that custom target artifact.

`summary.json` in each experiment records every paired and repeated comparison.
Compressed reports preserve raw samples and exact token/HTML/source validation.
`SHA256SUMS` covers retained evidence except itself. `validation/` contains
lossless final gate logs, including the target-directory fix and proof that the
ordinary final addon is byte-identical to the measured accepted addon.

This closes the two-round investigation. The remaining VM-dominated
C++ work can be revisited with instruction/pattern-level evidence if a future
workload warrants it. No additional optimization round is required for this PR.

## Final gates

All passed: workspace formatting, all-target/all-feature Clippy with warnings
denied, all-feature workspace tests, Rustdoc with warnings denied, cargo-deny,
ADR checks, real custom-target artifact selection and receipt flags, mandatory
`test:ferriki-compat:core`, full curated 20×2 parity, Node formatting, lint and
typecheck. The core lane retains its explicitly classified deferred upstream
audit cases; this does not claim the full upstream audit suite passes.

`validation/ordinary-runtime-identity.json` verifies that the final ordinary
addon after the build-helper fix has the exact same Rust source and binary hash
as measured commit `25cc596da7aa93ffe93af9a55c471e0a98ede8a4`. Classes and advanced
HAST route semantics are checked; their performance remains unmeasured.

The concurrent benchmark-gate changes on main
`5ba30d7327d97001f5278646201bd20deeff7aaf` are also validated. The profiling
receipt field is aligned with main in
`6fad1d513e6c3a7718d803e9080ca95bab6bb9de`; a local merge-tree proof confirms
one field and byte-identical Rust/Cargo sources. The current-main benchmark
gate passes using an external copy with only its three module/script URLs
adapted. Its driver, log and aligned native receipt are retained in
`validation/`. The ordinary addon still matches the measured source and binary.
