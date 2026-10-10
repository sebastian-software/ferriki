# Ferriki Blacksmith comparison: linux-x86-64

Commit: ad991d0d1cbcc8e5f24d5cbcc95d3468425323db. Runner: blacksmith-4vcpu-ubuntu-2404. CPU: AMD EPYC. Node: v24.21.0.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| Repository / warm total | on | 36.681 | 171.896 | 193.036 |
| Repository / cold total | on | 818.841 | 722.043 | 785.844 |
| Repository / warm total | off | 55.248 | 167.287 | 188.208 |
| Repository / cold total | off | 512.929 | 750.149 | 770.380 |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |
| JSON | example | 0.177 | 0.180 | 1.75% |
| JSON | large | 2.662 | 2.754 | 3.45% |
| Astro | example | 1.193 | 1.215 | 1.82% |
| Astro | large | 13.691 | 13.976 | 2.09% |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| curated / TypeScript / example | on | 0.559 | 2.078 | 4.812 |
| curated / TypeScript / large | on | 7.073 | 31.242 | 75.238 |
| curated / TSX / example | on | 0.614 | 2.013 | 3.885 |
| curated / TSX / large | on | 7.981 | 30.925 | 60.664 |
| curated / Rust / example | on | 0.272 | 1.270 | 1.149 |
| curated / Rust / large | on | 3.514 | 18.883 | 17.084 |
| curated / CSS / example | on | 0.409 | 1.379 | 0.622 |
| curated / CSS / large | on | 5.454 | 20.707 | 9.123 |
| curated / HTML / example | on | 0.657 | 1.780 | 2.523 |
| curated / HTML / large | on | 8.756 | 27.536 | 38.732 |
| curated / C++ / example | on | 0.655 | 2.541 | 4.373 |
| curated / C++ / large | on | 8.048 | 38.369 | 66.754 |
| curated / Swift / example | on | 0.376 | 1.472 | 1.266 |
| curated / Swift / large | on | 4.408 | 21.721 | 18.141 |
| curated / Java / example | on | 0.296 | 1.153 | 1.043 |
| curated / Java / large | on | 3.540 | 16.692 | 15.446 |
| curated / Markdown / example | on | 0.422 | 1.109 | 1.891 |
| curated / Markdown / large | on | 5.149 | 16.662 | 29.557 |
| curated / TOML / example | on | 0.111 | 0.221 | 0.180 |
| curated / TOML / large | on | 1.460 | 3.344 | 2.745 |
| curated / YAML / example | on | 0.218 | 0.453 | 0.397 |
| curated / YAML / large | on | 2.805 | 6.656 | 5.931 |
| curated / JSON / example | on | 0.177 | 0.362 | 0.341 |
| curated / JSON / large | on | 2.662 | 5.628 | 5.381 |
| curated / Astro / example | on | 1.193 | 2.746 | 3.541 |
| curated / Astro / large | on | 13.691 | 35.369 | 48.816 |
| curated / Svelte / example | on | 1.248 | 3.156 | 4.397 |
| curated / Svelte / large | on | 14.251 | 45.106 | 66.282 |
| curated / Ruby / example | on | 0.298 | 1.681 | 1.597 |
| curated / Ruby / large | on | 3.486 | 25.105 | 23.384 |
| curated / Python / example | on | 0.395 | 1.678 | 1.463 |
| curated / Python / large | on | 4.909 | 25.245 | 21.796 |
| curated / Vue / example | on | 0.613 | 2.113 | 2.778 |
| curated / Vue / large | on | 7.265 | 32.215 | 42.783 |
| curated / MDX / example | on | 0.537 | 1.694 | 3.292 |
| curated / MDX / large | on | 6.407 | 25.635 | 51.016 |
| curated / SCSS / example | on | 0.358 | 2.610 | 0.807 |
| curated / SCSS / large | on | 4.389 | 40.802 | 11.060 |
| curated / Bash / example | on | 0.396 | 1.028 | 0.860 |
| curated / Bash / large | on | 4.635 | 13.732 | 11.214 |
| curated / TypeScript / example | off | 0.869 | 2.066 | 4.650 |
| curated / TypeScript / large | off | 11.665 | 31.156 | 72.050 |
| curated / TSX / example | off | 0.884 | 2.017 | 3.903 |
| curated / TSX / large | off | 12.129 | 31.034 | 61.050 |
| curated / Rust / example | off | 0.309 | 1.274 | 1.158 |
| curated / Rust / large | off | 4.043 | 18.796 | 17.112 |
| curated / CSS / example | off | 0.380 | 1.405 | 0.632 |
| curated / CSS / large | off | 4.859 | 20.770 | 9.106 |
| curated / HTML / example | off | 0.806 | 1.799 | 2.536 |
| curated / HTML / large | off | 11.207 | 28.626 | 39.196 |
| curated / C++ / example | off | 1.260 | 2.700 | 4.454 |
| curated / C++ / large | off | 16.921 | 38.613 | 66.808 |
| curated / Swift / example | off | 0.502 | 1.467 | 1.252 |
| curated / Swift / large | off | 6.352 | 21.594 | 18.272 |
| curated / Java / example | off | 0.376 | 1.141 | 1.059 |
| curated / Java / large | off | 4.744 | 16.644 | 15.544 |
| curated / Markdown / example | off | 0.530 | 1.161 | 2.002 |
| curated / Markdown / large | off | 6.535 | 16.970 | 30.354 |
| curated / TOML / example | off | 0.112 | 0.223 | 0.178 |
| curated / TOML / large | off | 1.478 | 3.311 | 2.710 |
| curated / YAML / example | off | 0.233 | 0.446 | 0.388 |
| curated / YAML / large | off | 2.999 | 6.512 | 5.807 |
| curated / JSON / example | off | 0.180 | 0.374 | 0.355 |
| curated / JSON / large | off | 2.754 | 5.977 | 5.770 |
| curated / Astro / example | off | 1.215 | 2.687 | 3.500 |
| curated / Astro / large | off | 13.976 | 34.701 | 48.627 |
| curated / Svelte / example | off | 1.257 | 2.982 | 4.303 |
| curated / Svelte / large | off | 17.218 | 46.203 | 67.288 |
| curated / Ruby / example | off | 0.352 | 1.628 | 1.570 |
| curated / Ruby / large | off | 4.188 | 23.900 | 23.194 |
| curated / Python / example | off | 0.448 | 1.639 | 1.462 |
| curated / Python / large | off | 5.629 | 24.776 | 21.422 |
| curated / Vue / example | off | 0.707 | 2.014 | 2.705 |
| curated / Vue / large | off | 9.743 | 32.216 | 42.927 |
| curated / MDX / example | off | 0.746 | 1.705 | 3.298 |
| curated / MDX / large | off | 10.026 | 25.639 | 51.015 |
| curated / SCSS / example | off | 0.402 | 2.501 | 0.759 |
| curated / SCSS / large | off | 4.847 | 38.349 | 10.533 |
| curated / Bash / example | off | 0.388 | 0.921 | 0.759 |
| curated / Bash / large | off | 4.858 | 13.114 | 10.756 |
| tiobe / Python / example | on | 0.381 | 1.611 | 1.411 |
| tiobe / Python / large | on | 4.933 | 24.876 | 21.404 |
| tiobe / C / example | on | 0.335 | 1.658 | 1.601 |
| tiobe / C / large | on | 3.889 | 24.931 | 23.668 |
| tiobe / C++ / example | on | 0.639 | 2.449 | 4.155 |
| tiobe / C++ / large | on | 8.088 | 37.461 | 64.224 |
| tiobe / Java / example | on | 0.285 | 1.091 | 1.007 |
| tiobe / Java / large | on | 3.385 | 15.858 | 14.690 |
| tiobe / C# / example | on | 0.423 | 1.203 | 2.516 |
| tiobe / C# / large | on | 5.261 | 17.637 | 39.221 |
| tiobe / JavaScript / example | on | 0.704 | 2.653 | 5.120 |
| tiobe / JavaScript / large | on | 7.306 | 37.191 | 75.969 |
| tiobe / Visual Basic / example | on | 0.375 | 1.033 | 0.588 |
| tiobe / Visual Basic / large | on | 4.713 | 15.335 | 8.459 |
| tiobe / SQL / example | on | 0.392 | 2.104 | 0.797 |
| tiobe / SQL / large | on | 5.011 | 32.175 | 11.258 |
| tiobe / R / example | on | 0.242 | 0.718 | 0.861 |
| tiobe / R / large | on | 3.465 | 10.866 | 13.525 |
| tiobe / Rust / example | on | 0.269 | 1.278 | 1.139 |
| tiobe / Rust / large | on | 3.551 | 19.126 | 16.824 |
| tiobe / Fortran / example | on | 0.571 | 1.809 | 1.431 |
| tiobe / Fortran / large | on | 8.074 | 28.320 | 20.913 |
| tiobe / Go / example | on | 0.375 | 1.410 | 1.099 |
| tiobe / Go / large | on | 4.603 | 20.971 | 15.856 |
| tiobe / Delphi/Object Pascal / example | on | 0.225 | 0.785 | 0.315 |
| tiobe / Delphi/Object Pascal / large | on | 2.885 | 11.984 | 4.518 |
| tiobe / PHP / example | on | 0.371 | 1.733 | 1.160 |
| tiobe / PHP / large | on | 4.594 | 26.156 | 16.093 |
| tiobe / Assembly language / example | on | 0.203 | 2.267 | 1.637 |
| tiobe / Assembly language / large | on | 2.187 | 35.024 | 23.391 |
| tiobe / Ada / example | on | 0.322 | 0.780 | 0.602 |
| tiobe / Ada / large | on | 3.980 | 11.187 | 8.644 |
| tiobe / Swift / example | on | 0.366 | 1.470 | 1.244 |
| tiobe / Swift / large | on | 4.309 | 21.690 | 18.165 |
| tiobe / Objective-C / example | on | 0.345 | 1.818 | 1.504 |
| tiobe / Objective-C / large | on | 4.416 | 27.777 | 22.518 |
| tiobe / COBOL / example | on | 1.345 | 3.733 | 1.394 |
| tiobe / COBOL / large | on | 19.150 | 57.195 | 19.703 |
| tiobe / Python / example | off | 0.465 | 1.669 | 1.476 |
| tiobe / Python / large | off | 5.924 | 24.913 | 21.575 |
| tiobe / C / example | off | 0.579 | 1.731 | 1.652 |
| tiobe / C / large | off | 7.625 | 25.861 | 25.069 |
| tiobe / C++ / example | off | 1.159 | 2.509 | 4.311 |
| tiobe / C++ / large | off | 15.893 | 36.610 | 63.898 |
| tiobe / Java / example | off | 0.372 | 1.123 | 1.037 |
| tiobe / Java / large | off | 4.647 | 16.494 | 15.044 |
| tiobe / C# / example | off | 0.963 | 1.266 | 2.634 |
| tiobe / C# / large | off | 13.508 | 17.918 | 39.467 |
| tiobe / JavaScript / example | off | 1.305 | 2.660 | 5.067 |
| tiobe / JavaScript / large | off | 16.243 | 37.462 | 77.074 |
| tiobe / Visual Basic / example | off | 0.364 | 1.032 | 0.585 |
| tiobe / Visual Basic / large | off | 4.931 | 15.522 | 8.539 |
| tiobe / SQL / example | off | 0.399 | 2.121 | 0.807 |
| tiobe / SQL / large | off | 5.029 | 32.113 | 11.137 |
| tiobe / R / example | off | 0.238 | 0.725 | 0.871 |
| tiobe / R / large | off | 3.389 | 10.633 | 13.248 |
| tiobe / Rust / example | off | 0.308 | 1.275 | 1.151 |
| tiobe / Rust / large | off | 3.947 | 18.878 | 16.977 |
| tiobe / Fortran / example | off | 0.736 | 1.812 | 1.451 |
| tiobe / Fortran / large | off | 9.959 | 26.354 | 21.415 |
| tiobe / Go / example | off | 0.488 | 1.411 | 1.108 |
| tiobe / Go / large | off | 6.040 | 20.199 | 15.942 |
| tiobe / Delphi/Object Pascal / example | off | 0.171 | 0.754 | 0.299 |
| tiobe / Delphi/Object Pascal / large | off | 2.301 | 11.404 | 4.173 |
| tiobe / PHP / example | off | 0.610 | 1.673 | 1.110 |
| tiobe / PHP / large | off | 8.350 | 24.939 | 15.393 |
| tiobe / Assembly language / example | off | 0.395 | 2.179 | 1.568 |
| tiobe / Assembly language / large | off | 4.888 | 33.393 | 22.380 |
| tiobe / Ada / example | off | 0.364 | 0.772 | 0.603 |
| tiobe / Ada / large | off | 4.811 | 10.958 | 8.160 |
| tiobe / Swift / example | off | 0.492 | 1.452 | 1.238 |
| tiobe / Swift / large | off | 6.202 | 20.605 | 17.122 |
| tiobe / Objective-C / example | off | 0.540 | 1.730 | 1.421 |
| tiobe / Objective-C / large | off | 7.240 | 26.628 | 21.290 |
| tiobe / COBOL / example | off | 1.292 | 3.579 | 1.321 |
| tiobe / COBOL / large | off | 19.343 | 57.782 | 19.680 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
