# Curated 20-format highlighting workloads

This corpus implements the [fixed 20-format selection](https://github.com/sebastian-software/ferroni/blob/16af64c93e6ecf1cb6786d04a1f434b23bd21716/benches/highlighting_corpus.md)
for finding Ferroni optimization candidates across web components, documentation,
configuration and programming languages. The `rank` field is a stable case
number, not a popularity ranking. The historical TIOBE corpus stays available.

Fixtures are original order-processing/dashboard examples, with explicit
dialects, grammar IDs and embedded-language dependencies in `manifest.json`.
The Rust, C++, Swift, Java and Python examples are copied unchanged from the
original TIOBE fixtures. The other examples add typed JSX, embedded CSS/JS/TS,
Markdown/MDX fences, YAML anchors and block scalars, TOML multiline strings,
SCSS nesting and Bash here-documents. They exercise Unicode and escaping.

For this first comparison, `example` uses one complete fixture and `large`
concatenates 16 copies, following the existing harness. This larger input is
synthetic highlighting traffic, not a standalone runnable application or a
substitute for large real-project files. Returning to top-level syntax between
repeated blocks exercises grammar-state transitions. Each report pins bytes, lines, copy count
and source hashes. Additional real-project fixtures need a separate corpus
commit and baseline.

## Run and validate

From `node/`, after installing dependencies and building comparator packages:

```sh
FERRIKI_FERRONI_PATH=/absolute/path/to/ferroni pnpm run build:native
pnpm run check:bench-curated
pnpm run bench:curated --write /tmp/curated-baseline.json
node scripts/render-tiobe.mjs /tmp/curated-baseline.json > /tmp/curated-baseline.md
node scripts/profile-tiobe.mjs --corpus curated --language vue --api tokens
node scripts/profile-tiobe.mjs --corpus curated --language vue --boundary native --api html
```

The shared [TIOBE methodology](../tiobe/README.md) applies: local assets, a
fixed theme, pinned comparator versions, warm public tokens and HTML measured
separately, rotating engine order, sequential language processes with timeouts,
raw samples, median/p95, loaded-addon build receipts, and exact output checks
before timing. Keep the machine idle; run no builds or tests during timing.
The correctness check uses two samples only and is not performance evidence.

Ferriki and both Shiki engines load the same explicit embedded dependencies.
The native profiler loads them too. Prism 1.30.0 has no Astro, Svelte, Vue or
MDX component. Those cells carry an explicit unsupported reason and no timing;
markup, JSX or Markdown is not substituted. The other 16 Prism components
use independent grammars and output structures, so their timings do not imply
TextMate-equivalent highlighting quality.

Use `bench:tiobe --corpus curated` for the same runner or `--language tsx
--sizes large` for a focused diagnostic. `compare-tiobe.mjs` accepts either
corpus and refuses comparisons across changed corpus, inputs, harness,
assets, machine, build flags or output. A large public-API slowdown identifies
a candidate for native-boundary/CPU profiling; it does not attribute all
runtime to Ferroni or prove that a compiler optimization will help.
