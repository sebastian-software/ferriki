# Direct inline HTML writer: October 1, 2026

The control wins 15/20 formats at both sizes in both repetitions. The candidate
wins **20/20** at both sizes in both repetitions, against
`MIN(Shiki WASM, Shiki JavaScript)` on warmed public inline HTML. All 40
format/size cells improve in both paired comparisons; the smallest measured
improvement is C++ at about 9%. This is evidence for this fixed corpus,
configuration and machine, not a universal performance guarantee.

The five remaining control losses were CSS, TOML, YAML, JSON and SCSS. Their
large-input candidate ratios are 0.655–0.668, 0.708–0.708, 0.540–0.576,
0.598–0.604 and 0.571–0.584 respectively. Every ratio below 1 wins.

## Complete public HTML results

Ranges show the two complete repetitions. The last column compares candidate
Ferriki medians to the corresponding control medians, rather than to Shiki.
Raw individual samples, comparator results (including Prism), exact source and
HTML/token parity, and build receipts are retained in the compressed reports.

| Format     | Example / best Shiki | Large / best Shiki | Large time reduction vs. control |
| ---------- | -------------------: | -----------------: | -------------------------------: |
| TypeScript |          0.463–0.477 |        0.406–0.410 |                       27.6–34.5% |
| TSX        |          0.445–0.455 |        0.382–0.383 |                       41.0–45.1% |
| Rust       |          0.340–0.344 |        0.282–0.287 |                       58.6–59.6% |
| CSS        |          0.818–0.836 |        0.655–0.668 |                       58.2–60.4% |
| HTML       |          0.497–0.513 |        0.419–0.425 |                       42.1–43.6% |
| C++        |          0.842–0.849 |        0.813–0.815 |                        9.0–11.5% |
| Swift      |          0.572–0.582 |        0.435–0.438 |                       40.5–43.2% |
| Java       |          0.614–0.624 |        0.564–0.577 |                       33.5–37.3% |
| Markdown   |          0.541–0.545 |        0.384–0.390 |                       42.2–46.4% |
| TOML       |          0.721–0.721 |        0.708–0.708 |                       62.6–63.0% |
| YAML       |          0.603–0.607 |        0.540–0.576 |                       52.2–54.2% |
| JSON       |          0.628–0.637 |        0.598–0.604 |                       62.4–63.1% |
| Astro      |          0.443–0.451 |        0.343–0.363 |                       31.2–35.5% |
| Svelte     |          0.414–0.414 |        0.354–0.355 |                       30.5–33.5% |
| Ruby       |          0.258–0.263 |        0.210–0.211 |                       50.3–50.8% |
| Python     |          0.367–0.373 |        0.286–0.287 |                       51.2–51.5% |
| Vue        |          0.365–0.375 |        0.289–0.289 |                       44.1–44.6% |
| MDX        |          0.523–0.528 |        0.415–0.422 |                       35.7–37.9% |
| SCSS       |          0.752–0.756 |        0.571–0.584 |                       50.3–51.0% |
| Bash       |          0.576–0.583 |        0.479–0.493 |                       49.5–51.3% |

## What changes

`render_html` writes the final inline HTML string directly using the existing
token preparation, style and escaping helpers. Previously it built a full
`serde_json::Value` HAST and then recursively serialized that tree to HTML.
There is no new opcode, expression rewrite, compiler hint or public API.
`render_hast` remains the structural API and differential oracle.

The earlier CSS profile in Ferroni's
[post-204 evidence](https://github.com/sebastian-software/ferroni/tree/e7ca9c42872687d6a0fde82b5a7e0a1c7cc71f13/benches/highlighting_results/post-204)
had 4,260 of 6,836 main-thread samples (62.3%) under rendering and 887 (13.0%)
under Ferroni. These inclusive categories overlap; they must not be added.
The `serde_json::Value::serialize` stacks construct HAST through `json!`,
rather than sending a complete token JSON payload across N-API. That profile
is diagnostic historical evidence, not a new profile of this control build.
The controlled measurement here establishes the benefit of avoiding the tree.

SCSS duplicate scanner expressions and YAML lookahead/search reuse remain
possible engine investigations. No speculative engine change is bundled here:
the renderer experiment already closes every remaining measured HTML gap.

## Scope and parity

The public measurement uses `codeToHtml(code, { lang, theme: "github-dark" })`.
CSS classes and `codeToHtmlWithCss` are **unmeasured** and keep their existing
HAST route. Nonempty transformers, decorations, structure/meta/data,
`grammarState`, `theme: "none"` and the multi-theme option retain their current
Node HAST routes. `codeToHast`, token APIs and the already-direct inline
`render_html_lines` are not the optimization target. Nothing changes in the
Node facade or N-API routing.

Two Rust differential tests compare the new output byte-for-byte with the
original HAST writer: 72 combinations of merging/root/tabindex controls with
escaping, all font style bits and empty/trailing lines; and 19 supported TIOBE
fixtures with two themes and four merging combinations. Both complete curated
20-format gates also passed before timing, requiring exact Shiki token/HTML
parity. `tokens` is retained as a diagnostic measurement, not the decision
boundary. Prism's Astro/Svelte/Vue/MDX cells are explicitly unsupported.

## Isolation and provenance

- Ferriki control `c0f0d13936a2e5ea8bccfe7bf9f40fa585c40c6a`: current main
  `12d44c8286c9f1494ce9c2574b709ee42dcca3ef` (0.8.0) plus the unchanged curated
  corpus and benchmark guards.
- Candidate `50bd6108267ac6873c407274c58f05231577a047`; its only difference
  from the control is `src/render.rs` (157 added / 5 removed lines, including
  differential tests). Runtime commit: `ae2375d4404c6c8fa43fa3e14b07aa8601cd0144`.
- Both build the same clean Ferroni 1.8.0 tag/main revision
  `e7ca9c42872687d6a0fde82b5a7e0a1c7cc71f13`, through an explicit local Cargo
  patch. The build receipt honestly records `M Cargo.lock` while this patch is
  active; the original lock is restored before every timing run.
- Ferriki initially locked registry Ferroni 1.6.1 despite its older 1.5.0
  minimum. Subsequent separate commit `e625623925952e38257197503c79383bbc2c7336`
  raises the minimum and lock to published 1.8.0. The published archive records
  the same release Git SHA; all 34 Rust source files match the measured local
  release byte-for-byte (`registry-engine-verification.json`). No dependency
  adoption effect is attributed to the isolated renderer comparison.
- Fixtures and embedded language lists are byte-identical to
  `0136c99d3aad9aad9eeaa025692124e94420153d`. `large` repeats each fixture
  16 times and is synthetic highlighting traffic. No workload was reduced.
- All four matrices run in the control checkout with the same runner and
  Node facade, swapping only the compiled addon and its receipt. Candidate
  receipts identify the actual candidate source/build, rather than pretending
  it came from the runner checkout. Both addon and original lock are restored
  byte-for-byte in `finally` (`addon-restoration.json`).
- Ordinary release builds use the checked-in fat LTO / one codegen unit
  profile. The driver rejects any `CARGO_PROFILE_*`, `RUSTFLAGS` or
  `CARGO_ENCODED_RUSTFLAGS` override. Receipts retain compiler, features,
  source/binary/lock hashes and build flags; binaries themselves are omitted.
- Apple M1 Ultra, Darwin arm64, Node 24.21.0, Shiki 4.4.3, Prism 1.30.0.
  ABBA order: control-1, candidate-1, candidate-2, control-2. One fresh worker
  per format, sequential formats, reused warmed highlighters, rotating engine
  order, 300 ms per engine/API with at least 30 samples. No concurrent builds,
  tests, benchmarks or profiles ran during measurement.
- `compareReports(..., { isolation: "ferriki" })` explicitly permits the
  renderer source change while requiring identical Ferroni source/build,
  runner, corpus, assets, dependencies, machine and method. Default Ferroni
  isolation remains strict about Ferriki identity. Every paired/repeated
  comparison contains all 80 Ferriki HTML/token cells and excludes none.
- The initial driver stopped on a same-source copy before any timed matrix.
  Restoration and failure status are retained under `preflight/`; the fixed
  driver produced all four reports. No timed run was discarded.

## Reproduction

From a checkout of this PR, recompute the full strict comparison:

```sh
node node/benchmarks/curated/results/direct-inline-html/summarize.mjs \
  "$PWD" node/benchmarks/curated/results/direct-inline-html
```

Prepare independent control/candidate/Ferroni worktrees at the revisions above,
install the pinned Node dependencies and build comparator packages as described
in the corpus README. `measurement.py` retains the exact historical driver
and its absolute paths. Adapt those paths to fresh local directories, preserve
both original lockfiles as the named inputs, and use a new empty output
location. It builds ordinary addons, runs both full correctness gates and
restores the measurement checkout after the four matrices. Never overlap
CPU work with timed runs. The 1.8 dependency commit and evidence-only commits
are subsequent to the isolated measured candidate.

The uncompressed JSON samples can be read with `gunzip -c`. `summary.json`
contains all pair and repeat comparisons. `SHA256SUMS` covers retained evidence
except itself. `validation/` retains lossless compressed final gate logs for
the registry 1.8 configuration, separately from historical local-patch timing.

## Final validation with published Ferroni 1.8.0

All passed: workspace formatting, Clippy on all targets/features with warnings
denied, workspace all-feature tests, Rustdoc with warnings denied, cargo-deny,
ADR checks, the mandatory supported core compatibility gate (including classes,
transformers, token state and native boundary checks), curated 20×2 exact parity,
Node lint and typecheck. The rebuilt ordinary addon resolves registry Ferroni
1.8.0 without a local patch; its receipt is in
`validation/published-engine-build.json`. Existing deferred upstream tests
remain classified by the mandatory core manifest; this does not claim the
entire upstream audit suite passes.
