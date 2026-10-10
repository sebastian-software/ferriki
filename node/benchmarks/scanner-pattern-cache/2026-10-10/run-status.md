# Measurement run status

The successful capture ran on 2026-10-10 from 11:56:47 UTC through 11:57:39 UTC. The output records `measuredAt` as 11:57:27 UTC. It produced 90 HTML samples and 10 paired memory samples. The readable [`results.json`](results.json) is the formatted view; [`results.raw.json.gz`](results.raw.json.gz) preserves the exact pre-format capture. Its uncompressed SHA-256 is `f56ab1c770367aa536dd0aed7853e03020f121615ad3634775a0feb7f367df86` and the gzip file SHA-256 is `b9912e2d230ff39dca80848048ed4edda00af67dd26fa1f742237bd03c6c48f4`.

An initial attempt ran from the `node/` directory with an output argument that incorrectly repeated the `node/` prefix:

```sh
PATH=/tmp/ferriki-tool-bin:/opt/homebrew/opt/node@24/bin:$PATH node benchmarks/scanner-pattern-cache/2026-10-10/measure.mjs run /private/tmp/ferriki-issue230-baseline /Users/sebastian/Workspace/.codex/issue-230-pattern-cache/ferriki node/benchmarks/scanner-pattern-cache/2026-10-10/results.json 9
```

The workers completed, but final persistence failed with exit code 1 because the resulting `node/node/benchmarks/...` directory did not exist. The report existed only in process memory and those completed samples were lost; they are not included in `results.json`. The full error was:

```text
node:fs:2482
    return binding.writeFileUtf8(
                   ^

Error: ENOENT: no such file or directory, open '/Users/sebastian/Workspace/.codex/issue-230-pattern-cache/ferriki/node/node/benchmarks/scanner-pattern-cache/2026-10-10/results.json'
    at writeFileSync (node:fs:2482:14)
    at file:///Users/sebastian/Workspace/.codex/issue-230-pattern-cache/ferriki/node/benchmarks/scanner-pattern-cache/2026-10-10/measure.mjs:340:1
    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5) {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/Users/sebastian/Workspace/.codex/issue-230-pattern-cache/ferriki/node/node/benchmarks/scanner-pattern-cache/2026-10-10/results.json'
}
Node.js v24.21.0
```

The corrected command wrote the report to a path relative to the `node/` working directory:

```sh
PATH=/tmp/ferriki-tool-bin:/opt/homebrew/opt/node@24/bin:$PATH node benchmarks/scanner-pattern-cache/2026-10-10/measure.mjs run /private/tmp/ferriki-issue230-baseline /Users/sebastian/Workspace/.codex/issue-230-pattern-cache/ferriki benchmarks/scanner-pattern-cache/2026-10-10/results.json 9
```

The successful run reused the same clean base and candidate builds and the same committed harness. No build, test, or formatter process ran during the captures.

## Final guarded capture

After the initial capture, the harness was strengthened to hash the actual addon file, build receipt, fixture manifest, asset manifest, and all five fixture files before capture. Each timing and memory worker rehashes its inputs before doing work; the coordinator compares every worker result and rechecks all inputs after the workers finish. Both input snapshots matched. The base and candidate receipt commits were clean, and each receipt's binary hash matched the bytes loaded from its actual `ferriki.node` file.

The guarded capture ran on 2026-10-10 and records `measuredAt` as `2026-10-10T12:08:57.130Z`. The command exited with status 0 and wrote 90 timed HTML samples and 10 memory samples:

```sh
/opt/homebrew/opt/node@24/bin/node benchmarks/scanner-pattern-cache/2026-10-10/measure.mjs run /private/tmp/ferriki-issue230-baseline /Users/sebastian/Workspace/.codex/issue-230-pattern-cache/ferriki benchmarks/scanner-pattern-cache/2026-10-10/results-guarded.json 9
```

The before/after input guard recorded base receipt SHA-256 `078aea8f5e6aaccfd711216cc75e9403e2ee406332f843cc88b41692a2b02550`, commit `6521b1be906e5a2711cddb15164e3ed2bd4a9af8`, and actual addon SHA-256 `e7d8f43a405966627e6f7dbafd3777d082f3e4afe59ebc29f166df692bc62b15`. Candidate receipt SHA-256 was `112ad50eccb88cbb73f79ae2f4fd5287549ee40fc15a316c519c083ee59b216b`, commit `19a363a20927ad52c5222daa16d86796056ce2ce`, and actual addon SHA-256 `70481219b25aa0117c2e5e4d0abe17c4cb44c9563749aefdf3e608d25522cae3`. Both statuses were empty. Fixture manifest SHA-256 was `4c0c2f8bfa535d7f6fc3397a0585e3e6d66c1509d5341d7022ced20303cd175e`; standard asset manifest SHA-256 was `30ca207f07ee8616369ffb8e5c6456195abca74d56de6a106a87cf99cd83debf`.

The readable report's SHA-256 is `b09b94cb03d7ee20b708183feb8d72c0dcfa5861c232e6833d728a938e99bc58`; the exact gzip copy's SHA-256 is `0238be9cff96ec5b79c71c285646344c3e15e87a35597c8a04e67c51c71998eb`. The pre-lint measured harness is preserved as `measure-guarded-capture.mjs.txt`, SHA-256 `c13a06f84e869adc814a88fd408993fdcf00e8894b558aa569cbca71b376becf`. After capture, the final harness was adjusted to satisfy CI lint: imports were sorted, `Buffer` was explicitly imported, worker output switched to synchronous `writeSync`, and an unused memory-worker variable was removed. No timed statements or hash comparisons changed; the preserved harness and output hashes make the exact measurement implementation auditable.
