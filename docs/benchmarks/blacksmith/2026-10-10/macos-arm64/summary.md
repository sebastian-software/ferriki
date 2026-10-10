# Ferriki Blacksmith comparison: macos-arm64

Commit: ad991d0d1cbcc8e5f24d5cbcc95d3468425323db. Runner: blacksmith-6vcpu-macos-26. CPU: Apple M4 Pro (Virtual). Node: v24.21.0.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| Repository / warm total | on | 34.434 | 188.524 | 195.753 |
| Repository / cold total | on | 819.163 | 986.036 | 1051.397 |
| Repository / warm total | off | 57.964 | 201.898 | 207.733 |
| Repository / cold total | off | 535.374 | 972.505 | 960.327 |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |
| JSON | example | 0.178 | 0.145 | -18.73% |
| JSON | large | 2.736 | 2.222 | -18.81% |
| Astro | example | 1.359 | 1.064 | -21.72% |
| Astro | large | 12.990 | 10.838 | -16.57% |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| curated / TypeScript / example | on | 0.693 | 2.519 | 7.075 |
| curated / TypeScript / large | on | 6.579 | 35.365 | 115.318 |
| curated / TSX / example | on | 0.829 | 2.556 | 6.102 |
| curated / TSX / large | on | 7.604 | 34.895 | 93.172 |
| curated / Rust / example | on | 0.301 | 1.461 | 1.079 |
| curated / Rust / large | on | 3.704 | 21.943 | 16.882 |
| curated / CSS / example | on | 0.516 | 1.637 | 0.647 |
| curated / CSS / large | on | 5.654 | 24.428 | 9.794 |
| curated / HTML / example | on | 0.945 | 2.285 | 3.498 |
| curated / HTML / large | on | 8.695 | 31.232 | 51.042 |
| curated / C++ / example | on | 1.029 | 3.643 | 5.613 |
| curated / C++ / large | on | 7.312 | 52.263 | 87.453 |
| curated / Swift / example | on | 0.459 | 1.793 | 1.248 |
| curated / Swift / large | on | 4.423 | 25.984 | 18.769 |
| curated / Java / example | on | 0.324 | 1.260 | 1.104 |
| curated / Java / large | on | 3.770 | 19.001 | 16.954 |
| curated / Markdown / example | on | 0.704 | 1.590 | 2.836 |
| curated / Markdown / large | on | 4.802 | 18.927 | 40.636 |
| curated / TOML / example | on | 0.108 | 0.220 | 0.169 |
| curated / TOML / large | on | 1.571 | 3.386 | 2.544 |
| curated / YAML / example | on | 0.203 | 0.495 | 0.390 |
| curated / YAML / large | on | 2.861 | 7.551 | 5.972 |
| curated / JSON / example | on | 0.178 | 0.364 | 0.320 |
| curated / JSON / large | on | 2.736 | 5.901 | 5.204 |
| curated / Astro / example | on | 1.359 | 3.486 | 5.126 |
| curated / Astro / large | on | 12.990 | 39.478 | 68.097 |
| curated / Svelte / example | on | 1.279 | 3.597 | 6.111 |
| curated / Svelte / large | on | 13.403 | 50.872 | 92.321 |
| curated / Ruby / example | on | 0.292 | 1.899 | 1.706 |
| curated / Ruby / large | on | 3.318 | 27.566 | 25.286 |
| curated / Python / example | on | 0.382 | 1.721 | 1.407 |
| curated / Python / large | on | 4.691 | 26.512 | 21.946 |
| curated / Vue / example | on | 0.732 | 2.690 | 4.021 |
| curated / Vue / large | on | 7.273 | 39.437 | 63.622 |
| curated / MDX / example | on | 0.850 | 2.408 | 5.573 |
| curated / MDX / large | on | 6.358 | 32.637 | 89.672 |
| curated / SCSS / example | on | 0.639 | 3.548 | 0.804 |
| curated / SCSS / large | on | 4.559 | 52.838 | 12.468 |
| curated / Bash / example | on | 0.382 | 1.045 | 0.779 |
| curated / Bash / large | on | 4.580 | 15.245 | 12.097 |
| curated / TypeScript / example | off | 1.165 | 2.787 | 7.886 |
| curated / TypeScript / large | off | 11.894 | 35.865 | 116.941 |
| curated / TSX / example | off | 1.089 | 2.512 | 6.161 |
| curated / TSX / large | off | 11.342 | 33.540 | 91.634 |
| curated / Rust / example | off | 0.329 | 1.381 | 1.011 |
| curated / Rust / large | off | 4.063 | 21.405 | 15.875 |
| curated / CSS / example | off | 0.424 | 1.556 | 0.604 |
| curated / CSS / large | off | 5.128 | 24.360 | 8.899 |
| curated / HTML / example | off | 0.998 | 2.188 | 3.513 |
| curated / HTML / large | off | 10.687 | 28.767 | 48.082 |
| curated / C++ / example | off | 1.357 | 3.085 | 4.769 |
| curated / C++ / large | off | 13.643 | 42.074 | 70.342 |
| curated / Swift / example | off | 0.445 | 1.492 | 1.067 |
| curated / Swift / large | off | 5.638 | 21.527 | 15.195 |
| curated / Java / example | off | 0.332 | 1.130 | 0.988 |
| curated / Java / large | off | 4.097 | 16.061 | 14.460 |
| curated / Markdown / example | off | 0.512 | 1.202 | 2.311 |
| curated / Markdown / large | off | 5.061 | 14.870 | 31.382 |
| curated / TOML / example | off | 0.084 | 0.180 | 0.136 |
| curated / TOML / large | off | 1.235 | 2.749 | 2.009 |
| curated / YAML / example | off | 0.191 | 0.415 | 0.327 |
| curated / YAML / large | off | 2.746 | 6.195 | 4.945 |
| curated / JSON / example | off | 0.145 | 0.303 | 0.270 |
| curated / JSON / large | off | 2.222 | 4.647 | 4.152 |
| curated / Astro / example | off | 1.064 | 2.788 | 3.960 |
| curated / Astro / large | off | 10.838 | 31.828 | 53.940 |
| curated / Svelte / example | off | 1.091 | 2.939 | 5.255 |
| curated / Svelte / large | off | 14.105 | 44.757 | 81.643 |
| curated / Ruby / example | off | 0.291 | 1.755 | 1.532 |
| curated / Ruby / large | off | 4.049 | 27.701 | 24.722 |
| curated / Python / example | off | 0.387 | 1.645 | 1.324 |
| curated / Python / large | off | 5.368 | 25.635 | 20.797 |
| curated / Vue / example | off | 0.669 | 2.308 | 3.386 |
| curated / Vue / large | off | 8.901 | 34.875 | 52.222 |
| curated / MDX / example | off | 0.608 | 1.681 | 4.011 |
| curated / MDX / large | off | 7.769 | 25.232 | 63.807 |
| curated / SCSS / example | off | 0.312 | 2.650 | 0.590 |
| curated / SCSS / large | off | 4.434 | 42.418 | 8.463 |
| curated / Bash / example | off | 0.270 | 0.771 | 0.577 |
| curated / Bash / large | off | 4.073 | 11.700 | 8.842 |
| tiobe / Python / example | on | 0.271 | 1.433 | 1.146 |
| tiobe / Python / large | on | 4.363 | 24.134 | 19.123 |
| tiobe / C / example | on | 0.359 | 1.973 | 1.710 |
| tiobe / C / large | on | 4.141 | 30.841 | 27.104 |
| tiobe / C++ / example | on | 0.989 | 3.589 | 5.503 |
| tiobe / C++ / large | on | 6.792 | 46.335 | 78.251 |
| tiobe / Java / example | on | 0.336 | 1.252 | 1.118 |
| tiobe / Java / large | on | 3.603 | 18.383 | 17.030 |
| tiobe / C# / example | on | 0.556 | 1.461 | 3.620 |
| tiobe / C# / large | on | 5.041 | 19.162 | 52.650 |
| tiobe / JavaScript / example | on | 0.671 | 2.679 | 6.913 |
| tiobe / JavaScript / large | on | 6.443 | 38.502 | 108.936 |
| tiobe / Visual Basic / example | on | 0.398 | 1.222 | 0.567 |
| tiobe / Visual Basic / large | on | 4.931 | 17.852 | 7.840 |
| tiobe / SQL / example | on | 0.383 | 2.700 | 0.710 |
| tiobe / SQL / large | on | 5.297 | 42.872 | 10.318 |
| tiobe / R / example | on | 0.214 | 0.660 | 0.916 |
| tiobe / R / large | on | 3.007 | 10.523 | 14.897 |
| tiobe / Rust / example | on | 0.229 | 1.183 | 0.880 |
| tiobe / Rust / large | on | 3.102 | 18.235 | 13.974 |
| tiobe / Fortran / example | on | 0.617 | 1.934 | 1.440 |
| tiobe / Fortran / large | on | 6.933 | 29.098 | 22.264 |
| tiobe / Go / example | on | 0.308 | 1.348 | 0.881 |
| tiobe / Go / large | on | 3.852 | 19.556 | 13.076 |
| tiobe / Delphi/Object Pascal / example | on | 0.206 | 0.790 | 0.255 |
| tiobe / Delphi/Object Pascal / large | on | 2.849 | 12.355 | 3.696 |
| tiobe / PHP / example | on | 0.530 | 1.911 | 1.066 |
| tiobe / PHP / large | on | 4.490 | 28.078 | 15.315 |
| tiobe / Assembly language / example | on | 0.230 | 2.483 | 1.566 |
| tiobe / Assembly language / large | on | 2.177 | 37.248 | 22.301 |
| tiobe / Ada / example | on | 0.256 | 0.646 | 0.447 |
| tiobe / Ada / large | on | 3.558 | 10.000 | 6.738 |
| tiobe / Swift / example | on | 0.322 | 1.460 | 1.051 |
| tiobe / Swift / large | on | 3.542 | 19.894 | 14.633 |
| tiobe / Objective-C / example | on | 0.308 | 1.864 | 1.235 |
| tiobe / Objective-C / large | on | 3.679 | 28.460 | 19.216 |
| tiobe / COBOL / example | on | 1.323 | 4.686 | 1.152 |
| tiobe / COBOL / large | on | 18.763 | 73.065 | 16.651 |
| tiobe / Python / example | off | 0.432 | 1.629 | 1.356 |
| tiobe / Python / large | off | 5.447 | 25.445 | 21.058 |
| tiobe / C / example | off | 0.622 | 1.943 | 1.694 |
| tiobe / C / large | off | 7.572 | 29.833 | 26.087 |
| tiobe / C++ / example | off | 1.684 | 3.505 | 5.288 |
| tiobe / C++ / large | off | 15.125 | 46.487 | 77.386 |
| tiobe / Java / example | off | 0.343 | 1.128 | 0.998 |
| tiobe / Java / large | off | 4.200 | 16.395 | 14.771 |
| tiobe / C# / example | off | 0.994 | 1.335 | 3.223 |
| tiobe / C# / large | off | 14.733 | 20.125 | 54.898 |
| tiobe / JavaScript / example | off | 1.347 | 2.957 | 7.432 |
| tiobe / JavaScript / large | off | 13.449 | 37.051 | 102.208 |
| tiobe / Visual Basic / example | off | 0.294 | 1.036 | 0.463 |
| tiobe / Visual Basic / large | off | 4.416 | 16.644 | 7.517 |
| tiobe / SQL / example | off | 0.376 | 2.616 | 0.673 |
| tiobe / SQL / large | off | 5.037 | 41.576 | 9.562 |
| tiobe / R / example | off | 0.188 | 0.602 | 0.846 |
| tiobe / R / large | off | 3.021 | 10.334 | 14.408 |
| tiobe / Rust / example | off | 0.262 | 1.194 | 0.879 |
| tiobe / Rust / large | off | 3.557 | 18.744 | 14.075 |
| tiobe / Fortran / example | off | 0.691 | 1.794 | 1.367 |
| tiobe / Fortran / large | off | 8.519 | 26.905 | 20.139 |
| tiobe / Go / example | off | 0.420 | 1.353 | 0.887 |
| tiobe / Go / large | off | 5.689 | 21.074 | 13.848 |
| tiobe / Delphi/Object Pascal / example | off | 0.153 | 0.796 | 0.246 |
| tiobe / Delphi/Object Pascal / large | off | 2.327 | 12.774 | 3.752 |
| tiobe / PHP / example | off | 1.116 | 2.017 | 1.138 |
| tiobe / PHP / large | off | 10.562 | 29.415 | 15.572 |
| tiobe / Assembly language / example | off | 0.448 | 2.636 | 1.727 |
| tiobe / Assembly language / large | off | 5.225 | 40.203 | 24.889 |
| tiobe / Ada / example | off | 0.340 | 0.707 | 0.486 |
| tiobe / Ada / large | off | 4.933 | 11.357 | 7.667 |
| tiobe / Swift / example | off | 0.650 | 1.790 | 1.283 |
| tiobe / Swift / large | off | 6.353 | 24.346 | 17.535 |
| tiobe / Objective-C / example | off | 0.713 | 2.169 | 1.484 |
| tiobe / Objective-C / large | off | 6.983 | 31.145 | 20.821 |
| tiobe / COBOL / example | off | 1.317 | 4.691 | 1.202 |
| tiobe / COBOL / large | off | 18.889 | 74.237 | 16.206 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
