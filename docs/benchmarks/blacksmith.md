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
materializes locked grammar/theme sources. All four native regex policies
and the comparator engines for one corpus run serially on that same VM. Independent corpora run concurrently;
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

Artifacts expire after 90 days and contain three mode-comparison JSON reports,
raw samples, logs, runner contexts, validation outcome, a Markdown summary and SHA256SUMS. The
merged artifact keeps each corpus VM's original context and build receipt.
Merging rejects missing or failed shards, edited reports, dirty builds, and
different source revisions, toolchains, locks, build flags or runner profiles. Preserve
downloaded artifacts with any performance claim. Mode captures retain each
corpus VM's CPU and core count independently; different CPUs across corpora are allowed
because no timing totals span those VMs. Legacy on/off merges retain their
original stricter hardware guard. The summary includes all curated and TIOBE
cases and reports warm and cold results separately. Repeat small differences
before attributing them to a policy. These runs compare current regex modes, not earlier
Ferroni releases. An upgrade comparison requires a baseline measured on the same
profile with identical fixtures, harness and compiler.

## Published measurements

The [October 24, 2026 archive](blacksmith/2026-10-24-prepared-eager/README.md)
preserves all twelve successful timing reports and both complete memory
captures for Ferriki 1.2.0, Ferroni 2.7.0 and Shiki 4.5.0. Prepared standard
regex packages are enabled in the default lane. Reused highlighters on the
14-file repository corpus were 2.4× faster than Shiki/WASM on Linux and 2.9×
on macOS, with identical HTML. Full-corpus first use was 876.6 versus 1,027.2 ms
on Linux and 618.3 versus 1,084.9 ms on macOS, excluding downloads and process
creation. All 14 languages are loaded up front; this is not one-snippet startup.

All six timing jobs and both memory jobs passed. The macOS merge passed; the
Linux merge rejected different CPUs across corpus VMs, marking the overall
workflow failed. Linux's repository VM was Intel Xeon; its curated and TIOBE
VMs were AMD EPYC. The archive publishes the successful shards independently
with original contexts and hashes, and no cross-VM aggregate. That capture used
the legacy merge guard. macOS VMs used Apple M4 Pro (Virtual).

The [website](https://ferriki.dev/evidence/benchmarks) presents these observations,
first-use and reuse results, JSON/Astro controls and memory ranges. The older
[October 16 archive](blacksmith/2026-10-16-sharded/README.md) remains available.
Its 3.3× / 4.1× factors were larger, but revisions, source inputs and hardware
changed; this is not a controlled measurement of the prepared-package effect.

The workflow does not replace the published homepage report automatically.
Review machine provenance and output agreement before publishing new figures.
Preserve a dated archive and point `scripts/publish-blacksmith-evidence.mjs`
at its separately retained corpus shards. Run the generator to refresh compact reports, review the copy, and run
`node scripts/publish-blacksmith-evidence.mjs --check`. This verifies original
artifact hashes, all report gates and published data; the homepage build runs
the same check. Update `README.md.src` and regenerate the root README with
`mise run readme:write` when its headline figures change.

To reproduce locally, after dependency installation and the native build:

```sh
cd node
node ../scripts/materialize-assets.mjs --sources
node scripts/run-blacksmith-comparison.mjs /tmp/ferriki-comparison --regex-modes
```

Use `--corpus comparison`, `--corpus curated` or `--corpus tiobe` on the local
orchestrator to validate and measure one corpus. Omitting it keeps the complete
serial local run. The workflow's merge requires all three corpus shards before
it can produce a successful complete artifact. Published repository totals use
only the repository VM; JSON/Astro comes from the curated VM. These are distinct
observations on one runner profile, not one shared physical host.

Both standalone harnesses accept `--regex-prefilter on|off`. The repository
harness's `--raw-samples` retains individual durations as well as its medians.

## Process memory

Run the memory suite on two separate Blacksmith VMs:

```sh
gh workflow run blacksmith-comparison.yml --ref main -f platform=both -f suite=memory
```

`timings` remains the default suite. `all` starts both suites; the memory jobs
have their own VMs and do not share a machine with timing jobs. Each memory VM
runs every engine and scenario serially. This controls the runner environment;
it does not guarantee that a virtual machine has no host-level interference.

For a local capture, use a clean checkout, install the frozen dependencies,
materialize the standard sources and build the release addon as described above,
then run:

```sh
cd node
node scripts/run-blacksmith-memory.mjs /tmp/ferriki-memory --regex-modes
```

The memory harness compares Ferriki source Off, Auto, Eager and Prepared with
current Shiki/Oniguruma WASM and Shiki's JavaScript engine. All use the same theme and
locked grammar sources. There are two fixed sequential workloads:

- **Repository:** the timing corpus's 12 shared files, excluding YAML and SQL for every
  engine. Shiki/JS cannot translate the YAML grammar and differs from native/WASM
  on the SQL fixture in a fresh isolated process. These are explicit cohort
  exclusions; the memory corpus differs from the 14-file timing corpus.
  Reuse one highlighter and discard each HTML result. Capture after 1, 10 and
  50 corpus passes (12, 120 and 600 rendered documents).
- **Large TypeScript:** repeat the repository's `node/ferriki/src/api.mts` with
  newline separators until the input reaches at least 256 KiB. Load only
  TypeScript and its grammar dependencies, reuse one highlighter, and capture
  after 1, 5 and 10 renders. The exact repetition count, bytes and SHA-256 are
  recorded; this is a generated size case, not an independent real-world file.

Before measurement, separate validation processes must agree on exact HTML
SHA-256 and byte length for every document in each workload. Measurement then
uses six fresh processes per engine and scenario, rotating engine order once
per repetition. The HTML is consumed as UTF-8 byte length and released after
one document; the total consumed bytes must match the validation output for
every pass. Assets are already cached locally; downloads are excluded.

Each worker records a baseline after loading inputs and before engine imports,
then initialization, each render checkpoint, and disposal. Two explicit V8
collections separated by event-loop turns precede baseline and initialization
snapshots and follow each render checkpoint. Raw snapshots immediately before
checkpoint GC are retained too. No collection is forced between documents.
The highlighter stays live until the final render checkpoint.

The published metrics are **absolute whole-process RSS** after initialization,
RSS after the final checkpoint's explicit GC, and **process-lifetime peak RSS**
through that checkpoint. Peak includes process startup, inputs, package imports,
engine setup, rendering and explicit GC. Node's `resourceUsage().maxRSS` is in
KiB and is multiplied by 1,024; displayed MiB divide bytes by 1,048,576.
Report medians and the full min–max range over the six independent processes.
Do not subtract baseline or initialization peaks: high-water marks cannot
recover a render-only peak. Compare engines within the same host profile;
Linux and macOS memory accounting and allocators differ.

RSS includes JavaScript, native Rust and WASM resident pages, code, caches and
allocator retention. `heapUsed`, `heapTotal`, `external` and `arrayBuffers` are
retained as diagnostics, not added to RSS or used as Rust allocation counters.
V8 GC cannot force native allocators or WASM to return memory to the OS. A
higher final RSS does not by itself prove a leak, and a lower RSS does not
establish fewer allocations. These bounded sequential workloads measure
process memory, not concurrent service capacity or production memory limits.
See the [Node memory API](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusage)
and [resource usage API](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage).

The `memory-<profile>-<run>-<attempt>` artifacts retain individual worker JSON,
stderr, combined raw samples, runner/build context, validation, a Markdown
summary and SHA256SUMS for 90 days. Dirty source/build receipts, a stale addon,
a loaded native binary that differs from the receipt, uncontrolled
`NODE_OPTIONS`, output differences, missing processes and invalid counters
fail the job. Preserve the original evidence in a dated archive before
publishing figures.

The homepage's memory tables are generated by
`node scripts/publish-memory-evidence.mjs` from the committed memory archive.
`--check` verifies every original worker file and checksum, the combined report,
HTML agreement, native binary receipts and the compact published values; the
homepage build runs this check. The publication does not replace timing reports
or combine the 12-file memory cohort with 14-file timing totals.

The [October 24 memory capture](blacksmith/2026-10-24-prepared-eager/README.md#process-memory)
passed on both profiles. With 12 languages loaded for the repository workload,
Ferriki's median RSS was 689.0 MiB on Linux and 1,071.3 MiB on macOS, versus
454.8 and 451.9 MiB for Shiki/WASM: 51–137% higher. With only the large
TypeScript workload, Ferriki used 151.4 and 205.6 MiB, versus 333.8 and 304.9 MiB:
33–55% lower. The summaries retain all engines, initialization and peak values,
and min–max ranges. Requested languages and dependencies are loaded, not the
whole catalog. The previous capture's repository memory saving does not hold
in this capture; attributing that change requires a controlled A/B experiment.

## Explicit regex-mode contenders

The current workflow uses `--regex-modes` for both timing and memory suites.
One report per corpus contains Ferriki source Off, source Auto (lazy DFA),
source Eager, and prepared Eager alongside the unchanged Shiki/Prism controls.
All source contenders skip standard prepared archives. Prepared remains the
product default; the benchmark's classic `ferriki` identity is explicitly Auto.
The legacy on/off CLI remains available and records its source policy. Dated
reports without a policy field keep their original documented meaning.

```sh
cd node
node scripts/bench-tiobe.mjs --regex-modes --language sql --write /tmp/sql-modes.json
node scripts/run-blacksmith-comparison.mjs /tmp/modes --corpus curated --regex-modes
node scripts/run-blacksmith-memory.mjs /tmp/memory-modes --regex-modes
```

Mode reports preserve the four policies as separate table columns. Runtime
snapshots validate the requested mode, source/archival separation, and actual
group decoding where prepared standard resources are expected. Snapshot work
is outside timers. Counts do not establish complete archive coverage or detect
every local rebuild. Exact HTML agreement and original timing budgets remain
required. Memory v2 uses six isolated engine processes per repetition instead
of mixing several Ferriki modes into one process.

A source-mode regression must compare the same source policy, fixtures,
grammars, output and machine. Replacing Source/Auto with Prepared and calling
the difference a source regression is invalid. Keep both separate, investigate
unexpected source differences, and measure prepared startup against Source/Eager.
