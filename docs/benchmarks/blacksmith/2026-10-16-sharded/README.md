# Blacksmith measurements — October 16, 2026, current comparators

The [completed workflow run](https://github.com/sebastian-software/ferriki/actions/runs/38971164540)
measured clean workspace builds at
`aea84dc7b911c79a86dd3631c698c991c36184b8`: Ferriki 1.1.1, Ferroni 2.2.2,
Shiki 4.5.0, Prism 1.30.0, Node 24.21.0 and Rust 1.99.1. Both profiles passed
all six reports: repository, curated and TIOBE, each with the prefilter on and
off. All six measurement jobs and both evidence-merge jobs succeeded.

This revision applies the benchmark changes to `main` at
`2d04039c083b0890aa7233575f406fb5ac36e8b2`. Shiki comes from the exact
`shiki-benchmark` npm alias, independently of the Shiki 4.4.3 compatibility
mirror. A registry preflight verified that Shiki and Prism matched their
current stable releases before measurement. All engines use the same locked
grammar and theme inputs; nonstandard TIOBE grammars come from Shiki 4.5.0 and
are registered as custom grammars for both native and Shiki engines.

| Profile | Observed CPU | Ferriki warm ms | Shiki/WASM warm ms | WASM / Ferriki |
| --- | --- | ---: | ---: | ---: |
| [Linux x86-64](linux-x86-64/summary.md) | AMD EPYC | 103.619 | 342.603 | 3.3× |
| [macOS ARM64](macos-arm64/summary.md) | Apple M4 Pro (Virtual) | 79.811 | 330.214 | 4.1× |

The factors divide summed warm HTML medians for the 14 repository files, with
the default prefilter. Ferriki and Shiki/WASM produced identical HTML for every
file. Shiki/JS matched the other 13 files but cannot translate the current VS
Code YAML grammar's multi-codepoint hex escape. YAML has no JS samples, and no
full-corpus warm or cold JS total is published. Per-document JS timings remain
available. Optional Phiki was skipped; this run makes no PHP performance claim.

These are observations on these machines and inputs, not total build speed,
standalone Rust performance, or certified registry artifacts.

## Faster execution, unchanged sampling budgets

The workflow adapts [Ferroni's independent shard and merge approach](https://github.com/sebastian-software/ferroni/commit/a51a2fd917eb4eacd679d565842b0ec695e3d2e6):
each profile uses one dedicated VM per corpus. Every engine and both prefilter
modes for one corpus share that VM and run serially. Other corpora run on
separate VMs. The repository totals and JSON/Astro results are separate corpus
observations; no comparison divides timings from different VMs or combines
corpora into a single total. Each corpus retains its own binary receipt.

The run took 5 minutes 24 seconds, including setup and merging. The
[preceding serial run](../2026-10-16/README.md) took 15 minutes 1 second.
The comparator release and runtime also changed; these durations describe the
complete workflow executions, not an isolated engine performance improvement.
Warmup, minimum samples and time budgets were not reduced. Repository cold
measurements still use ten fresh processes per supported engine; engine order
now rotates each round. The optional shared Phiki cohort rotates too.

A merge requires all three successful corpus shards. It checks original
checksums, output gates, source/build cleanliness, source revision, toolchain,
locks, build flags, comparator versions and runner profile before joining the
reports. It preserves raw JSON/log bytes and each VM's original context.
Independent builds may have different binary hashes; each report must match
its own VM's receipt. Missing, edited, mismatching or failed shards cannot
produce a successful complete artifact.

## Prefilter observations

Disabling the prefilter made warm repository highlighting take 31% longer on
Linux and 48% longer on macOS. First use was 25% shorter on Linux and 28%
shorter on macOS. First use includes imports, setup and rendering all 14 files;
process creation and downloads are excluded. It does not measure one isolated
snippet. Reuse the default configuration in a CMS worker or site build.

On Linux, Ferriki's JSON off medians were 2–6% longer. Astro's example was 17%
shorter and its large input 38% longer. The unchanged Shiki controls ranged
from 28% faster to 11% slower across those cells. On macOS, Ferriki's JSON
medians were 7–19% shorter and Astro's 32–34% longer; Shiki's controls were
4–16% faster. These are fixed-order on/off windows with moving controls, not
isolated measurements of configuration effects. A causal comparison needs
repeated, alternating runs on one host.

## Preserved artifacts

Each profile contains six original reports and six process logs compressed
losslessly as `.gz`. `contexts/` preserves each corpus VM's original context
and native build receipt. The merged `context.json`, validation result,
summary and `ORIGINAL_SHA256SUMS` are also retained. Checksums apply to the
**decompressed original bytes**, including logs. The dated archive remains
in Git after the workflow artifacts' 90-day retention period.

From the repository root:

```sh
node scripts/publish-blacksmith-evidence.mjs --check
```

This verifies original checksums, all twelve report gates, source/build
provenance, the original corpus contexts and the generated compact website
reports. To regenerate compact data:

```sh
node scripts/publish-blacksmith-evidence.mjs
```

Compact reports omit individual `samplesMs` arrays; the archive keeps them.
README headline factors are checked too. Edit `README.md.src` and regenerate
the root README with `mise run readme:write` when updating its figures.

See the [workflow and reproduction guide](../../blacksmith.md) for runner
profiles, timing boundaries and artifact handling. The earlier
[October 16 serial archive](../2026-10-16/README.md) and
[October 10 archive](../2026-10-10/README.md) retain their original inputs and
results; they are not version-comparison baselines for this run.
