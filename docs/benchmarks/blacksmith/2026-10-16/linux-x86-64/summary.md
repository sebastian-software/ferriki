# Ferriki Blacksmith comparison: linux-x86-64

Commit: c18c0127bad274072ee81f9e1e9d4dc142f978da. Runner: blacksmith-4vcpu-ubuntu-2404. CPU: AMD EPYC. Node: v24.21.0.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| Repository / warm total | on | 111.929 | 467.991 | unsupported |
| Repository / cold total | on | 709.480 | 1313.500 | unsupported |
| Repository / warm total | off | 157.726 | 505.872 | unsupported |
| Repository / cold total | off | 806.435 | 2229.118 | unsupported |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |
| JSON | example | 0.225 | 0.190 | -15.36% |
| JSON | large | 3.483 | 2.877 | -17.39% |
| Astro | example | 4.128 | 3.034 | -26.50% |
| Astro | large | 21.051 | 26.267 | 24.78% |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| curated / TypeScript / example | on | 3.407 | 11.846 | 26.734 |
| curated / TypeScript / large | on | 21.755 | 159.944 | 388.597 |
| curated / TSX / example | on | 3.678 | 13.452 | 27.889 |
| curated / TSX / large | on | 25.251 | 190.366 | 395.667 |
| curated / Rust / example | on | 0.726 | 2.442 | 2.233 |
| curated / Rust / large | on | 6.108 | 35.494 | 33.893 |
| curated / CSS / example | on | 1.639 | 6.139 | 1.850 |
| curated / CSS / large | on | 9.743 | 85.489 | 23.948 |
| curated / HTML / example | on | 3.215 | 12.013 | 16.044 |
| curated / HTML / large | on | 18.661 | 159.705 | 201.706 |
| curated / C++ / example | on | 3.658 | 8.970 | 10.986 |
| curated / C++ / large | on | 15.876 | 80.321 | 105.422 |
| curated / Swift / example | on | 1.025 | 2.478 | 1.757 |
| curated / Swift / large | on | 5.615 | 27.643 | 22.479 |
| curated / Java / example | on | 0.354 | 1.332 | 1.228 |
| curated / Java / large | on | 3.977 | 19.439 | 17.988 |
| curated / Markdown / example | on | 1.020 | 2.134 | 2.965 |
| curated / Markdown / large | on | 6.586 | 24.070 | 43.375 |
| curated / TOML / example | on | 0.128 | 0.286 | 0.227 |
| curated / TOML / large | on | 1.986 | 4.490 | 3.681 |
| curated / YAML / example | on | 2.146 | 1.812 | unsupported |
| curated / YAML / large | on | 35.374 | 29.175 | unsupported |
| curated / JSON / example | on | 0.225 | 0.512 | 0.477 |
| curated / JSON / large | on | 3.483 | 9.066 | 7.995 |
| curated / Astro / example | on | 4.128 | 14.739 | 23.195 |
| curated / Astro / large | on | 21.051 | 145.504 | 249.236 |
| curated / Svelte / example | on | 3.170 | 13.136 | 24.525 |
| curated / Svelte / large | on | 22.528 | 179.047 | 381.834 |
| curated / Ruby / example | on | 0.582 | 2.242 | 2.178 |
| curated / Ruby / large | on | 6.013 | 40.593 | 41.046 |
| curated / Python / example | on | 1.217 | 3.012 | 2.575 |
| curated / Python / large | on | 6.599 | 34.947 | 31.992 |
| curated / Vue / example | on | 1.393 | 3.125 | 3.841 |
| curated / Vue / large | on | 12.517 | 46.319 | 63.396 |
| curated / MDX / example | on | 1.993 | 4.185 | 6.623 |
| curated / MDX / large | on | 9.565 | 50.186 | 98.177 |
| curated / SCSS / example | on | 0.665 | 3.684 | 1.102 |
| curated / SCSS / large | on | 5.122 | 51.831 | 14.548 |
| curated / Bash / example | on | 0.460 | 1.215 | 0.975 |
| curated / Bash / large | on | 5.499 | 17.232 | 14.951 |
| curated / TypeScript / example | off | 2.496 | 6.598 | 14.562 |
| curated / TypeScript / large | off | 30.909 | 96.543 | 227.489 |
| curated / TSX / example | off | 3.256 | 8.876 | 17.377 |
| curated / TSX / large | off | 35.724 | 122.221 | 255.517 |
| curated / Rust / example | off | 0.363 | 1.569 | 1.429 |
| curated / Rust / large | off | 4.777 | 25.030 | 22.692 |
| curated / CSS / example | off | 0.530 | 3.084 | 0.973 |
| curated / CSS / large | off | 5.923 | 47.409 | 13.322 |
| curated / HTML / example | off | 1.945 | 6.634 | 8.548 |
| curated / HTML / large | off | 20.296 | 104.231 | 136.434 |
| curated / C++ / example | off | 2.843 | 4.541 | 5.886 |
| curated / C++ / large | off | 23.408 | 58.672 | 84.455 |
| curated / Swift / example | off | 0.702 | 1.869 | 1.475 |
| curated / Swift / large | off | 7.529 | 26.365 | 20.849 |
| curated / Java / example | off | 0.448 | 1.326 | 1.207 |
| curated / Java / large | off | 5.254 | 20.275 | 20.239 |
| curated / Markdown / example | off | 1.177 | 2.170 | 3.040 |
| curated / Markdown / large | off | 8.251 | 23.682 | 43.958 |
| curated / TOML / example | off | 0.123 | 0.272 | 0.218 |
| curated / TOML / large | off | 1.984 | 4.510 | 3.757 |
| curated / YAML / example | off | 1.669 | 1.610 | unsupported |
| curated / YAML / large | off | 26.209 | 24.609 | unsupported |
| curated / JSON / example | off | 0.190 | 0.428 | 0.404 |
| curated / JSON / large | off | 2.877 | 6.765 | 6.391 |
| curated / Astro / example | off | 3.034 | 11.034 | 18.489 |
| curated / Astro / large | off | 26.267 | 116.476 | 211.654 |
| curated / Svelte / example | off | 3.151 | 10.960 | 21.449 |
| curated / Svelte / large | off | 37.121 | 171.235 | 364.387 |
| curated / Ruby / example | off | 0.561 | 2.049 | 1.920 |
| curated / Ruby / large | off | 4.808 | 29.156 | 27.598 |
| curated / Python / example | off | 0.640 | 2.102 | 1.843 |
| curated / Python / large | off | 6.037 | 28.531 | 24.817 |
| curated / Vue / example | off | 1.574 | 2.698 | 3.454 |
| curated / Vue / large | off | 21.211 | 40.857 | 54.609 |
| curated / MDX / example | off | 1.491 | 2.992 | 4.695 |
| curated / MDX / large | off | 11.527 | 33.660 | 65.840 |
| curated / SCSS / example | off | 0.599 | 3.486 | 1.057 |
| curated / SCSS / large | off | 5.522 | 51.243 | 13.817 |
| curated / Bash / example | off | 0.542 | 1.259 | 0.999 |
| curated / Bash / large | off | 6.875 | 19.090 | 14.311 |
| tiobe / Python / example | on | 0.533 | 2.118 | 1.852 |
| tiobe / Python / large | on | 6.634 | 34.776 | 30.640 |
| tiobe / C / example | on | 1.213 | 3.482 | 2.774 |
| tiobe / C / large | on | 4.997 | 33.351 | 31.512 |
| tiobe / C++ / example | on | 3.209 | 7.527 | 8.993 |
| tiobe / C++ / large | on | 17.372 | 102.358 | 114.698 |
| tiobe / Java / example | on | 0.939 | 2.138 | 1.862 |
| tiobe / Java / large | on | 5.241 | 26.818 | 24.423 |
| tiobe / C# / example | on | 1.457 | 2.763 | 4.954 |
| tiobe / C# / large | on | 7.457 | 28.577 | 61.345 |
| tiobe / JavaScript / example | on | 3.331 | 13.386 | 24.239 |
| tiobe / JavaScript / large | on | 21.694 | 200.301 | 379.031 |
| tiobe / Visual Basic / example | on | 1.199 | 2.323 | 1.561 |
| tiobe / Visual Basic / large | on | 10.137 | 33.343 | 23.993 |
| tiobe / SQL / example | on | 1.209 | 4.504 | 2.025 |
| tiobe / SQL / large | on | 9.949 | 57.615 | 28.398 |
| tiobe / R / example | on | 0.838 | 2.993 | 2.252 |
| tiobe / R / large | on | 6.006 | 45.641 | 35.861 |
| tiobe / Rust / example | on | 1.135 | 2.998 | 2.755 |
| tiobe / Rust / large | on | 6.744 | 37.337 | 36.209 |
| tiobe / Fortran / example | on | 2.852 | 5.898 | 4.061 |
| tiobe / Fortran / large | on | 14.326 | 59.420 | 49.295 |
| tiobe / Go / example | on | 1.479 | 3.675 | 2.634 |
| tiobe / Go / large | on | 9.307 | 44.949 | 37.494 |
| tiobe / Delphi/Object Pascal / example | on | 1.122 | 1.852 | 0.909 |
| tiobe / Delphi/Object Pascal / large | on | 7.780 | 28.486 | 15.622 |
| tiobe / PHP / example | on | 2.444 | 6.761 | 4.352 |
| tiobe / PHP / large | on | 9.837 | 65.133 | 44.198 |
| tiobe / Assembly language / example | on | 1.226 | 5.337 | 4.477 |
| tiobe / Assembly language / large | on | 5.075 | 71.318 | 50.570 |
| tiobe / Ada / example | on | 1.957 | 3.176 | 2.308 |
| tiobe / Ada / large | on | 10.206 | 33.961 | 29.509 |
| tiobe / Swift / example | on | 2.604 | 5.595 | 3.886 |
| tiobe / Swift / large | on | 12.564 | 60.228 | 48.896 |
| tiobe / Objective-C / example | on | 1.985 | 5.775 | 4.104 |
| tiobe / Objective-C / large | on | 10.730 | 74.943 | 61.836 |
| tiobe / COBOL / example | on | 2.065 | 5.685 | 2.415 |
| tiobe / COBOL / large | on | 20.432 | 80.517 | 29.142 |
| tiobe / Python / example | off | 1.182 | 2.918 | 2.556 |
| tiobe / Python / large | off | 7.611 | 36.572 | 35.111 |
| tiobe / C / example | off | 1.103 | 2.888 | 2.288 |
| tiobe / C / large | off | 8.833 | 35.558 | 33.039 |
| tiobe / C++ / example | off | 4.995 | 7.607 | 9.837 |
| tiobe / C++ / large | off | 59.161 | 126.127 | 134.903 |
| tiobe / Java / example | off | 0.835 | 1.909 | 1.642 |
| tiobe / Java / large | off | 5.400 | 21.836 | 19.821 |
| tiobe / C# / example | off | 1.730 | 2.303 | 3.846 |
| tiobe / C# / large | off | 17.007 | 25.010 | 53.311 |
| tiobe / JavaScript / example | off | 3.460 | 10.026 | 17.074 |
| tiobe / JavaScript / large | off | 40.293 | 140.035 | 256.544 |
| tiobe / Visual Basic / example | off | 0.745 | 1.864 | 1.187 |
| tiobe / Visual Basic / large | off | 5.895 | 20.897 | 11.786 |
| tiobe / SQL / example | off | 0.596 | 2.601 | 1.098 |
| tiobe / SQL / large | off | 5.988 | 45.388 | 15.481 |
| tiobe / R / example | off | 0.750 | 2.400 | 1.758 |
| tiobe / R / large | off | 5.073 | 31.312 | 24.335 |
| tiobe / Rust / example | off | 0.741 | 2.005 | 1.818 |
| tiobe / Rust / large | off | 4.998 | 26.151 | 25.537 |
| tiobe / Fortran / example | off | 1.655 | 3.591 | 2.412 |
| tiobe / Fortran / large | off | 12.052 | 41.059 | 30.984 |
| tiobe / Go / example | off | 0.995 | 2.323 | 1.705 |
| tiobe / Go / large | off | 8.401 | 28.659 | 23.207 |
| tiobe / Delphi/Object Pascal / example | off | 0.266 | 1.050 | 0.451 |
| tiobe / Delphi/Object Pascal / large | off | 3.200 | 16.637 | 6.521 |
| tiobe / PHP / example | off | 1.837 | 3.555 | 2.148 |
| tiobe / PHP / large | off | 8.715 | 37.890 | 24.207 |
| tiobe / Assembly language / example | off | 0.646 | 2.747 | 2.027 |
| tiobe / Assembly language / large | off | 6.932 | 48.778 | 32.495 |
| tiobe / Ada / example | off | 0.695 | 1.375 | 1.032 |
| tiobe / Ada / large | off | 5.477 | 15.730 | 13.554 |
| tiobe / Swift / example | off | 1.346 | 2.503 | 1.750 |
| tiobe / Swift / large | off | 8.463 | 29.690 | 24.631 |
| tiobe / Objective-C / example | off | 0.928 | 2.644 | 1.953 |
| tiobe / Objective-C / large | off | 8.318 | 39.145 | 30.327 |
| tiobe / COBOL / example | off | 1.461 | 4.488 | 1.807 |
| tiobe / COBOL / large | off | 17.351 | 73.693 | 26.841 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
