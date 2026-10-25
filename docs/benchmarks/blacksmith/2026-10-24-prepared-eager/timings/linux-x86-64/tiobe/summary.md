# Ferriki Blacksmith comparison: linux-x86-64

Commit: 2b16844ed26da3d58a8198e362cd467f777bea7d. Runner: blacksmith-4vcpu-ubuntu-2404. CPU: AMD EPYC. Node: v24.21.0.
Corpus scope: tiobe.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| tiobe / Python / example | on | 0.383 | 1.855 | 1.165 |
| tiobe / Python / large | on | 4.823 | 27.491 | 16.221 |
| tiobe / C / example | on | 0.312 | 1.910 | 1.183 |
| tiobe / C / large | on | 4.279 | 35.116 | 22.692 |
| tiobe / C++ / example | on | 0.605 | 2.972 | 3.033 |
| tiobe / C++ / large | on | 7.754 | 45.712 | 44.771 |
| tiobe / Java / example | on | 0.277 | 1.251 | 0.863 |
| tiobe / Java / large | on | 3.379 | 18.060 | 12.018 |
| tiobe / C# / example | on | 0.428 | 1.408 | 1.938 |
| tiobe / C# / large | on | 5.143 | 20.244 | 28.034 |
| tiobe / JavaScript / example | on | 0.987 | 5.060 | 5.292 |
| tiobe / JavaScript / large | on | 14.057 | 79.737 | 82.250 |
| tiobe / Visual Basic / example | on | 0.376 | 1.124 | 0.509 |
| tiobe / Visual Basic / large | on | 4.839 | 16.468 | 7.136 |
| tiobe / SQL / example | on | 6.125 | 2.337 | 0.608 |
| tiobe / SQL / large | on | 95.304 | 34.624 | 7.687 |
| tiobe / R / example | on | 0.259 | 1.717 | 0.937 |
| tiobe / R / large | on | 3.336 | 25.413 | 12.757 |
| tiobe / Rust / example | on | 0.249 | 1.428 | 0.699 |
| tiobe / Rust / large | on | 3.347 | 21.725 | 9.512 |
| tiobe / Fortran / example | on | 0.557 | 1.989 | 1.370 |
| tiobe / Fortran / large | on | 7.319 | 30.233 | 19.350 |
| tiobe / Go / example | on | 0.343 | 1.516 | 0.796 |
| tiobe / Go / large | on | 4.138 | 22.626 | 10.794 |
| tiobe / Delphi/Object Pascal / example | on | 0.213 | 0.872 | 0.314 |
| tiobe / Delphi/Object Pascal / large | on | 2.820 | 13.372 | 4.391 |
| tiobe / PHP / example | on | 0.299 | 1.897 | 0.904 |
| tiobe / PHP / large | on | 3.586 | 28.267 | 11.329 |
| tiobe / Assembly language / example | on | 0.189 | 2.495 | 0.997 |
| tiobe / Assembly language / large | on | 1.920 | 38.360 | 13.411 |
| tiobe / Ada / example | on | 0.304 | 0.870 | 0.611 |
| tiobe / Ada / large | on | 3.734 | 12.024 | 7.987 |
| tiobe / Swift / example | on | 0.328 | 1.657 | 1.058 |
| tiobe / Swift / large | on | 4.032 | 24.724 | 14.622 |
| tiobe / Objective-C / example | on | 0.319 | 2.000 | 1.093 |
| tiobe / Objective-C / large | on | 4.031 | 30.685 | 15.284 |
| tiobe / COBOL / example | on | 0.921 | 4.018 | 0.868 |
| tiobe / COBOL / large | on | 12.594 | 61.814 | 11.513 |
| tiobe / Python / example | off | 0.467 | 1.842 | 1.138 |
| tiobe / Python / large | off | 5.889 | 27.304 | 15.528 |
| tiobe / C / example | off | 0.555 | 1.928 | 1.201 |
| tiobe / C / large | off | 7.136 | 28.588 | 16.175 |
| tiobe / C++ / example | off | 1.270 | 3.037 | 3.034 |
| tiobe / C++ / large | off | 18.176 | 45.723 | 45.029 |
| tiobe / Java / example | off | 0.374 | 1.245 | 0.853 |
| tiobe / Java / large | off | 4.641 | 18.065 | 11.814 |
| tiobe / C# / example | off | 1.064 | 1.443 | 1.989 |
| tiobe / C# / large | off | 15.244 | 20.819 | 28.642 |
| tiobe / JavaScript / example | off | 2.368 | 5.101 | 5.362 |
| tiobe / JavaScript / large | off | 35.793 | 80.285 | 83.191 |
| tiobe / Visual Basic / example | off | 0.373 | 1.144 | 0.514 |
| tiobe / Visual Basic / large | off | 5.016 | 16.845 | 7.144 |
| tiobe / SQL / example | off | 0.375 | 2.318 | 0.588 |
| tiobe / SQL / large | off | 4.746 | 35.416 | 7.952 |
| tiobe / R / example | off | 0.314 | 1.683 | 0.908 |
| tiobe / R / large | off | 3.990 | 25.397 | 12.581 |
| tiobe / Rust / example | off | 0.296 | 1.457 | 0.728 |
| tiobe / Rust / large | off | 3.961 | 21.732 | 9.984 |
| tiobe / Fortran / example | off | 0.722 | 2.044 | 1.402 |
| tiobe / Fortran / large | off | 9.594 | 30.546 | 20.879 |
| tiobe / Go / example | off | 0.513 | 1.566 | 0.837 |
| tiobe / Go / large | off | 6.651 | 23.254 | 10.843 |
| tiobe / Delphi/Object Pascal / example | off | 0.168 | 0.902 | 0.337 |
| tiobe / Delphi/Object Pascal / large | off | 2.276 | 13.567 | 4.651 |
| tiobe / PHP / example | off | 0.450 | 1.920 | 0.916 |
| tiobe / PHP / large | off | 5.515 | 28.791 | 11.669 |
| tiobe / Assembly language / example | off | 0.370 | 2.514 | 1.017 |
| tiobe / Assembly language / large | off | 4.458 | 38.276 | 13.485 |
| tiobe / Ada / example | off | 0.308 | 0.867 | 0.615 |
| tiobe / Ada / large | off | 4.107 | 12.244 | 8.596 |
| tiobe / Swift / example | off | 0.500 | 1.665 | 1.057 |
| tiobe / Swift / large | off | 6.361 | 25.816 | 14.396 |
| tiobe / Objective-C / example | off | 0.544 | 2.012 | 1.092 |
| tiobe / Objective-C / large | off | 6.844 | 30.340 | 15.268 |
| tiobe / COBOL / example | off | 0.919 | 4.000 | 0.897 |
| tiobe / COBOL / large | off | 12.755 | 61.763 | 11.712 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
