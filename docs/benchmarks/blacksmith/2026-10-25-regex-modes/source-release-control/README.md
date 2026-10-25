# Local source-path release control

Two serial captures on one local macOS ARM64 machine compare the published `@ferriki/darwin-arm64@1.1.2` addon with the repository native build at `bcceeea`. The release tarball was downloaded from npm and matched its recorded SHA-512 integrity before extraction. The 1.1.2 source release locks Ferroni 2.2.3; the current build uses 2.7.0. Native binary hashes and the current complete build receipt are in the raw captures.

All 20 curated formats use identical current custom grammar/theme registrations in both binaries, at example and 16-copy large sizes. The native `codeToHtml` output must match exactly in every lane. Each language has its own process; five lanes rotate in warm measurement rounds after five warm-ups. Samples run for at least 30 rounds and a 300 ms per-lane budget, capped at 1,000 rounds. This isolates source paths from standard prepared packages and download behavior.

This is a diagnostic, not a compiler-controlled Ferroni upgrade experiment. The published binary and local binary can differ in compiler and build environment. It does not measure facade overhead, cold startup, CDN behavior or all TIOBE languages. Old Auto/Off are compared with equivalent source policies; current Eager is observed without claiming an equivalent historical Eager baseline.

Several small slowdowns repeat, including about 6% on TOML Auto. Some cases improve. These differences remain investigation targets; this capture does not establish that all classic paths are regression-free or identify the cause.

Times below are run A medians in milliseconds; changes show A / B, current relative to released 1.1.2. Positive means slower. Full raw sample distributions are retained in `released-a.json.gz` and `released-b.json.gz`.

| Format / size | Old Auto | Current Auto | Auto change A / B | Off change A / B | Current Eager |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript / example | 0.932 | 0.959 | +2.8% / +2.0% | +2.8% / +3.7% | 0.940 |
| TypeScript / large | 12.978 | 13.425 | +3.4% / +2.5% | +4.3% / +3.4% | 13.399 |
| TSX / example | 1.130 | 1.143 | +1.2% / +2.6% | +2.6% / +2.9% | 1.132 |
| TSX / large | 15.838 | 16.365 | +3.3% / +3.1% | +3.5% / +2.8% | 16.319 |
| Rust / example | 0.193 | 0.198 | +2.3% / +2.6% | +3.1% / +3.4% | 0.197 |
| Rust / large | 3.072 | 3.165 | +3.0% / +2.7% | +3.1% / +2.8% | 3.164 |
| CSS / example | 0.311 | 0.316 | +1.8% / +2.4% | -10.4% / -10.6% | 0.311 |
| CSS / large | 4.722 | 4.855 | +2.8% / +3.1% | -11.3% / -11.2% | 4.841 |
| HTML / example | 0.821 | 0.830 | +1.0% / +0.7% | -0.2% / -0.4% | 0.821 |
| HTML / large | 10.891 | 11.128 | +2.2% / +3.0% | +0.7% / -0.0% | 11.209 |
| C++ / example | 0.659 | 0.619 | -6.1% / -5.6% | -11.0% / -12.0% | 0.610 |
| C++ / large | 7.495 | 7.554 | +0.8% / +1.2% | -4.0% / -2.8% | 7.458 |
| Swift / example | 0.274 | 0.275 | +0.5% / +0.1% | -1.0% / -1.3% | 0.267 |
| Swift / large | 3.961 | 4.085 | +3.1% / +3.3% | +0.1% / +0.6% | 3.976 |
| Java / example | 0.224 | 0.227 | +1.3% / +1.8% | +3.1% / +3.1% | 0.224 |
| Java / large | 3.330 | 3.444 | +3.4% / +3.9% | +3.8% / +3.2% | 3.419 |
| Markdown / example | 0.367 | 0.374 | +1.9% / +0.7% | +1.3% / +1.5% | 0.365 |
| Markdown / large | 4.449 | 4.661 | +4.8% / +4.1% | +5.0% / +3.6% | 4.647 |
| TOML / example | 0.095 | 0.100 | +5.9% / +5.8% | +5.6% / +5.5% | 0.102 |
| TOML / large | 1.460 | 1.546 | +5.9% / +6.3% | +5.3% / +5.3% | 1.578 |
| YAML / example | 1.884 | 1.807 | -4.1% / -5.3% | -9.1% / -9.4% | 1.793 |
| YAML / large | 29.565 | 27.187 | -8.0% / -7.6% | -10.6% / -11.6% | 27.158 |
| JSON / example | 0.159 | 0.165 | +3.5% / +3.8% | +2.9% / +3.2% | 0.182 |
| JSON / large | 2.504 | 2.591 | +3.5% / +4.1% | +2.4% / +3.1% | 2.849 |
| Astro / example | 1.516 | 1.513 | -0.2% / -0.5% | +1.2% / +3.3% | 1.793 |
| Astro / large | 17.784 | 17.920 | +0.8% / +0.7% | +1.9% / +1.9% | 22.545 |
| Svelte / example | 1.451 | 1.471 | +1.4% / +0.4% | +1.3% / +2.2% | 1.622 |
| Svelte / large | 20.748 | 20.503 | -1.2% / +2.0% | +1.0% / +2.3% | 23.319 |
| Ruby / example | 0.199 | 0.202 | +1.9% / +1.7% | +2.8% / +2.7% | 0.204 |
| Ruby / large | 3.041 | 3.172 | +4.3% / +2.8% | +3.5% / +2.7% | 3.188 |
| Python / example | 0.304 | 0.314 | +3.4% / +3.7% | +2.8% / +3.9% | 0.309 |
| Python / large | 4.648 | 4.822 | +3.7% / +3.4% | +2.8% / +4.0% | 4.815 |
| Vue / example | 0.834 | 0.850 | +1.9% / +1.8% | +2.3% / +2.6% | 0.824 |
| Vue / large | 10.679 | 10.941 | +2.5% / +3.6% | +3.5% / +2.4% | 10.967 |
| MDX / example | 0.488 | 0.499 | +2.2% / +2.4% | +2.2% / +2.1% | 0.478 |
| MDX / large | 5.844 | 6.101 | +4.4% / +3.2% | +2.8% / +2.8% | 5.890 |
| SCSS / example | 0.257 | 0.259 | +0.7% / +1.1% | +1.8% / +1.6% | 0.257 |
| SCSS / large | 3.969 | 4.106 | +3.5% / +3.1% | +2.0% / +2.5% | 4.094 |
| Bash / example | 0.373 | 0.370 | -0.8% / +1.7% | -2.5% / +1.0% | 0.366 |
| Bash / large | 5.188 | 5.291 | +2.0% / +2.4% | -0.7% / +1.6% | 5.261 |

`compare.mjs` is the exact diagnostic program used. It takes the repository root and an output tag, expects the verified baseline extracted at its recorded temporary path, and writes raw JSON under that same temporary directory. Materialize current standard grammar sources and build the current release addon before reproducing. The program is archived evidence, not an additional production benchmark entry point.
