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

Paid runners are only started by manual dispatch. Each host builds its release
addon and pinned Shiki comparators before timing. All workloads on that host run
serially, using the same addon with `regexPrefilter` enabled and then disabled
for each corpus. Separate hosts may run concurrently.

- The repository comparison measures 14 real source files, both warm reused
  highlighters and ten fresh processes per engine. Cold timing includes
  engine-specific imports, setup and one full-corpus render, excluding process
  creation. Local cached assets exclude downloads. This is a full-corpus first
  use measurement, not the latency of highlighting one isolated code snippet.
- The curated corpus covers 20 formats, including JSON and Astro, at example
  and large sizes. The TIOBE corpus covers its pinned language ranking. Both
  retain every warm HTML sample and reuse one highlighter per language. Setup
  diagnostics in these reports are not fair cold-start comparisons.
- Ferriki and both Shiki engines must preserve exact TextMate HTML. Curated and
  TIOBE reports additionally check source preservation, with explicit unsupported
  Prism grammars and Scratch. Errors, timeouts, missing cases and output changes
  fail the job even if the underlying harness exits zero. Prism uses independent
  grammars; its raw timings do not claim TextMate parity.
- Phiki is optional in the repository harness. This workflow does not install
  PHP or Composer; availability and skips are reported explicitly. Phiki output
  differences do not weaken the required Node HTML gate.

Artifacts expire after 90 days and contain six JSON reports, raw samples, logs,
runner context, validation outcome, a Markdown summary and SHA256SUMS. Preserve
downloaded artifacts with any performance claim. The summary highlights JSON
and Astro and reports warm and cold results separately. The fixed on/off report
order can introduce drift; repeat small differences before attributing them to
the option. These runs compare current engines and prefilter modes, not earlier
Ferroni releases. An upgrade comparison requires a baseline measured on the same
profile with identical fixtures, harness and compiler.

## Published measurements

The [October 10, 2026 archive](blacksmith/2026-10-10/README.md) preserves all
twelve successful reports from both profiles with Ferroni 2.1.0. On the same
14 repository files, default reused Ferriki highlighters were 4.7× faster
than Shiki/WASM on Linux x86-64 and 5.5× faster on macOS ARM64, with identical
HTML. Linux's observed processor was AMD EPYC; macOS used an Apple M4 Pro
virtual machine. The Linux profile is x86-64, not a promise of Intel hardware.

The [website](https://ferriki.dev/evidence/benchmarks) presents these two hosts,
first-use and reuse results, and JSON/Astro with the unchanged Shiki controls.
The controls moved with Ferriki in macOS's on/off windows, so that difference
does not establish a prefilter benefit. The archive records the full scope
and interpretation alongside the raw samples.

The workflow does not replace the published homepage report automatically.
Review machine provenance and output agreement before publishing new figures.
Preserve a dated archive and point `scripts/publish-blacksmith-evidence.mjs`
at it. Run the generator to refresh compact reports, review the copy, and run
`node scripts/publish-blacksmith-evidence.mjs --check`. This verifies original
artifact hashes, all report gates and published data; the homepage build runs
the same check. Update `README.md.src` and regenerate the root README with
`mise run readme:write` when its headline figures change.

To reproduce locally, after native and compatibility builds:

```sh
cd node
node scripts/run-blacksmith-comparison.mjs /tmp/ferriki-comparison
```

Both standalone harnesses accept `--regex-prefilter on|off`. The repository
harness's `--raw-samples` retains individual durations as well as its medians.
