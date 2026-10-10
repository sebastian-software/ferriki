# Blacksmith measurements — October 10, 2026

The [completed workflow run](https://github.com/sebastian-software/ferriki/actions/runs/38043610857)
measured a clean workspace build at
`ad991d0d1cbcc8e5f24d5cbcc95d3468425323db`, with Ferroni 2.1.0,
Node 24.21.0 and Rust 1.99.0. Both profiles passed all six reports:
repository, curated and TIOBE, each with the regex prefilter on and off.

| Profile | Runner | Observed CPU | Warm Shiki/WASM / Ferriki | Warm Shiki/JS / Ferriki |
| --- | --- | --- | --- | --- |
| [Linux x86-64](linux-x86-64/summary.md) | `blacksmith-4vcpu-ubuntu-2404` | AMD EPYC | 4.7× | 5.3× |
| [macOS ARM64](macos-arm64/summary.md) | `blacksmith-6vcpu-macos-26` | Apple M4 Pro (Virtual) | 5.5× | 5.7× |

These factors divide the summed warm HTML medians for the 14 repository files,
with default prefilter settings. Ferriki and both Shiki engines produced exact
matching HTML for every file. They describe these machines and this corpus,
not overall CMS/build speed or standalone Rust performance. Reports describe
workspace builds, not certified registry artifacts or a controlled comparison
between Ferroni releases.

For this corpus, disabling the prefilter reduced first-use time by 35–37%,
while warm highlighting took 51–68% longer. First use includes imports, setup
and one render of all 14 files; process creation and downloads are excluded.
It does not measure one isolated snippet. Reuse the default configuration in
a CMS worker or site build.

JSON/Astro off-mode times on macOS were 17–22% shorter, but unchanged Shiki
controls also improved by roughly 16–23%. The fixed on/off order allows drift
between windows; this run does not establish a causal prefilter benefit for
these languages. Linux's corresponding Ferriki timings were 2–3.5% longer.
The [published benchmark page](https://ferriki.dev/evidence/benchmarks)
shows the default medians and raw percentage changes for the controls.

## Preserved artifacts

Each profile directory contains all six original reports and process logs,
compressed losslessly as `.gz`, plus the original runner context, build
receipt, validation result, summary and `ORIGINAL_SHA256SUMS`. The checksums
apply to the **decompressed original bytes**, including the logs. This archive
remains in Git after the workflow artifacts' 90-day retention period.

From the repository root:

```sh
node scripts/publish-blacksmith-evidence.mjs --check
```

The check decompresses and verifies every original checksum, validates all
twelve reports, checks clean source/build provenance and ensures the compact
website reports match. To regenerate those compact reports:

```sh
node scripts/publish-blacksmith-evidence.mjs
```

Compact reports omit individual `samplesMs` arrays; the archive keeps them.
The generator also checks the repeated README headline factors. Root README
wording lives in `README.md.src`; regenerate it with `mise run readme:write`.
For new measurements, preserve a new dated archive, update the generator's
archive reference, regenerate compact data and review every repeated claim.

See the [workflow and reproduction guide](../../blacksmith.md) for timing
boundaries, corpus selection, output gates and runner configuration. The
[previous October 4 report](../../archive/shiki-comparison-2026-10-04.json)
is retained separately, with its original revision, machine and Phiki evidence.
