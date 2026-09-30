# Curated 20-format baseline: Ferroni 1.7.0

## Scope and provenance

Two sequential full runs on Apple M1 Ultra, macOS 27.0, Node 24.21.0,
Rust 1.96.0 compare Ferriki 0.7.0, Shiki 4.4.3 (WASM and strict JavaScript)
and Prism 1.30.0. Ferriki is fixed at `580d5b5`; Ferroni is fixed at merged
PR #203, `16af64c`. Both runtime Git states are clean. The native build
receipt records only the temporary local-patch `Cargo.lock` change; the
lockfile was restored before measuring. The ordinary release profile uses
fat LTO, one codegen unit and stripped symbols, without environment overrides.
No Rust builds, tests or other benchmark processes ran concurrently.

The default shared harness uses five warmup calls, at least 30 measured
rounds, a 300 ms shared budget per engine, and rotating engine order. Each
format runs in a fresh process. Each format has one original fixture and a
larger synthetic document of 16 copies; bytes, lines and hashes are retained.
All 20 formats in both sizes preserve source and match exact tokens/HTML
across Ferriki and both Shiki engines. All 16 supported Prism components
preserve source; Astro, Svelte, Vue and MDX remain explicitly unsupported.

## Large-document medians

Each range below retains the medians of the two complete runs, in milliseconds
per document. It is not a confidence interval or a selected best run. Raw
samples, p95, min/max and MiB/s for both sizes remain in the compressed reports.
Prism uses different grammars and output structures; its low timings do not
establish TextMate-equivalent highlighting quality.

### Html

| Format     | Bytes |     Ferriki |  Shiki WASM |      Shiki JS |       Prism |
| ---------- | ----: | ----------: | ----------: | ------------: | ----------: |
| TypeScript | 19248 | 27.81–28.78 | 45.16–46.49 | 132.90–137.29 |   3.53–3.59 |
| TSX        | 25088 | 28.15–28.23 | 42.02–42.26 | 105.21–105.66 |   5.97–5.97 |
| Rust       | 15440 | 13.92–14.00 | 28.93–29.09 |   20.43–20.52 |   1.71–1.72 |
| CSS        | 17216 | 23.10–23.46 | 29.26–29.38 |   10.09–10.69 |   1.46–1.46 |
| HTML       | 22352 | 28.51–29.43 | 36.36–37.60 |   58.77–60.42 |   3.64–3.68 |
| C++        | 14992 | 82.78–84.16 | 58.50–60.17 | 103.05–105.58 |   1.70–1.75 |
| Swift      | 15504 | 16.85–17.09 | 33.01–33.33 |   22.83–23.67 |   1.50–1.53 |
| Java       | 17856 | 23.12–23.39 | 24.21–24.61 |   20.95–21.17 |   1.87–1.94 |
| Markdown   | 16304 | 15.47–15.79 | 23.43–23.53 |   47.71–47.90 |   3.25–3.29 |
| TOML       |  9696 |   5.60–5.65 |   4.03–4.03 |     3.02–3.02 |   0.70–0.71 |
| YAML       | 12592 |   8.71–8.84 |   9.09–9.11 |     7.41–7.49 |   0.91–0.93 |
| JSON       | 12176 |   9.85–9.87 |   6.94–7.02 |     6.15–6.18 |   1.17–1.17 |
| Astro      | 17296 | 26.69–29.25 | 47.80–51.65 |   77.45–86.38 | unsupported |
| Svelte     | 16992 | 34.31–37.56 | 64.89–99.55 | 114.40–180.91 | unsupported |
| Ruby       | 13696 | 13.91–14.54 | 39.46–54.32 |   33.40–43.07 |   1.84–1.90 |
| Python     | 21824 | 15.93–16.89 | 36.42–38.44 |   27.57–59.21 |   2.22–2.28 |
| Vue        | 20960 | 29.28–36.98 | 46.43–75.13 |  68.74–137.54 | unsupported |
| MDX        | 17200 | 24.01–24.79 | 37.51–37.62 |   89.80–91.26 | unsupported |
| SCSS       | 13696 | 43.37–44.29 | 63.11–63.93 |   13.22–13.38 |   2.82–2.86 |
| Bash       | 16176 | 14.52–14.64 | 19.56–20.74 |   14.70–15.14 |   1.95–2.09 |

### Tokens

| Format     | Bytes |       Ferriki |   Shiki WASM |      Shiki JS |       Prism |
| ---------- | ----: | ------------: | -----------: | ------------: | ----------: |
| TypeScript | 19248 |   47.18–48.60 |  40.58–40.61 | 126.69–131.15 |   2.32–2.34 |
| TSX        | 25088 |   47.80–48.75 |  35.63–36.84 |  99.39–101.13 |   3.89–4.03 |
| Rust       | 15440 |   18.28–18.34 |  24.23–24.38 |   16.15–16.46 |   0.83–0.84 |
| CSS        | 17216 |   29.36–29.40 |  24.30–24.72 |     5.65–5.74 |   0.65–0.65 |
| HTML       | 22352 |   42.00–42.03 |  30.89–31.31 |   53.97–54.19 |   1.97–1.99 |
| C++        | 14992 | 148.58–149.09 |  55.54–55.58 |   98.82–99.78 |   0.87–0.88 |
| Swift      | 15504 |   24.55–25.32 |  28.68–29.92 |   18.79–19.22 |   0.66–0.68 |
| Java       | 17856 |   38.39–38.75 |  21.10–21.22 |   17.70–18.10 |   0.91–0.92 |
| Markdown   | 16304 |   23.57–23.70 |  20.00–20.01 |   44.18–44.72 |   2.65–2.66 |
| TOML       |  9696 |     8.18–8.33 |    2.28–2.29 |     1.28–1.29 |   0.25–0.25 |
| YAML       | 12592 |   17.92–18.05 |    6.76–6.88 |     5.06–5.18 |   0.49–0.49 |
| JSON       | 12176 |   15.70–15.81 |    3.96–3.98 |     3.10–3.22 |   0.43–0.43 |
| Astro      | 17296 |   37.03–41.71 |  44.52–51.70 |   75.18–87.15 | unsupported |
| Svelte     | 16992 |  57.83–108.59 | 59.91–130.19 | 109.59–302.07 | unsupported |
| Ruby       | 13696 |   20.91–20.98 |  36.28–37.58 |   29.85–30.26 |   0.98–1.00 |
| Python     | 21824 |   22.84–25.42 |  32.65–38.60 |   23.59–24.54 |   1.24–1.27 |
| Vue        | 20960 |   48.27–52.94 |  40.95–43.32 |   63.54–67.94 | unsupported |
| MDX        | 17200 |   37.09–37.40 |  32.61–33.37 |   84.68–86.19 | unsupported |
| SCSS       | 13696 |   78.34–82.85 |  59.26–60.97 |    9.93–10.02 |   2.16–2.17 |
| Bash       | 16176 |   23.39–23.63 |  16.69–16.83 |   11.44–11.48 |   1.26–1.27 |

## Interpretation and counterexamples

- C++ remains the largest absolute native token cost: 148.6–149.1 ms versus
  55.5–55.6 ms for WASM. The existing [Ferroni scanner replay](https://github.com/sebastian-software/ferroni/tree/16af64c93e6ecf1cb6786d04a1f434b23bd21716/benches/cpp_scanner)
  independently locates its regex bottleneck and group-78 fallback searches.
- JSON (3.95–3.99×) and TOML (3.57–3.65×) have greater token ratios to WASM.
  Native profiling below attributes much of their cost to TextMate/scopes,
  serialization and rendering, rather than a large regex-VM bottleneck.
- SCSS is a stronger new Ferroni candidate: 78.3–82.9 ms tokens versus
  9.9–10.0 ms for Shiki JS, while HTML is 43.4–44.3 ms versus 13.2–13.4 ms.
  Its native HTML profile spends about 73% in Ferroni and 68% in the VM.
  CSS has a smaller related gap, with about 36% in Ferroni and 33% in the VM.
- Run 2 has large tails in several formats and engines. In particular Svelte
  tokens reach 108.6 ms median and 302.0 ms p95, while WASM also becomes slower.
  A fresh focused run measures 59.2 ms native median versus 60.5 ms WASM, but
  both still have p95 around 112 ms. Vue repeats at 29.1 ms HTML / 48.4 ms
  tokens, close to run 1. TOML repeats at 5.65 / 8.18 ms with p95 6.02 / 8.55 ms.
  The unstable rows and every repeat are retained; these observations do not
  isolate their tail cause or establish an engine regression.

The next targeted compiler experiment should derive an SCSS scanner replay
and identify its expensive patterns/VM instructions before changing compiler
lowering. C++ remains a separate, validated fallback-search target. Original
grammar expressions stay unchanged. Broader Ferriki token costs, including
[duplicated scoped scanning](https://github.com/sebastian-software/ferriki/issues/172),
need their own highlighter changes. No runtime optimization is included here.

## CPU profiles

Separate release builds retain fat LTO and use line tables without stripping.
Each native workload validates exact output, warms five calls, then runs for
20 seconds; macOS `sample` attaches after the ready marker for ten seconds.
HTML omits scope requests; native tokens request scopes to reproduce the
public token API. These are diagnostic boundaries and sampled timings must
not be substituted for the ordinary-profile public medians above.

Inclusive shares of main-thread samples overlap and cannot be summed:

| Native workload    | Main samples | Ferroni | Regex VM | TextMate |  Theme | serde_json |
| ------------------ | -----------: | ------: | -------: | -------: | -----: | ---------: |
| json-native-html   |         5689 |   3.92% |    0.97% |   23.31% |  3.52% |     26.65% |
| toml-native-html   |         5410 |   7.97% |    3.33% |   23.72% |  3.09% |     25.21% |
| json-native-tokens |         5561 |   8.92% |    2.28% |   76.41% | 27.28% |      0.00% |
| toml-native-tokens |         6049 |  25.67% |   11.21% |   80.91% | 12.86% |      0.05% |
| scss-native-html   |         6630 |  73.42% |   68.30% |   78.25% |  0.90% |      7.53% |
| css-native-html    |         6157 |  36.06% |   32.91% |   47.23% |  2.05% |     17.98% |

JSON and TOML scoped-token samples also show both `tokenize_line` and
`tokenize_line2`; their scope/binary shares are retained in `cpu-summary.json`.
The profile identifies functions, not individual regex patterns, and is
specific to these fixtures and this machine.

## Retained artifacts and reproduction

- `baseline-{1,2}.json.gz`: complete 20 × 2 × 4 reports with every timing,
  setup/validation outcome, fixture hash, loaded-addon hash and build receipt.
- `{vue,svelte,toml}-repeat.json.gz`: fresh, focused large-document checks.
- `summary.json` and `run-comparison.json`: all large/small per-API medians
  and fixed-source run-to-run changes. Positive changes mean slower.
- `*-native-*.profile.json.gz`, `*.sample.txt.gz`, `*.profiler.log.gz`: raw
  diagnostic timings, profiler stacks/logs and symbolized build receipts.
- `cpu-summary.json`: main-thread inclusive categories and exclusive Rust symbols.

Run the complete ordinary baseline from `node/`:

```sh
FERRIKI_FERRONI_PATH=/absolute/path/to/ferroni-16af64c pnpm run build:native
pnpm run check:bench-curated
pnpm run bench:curated --write /tmp/curated-1.json
pnpm run bench:curated --write /tmp/curated-2.json
node scripts/compare-tiobe.mjs /tmp/curated-1.json /tmp/curated-2.json
```

For CPU recording, rebuild with `CARGO_PROFILE_RELEASE_DEBUG=line-tables-only`
and `CARGO_PROFILE_RELEASE_STRIP=none`. From the repository root on macOS:

```sh
python3 node/benchmarks/curated/results/ferroni-1.7.0/record-cpu.py \
  node scss /tmp/scss-native-html.sample.txt
python3 node/benchmarks/curated/results/ferroni-1.7.0/record-cpu.py \
  node json /tmp/json-native-tokens.sample.txt --api tokens --scopes
python3 node/benchmarks/curated/results/ferroni-1.7.0/summarize-cpu.py \
  node/benchmarks/curated/results/ferroni-1.7.0/*-native-*.sample.txt.gz
```

The profiler needs permission to inspect its own child process. Restore the
ordinary release addon before collecting comparative timings. The local
ordinary addon was restored and its hash matches the retained baseline.

Validation: the curated corpus correctness gate on registry Ferroni 1.6.1
and pinned local Ferroni 1.7.0; original TIOBE failure/timeout/comparison gate;
full mandatory supported-core compatibility gate; workspace lint, typecheck
and formatting; workflow pins and ADR checks; JSON/TOML fixture parsing and
Bash syntax; profile output validation, sample-tree invariants and raw artifact
checks. No runtime engine code, dependencies or upstream mirrors changed.
