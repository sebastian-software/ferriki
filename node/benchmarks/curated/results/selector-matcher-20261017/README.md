# Unary selector groups: independent measurements

This October 17, 2026 experiment compares the candidate with `de4ae42b9330355ef6352314eef26795f815781a`. Each branch starts directly from its repository's main; none includes Ferriki PR #279 or either of the other candidates. The packages use Node 24.21.0, rustc 1.99.0, Ferriki 1.1.1, Ferroni 2.2.2, and the ordinary stripped release profile (fat LTO, one codegen unit, no profiling flags) on an Apple M1 Ultra/macOS arm64 host. Control and candidate were built sequentially at the same worktree path and saved as independent packages and sidecars. Receipts record compiler, lockfile, source fingerprints, and addon SHA-256.

The 40-case curated screening (three workers, 12 warmups, 25 paired rounds) changes the equally weighted geometric mean by +0.10%. The most promising language was selected for an independent repetition with eight fresh workers, 12 warmups, and 60 rounds. The selection is exploratory; the repetition and the complete screening, including slower cases, are retained. The 3% threshold is case-specific and requires a benefit in both runs, with the repetition's upper 95% endpoint below zero.

| Selected native HTML case  | Screening | Repetition | Repetition 95% interval |
| -------------------------- | --------: | ---------: | ----------------------: |
| `curated/cpp/example/html` |    +0.80% |     +1.11% |        +0.12% to +2.03% |
| `curated/cpp/large/html`   |    -3.47% |     -0.12% |        -1.13% to +0.45% |

The independent single-theme homepage comparison uses 8 fresh workers, 12 warmups, 60 paired rounds, and 40 rotating cold-process pairs. It freezes all 14 input files at the published fixture revision `aea84dc7b911c79a86dd3631c698c991c36184b8`. Every warm worker first checks byte-for-byte HTML equality with Shiki/WASM. Small calls are batched and engine order rotates. Cold timing includes imports, corpus reading, grammar loading, and first renders; process creation is excluded. No builds or tests ran alongside the timed processes.

The single-theme warm total changes by -0.38%. The largest individual warm upper 95% endpoint is +2.43%. Cold start changes by +0.23% (-0.30% to +0.75%). The requested +2% regression bound is not established. The 3% gain criterion does not pass; this candidate remains a draft and is not recommended for merging on performance grounds.

| Single-theme homepage document                                           | Warm change |     95% interval |
| ------------------------------------------------------------------------ | ----------: | ---------------: |
| `src/highlighter.rs`                                                     |      -0.19% | -1.37% to +0.97% |
| `node/ferriki/src/api.mts`                                               |      -0.94% | -2.05% to +0.53% |
| `node/ferriki/src/index.mjs`                                             |      -0.61% | -0.93% to -0.05% |
| `docs/ferriki-api.md`                                                    |      -0.66% | -1.39% to -0.04% |
| `.github/workflows/ci.yml`                                               |      +0.28% | -0.57% to +0.60% |
| `node/compat/upstream/shiki/packages/twoslash/style-rich.css`            |      +1.08% | -0.28% to +2.43% |
| `node/package.json`                                                      |      -0.82% | -1.53% to +0.21% |
| `Cargo.toml`                                                             |      +0.70% | -0.03% to +1.88% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.py`   |      +0.29% | -1.36% to +1.51% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.html` |      -0.35% | -1.49% to +2.22% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.go`   |      +0.02% | -0.31% to +0.67% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.php`  |      -0.30% | -0.53% to +1.17% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.sh`   |      -0.86% | -1.52% to +0.33% |
| `node/compat/upstream/vscode-textmate/test-cases/themes/tests/test.sql`  |      -0.47% | -1.70% to -0.04% |

Intervals use 10,000 deterministic bootstrap samples of independent worker ratios or cold-process pairs. Warm totals are medians of worker ratios of summed document medians; native corpus summaries are geometric means. These are local measurements, not universal speed guarantees. Screening runs are kept separate from confirmation; no unfavorable worker is removed.

Validation commands and exit codes are in `validation.json`; complete logs are compressed alongside the raw timings. The source patch and measured harnesses are retained. Additional regression tests were added after the initial build; the validated release addon is byte-identical to the measured candidate. Both original and validated build receipts are retained. No upstream mirror is hand-edited.

To reproduce, build the parent and candidate sequentially in the same worktree with the pinned dependencies and ordinary `pnpm run build:native` command. Materialize assets with `node scripts/materialize-assets.mjs --payloads` and install the pinned pnpm 10.28.2 workspace dependencies first. Extract the archived `.py.gz` and `.mjs.gz` scripts with `gzip -dc`. Use `save-package.py` to save each package and its receipt to separate directories. For Ferroni, apply the same local crates.io patch to the consumer for both builds and retain its generated lockfile. Extract `homepage-harness.mjs.gz` to the consumer's `node/scripts/bench-independent-paired.mjs`; it uses repository-local Shiki and corpus helpers. The exact screening and confirmation arguments are in `run-screens.py.gz` and `run-finals.py.gz`; substitute local checkout and output paths. The native harness is also archived as `native-harness.mjs.gz`. Extract the published corpus revision before editing any measured file.

Run `shasum -a 256 -c SHA256SUMS` in this directory to verify the archived evidence.
