# Ferriki Blacksmith comparison: linux-x86-64

Commit: 2b16844ed26da3d58a8198e362cd467f777bea7d. Runner: blacksmith-4vcpu-ubuntu-2404. CPU: AMD EPYC. Node: v24.21.0.
Corpus scope: curated.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |
| JSON | example | 0.165 | 0.147 | -10.92% |
| JSON | large | 2.587 | 2.296 | -11.23% |
| Astro | example | 1.358 | 1.970 | 45.04% |
| Astro | large | 15.676 | 22.807 | 45.49% |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| curated / TypeScript / example | on | 0.801 | 3.538 | 4.384 |
| curated / TypeScript / large | on | 11.201 | 55.273 | 68.118 |
| curated / TSX / example | on | 0.952 | 4.073 | 3.928 |
| curated / TSX / large | on | 13.682 | 64.670 | 61.284 |
| curated / Rust / example | on | 0.220 | 1.251 | 0.592 |
| curated / Rust / large | on | 2.936 | 18.664 | 8.021 |
| curated / CSS / example | on | 0.346 | 2.432 | 0.650 |
| curated / CSS / large | on | 4.541 | 37.331 | 9.084 |
| curated / HTML / example | on | 0.714 | 3.304 | 2.501 |
| curated / HTML / large | on | 9.812 | 52.206 | 38.801 |
| curated / C++ / example | on | 0.538 | 2.658 | 2.639 |
| curated / C++ / large | on | 6.804 | 40.152 | 38.729 |
| curated / Swift / example | on | 0.284 | 1.452 | 0.887 |
| curated / Swift / large | on | 3.371 | 21.699 | 12.155 |
| curated / Java / example | on | 0.243 | 1.101 | 0.721 |
| curated / Java / large | on | 2.963 | 16.192 | 10.165 |
| curated / Markdown / example | on | 0.384 | 1.148 | 1.563 |
| curated / Markdown / large | on | 4.423 | 16.931 | 22.985 |
| curated / TOML / example | on | 0.095 | 0.214 | 0.173 |
| curated / TOML / large | on | 1.311 | 3.288 | 2.654 |
| curated / YAML / example | on | 1.591 | 1.286 | invalid |
| curated / YAML / large | on | 24.083 | 19.144 | invalid |
| curated / JSON / example | on | 0.165 | 0.345 | 0.299 |
| curated / JSON / large | on | 2.587 | 5.413 | 4.761 |
| curated / Astro / example | on | 1.358 | 4.293 | 3.860 |
| curated / Astro / large | on | 15.676 | 53.788 | 51.203 |
| curated / Svelte / example | on | 1.245 | 4.435 | 4.588 |
| curated / Svelte / large | on | 17.246 | 69.157 | 71.903 |
| curated / Ruby / example | on | 0.244 | 1.594 | 0.808 |
| curated / Ruby / large | on | 2.798 | 24.320 | 10.936 |
| curated / Python / example | on | 0.335 | 1.631 | 0.983 |
| curated / Python / large | on | 4.192 | 24.426 | 13.740 |
| curated / Vue / example | on | 0.672 | 2.023 | 2.133 |
| curated / Vue / large | on | 9.018 | 32.022 | 33.245 |
| curated / MDX / example | on | 0.453 | 1.753 | 2.354 |
| curated / MDX / large | on | 5.437 | 27.152 | 36.664 |
| curated / SCSS / example | on | 0.278 | 2.556 | 0.646 |
| curated / SCSS / large | on | 3.228 | 39.704 | 8.757 |
| curated / Bash / example | on | 0.342 | 0.972 | 0.697 |
| curated / Bash / large | on | 4.243 | 13.711 | 9.502 |
| curated / TypeScript / example | off | 1.721 | 3.541 | 4.410 |
| curated / TypeScript / large | off | 25.908 | 55.536 | 68.276 |
| curated / TSX / example | off | 1.910 | 4.081 | 3.914 |
| curated / TSX / large | off | 28.638 | 64.271 | 60.648 |
| curated / Rust / example | off | 0.254 | 1.251 | 0.583 |
| curated / Rust / large | off | 3.386 | 18.806 | 7.968 |
| curated / CSS / example | off | 0.331 | 2.420 | 0.649 |
| curated / CSS / large | off | 4.092 | 37.268 | 9.473 |
| curated / HTML / example | off | 1.108 | 3.311 | 2.524 |
| curated / HTML / large | off | 15.892 | 52.533 | 39.034 |
| curated / C++ / example | off | 1.098 | 2.641 | 2.639 |
| curated / C++ / large | off | 15.793 | 40.684 | 39.518 |
| curated / Swift / example | off | 0.431 | 1.453 | 0.882 |
| curated / Swift / large | off | 5.391 | 21.824 | 12.159 |
| curated / Java / example | off | 0.325 | 1.107 | 0.729 |
| curated / Java / large | off | 3.985 | 16.042 | 9.898 |
| curated / Markdown / example | off | 0.485 | 1.139 | 1.544 |
| curated / Markdown / large | off | 5.913 | 16.546 | 22.822 |
| curated / TOML / example | off | 0.093 | 0.207 | 0.168 |
| curated / TOML / large | off | 1.299 | 3.129 | 2.521 |
| curated / YAML / example | off | 1.197 | 1.270 | invalid |
| curated / YAML / large | off | 17.892 | 19.136 | invalid |
| curated / JSON / example | off | 0.147 | 0.345 | 0.297 |
| curated / JSON / large | off | 2.296 | 5.400 | 4.680 |
| curated / Astro / example | off | 1.970 | 4.319 | 3.904 |
| curated / Astro / large | off | 22.807 | 54.012 | 51.172 |
| curated / Svelte / example | off | 2.043 | 4.556 | 4.611 |
| curated / Svelte / large | off | 30.138 | 70.181 | 71.223 |
| curated / Ruby / example | off | 0.315 | 1.598 | 0.815 |
| curated / Ruby / large | off | 3.730 | 24.088 | 10.717 |
| curated / Python / example | off | 0.406 | 1.627 | 0.972 |
| curated / Python / large | off | 5.061 | 24.239 | 13.359 |
| curated / Vue / example | off | 1.212 | 2.050 | 2.154 |
| curated / Vue / large | off | 17.666 | 31.522 | 33.788 |
| curated / MDX / example | off | 0.693 | 1.748 | 2.351 |
| curated / MDX / large | off | 8.716 | 26.236 | 35.250 |
| curated / SCSS / example | off | 0.344 | 2.545 | 0.651 |
| curated / SCSS / large | off | 4.063 | 39.385 | 8.766 |
| curated / Bash / example | off | 0.394 | 0.959 | 0.690 |
| curated / Bash / large | off | 4.929 | 13.799 | 9.743 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
