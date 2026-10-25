# Separate regex policies on Blacksmith

Measured October 25, 2026 at `8aba6dd009fa09a3eed895e1764b2f04dbef0f1b` in [the complete successful workflow](https://github.com/sebastian-software/ferriki/actions/runs/40174524561). All six timing jobs, both memory jobs and both evidence merges passed. This is a repository build after npm 1.2.0, using Ferroni 2.7.0 and Shiki 4.5.0.

Source Off, source Auto (lazy DFA), source Eager and Prepared are independent contenders. Prepared remains the product default. Explicit source policies do not open prepared archives. Source Eager prepares helpers as scanners are constructed; it does not visit every possible grammar path up front. Custom-only grammars use source Auto under Prepared.

## Repository timing

Milliseconds; lower is faster. Warm values sum medians for the same 14 files on one VM. First use is the median of ten fresh processes, including imports, setup and a complete corpus render. Assets are cached; downloads and process creation are excluded. Only requested languages and their dependencies are loaded, rather than the entire catalog.

| Host / phase | Source Off | Source Auto | Source Eager | Prepared | Shiki WASM |
| --- | ---: | ---: | ---: | ---: | ---: |
| Linux x86-64 / reused | 120.621 | 84.363 | 84.545 | 154.582 | 300.966 |
| Linux x86-64 / first use | 214.878 | 354.143 | 445.894 | 817.980 | 958.419 |
| macOS ARM64 / reused | 121.395 | 80.638 | 80.421 | 115.311 | 335.882 |
| macOS ARM64 / first use | 219.734 | 338.459 | 413.725 | 619.943 | 1099.914 |

There is no full-corpus Shiki/JS total because its YAML converter is unsupported. Required native/Shiki HTML agreement passed for every supported case. Prism uses independent grammars in the language corpora.

## Findings

Prepared does not meet the cheaper full-package startup target in this workload: it takes longer than source Eager on both hosts. This differs from the earlier isolated-primary-grammar tokenizer diagnostic, which excluded file I/O and full production dependency/injection packages. The two experiments answer different questions.

| TIOBE SQL / size | Source Auto | Source Eager | Prepared | Prepared / Eager |
| --- | ---: | ---: | ---: | ---: |
| Linux x86-64 / example | 0.446 | 0.426 | 6.144 | 14.4× |
| Linux x86-64 / large | 4.418 | 4.375 | 94.555 | 21.6× |
| macOS ARM64 / example | 0.249 | 0.239 | 4.306 | 18.0× |
| macOS ARM64 / large | 3.678 | 3.681 | 69.172 | 18.8× |

SQL is a large Prepared-specific execution outlier. Source Auto and source Eager are close to each other here. Runtime snapshots show actual prepared groups loaded with no invalid groups or scanner-assembly retries. Those counters do not prove complete coverage or exclude ordinary local rebuilds; the root cause remains open. Most other language cases have similar Prepared and source-Eager execution times.

## Whole-process memory

MiB after the final render checkpoint and explicit V8 GC, median of six isolated processes per engine and scenario. Full initialization/peak values, checkpoint series and min–max ranges remain in the original reports and website tables.

| Host / workload | Source Off | Source Auto | Source Eager | Prepared | Shiki WASM | Shiki JS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Linux x86-64 / repository | 140.2 | 252.4 | 254.8 | 689.1 | 438.6 | 341.7 |
| Linux x86-64 / large-typescript | 86.3 | 102.2 | 103.7 | 151.2 | 306.9 | 287.8 |
| macOS ARM64 / repository | 142.1 | 270.9 | 272.6 | 1071.3 | 452.1 | 333.1 |
| macOS ARM64 / large-typescript | 85.6 | 104.1 | 105.1 | 205.5 | 315.6 | 288.8 |

The repository memory cohort uses 12 files × 50 passes; YAML and SQL are excluded for every engine because of documented Shiki/JS limitations. The generated large-TypeScript cohort uses ten renders. All contenders passed separate exact HTML SHA-256 and byte-length validation before measuring. Prepared retains more RSS than source Eager in both workloads. These are absolute process observations, including Node, Rust, WASM and allocator retention; they are not leak or concurrency tests.

## Classical-path regression control

The [repeated local release control](source-release-control/README.md) compares the published 1.1.2 native addon with the current native source paths using identical current grammar/theme registrations and all 20 curated formats at both sizes. It records smaller repeatable differences, including about 6% slower Auto on TOML. It does not justify claiming that every source path is regression-free, and differing binary build environments prevent attributing the changes to Ferroni alone. There is no historical Eager comparison with equivalent semantics.

## Evidence and reproduction

- [Linux: every timing row](linux-x86-64.md).
- [macOS: every timing row](macos-arm64.md).
- `timings/<profile>/<corpus>/` retains six original reports, contexts, process logs, validations, summaries and original uncompressed SHA-256 records. Large reports/logs are losslessly gzipped.
- `memory/<profile>/` retains every original worker result/log and both complete captures: 144 isolated measurements and 24 separate output-validation processes.
- `capture.json` pins the capture revision and workflow; the compact report is generated from verified originals.

Run `node scripts/publish-regex-mode-evidence.mjs --check` to verify every artifact, policy, output gate and generated website value. The homepage build runs the same check. Native/Shiki comparisons stay within each corpus VM; no timing aggregate spans corpus VMs or operating systems. Current policy comparisons and historical regressions remain separate questions.
