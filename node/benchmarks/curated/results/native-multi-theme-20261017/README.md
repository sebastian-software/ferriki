# Native multi-theme HTML: independent measurements

This October 17, 2026 experiment compares the candidate with `de4ae42b9330355ef6352314eef26795f815781a`. Each branch starts directly from its repository's main; none includes Ferriki PR #279 or either of the other candidates. The packages use Node 24.21.0, rustc 1.99.0, Ferriki 1.1.1, Ferroni 2.2.2, and the ordinary stripped release profile (fat LTO, one codegen unit, no profiling flags) on an Apple M1 Ultra/macOS arm64 host. Control and candidate were built sequentially at the same worktree path and saved as independent packages and sidecars. Receipts record compiler, lockfile, source fingerprints, and addon SHA-256.

The public multi-theme HTML call changes the summed-document warm latency by -19.03% in screening (three workers) and -19.39% in the independent six-worker repetition. This measures `codeToHtml` with light/dark themes and `defaultColor: false`, including the public facade and HTML serialization. A private multi-theme token benchmark would measure a different, unchanged transport path.

| Multi-theme document                                                     | Warm change |       95% interval |
| ------------------------------------------------------------------------ | ----------: | -----------------: |
| `src/highlighter.rs`                                                     |     -44.44% | -44.77% to -44.02% |
| `node/ferriki/src/api.mts`                                               |     -17.35% | -18.02% to -16.30% |
| `node/ferriki/src/index.mjs`                                             |     -19.36% | -19.79% to -18.46% |
| `docs/ferriki-api.md`                                                    |     -28.33% | -28.93% to -27.67% |
| `.github/workflows/ci.yml`                                               |      -4.30% |   -4.72% to -3.79% |
| `node/compat/upstream/shiki/packages/twoslash/style-rich.css`            |     -38.13% | -39.28% to -37.31% |
| `node/package.json`                                                      |     -39.67% | -40.65% to -38.81% |
| `Cargo.toml`                                                             |     -33.06% | -33.91% to -31.62% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.py`   |     -20.18% | -20.57% to -16.01% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.html` |     -30.27% | -31.52% to -27.65% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.go`   |     -29.15% | -32.22% to -26.56% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.php`  |     -35.86% | -37.16% to -33.68% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.sh`   |     -26.63% | -30.12% to -25.00% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.sql`  |     -27.46% | -30.13% to -23.09% |

Multi-theme cold-start change: -8.28% (-8.63% to -7.65%).

The independent single-theme homepage comparison uses 32 fresh workers, 12 warmups, 60 paired rounds, and 40 rotating cold-process pairs. It freezes all 14 input files at the published fixture revision `aea84dc7b911c79a86dd3631c698c991c36184b8`. Every warm worker first checks byte-for-byte HTML equality with Shiki/WASM. Small calls are batched and engine order rotates. Cold timing includes imports, corpus reading, grammar loading, and first renders; process creation is excluded. No builds or tests ran alongside the timed processes.

The single-theme warm total changes by +0.31%. The largest individual warm upper 95% endpoint is +0.98%. Cold start changes by -0.42% (-0.93% to +0.11%). The requested +2% regression bound passes. The 3% gain criterion passes; this candidate is eligible for review.

| Single-theme homepage document                                           | Warm change |     95% interval |
| ------------------------------------------------------------------------ | ----------: | ---------------: |
| `src/highlighter.rs`                                                     |      +0.41% | +0.26% to +0.64% |
| `node/ferriki/src/api.mts`                                               |      -0.10% | -0.30% to +0.49% |
| `node/ferriki/src/index.mjs`                                             |      +0.35% | +0.14% to +0.59% |
| `docs/ferriki-api.md`                                                    |      -0.12% | -0.34% to +0.69% |
| `.github/workflows/ci.yml`                                               |      +0.33% | +0.21% to +0.58% |
| `node/compat/upstream/shiki/packages/twoslash/style-rich.css`            |      +0.09% | -1.09% to +0.89% |
| `node/package.json`                                                      |      +0.41% | -0.14% to +0.98% |
| `Cargo.toml`                                                             |      +0.28% | -0.58% to +0.43% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.py`   |      +0.29% | -0.36% to +0.73% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.html` |      +0.08% | -0.64% to +0.63% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.go`   |      -0.09% | -0.68% to +0.35% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.php`  |      -0.06% | -0.48% to +0.71% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.sh`   |      -0.05% | -0.29% to +0.75% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.sql`  |      -0.06% | -0.27% to +0.30% |

The initial implementation placed the complete dispatcher inside the ordinary `codeToHtml` method. Its 16-worker pooled comparison still had a largest upper endpoint of +2.65%. The final facade extracts that dispatcher into a helper, keeping the ordinary call compact and leaving its single-theme native input shape unchanged. The final comparison uses two fixed cohorts of 16 workers and the first cohort's 40 cold pairs. `guard-v2-plan.json.gz` fixes that sample count before the first final-cohort result was available. All 32 workers are retained. The earlier implementation's raw results remain archived and are not pooled with a different facade. `run-v2.py.gz` and `confirm-v2-guard.py.gz` reproduce the final comparison and pooling.

The Rust coverage gate passes at 90.43% overall, with 98.63% line coverage for the new renderer. The core compatibility gate includes the 720-case callback comparison; plaintext is also checked against Shiki. ANSI remains explicitly unsupported. An attempted ANSI parity case hit that existing contract; the final gate checks ERR_UNSUPPORTED instead. An initial ESLint failure for four Unicode escape spellings was corrected and the check rerun. Original logs are retained.

Intervals use 10,000 deterministic bootstrap samples of independent worker ratios or cold-process pairs. Warm totals are medians of worker ratios of summed document medians; native corpus summaries are geometric means. These are local measurements, not universal speed guarantees. Screening runs are kept separate from confirmation; no unfavorable worker is removed.

Validation commands and exit codes are in `validation.json`; complete logs are compressed alongside the raw timings. The source patch and measured harnesses are retained. Additional regression tests were added after the initial build; the validated release addon is byte-identical to the measured candidate. Both original and validated build receipts are retained. No upstream mirror is hand-edited.

To reproduce, build the parent and candidate sequentially in the same worktree with the pinned dependencies and ordinary `pnpm run build:native` command. Materialize assets with `node scripts/materialize-assets.mjs --payloads` and install the pinned pnpm 10.28.2 workspace dependencies first. Extract the archived `.py.gz` and `.mjs.gz` scripts with `gzip -dc`. Use `save-package.py` to save each package and its receipt to separate directories. For Ferroni, apply the same local crates.io patch to the consumer for both builds and retain its generated lockfile. Extract `homepage-harness.mjs.gz` to the consumer's `node/scripts/bench-independent-paired.mjs`; it uses repository-local Shiki and corpus helpers. The exact screening and confirmation arguments are in `run-screens.py.gz` and `run-finals.py.gz`; substitute local checkout and output paths. The native harness is also archived as `native-harness.mjs.gz`. Extract the published corpus revision before editing any measured file.

Run `shasum -a 256 -c SHA256SUMS` in this directory to verify the archived evidence.
