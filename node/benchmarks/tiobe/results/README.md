# Initial observations: September 30, 2026

These are archived captures from Ferriki revisions that still exposed Node
token output. Their token timings describe those recorded revisions only and
are not measurements or performance claims for the current HTML-only Node API.

Two complete, sequential runs on an Apple M1 Ultra (darwin-arm64), Node
24.21.0, Rust 1.96.0, using the default measurement settings. Both runs used
clean Ferriki commit `3ad8f0c834e92e0dd558682a18ce71129f1bf2f4`, Ferriki 0.6.0,
registry Ferroni 1.6.1, Shiki 4.4.3 and Prism 1.30.0. Native builds used the
repository's release profile, with no extra Rust flags. Full provenance and
individual samples are retained in each compressed JSON file.

- [Run 1 table](run-1.md) and [raw report](run-1.json.gz)
- [Run 2 table](run-2.md) and [raw report](run-2.json.gz)

Both runs measured all 19 text languages, both sizes and all four engines:
304 timing cells per run (HTML and tokens separately). Every cell preserves
source; all native/Shiki token and HTML outputs match. Scratch is explicitly
unsupported at rank 15. Neither run is selected as the winner; inspect both.

## Where to investigate Ferroni performance

The long C++ workload is a reproducible starting point:

| API    | Ferriki/Ferroni run 1 | Shiki WASM run 1 | Ferriki/Ferroni run 2 | Shiki WASM run 2 |
| ------ | --------------------: | ---------------: | --------------------: | ---------------: |
| HTML   |             81.915 ms |        58.838 ms |             77.293 ms |        54.326 ms |
| Tokens |            146.413 ms |        54.969 ms |            141.471 ms |        52.025 ms |

Native token output takes 2.66–2.72 times the WASM duration here. C# and Java
also show slower native token output in both runs. Python and C are faster
than WASM for both APIs on their long examples. These are workload-specific
observations; the ranking does not imply a regex-engine-only bottleneck.

The difference between HTML and token timings warrants profiling the complete
native path, including token materialization, N-API marshaling and facade
processing, before assigning the cost to Ferroni. A useful next experiment is
to profile the C++ workload, extract any dominant regex/scanner cases into
Ferroni's own benchmarks, change one engine behavior on its own branch, and
rerun this same corpus with a local Ferroni patch. Check every language and
both sizes for regressions rather than judging only the targeted C++ case.

Prism is substantially faster in these examples, but uses different grammars,
nested tokens and class-based HTML instead of themed TextMate tokens. It is an
independent practical baseline; matching source text does not establish equal
highlighting detail or fidelity. See the [methodology](../README.md).

These are baseline runs of the **same Ferroni build**, not a before/after
optimization result. Differences between them demonstrate measurement noise;
Across the 76 native medians, the second run ranges from 6.98% faster to
6.29% slower than the first. Small proposed gains therefore need repeated,
alternating baseline/candidate runs.

## Inspect or compare raw reports

The renderer and comparison command accept plain JSON or `.json.gz` directly:

```sh
# From node/
node scripts/render-tiobe.mjs benchmarks/tiobe/results/run-1.json.gz
node scripts/compare-tiobe.mjs benchmarks/tiobe/results/run-1.json.gz benchmarks/tiobe/results/run-2.json.gz
```

For other tools, decompress with `gzip -dc run-1.json.gz > run-1.json`.
