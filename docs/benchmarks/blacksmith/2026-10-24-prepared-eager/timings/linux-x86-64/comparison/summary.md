# Ferriki Blacksmith comparison: linux-x86-64

Commit: 2b16844ed26da3d58a8198e362cd467f777bea7d. Runner: blacksmith-4vcpu-ubuntu-2404. CPU: Intel(R) Xeon(R) Processor. Node: v24.21.0.
Corpus scope: comparison.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| Repository / warm total | on | 128.554 | 311.100 | unsupported |
| Repository / cold total | on | 876.575 | 1027.244 | unsupported |
| Repository / warm total | off | 124.932 | 311.685 | unsupported |
| Repository / cold total | off | 228.848 | 1022.893 | unsupported |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
