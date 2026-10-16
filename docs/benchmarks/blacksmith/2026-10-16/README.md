# Blacksmith measurements — October 16, 2026

The [completed workflow run](https://github.com/sebastian-software/ferriki/actions/runs/38967200840)
measured a clean workspace build at
`c18c0127bad274072ee81f9e1e9d4dc142f978da`, with Ferriki 1.1.0,
Ferroni 2.2.2, Node 24.21.0 and Rust 1.99.1. Both profiles passed all six
reports: repository, curated and TIOBE, each with the regex prefilter on and off.

The requested `main` snapshot was `775f1f42c3edffd8b3471112d7a07cd0d3d21b29`.
The [initial run](https://github.com/sebastian-software/ferriki/actions/runs/38966779179)
failed because the workflow did not materialize the standard grammar sources
needed by the Shiki reference. The measured revision adds only that preparation
step; runtime code, dependencies, asset catalog, fixtures and benchmark harness
are unchanged from that `main` snapshot. The native Rust source hash is
`d74895eb07a6efe8151d01d4251968c5faf82442c8ce9f588e20054f98f56f2c`.

| Profile | Runner | Observed CPU | Warm Shiki/WASM / Ferriki | Warm Shiki/JS / Ferriki |
| --- | --- | --- | --- | --- |
| [Linux x86-64](linux-x86-64/summary.md) | `blacksmith-4vcpu-ubuntu-2404` | AMD EPYC | 4.2× | Unsupported |
| [macOS ARM64](macos-arm64/summary.md) | `blacksmith-6vcpu-macos-26` | Apple M4 Pro (Virtual) | 5.3× | Unsupported |

These factors divide the summed warm HTML medians for the 14 repository files,
with default prefilter settings. Ferriki and Shiki/WASM produced exact matching
HTML for every file. Shiki/JS matched the other 13 files but cannot translate the
current VS Code YAML grammar's multi-codepoint hex escape. YAML has no JS
samples, and no full-corpus warm or cold JS total is published.

These observations describe these machines and this corpus, not overall
CMS/build speed or standalone Rust performance. Reports describe workspace
builds, not certified registry artifacts. The catalog, source files and compiler
have changed since the [October 10 archive](../2026-10-10/README.md), so these
runs do not isolate a Ferroni upgrade or a runtime regression.

## Prefilter observations

Disabling the prefilter made warm repository highlighting take 41% longer on
Linux and 40% longer on macOS. First use was 14% longer on Linux and 33% shorter
on macOS. First use includes imports, setup and rendering all 14 files;
process creation and downloads are excluded. It does not measure one isolated
snippet. Reuse the default configuration in a CMS worker or site build.

The reports ran in fixed-order on/off windows. Linux's unchanged Shiki/WASM
cold control also took 70% longer in the off window; macOS's was 9% shorter.
The results do not establish a consistent first-use benefit from disabling
the prefilter.

For JSON on Linux, Ferriki's off-mode medians were 15–17% shorter. Astro's
example was 27% shorter and its large input 25% longer. The unchanged Shiki
controls were 15–25% faster. On macOS, Ferriki's JSON medians were 22–26% longer
and Astro's 79–99% longer, while the unchanged Shiki controls were 17–24% slower.
Shared movement shows drift between windows; the larger Astro differences
remain observations, not an isolated measurement of the prefilter's effect.
The [published benchmark page](https://ferriki.dev/evidence/benchmarks)
shows default medians and the percentage changes for every control.

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
[October 4 report](../../archive/shiki-comparison-2026-10-04.json)
is retained separately, with its original revision, machine and Phiki evidence.
