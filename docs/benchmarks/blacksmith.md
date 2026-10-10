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

The workflow does not replace the published homepage report automatically.
Review machine provenance and output agreement before publishing new figures.

To reproduce locally, after native and compatibility builds:

```sh
cd node
node scripts/run-blacksmith-comparison.mjs /tmp/ferriki-comparison
```

Both standalone harnesses accept `--regex-prefilter on|off`. The repository
harness's `--raw-samples` retains individual durations as well as its medians.
