# Blacksmith highlighting comparison

The manual `Blacksmith comparison` workflow uses the same runner profiles as
Ferroni's `blacksmith-comparison.yml`:

| Profile | Runner label |
| --- | --- |
| Linux x86-64 | `blacksmith-4vcpu-ubuntu-2404` |
| macOS ARM64 | `blacksmith-6vcpu-macos-26` |

The runner label does not guarantee a CPU vendor or model. Every artifact records
the observed CPU, OS, core count, Node version, Rust compiler, commit, lockfile
hashes and native build receipt. Node is pinned to 24.21.0, matching Ferroni;
pnpm comes from Ferriki's `node/package.json`. Rust uses stable, with its exact
version recorded. Runs on different machines are independent observations.

Start both profiles at one revision:

```sh
gh workflow run blacksmith-comparison.yml --ref main -f platform=both
```

Paid runners are only started by manual dispatch. A complete run starts six
measurement VMs: one per profile and corpus. Each builds its release addon and
materializes locked grammar/theme sources. The engines and both prefilter modes
for one corpus run serially on that same VM. Independent corpora run concurrently;
they never contend for one VM's CPU. Two ordinary Linux jobs then validate and
join the reports by profile, without combining timings from different VMs.
This adapts [Ferroni's independent shard and merge approach](https://github.com/sebastian-software/ferroni/commit/a51a2fd917eb4eacd679d565842b0ec695e3d2e6)
to our three corpora. It shortens elapsed time without reducing sample counts;
each corpus now pays its own build/setup cost.

The comparison uses the current stable Shiki release as the exact
`shiki-benchmark` npm alias, independently of the immutable compatibility mirror.
Prism is pinned too. A registry preflight rejects outdated comparator pins or a
failed version lookup before building or measuring. Update the catalog pins and
lockfile when a stable release changes. Every report records actual versions.
Both native and Shiki engines receive the same locked grammar and theme data;
nonstandard TIOBE grammars come from the current Shiki release and are registered
as custom grammars in both. No comparator workspace build is needed.

- The repository comparison measures 14 real source files, both warm reused
  highlighters and ten fresh processes per engine. Cold timing includes
  engine-specific imports, setup and one full-corpus render, excluding process
  creation. Local cached assets exclude downloads. This is a full-corpus first
  use measurement, not the latency of highlighting one isolated code snippet.
  Cold engine order rotates each round, with ten fresh processes per supported
  engine; warm engine order also rotates.
- The curated corpus covers 20 formats, including JSON and Astro, at example
  and large sizes. The TIOBE corpus covers its pinned language ranking. Both
  retain every warm HTML sample and reuse one highlighter per language. Setup
  diagnostics in these reports are not fair cold-start comparisons.
- Ferriki and Shiki/WASM must preserve exact TextMate HTML using the same
  current grammar data. Shiki/JS has the same gate for supported grammars. The
  current VS Code YAML multi-codepoint hex escape cannot be converted by its
  JavaScript engine; only that precise failure is reported as unsupported.
  That case has no JS samples, and repository reports omit full-corpus JS totals
  when YAML is unsupported. Curated and TIOBE reports additionally check source
  preservation, with explicit unsupported Prism grammars and Scratch. Other
  errors, timeouts, missing cases and output changes fail the job even if the
  underlying harness exits zero. Prism uses independent grammars; its raw
  timings do not claim TextMate parity.
- Phiki is optional in the repository harness. This workflow does not install
  PHP or Composer; availability and skips are reported explicitly. Phiki output
  differences do not weaken the required Node HTML gate.

Artifacts expire after 90 days and contain six JSON reports, raw samples, logs,
runner contexts, validation outcome, a Markdown summary and SHA256SUMS. The
merged artifact keeps each corpus VM's original context and build receipt.
Merging rejects missing or failed shards, edited reports, dirty builds, and
different source revisions, toolchains, locks, build flags or runner profiles. Preserve
downloaded artifacts with any performance claim. The summary highlights JSON
and Astro and reports warm and cold results separately. The fixed on/off report
order can introduce drift; repeat small differences before attributing them to
the option. These runs compare current engines and prefilter modes, not earlier
Ferroni releases. An upgrade comparison requires a baseline measured on the same
profile with identical fixtures, harness and compiler.

## Published measurements

The [October 16, 2026 archive](blacksmith/2026-10-16-sharded/README.md) preserves all
twelve successful reports from both profiles with Ferriki 1.1.1, Shiki 4.5.0
and Ferroni 2.2.2. On the same
14 repository files, default reused Ferriki highlighters were 3.3× faster
than Shiki/WASM on Linux x86-64 and 4.1× faster on macOS ARM64, with identical
HTML against Shiki/WASM. Shiki/JS matched the other 13 files; its full-corpus
total is unavailable because it cannot translate the current YAML grammar.
Linux's observed processor was AMD EPYC; macOS used an Apple M4 Pro
virtual machine. The Linux profile is x86-64, not a promise of Intel hardware.

The [website](https://ferriki.dev/evidence/benchmarks) presents these runner profiles,
first-use and reuse results, and JSON/Astro with the unchanged Shiki controls.
Unchanged controls moved between on/off windows on both profiles. These
observations do not isolate the prefilter's effect on first use or JSON/Astro. The archive records the full scope
and interpretation alongside the raw samples.

The workflow does not replace the published homepage report automatically.
Review machine provenance and output agreement before publishing new figures.
Preserve a dated archive and point `scripts/publish-blacksmith-evidence.mjs`
at it. Run the generator to refresh compact reports, review the copy, and run
`node scripts/publish-blacksmith-evidence.mjs --check`. This verifies original
artifact hashes, all report gates and published data; the homepage build runs
the same check. Update `README.md.src` and regenerate the root README with
`mise run readme:write` when its headline figures change.

To reproduce locally, after dependency installation and the native build:

```sh
cd node
node ../scripts/materialize-assets.mjs --sources
node scripts/run-blacksmith-comparison.mjs /tmp/ferriki-comparison
```

Use `--corpus comparison`, `--corpus curated` or `--corpus tiobe` on the local
orchestrator to validate and measure one corpus. Omitting it keeps the complete
serial local run. The workflow's merge requires all three corpus shards before
it can produce a successful complete artifact. Published repository totals use
only the repository VM; JSON/Astro comes from the curated VM. These are distinct
observations on one runner profile, not one shared physical host.

Both standalone harnesses accept `--regex-prefilter on|off`. The repository
harness's `--raw-samples` retains individual durations as well as its medians.
