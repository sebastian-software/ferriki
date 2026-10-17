# Allocation reductions in highlighting and inline rendering

The initial October 17, 2026 experiment compares the local Ferriki baseline
`a8a177ee24467a81712c87657eda10e5c6894d06` with two local Rust changes on an
Apple M1 Ultra, macOS arm64, Node 24.21.0, rustc 1.99.0, and registry Ferroni
2.2.1. All timing builds use the ordinary stripped release profile, automatic
regex prefiltering, the same lockfile and assets, and `github-dark`.

## Follow-up: direct CSS emission and ASCII offsets

The follow-up compares two more allocation reductions against PR revision
`7da64467890423d10f44c049d34810a131798d46`: emitting inline CSS directly into
the HTML buffer and representing ASCII UTF-16/UTF-8 positions without an
allocated lookup vector. Unicode retains its original mapping algorithm.
Independent builds isolate each change before measuring their combination.
The [follow-up report](style-ascii/README.md) records the incremental results,
the complete PR comparison against main, and the repeated homepage boundary.
The measurements below describe the earlier two-change PR revision.

## PR integration check: Ferroni 2.2.2

The PR rebases the same Rust changes onto main
`de4ae42b9330355ef6352314eef26795f815781a` (Ferriki 1.1.1 and Ferroni 2.2.2).
Fresh baseline and candidate builds use that same dependency lockfile and
ordinary release profile. The refreshed published homepage fixture revision is
`aea84dc7b911c79a86dd3631c698c991c36184b8`.

The native curated repetition covers all 40 cases in four fresh workers, with
12 warmups and 20 rounds. Its median worker geometric mean changes by
**-5.79%**, with a worker range of -7.48% to -4.80%. The sum of pooled case
medians changes from 218.40 to 212.81 ms (-2.56%).

The public homepage repetition uses six fresh workers, 12 warmups, 40 rounds,
and 30 alternating cold-start pairs. Its total changes by **-3.20%**. All 14
per-document central estimates improve, from -1.37% to -20.05%; the largest
warm upper 95% interval endpoint is +0.70%. Cold start is unchanged (+0.01%),
with a 95% interval of **[-1.64%, +0.96%]**. Every individual warm case and
cold start therefore remains below the +2% regression boundary on this host.

Rust formatting, strict Clippy, the complete Rust all-features suite, the
mandatory Node core compatibility gate, and both curated/TIOBE parity gates
pass on the rebased source. The existing optional missing-PHP smoke skip
remains explicit. [Current-main results](main-2.2.2/summary.json),
[build receipts](main-2.2.2/builds.json),
[homepage samples](main-2.2.2/homepage.json.gz),
[curated samples](main-2.2.2/curated.json.gz), and
[validation](main-2.2.2/validation.json) retain this follow-up separately from
the initial Ferroni 2.2.1 evidence below.

## Changes

- Copy the theme name and foreground/background defaults at the start of
  tokenization, instead of cloning `ThemeData` and all its raw theme rules.
- Serialize inline whitespace merging from borrowed token slices. This avoids
  cloning the complete token tree and constructing merged content strings in
  `render_html` and `render_html_lines`. Whitespace before underlined or
  struck-through tokens still gets its separate unstyled span. Same-style
  merging retains the existing owned preparation path.
- Emit inline CSS declarations into the HTML buffer, with the same property
  order and attribute escaping. HAST and decorated rendering retain owned CSS
  strings through the shared declaration visitor.
- Use checked identity positions for ASCII input instead of allocating a
  UTF-16-to-byte vector. Non-ASCII input keeps the original vector mapping,
  including the handling of surrogate halves and end boundaries.

The public types, tokenization algorithm, theme matching, escaping, output
bytes, and dependency versions are unchanged. No ADR decision changes.

## Candidate isolation

The four-engine native ablation uses all 20 curated languages at both sizes
(40 cases), three fresh workers, 12 warmups, and 25 timed rounds. Call order
rotates within every round. Output hashes must agree between engines and
workers. Negative percentages mean less elapsed time.

| Change            | Median worker geometric mean |     Worker range |
| ----------------- | ---------------------------: | ---------------: |
| Borrowed renderer |                       -3.67% | -4.19% to -3.37% |
| Combined          |                       -4.88% | -5.47% to -4.39% |

The theme-only change is about flat across the whole curated corpus. It has
over 3% gains on small TOML, Rust, Swift, and JSON cases in that ablation.
The separate public four-engine comparison on the 14 current repository
fixtures measures -5.89% for Go and -12.93% for SQL with the theme change
alone. The renderer alone measures -8.41% for Rust, -6.52% for CSS, and
-6.07% for JSON there. These are case-specific effects, not uniform speedups.
Individual ablation cells also fluctuate or regress; admission uses the
independent measurements of the final combination below.

The final native repetition compares only the baseline and final candidate:
four fresh workers, 12 warmups, and 30 rounds on the same 40 curated cases.

| Group            | Median worker geometric mean |     Worker range |
| ---------------- | ---------------------------: | ---------------: |
| All 40 cases     |                       -5.11% | -5.17% to -4.96% |
| Examples         |                       -5.79% | -5.97% to -5.60% |
| Large, 16 copies |                       -4.31% | -4.74% to -4.16% |

The sum of the 40 pooled case medians falls from 201.75 to 195.64 ms
(-3.03%). This duration-weighted total and the equally weighted geometric
mean answer different questions.

## Homepage regression boundary

The public `codeToHtml` comparison uses the homepage's 14-file repository
corpus. Source files are frozen before changing the implementation, including
`src/highlighter.rs`, so shorter candidate source does not reduce the work.
The published revision recorded with that baseline and the local baseline
revision are separate input cohorts. Both use the current, identical grammar/theme assets for the baseline
and candidate; this is a comparison of the patch, not a recreation of the
historical Blacksmith machine or dependency versions.

The initial-source cohort uses six independent workers, 12 warmups, 60 rounds,
and 40 alternating cold-start pairs. Every document and engine must equal
Shiki/WASM HTML before timing in each warm worker. Small calls use batches
targeting at least 1 ms, capped at 100 calls; source loading, validation, and
serialization stay outside warm timing. Both implementations consume their
output. Cold timing includes imports, corpus reading, grammar loading, and
the first highlight of all 14 documents, excluding process creation, as in
the existing homepage runner.

Initial-source results: the median worker ratio of summed document medians is
**-2.08%**. All 14 per-document changes are negative, from -0.91% to -20.06%.
The cold median paired ratio is -0.15%, with a 95% bootstrap interval of
**[-0.44%, +0.17%]**: effectively unchanged.

Intervals resample independent worker ratios (warm) or fresh-process pairs
(cold), with 10,000 deterministic bootstrap resamples. They do not treat
hundreds of calls in one worker as independent experiments. Every initial-source
document's upper interval endpoint, and the cold upper endpoint, is below
the requested +2% regression limit.

The exact published-source cohort repeats the comparison in six fresh workers
with 40 rounds and 30 alternating cold-start pairs. Its warm total changes by
**-2.30%**; all 14 documents improve, from -0.98% to -20.23%. Its cold paired
ratio changes by -0.26%, with a 95% interval of **[-0.70%, +0.01%]**.
Every individual warm upper interval endpoint also stays below +2%.

| Homepage document | Initial-source change | Published-source change |
| ----------------- | --------------------: | ----------------------: |
| Rust              |                -8.13% |                  -7.37% |
| TypeScript        |                -1.64% |                  -1.95% |
| JavaScript        |                -1.71% |                  -2.30% |
| Markdown          |                -4.80% |                  -5.36% |
| YAML              |                -0.91% |                  -0.98% |
| CSS               |                -5.66% |                  -4.75% |
| JSON              |                -2.72% |                  -3.98% |
| TOML              |                -2.53% |                  -3.68% |
| Python            |                -2.28% |                  -1.98% |
| HTML              |                -4.48% |                  -4.68% |
| Go                |                -8.73% |                  -8.75% |
| PHP               |                -8.86% |                  -8.52% |
| Shell             |                -5.82% |                  -6.46% |
| SQL               |               -20.06% |                 -20.23% |

## Profiling

Two separate 12-second samply captures use release builds with line tables and
symbols retained. They are diagnostic only; none of their timings enters the
ordinary release comparisons. The broad profile repeats all 40 curated cases.
The small-file profile validates the six smallest editor-fixture documents
against Shiki/WASM before repeatedly rendering them.

The profiles show copying and allocator work in `prepare_tokens`, and raw
theme cloning in the small-file path. Inlining limits attribution to individual
helpers; the isolated ordinary-build comparisons establish the effects.
Scanner DFA candidate walking remains the largest named self symbol in the
broad profile. These Rust allocation changes keep the external Ferroni engine untouched.

## Evidence and limits

Raw samples, output hashes, source and addon fingerprints, ordinary build
receipts, profile captures, and validation logs are retained alongside this
report. The initial baseline can be reconstructed from commit
`09782d016d066d1ae96b6856eb23b3ab72520ea3` plus
[the baseline dependency patch](baseline-dependency.patch). Its local commit
also contained diagnostic documentation. The initial candidate adds the two
`src/` changes in this PR to that baseline; the PR integration check below uses
the newer main source and dependencies. The preliminary ablation precedes final
test-helper and formatting edits; final repetitions use the final release
binary identified by their receipts. The preliminary combined addon's binary
hash is retained in the ablation and context; its separate build receipt was
replaced by the final build receipt.

- [Acceptance summary](summary.json), [build receipts](builds.json), and
  [source/fixture context](context.json).
- [Native ablation](ablation.json.gz) and
  [final native repetition](curated-final.json.gz).
- [Public ablation](homepage-ablation.json.gz),
  [initial-source repetition](homepage-final.json.gz), and
  [published-source repetition](homepage-published.json.gz).
- [Broad profile](profiles/baseline-profile.json.gz) and
  [small-file profile](profiles/small-profile.json.gz), with compressed symbol
  sidecars, ready timestamps, and diagnostic summaries. Decompress each
  `*.syms.json.gz` beside its profile before using `summarize-samply-profile.mjs`.

Builds, tests, profiling, and timing runs execute in separate windows. This is
a local desktop experiment: power mode, thermal state, and unrelated background
activity are not controlled. Bootstrap intervals and process ranges describe
these observations. Linux, Windows, other CPUs, other compilers, and unseen
inputs have not been measured. Published homepage numbers remain historical.

## Correctness and validation

The Rust renderer tests compare full HTML and line fragments with the existing
HAST renderer. They cover 216 triples of plain, empty, whitespace, Unicode,
underlined, and struck-through tokens across all four combinations of the two
merge options, plus the existing curated-fixture, theme, escaping, and root
control cases.

The complete Rust all-features suite and strict Clippy check passed. The
mandatory Node core compatibility gate passed, including the existing HTML,
class, transformer, decoration, multi-theme, grammar, consumer, and benchmark
contracts. Its intentional deferred fixtures and optional missing-PHP smoke
skip remain explicit. The gate's rebuild produced the exact final measured
addon and Rust source fingerprints.

The curated benchmark gate passed all 20 formats at both sizes. The TIOBE
gate passed all 19 supported languages at both sizes, including source
preservation and exact native/Shiki HTML parity. Focused ESLint, formatting,
and `git diff --check` passed. Exact commands and terminal states are recorded
in [the validation record](validation/checks.json).

The first all-features Rust attempt could not bind the loopback HTTP servers
inside the sandbox. The complete rerun with local-server access passed. Logs
are retained under `validation/`.

## Reproduction

Build the baseline and candidate with the repository-pinned pnpm 10.28.2 and
the same toolchain. Save each package's facade, standard asset manifests,
`.benchmark-build.json`, and an independent copy of its matching native sidecar
under that snapshot's `node_modules/@ferriki/<platform>/ferriki.node`. A symlink
back to the live checkout would accidentally select the last build. The new
runner verifies each sidecar's SHA-256 against its receipt and rejects compiler,
Ferroni, flags, profile, or lockfile differences.

From `node/`, with those saved package directories and frozen fixture files:

```sh
node scripts/bench-homepage-paired.mjs \
  --engine baseline=/absolute/path/to/baseline-package \
  --engine combined=/absolute/path/to/candidate-package \
  --corpus-root /absolute/path/to/frozen-repository-files \
  --processes 6 --rounds 60 --cold-runs 40 --write homepage.json

node scripts/bench-native-boundary-paired.mjs \
  --engine baseline=/absolute/path/to/baseline.node \
  --engine combined=/absolute/path/to/candidate.node \
  --processes 4 --warmups 12 --rounds 30 --themes html \
  --corpora curated --write curated.json
```

For the initial published-source cohort, extract each corpus file with
`git show` from `ad991d0d1cbcc8e5f24d5cbcc95d3468425323db`. The integration
and follow-up cohorts use `aea84dc7b911c79a86dd3631c698c991c36184b8` instead.
Use the selected frozen directory as `--corpus-root` with matching package
snapshots; these revision cohorts are distinct.
