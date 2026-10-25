# Ferriki Blacksmith comparison: macos-arm64

Commit: 2b16844ed26da3d58a8198e362cd467f777bea7d. Runner: blacksmith-6vcpu-macos-26. CPU: Apple M4 Pro (Virtual). Node: v24.21.0.
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
| tiobe / Python / example | on | 0.385 | 1.777 | 1.039 |
| tiobe / Python / large | on | 3.877 | 25.063 | 13.854 |
| tiobe / C / example | on | 0.283 | 1.894 | 1.032 |
| tiobe / C / large | on | 3.437 | 29.166 | 15.921 |
| tiobe / C++ / example | on | 0.678 | 3.278 | 2.815 |
| tiobe / C++ / large | on | 5.927 | 47.387 | 41.058 |
| tiobe / Java / example | on | 0.207 | 1.088 | 0.712 |
| tiobe / Java / large | on | 2.931 | 17.285 | 10.960 |
| tiobe / C# / example | on | 0.370 | 1.299 | 2.010 |
| tiobe / C# / large | on | 4.342 | 19.594 | 32.210 |
| tiobe / JavaScript / example | on | 1.197 | 5.647 | 6.692 |
| tiobe / JavaScript / large | on | 12.433 | 84.863 | 100.544 |
| tiobe / Visual Basic / example | on | 0.335 | 1.175 | 0.412 |
| tiobe / Visual Basic / large | on | 4.694 | 18.160 | 6.095 |
| tiobe / SQL / example | on | 4.798 | 2.727 | 0.524 |
| tiobe / SQL / large | on | 83.691 | 44.524 | 7.334 |
| tiobe / R / example | on | 0.225 | 1.914 | 0.870 |
| tiobe / R / large | on | 2.713 | 28.267 | 12.479 |
| tiobe / Rust / example | on | 0.203 | 1.342 | 0.552 |
| tiobe / Rust / large | on | 2.491 | 19.027 | 7.510 |
| tiobe / Fortran / example | on | 0.574 | 1.947 | 1.266 |
| tiobe / Fortran / large | on | 5.768 | 27.949 | 17.980 |
| tiobe / Go / example | on | 0.304 | 1.458 | 0.667 |
| tiobe / Go / large | on | 3.478 | 21.843 | 8.995 |
| tiobe / Delphi/Object Pascal / example | on | 0.161 | 0.792 | 0.225 |
| tiobe / Delphi/Object Pascal / large | on | 2.573 | 13.127 | 3.482 |
| tiobe / PHP / example | on | 0.303 | 2.054 | 0.817 |
| tiobe / PHP / large | on | 3.007 | 30.176 | 10.658 |
| tiobe / Assembly language / example | on | 0.210 | 2.607 | 0.982 |
| tiobe / Assembly language / large | on | 1.830 | 42.154 | 13.648 |
| tiobe / Ada / example | on | 0.273 | 0.823 | 0.521 |
| tiobe / Ada / large | on | 3.334 | 12.128 | 7.123 |
| tiobe / Swift / example | on | 0.357 | 1.800 | 0.954 |
| tiobe / Swift / large | on | 3.442 | 26.199 | 14.112 |
| tiobe / Objective-C / example | on | 0.334 | 2.110 | 0.984 |
| tiobe / Objective-C / large | on | 3.287 | 30.896 | 13.304 |
| tiobe / COBOL / example | on | 0.855 | 4.664 | 0.740 |
| tiobe / COBOL / large | on | 11.761 | 73.786 | 9.572 |
| tiobe / Python / example | off | 0.355 | 1.607 | 0.937 |
| tiobe / Python / large | off | 4.630 | 24.290 | 13.410 |
| tiobe / C / example | off | 0.353 | 1.566 | 0.859 |
| tiobe / C / large | off | 5.549 | 26.591 | 14.021 |
| tiobe / C++ / example | off | 1.098 | 3.021 | 2.553 |
| tiobe / C++ / large | off | 16.107 | 50.728 | 43.344 |
| tiobe / Java / example | off | 0.336 | 1.232 | 0.806 |
| tiobe / Java / large | off | 4.017 | 18.570 | 11.810 |
| tiobe / C# / example | off | 1.066 | 1.559 | 2.463 |
| tiobe / C# / large | off | 12.712 | 19.004 | 31.639 |
| tiobe / JavaScript / example | off | 2.544 | 5.940 | 7.106 |
| tiobe / JavaScript / large | off | 33.126 | 78.590 | 93.176 |
| tiobe / Visual Basic / example | off | 0.269 | 1.040 | 0.352 |
| tiobe / Visual Basic / large | off | 4.106 | 16.973 | 5.727 |
| tiobe / SQL / example | off | 0.314 | 2.577 | 0.456 |
| tiobe / SQL / large | off | 4.052 | 39.486 | 6.128 |
| tiobe / R / example | off | 0.235 | 1.682 | 0.748 |
| tiobe / R / large | off | 2.917 | 24.242 | 10.065 |
| tiobe / Rust / example | off | 0.189 | 1.121 | 0.471 |
| tiobe / Rust / large | off | 2.917 | 17.814 | 7.462 |
| tiobe / Fortran / example | off | 0.538 | 1.749 | 1.133 |
| tiobe / Fortran / large | off | 6.760 | 25.637 | 15.729 |
| tiobe / Go / example | off | 0.389 | 1.387 | 0.617 |
| tiobe / Go / large | off | 5.213 | 20.118 | 8.230 |
| tiobe / Delphi/Object Pascal / example | off | 0.114 | 0.741 | 0.209 |
| tiobe / Delphi/Object Pascal / large | off | 1.759 | 11.648 | 3.103 |
| tiobe / PHP / example | off | 0.333 | 1.737 | 0.667 |
| tiobe / PHP / large | off | 4.420 | 27.659 | 10.139 |
| tiobe / Assembly language / example | off | 0.287 | 2.449 | 0.889 |
| tiobe / Assembly language / large | off | 3.608 | 35.574 | 11.722 |
| tiobe / Ada / example | off | 0.204 | 0.667 | 0.423 |
| tiobe / Ada / large | off | 2.904 | 10.626 | 6.551 |
| tiobe / Swift / example | off | 0.388 | 1.492 | 0.793 |
| tiobe / Swift / large | off | 5.059 | 23.551 | 11.323 |
| tiobe / Objective-C / example | off | 0.429 | 1.886 | 0.850 |
| tiobe / Objective-C / large | off | 5.420 | 28.519 | 12.261 |
| tiobe / COBOL / example | off | 0.849 | 4.627 | 0.713 |
| tiobe / COBOL / large | off | 11.372 | 72.641 | 9.232 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
