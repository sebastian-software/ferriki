# Ferriki Blacksmith comparison: linux-x86-64

Commit: aea84dc7b911c79a86dd3631c698c991c36184b8. Runner: blacksmith-4vcpu-ubuntu-2404. CPU: AMD EPYC. Node: v24.21.0.
Corpus scope: comparison, curated, tiobe.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| Repository / warm total | on | 103.619 | 342.603 | unsupported |
| Repository / cold total | on | 648.087 | 1106.051 | unsupported |
| Repository / warm total | off | 136.151 | 342.009 | unsupported |
| Repository / cold total | off | 483.920 | 1180.351 | unsupported |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |
| JSON | example | 0.184 | 0.188 | 2.04% |
| JSON | large | 2.911 | 3.091 | 6.20% |
| Astro | example | 3.581 | 2.974 | -16.94% |
| Astro | large | 19.869 | 27.418 | 38.00% |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| curated / TypeScript / example | on | 3.526 | 9.814 | 12.067 |
| curated / TypeScript / large | on | 17.994 | 95.810 | 114.298 |
| curated / TSX / example | on | 3.229 | 8.026 | 8.133 |
| curated / TSX / large | on | 21.213 | 106.071 | 109.851 |
| curated / Rust / example | on | 0.596 | 1.815 | 0.974 |
| curated / Rust / large | on | 4.228 | 25.390 | 11.949 |
| curated / CSS / example | on | 0.987 | 3.686 | 1.024 |
| curated / CSS / large | on | 5.996 | 47.229 | 11.288 |
| curated / HTML / example | on | 2.039 | 5.552 | 4.216 |
| curated / HTML / large | on | 15.100 | 96.364 | 66.047 |
| curated / C++ / example | on | 2.230 | 5.374 | 4.919 |
| curated / C++ / large | on | 11.172 | 57.374 | 52.330 |
| curated / Swift / example | on | 0.739 | 2.043 | 1.252 |
| curated / Swift / large | on | 5.235 | 26.632 | 16.397 |
| curated / Java / example | on | 0.445 | 1.353 | 0.923 |
| curated / Java / large | on | 4.537 | 23.138 | 14.877 |
| curated / Markdown / example | on | 0.975 | 1.996 | 2.541 |
| curated / Markdown / large | on | 5.625 | 19.463 | 26.981 |
| curated / TOML / example | on | 0.116 | 0.252 | 0.201 |
| curated / TOML / large | on | 1.556 | 3.483 | 2.784 |
| curated / YAML / example | on | 2.074 | 1.674 | unsupported |
| curated / YAML / large | on | 32.342 | 25.102 | unsupported |
| curated / JSON / example | on | 0.184 | 0.408 | 0.344 |
| curated / JSON / large | on | 2.911 | 6.737 | 5.747 |
| curated / Astro / example | on | 3.581 | 8.209 | 7.554 |
| curated / Astro / large | on | 19.869 | 69.016 | 63.891 |
| curated / Svelte / example | on | 2.398 | 6.618 | 6.256 |
| curated / Svelte / large | on | 23.926 | 110.504 | 104.448 |
| curated / Ruby / example | on | 0.327 | 1.824 | 0.960 |
| curated / Ruby / large | on | 3.407 | 26.525 | 12.024 |
| curated / Python / example | on | 0.383 | 1.703 | 1.036 |
| curated / Python / large | on | 4.851 | 26.364 | 14.865 |
| curated / Vue / example | on | 0.932 | 2.328 | 2.415 |
| curated / Vue / large | on | 10.752 | 36.399 | 37.751 |
| curated / MDX / example | on | 0.582 | 1.970 | 2.638 |
| curated / MDX / large | on | 7.425 | 31.318 | 43.226 |
| curated / SCSS / example | on | 0.596 | 3.339 | 0.858 |
| curated / SCSS / large | on | 4.720 | 51.754 | 11.074 |
| curated / Bash / example | on | 0.550 | 1.263 | 0.961 |
| curated / Bash / large | on | 5.686 | 17.195 | 13.847 |
| curated / TypeScript / example | off | 2.631 | 5.167 | 6.356 |
| curated / TypeScript / large | off | 30.459 | 68.206 | 81.435 |
| curated / TSX / example | off | 2.653 | 5.309 | 5.220 |
| curated / TSX / large | off | 33.050 | 75.251 | 71.500 |
| curated / Rust / example | off | 0.345 | 1.427 | 0.691 |
| curated / Rust / large | off | 4.127 | 21.245 | 9.186 |
| curated / CSS / example | off | 0.532 | 2.940 | 0.813 |
| curated / CSS / large | off | 5.629 | 43.460 | 10.388 |
| curated / HTML / example | off | 1.695 | 4.436 | 3.265 |
| curated / HTML / large | off | 18.560 | 62.020 | 44.840 |
| curated / C++ / example | off | 2.071 | 3.792 | 3.349 |
| curated / C++ / large | off | 22.724 | 58.649 | 55.901 |
| curated / Swift / example | off | 0.560 | 1.614 | 1.018 |
| curated / Swift / large | off | 7.020 | 24.419 | 13.762 |
| curated / Java / example | off | 0.408 | 1.298 | 0.865 |
| curated / Java / large | off | 4.814 | 18.678 | 12.048 |
| curated / Markdown / example | off | 0.751 | 1.575 | 2.043 |
| curated / Markdown / large | off | 7.649 | 21.157 | 31.087 |
| curated / TOML / example | off | 0.122 | 0.276 | 0.221 |
| curated / TOML / large | off | 1.887 | 4.192 | 3.391 |
| curated / YAML / example | off | 1.731 | 1.701 | unsupported |
| curated / YAML / large | off | 25.116 | 23.774 | unsupported |
| curated / JSON / example | off | 0.188 | 0.409 | 0.346 |
| curated / JSON / large | off | 3.091 | 7.452 | 6.187 |
| curated / Astro / example | off | 2.974 | 6.094 | 5.429 |
| curated / Astro / large | off | 27.418 | 67.511 | 63.566 |
| curated / Svelte / example | off | 3.131 | 6.797 | 6.617 |
| curated / Svelte / large | off | 33.039 | 78.579 | 79.406 |
| curated / Ruby / example | off | 0.494 | 2.050 | 1.090 |
| curated / Ruby / large | off | 5.348 | 30.643 | 14.639 |
| curated / Python / example | off | 0.514 | 1.807 | 1.131 |
| curated / Python / large | off | 6.012 | 27.852 | 15.887 |
| curated / Vue / example | off | 1.705 | 2.802 | 2.857 |
| curated / Vue / large | off | 20.062 | 37.454 | 38.734 |
| curated / MDX / example | off | 1.218 | 2.562 | 3.156 |
| curated / MDX / large | off | 10.470 | 30.646 | 42.299 |
| curated / SCSS / example | off | 0.474 | 2.957 | 0.765 |
| curated / SCSS / large | off | 4.932 | 44.702 | 9.762 |
| curated / Bash / example | off | 0.500 | 1.107 | 0.803 |
| curated / Bash / large | off | 6.062 | 15.698 | 10.974 |
| tiobe / Python / example | on | 0.995 | 2.426 | 1.638 |
| tiobe / Python / large | on | 5.526 | 28.703 | 17.777 |
| tiobe / C / example | on | 0.876 | 2.804 | 1.491 |
| tiobe / C / large | on | 5.192 | 35.249 | 21.668 |
| tiobe / C++ / example | on | 1.987 | 4.647 | 4.289 |
| tiobe / C++ / large | on | 10.680 | 52.525 | 51.182 |
| tiobe / Java / example | on | 0.354 | 1.291 | 0.852 |
| tiobe / Java / large | on | 3.990 | 19.092 | 12.082 |
| tiobe / C# / example | on | 0.763 | 1.693 | 2.166 |
| tiobe / C# / large | on | 6.165 | 21.988 | 30.316 |
| tiobe / JavaScript / example | on | 2.006 | 6.293 | 6.577 |
| tiobe / JavaScript / large | on | 15.067 | 86.896 | 87.420 |
| tiobe / Visual Basic / example | on | 0.459 | 1.214 | 0.555 |
| tiobe / Visual Basic / large | on | 5.779 | 20.208 | 8.037 |
| tiobe / SQL / example | on | 0.586 | 2.452 | 0.717 |
| tiobe / SQL / large | on | 5.312 | 37.060 | 8.431 |
| tiobe / R / example | on | 0.556 | 2.019 | 1.092 |
| tiobe / R / large | on | 3.860 | 27.058 | 13.458 |
| tiobe / Rust / example | on | 0.487 | 1.606 | 0.850 |
| tiobe / Rust / large | on | 4.467 | 26.728 | 13.423 |
| tiobe / Fortran / example | on | 1.288 | 2.724 | 1.744 |
| tiobe / Fortran / large | on | 8.783 | 36.923 | 24.021 |
| tiobe / Go / example | on | 0.780 | 2.139 | 1.213 |
| tiobe / Go / large | on | 4.907 | 23.253 | 10.759 |
| tiobe / Delphi/Object Pascal / example | on | 0.261 | 0.895 | 0.324 |
| tiobe / Delphi/Object Pascal / large | on | 3.595 | 14.191 | 4.655 |
| tiobe / PHP / example | on | 0.955 | 2.700 | 1.324 |
| tiobe / PHP / large | on | 4.617 | 31.223 | 12.871 |
| tiobe / Assembly language / example | on | 0.445 | 2.744 | 1.261 |
| tiobe / Assembly language / large | on | 2.461 | 41.096 | 14.471 |
| tiobe / Ada / example | on | 0.471 | 1.037 | 0.712 |
| tiobe / Ada / large | on | 4.715 | 14.238 | 9.067 |
| tiobe / Swift / example | on | 0.853 | 2.272 | 1.299 |
| tiobe / Swift / large | on | 5.703 | 27.800 | 17.621 |
| tiobe / Objective-C / example | on | 0.580 | 2.280 | 1.204 |
| tiobe / Objective-C / large | on | 4.870 | 32.530 | 15.882 |
| tiobe / COBOL / example | on | 1.371 | 4.311 | 1.055 |
| tiobe / COBOL / large | on | 16.078 | 65.847 | 12.166 |
| tiobe / Python / example | off | 0.649 | 1.972 | 1.258 |
| tiobe / Python / large | off | 6.244 | 28.548 | 16.509 |
| tiobe / C / example | off | 0.798 | 2.206 | 1.260 |
| tiobe / C / large | off | 7.595 | 30.866 | 17.829 |
| tiobe / C++ / example | off | 3.456 | 5.468 | 4.845 |
| tiobe / C++ / large | off | 24.445 | 56.933 | 54.286 |
| tiobe / Java / example | off | 0.382 | 1.200 | 0.802 |
| tiobe / Java / large | off | 4.898 | 18.456 | 11.769 |
| tiobe / C# / example | off | 1.267 | 1.668 | 2.087 |
| tiobe / C# / large | off | 14.325 | 20.242 | 27.624 |
| tiobe / JavaScript / example | off | 2.882 | 6.065 | 6.267 |
| tiobe / JavaScript / large | off | 35.775 | 84.242 | 87.573 |
| tiobe / Visual Basic / example | off | 0.399 | 1.144 | 0.498 |
| tiobe / Visual Basic / large | off | 5.278 | 17.791 | 7.183 |
| tiobe / SQL / example | off | 0.523 | 2.326 | 0.660 |
| tiobe / SQL / large | off | 4.971 | 35.032 | 7.726 |
| tiobe / R / example | off | 0.383 | 1.663 | 0.889 |
| tiobe / R / large | off | 4.968 | 31.058 | 17.454 |
| tiobe / Rust / example | off | 0.335 | 1.432 | 0.691 |
| tiobe / Rust / large | off | 4.478 | 22.559 | 10.189 |
| tiobe / Fortran / example | off | 1.122 | 2.556 | 1.638 |
| tiobe / Fortran / large | off | 11.779 | 37.749 | 25.118 |
| tiobe / Go / example | off | 0.632 | 1.747 | 0.937 |
| tiobe / Go / large | off | 7.294 | 25.526 | 12.125 |
| tiobe / Delphi/Object Pascal / example | off | 0.215 | 0.912 | 0.340 |
| tiobe / Delphi/Object Pascal / large | off | 2.877 | 13.977 | 5.036 |
| tiobe / PHP / example | off | 0.727 | 2.141 | 1.048 |
| tiobe / PHP / large | off | 6.666 | 28.767 | 11.820 |
| tiobe / Assembly language / example | off | 0.433 | 2.368 | 0.949 |
| tiobe / Assembly language / large | off | 5.285 | 37.135 | 12.664 |
| tiobe / Ada / example | off | 0.320 | 0.795 | 0.556 |
| tiobe / Ada / large | off | 4.204 | 11.741 | 7.810 |
| tiobe / Swift / example | off | 0.589 | 1.693 | 1.045 |
| tiobe / Swift / large | off | 7.730 | 25.330 | 16.055 |
| tiobe / Objective-C / example | off | 0.653 | 2.060 | 1.116 |
| tiobe / Objective-C / large | off | 6.905 | 29.878 | 14.303 |
| tiobe / COBOL / example | off | 1.076 | 3.766 | 0.848 |
| tiobe / COBOL / large | off | 14.618 | 59.506 | 10.984 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
