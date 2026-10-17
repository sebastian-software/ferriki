# Direct CSS emission and ASCII offset mapping

This October 17, 2026 follow-up compares two allocation reductions with the
existing PR revision `7da64467890423d10f44c049d34810a131798d46`. An additional
unmodified-main build at `de4ae42b9330355ef6352314eef26795f815781a` measures
the accumulated PR effect. All five builds use Ferroni 2.2.2, rustc 1.99.0,
Node 24.21.0, the ordinary stripped release profile, identical dependencies,
and automatic regex prefiltering on the same Apple M1 Ultra/macOS arm64 host.

## Changes

- Serialize CSS properties directly into inline HTML instead of allocating a
  temporary style string for each token. The shared visitor preserves property
  order; values are attribute-escaped. HAST and decorated rendering still
  request an owned style string from the same visitor.
- Represent ASCII UTF-16-to-byte positions as a checked identity mapping,
  including the end boundary. This avoids allocating and filling a vector.
  Non-ASCII input retains the original mapping and surrogate-half behavior.

Public APIs, output bytes, theme matching, grammar behavior, and dependencies
are unchanged. No ADR decision changes.

## Isolated measurements and admission

The initial four-engine screening uses three fresh workers, 12 warmups, and
25 rounds on all 20 curated languages at both sizes. Its median worker
geometric mean changes by -1.65% for CSS, -1.61% for ASCII, and -2.86% for the
combination. A separate public screening uses three workers and 40 rounds.

The independent native repetition uses four fresh workers, 12 warmups, and
30 rounds on the same 40 cases, with the original-main engine added. Every
output hash must agree across all engines and workers.

| Change vs. previous PR | Median worker geometric mean |     Worker range |
| ---------------------- | ---------------------------: | ---------------: |
| Direct CSS             |                       -1.52% | -1.91% to -0.93% |
| ASCII mapping          |                       -0.83% | -0.92% to -0.72% |
| Combined               |                       -2.34% | -2.93% to -2.09% |
| Complete PR vs. main   |                       -6.01% | -6.38% to -5.84% |

The 3% admission threshold is **case-specific**, rather than a claim that each
candidate improves the entire corpus by 3%. Both candidates exceed it on the
curated CSS example in the screening and independent repetition:

| Candidate, CSS example | Screening median | Repetition median | Repetition 95% interval |
| ---------------------- | ---------------: | ----------------: | ----------------------: |
| Direct CSS             |           -3.83% |            -4.29% |        -7.37% to -1.80% |
| ASCII mapping          |           -7.58% |            -3.78% |        -8.91% to -1.94% |

These intervals support a benefit on this case, but do not establish a 3%
minimum across machines or even every worker. Stronger screening effects on
Java for ASCII and MDX for CSS did not repeat at the same magnitude. The full
raw corpus and per-case estimates remain available, including slower cells.
The final combination must separately pass every homepage regression bound.

## Homepage regression bound

The final public comparison uses twelve fresh workers in two six-worker
cohorts, 12 warmups, and 60 rounds. The first cohort also includes 40 rotating
cold-start triples. The same 14 repository files are frozen
at published fixture revision `aea84dc7b911c79a86dd3631c698c991c36184b8`.
Every engine equals Shiki/WASM HTML before warm timing in each worker. Small
calls are batched; validation and source loading stay outside warm timing.
Cold timing includes imports, corpus reading, grammar loading, and first
renders, excluding process creation, as in the homepage runner.

| Comparison                    | Warm total | Largest per-case warm upper 95% endpoint | Cold paired median | Cold 95% interval |
| ----------------------------- | ---------: | ---------------------------------------: | -----------------: | ----------------: |
| Added changes vs. previous PR |     -1.08% |                                   +1.16% |             -0.22% |  -0.50% to +0.15% |
| Complete PR vs. main          |     -3.04% |                                   -0.26% |             -0.33% |  -0.83% to -0.01% |

The first six-worker cohort already met the complete-PR bound. Its incremental
HTML median was -3.80%, but its upper interval endpoint was +2.34%, crossing
the stricter additional-change bound. I added one six-worker confirmation
cohort with identical inputs and settings, retained all twelve workers, and
kept the original 40 cold triples. The pooled results above include both
cohorts; neither cohort is discarded.

Every individual warm case and cold-start upper 95% endpoint is below the
requested +2% regression boundary for both comparisons. Intervals use 10,000
deterministic bootstrap samples of independent worker ratios or cold-process
pairs. They describe this local experiment. The warm total is the median
worker ratio of summed document medians; it differs from the equally weighted
native geometric mean.

| Homepage document                                                        | Added changes vs. previous PR | Complete PR vs. main |
| ------------------------------------------------------------------------ | ----------------------------: | -------------------: |
| `src/highlighter.rs`                                                     |                        -4.44% |               -7.44% |
| `node/ferriki/src/api.mts`                                               |                        -1.46% |               -2.43% |
| `node/ferriki/src/index.mjs`                                             |                        -1.31% |               -3.17% |
| `docs/ferriki-api.md`                                                    |                        -3.69% |               -8.90% |
| `.github/workflows/ci.yml`                                               |                        +0.79% |               -0.64% |
| `node/compat/upstream/shiki/packages/twoslash/style-rich.css`            |                        -3.73% |              -11.49% |
| `node/package.json`                                                      |                        -5.54% |              -14.09% |
| `Cargo.toml`                                                             |                        -4.40% |              -10.64% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.py`   |                        -0.24% |               -1.93% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.html` |                        -2.03% |               -7.07% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.go`   |                        -3.09% |              -11.79% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.php`  |                        -3.68% |              -12.34% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.sh`   |                        -2.32% |               -8.04% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.sql`  |                        -4.29% |              -23.70% |

## Correctness and evidence

Rust formatting, strict all-target/all-feature Clippy, the complete Rust
all-features suite, the mandatory Node core compatibility gate, and both
curated/TIOBE output parity gates pass. The compatibility rebuild reproduces
the measured combined source and binary fingerprints exactly. The existing
optional missing-PHP smoke skip remains explicit.

The new CSS golden cases cover empty colors, font styles, property order,
unknown bits, and escaped values. Existing full-HTML/HAST and fragment parity
matrices still pass. Offset tests cover ASCII, BMP Unicode, surrogate pairs,
combining marks, CRLF, the end boundary, and invalid indices; existing Node
single/multi-theme and public Rust offset contracts pass as well.

- [Full summary and admission record](summary.json), [build receipts](builds.json),
  and [source context](context.json).
- [Native screening](ablation.json.gz), [native repetition](curated-final.json.gz),
  [homepage screening](homepage-ablation.json.gz), and
  [first homepage repetition](homepage-final.json.gz), including raw samples and hashes.
  The [six-worker confirmation](homepage-confirmation.json.gz) supplies the
  additional warm cohort; the summary pools all twelve workers.
- Isolated [CSS](css.patch.gz), [ASCII](ascii.patch.gz), and [combined](combined.patch.gz)
  source patches, relative to the previous PR revision above.
- [Validation record](validation.json) and compressed build/test logs.

Reproduce with the paired runners documented in the parent report. Build the
previous PR revision first, then apply each isolated patch and save independent
package/addon snapshots. Decompress the `*.patch.gz` source patches before
applying them. The receipt keys, corpus revision, and raw options
identify every measurement input. The final public run includes the previous
PR, original main, and combined package snapshots in one rotating comparison.
Run `python3 summarize.py` in this directory to recompute the summary and
admission checks from both compressed homepage cohorts and the native report.
The [analysis script](summarize.py) writes the recomputed JSON to stdout.

Builds, tests, and measurements run in separate windows. Desktop power state,
thermals, and unrelated activity are not controlled. No Linux, Windows, other
CPU/compiler, or unseen-input performance claim follows from these results.
Published homepage numbers remain historical.
