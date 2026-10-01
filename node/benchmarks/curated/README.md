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

Run from `node/` after preparing comparator packages and the
ordinary native addon:

```sh
pnpm run build:native
pnpm run check:bench-curated
pnpm run bench:curated --write /tmp/curated-report.json
node scripts/profile-tiobe.mjs --corpus curated --language vue --boundary native --api html
```

The TIOBE method is reused: warmed public tokens and HTML measured separately,
rotating engine order, one fresh worker per format, sequential formats, raw
samples, ordinary addon receipts, and exact TextMate token/HTML parity before
timing. HTML is the primary decision boundary; tokens are diagnostic.
Prism's Astro/Svelte/Vue/MDX cells are explicitly unsupported.

For a local Ferroni experiment, set `FERRIKI_FERRONI_PATH=/absolute/path/to/ferroni`
when building. The [profiling instructions](../tiobe/README.md#profile-one-workload)
also apply to this corpus with `--corpus curated`.

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
