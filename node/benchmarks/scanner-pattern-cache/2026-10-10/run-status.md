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
