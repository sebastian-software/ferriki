# Curated 20-format performance corpus

This original corpus implements the fixed selection in Ferroni's
`benches/highlighting_corpus.md`: TypeScript, TSX, Rust, CSS, HTML, C++, Swift,
Java, Markdown, TOML, YAML, JSON, Astro, Svelte, Ruby, Python, Vue, MDX, SCSS
and Bash. Stable case numbers are not popularity rankings.

The fixtures and embedded language lists are unchanged from Ferriki commit
`0136c99d3aad9aad9eeaa025692124e94420153d`. The current-main harness uses the
existing offline asset cache. `example` highlights one complete fixture;
`large` repeats it 16 times. These large inputs are synthetic highlighting
traffic, rather than standalone runnable applications.

Run from `node/` after installing dependencies and building the
ordinary native addon:

```sh
pnpm run build:native
pnpm run check:bench-curated
pnpm run bench:curated --write /tmp/curated-report.json
node scripts/profile-tiobe.mjs --corpus curated --language vue --boundary native
```

The TIOBE method is reused: warmed HTML measurements, rotating engine order,
one fresh worker per format, sequential formats, raw samples, ordinary addon
receipts, and exact TextMate HTML parity before timing. Current runs do not
measure public Node token APIs.
Prism's Astro/Svelte/Vue/MDX cells are explicitly unsupported.

The [October 24, 2026 Blacksmith archive](../../../docs/benchmarks/blacksmith/2026-10-24-prepared-eager/README.md)
preserves all default/Off per-language tables, raw samples and receipts for
Ferriki 1.2.0 / Ferroni 2.7.0 with prepared standard packages. The Linux corpus
VMs had different CPU vendors, so their successful reports are retained
separately; the Linux merged job failed its CPU check. The archive also keeps
[a per-language comparison with October 16](../../../docs/benchmarks/blacksmith/2026-10-24-prepared-eager/comparison-with-october-16.md).
The [published benchmarks](https://ferriki.dev/evidence/benchmarks) use the
separate repository corpus for headline factors and show JSON/Astro controls.
Historical experiment reports below retain their original scope.

For a local Ferroni experiment, set `FERRIKI_FERRONI_PATH=/absolute/path/to/ferroni`
when building. The [profiling instructions](../tiobe/README.md#profile-one-workload)
also apply to this corpus with `--corpus curated`.

The [October 17 borrowed-rendering experiment](results/borrowed-inline-render/README.md)
records isolated theme/renderer candidates, a repeated 40-case comparison,
and per-document regression checks on both the current and exact published
homepage fixtures, including cold starts.

Repeat baseline/candidate in ABBA order with the same source fixtures,
assets, dependencies, features and build flags. Never run builds or CPU
profiles alongside timed workloads. Preserve outputs, source hashes and
full reports; do not rank engines when their highlighting differs.

The [direct inline HTML experiment](results/direct-inline-html/README.md)
retains the full ABBA comparison on Ferriki 0.8.0 / Ferroni 1.8.0, exact parity
gates, ordinary build receipts and final compatibility validation.

The [post-inline-HTML profiling round](results/post-inline-html/README.md)
retains the final two independent trials on Ferriki 0.8.1 / Ferroni 1.8.0,
including the accepted borrowed escaping path, rejected style buffer, verified
CPU profiles and all eight complete comparison reports.

The [Prism quality and profiling investigation](results/prism-investigation/README.md)
records current repeated Prism/Ferriki/Shiki comparisons, committed quality
fixtures, output-mode costs, and diagnostic profiles for representative
languages.

Those archived experiment reports were collected before removal of the public
Node token APIs. Their token figures describe the recorded historical source
revisions and are not current API or performance claims.
