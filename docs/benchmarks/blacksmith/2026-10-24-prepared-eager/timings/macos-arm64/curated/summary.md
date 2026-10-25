# Ferriki Blacksmith comparison: macos-arm64

Commit: 2b16844ed26da3d58a8198e362cd467f777bea7d. Runner: blacksmith-6vcpu-macos-26. CPU: Apple M4 Pro (Virtual). Node: v24.21.0.
Corpus scope: curated.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |
| JSON | example | 0.145 | 0.117 | -19.40% |
| JSON | large | 2.270 | 1.799 | -20.73% |
| Astro | example | 1.648 | 1.725 | 4.69% |
| Astro | large | 14.161 | 20.190 | 42.58% |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| curated / TypeScript / example | on | 1.126 | 4.431 | 6.549 |
| curated / TypeScript / large | on | 11.554 | 63.605 | 93.087 |
| curated / TSX / example | on | 1.064 | 4.693 | 5.031 |
| curated / TSX / large | on | 14.013 | 73.587 | 78.175 |
| curated / Rust / example | on | 0.179 | 1.239 | 0.505 |
| curated / Rust / large | on | 2.654 | 19.371 | 7.545 |
| curated / CSS / example | on | 0.293 | 2.803 | 0.575 |
| curated / CSS / large | on | 3.626 | 39.107 | 7.279 |
| curated / HTML / example | on | 0.577 | 3.239 | 2.320 |
| curated / HTML / large | on | 8.258 | 50.762 | 36.082 |
| curated / C++ / example | on | 0.420 | 2.610 | 2.141 |
| curated / C++ / large | on | 5.224 | 38.737 | 32.328 |
| curated / Swift / example | on | 0.208 | 1.401 | 0.750 |
| curated / Swift / large | on | 3.063 | 22.905 | 11.672 |
| curated / Java / example | on | 0.207 | 1.118 | 0.709 |
| curated / Java / large | on | 3.071 | 18.303 | 11.645 |
| curated / Markdown / example | on | 0.501 | 1.484 | 2.153 |
| curated / Markdown / large | on | 4.326 | 19.855 | 29.134 |
| curated / TOML / example | on | 0.093 | 0.209 | 0.158 |
| curated / TOML / large | on | 1.368 | 3.189 | 2.355 |
| curated / YAML / example | on | 1.377 | 1.392 | invalid |
| curated / YAML / large | on | 21.142 | 21.270 | invalid |
| curated / JSON / example | on | 0.145 | 0.320 | 0.261 |
| curated / JSON / large | on | 2.270 | 5.070 | 4.058 |
| curated / Astro / example | on | 1.648 | 5.400 | 5.235 |
| curated / Astro / large | on | 14.161 | 60.977 | 59.040 |
| curated / Svelte / example | on | 1.459 | 5.094 | 5.798 |
| curated / Svelte / large | on | 15.806 | 73.827 | 85.676 |
| curated / Ruby / example | on | 0.205 | 1.792 | 0.816 |
| curated / Ruby / large | on | 2.863 | 28.949 | 12.876 |
| curated / Python / example | on | 0.319 | 1.642 | 0.971 |
| curated / Python / large | on | 4.096 | 26.531 | 14.328 |
| curated / Vue / example | on | 0.652 | 2.129 | 2.374 |
| curated / Vue / large | on | 8.138 | 31.188 | 34.696 |
| curated / MDX / example | on | 0.360 | 1.663 | 2.456 |
| curated / MDX / large | on | 4.790 | 26.991 | 43.604 |
| curated / SCSS / example | on | 0.361 | 3.132 | 0.666 |
| curated / SCSS / large | on | 3.174 | 47.158 | 8.024 |
| curated / Bash / example | on | 0.266 | 0.870 | 0.583 |
| curated / Bash / large | on | 3.840 | 13.185 | 8.781 |
| curated / TypeScript / example | off | 1.854 | 3.944 | 5.665 |
| curated / TypeScript / large | off | 25.777 | 56.680 | 82.881 |
| curated / TSX / example | off | 2.048 | 4.568 | 4.932 |
| curated / TSX / large | off | 28.304 | 65.733 | 70.085 |
| curated / Rust / example | off | 0.207 | 1.202 | 0.503 |
| curated / Rust / large | off | 3.061 | 18.609 | 7.613 |
| curated / CSS / example | off | 0.277 | 2.844 | 0.573 |
| curated / CSS / large | off | 3.914 | 45.905 | 8.455 |
| curated / HTML / example | off | 1.196 | 3.884 | 2.871 |
| curated / HTML / large | off | 16.822 | 60.323 | 43.164 |
| curated / C++ / example | off | 0.892 | 2.594 | 2.135 |
| curated / C++ / large | off | 12.663 | 38.932 | 32.031 |
| curated / Swift / example | off | 0.305 | 1.286 | 0.665 |
| curated / Swift / large | off | 4.536 | 19.692 | 9.856 |
| curated / Java / example | off | 0.218 | 0.935 | 0.586 |
| curated / Java / large | off | 3.222 | 14.210 | 8.807 |
| curated / Markdown / example | off | 0.303 | 0.920 | 1.303 |
| curated / Markdown / large | off | 4.386 | 13.928 | 20.260 |
| curated / TOML / example | off | 0.072 | 0.172 | 0.128 |
| curated / TOML / large | off | 1.040 | 2.588 | 1.896 |
| curated / YAML / example | off | 0.939 | 1.140 | invalid |
| curated / YAML / large | off | 14.745 | 18.322 | invalid |
| curated / JSON / example | off | 0.117 | 0.283 | 0.229 |
| curated / JSON / large | off | 1.799 | 4.431 | 3.568 |
| curated / Astro / example | off | 1.725 | 4.191 | 3.911 |
| curated / Astro / large | off | 20.190 | 50.943 | 50.839 |
| curated / Svelte / example | off | 1.831 | 4.367 | 5.021 |
| curated / Svelte / large | off | 27.192 | 66.663 | 76.417 |
| curated / Ruby / example | off | 0.203 | 1.486 | 0.634 |
| curated / Ruby / large | off | 3.014 | 23.163 | 9.705 |
| curated / Python / example | off | 0.274 | 1.360 | 0.749 |
| curated / Python / large | off | 4.092 | 21.009 | 11.334 |
| curated / Vue / example | off | 1.054 | 1.894 | 2.067 |
| curated / Vue / large | off | 16.068 | 28.566 | 32.005 |
| curated / MDX / example | off | 0.467 | 1.509 | 2.250 |
| curated / MDX / large | off | 6.669 | 22.501 | 35.039 |
| curated / SCSS / example | off | 0.224 | 2.563 | 0.478 |
| curated / SCSS / large | off | 3.313 | 40.291 | 7.034 |
| curated / Bash / example | off | 0.266 | 0.802 | 0.530 |
| curated / Bash / large | off | 4.004 | 12.231 | 8.074 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
