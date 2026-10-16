# Ferriki Blacksmith comparison: macos-arm64

Commit: aea84dc7b911c79a86dd3631c698c991c36184b8. Runner: blacksmith-6vcpu-macos-26. CPU: Apple M4 Pro (Virtual). Node: v24.21.0.
Corpus scope: comparison, curated, tiobe.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| Repository / warm total | on | 79.811 | 330.214 | unsupported |
| Repository / cold total | on | 562.752 | 1224.098 | unsupported |
| Repository / warm total | off | 118.422 | 320.270 | unsupported |
| Repository / cold total | off | 403.458 | 1201.137 | unsupported |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |
| JSON | example | 0.158 | 0.128 | -19.08% |
| JSON | large | 2.421 | 2.263 | -6.51% |
| Astro | example | 1.738 | 2.287 | 31.58% |
| Astro | large | 16.247 | 21.795 | 34.15% |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| curated / TypeScript / example | on | 1.080 | 4.312 | 6.464 |
| curated / TypeScript / large | on | 12.138 | 65.691 | 96.347 |
| curated / TSX / example | on | 1.168 | 4.617 | 5.017 |
| curated / TSX / large | on | 13.787 | 73.165 | 77.556 |
| curated / Rust / example | on | 0.212 | 1.322 | 0.531 |
| curated / Rust / large | on | 3.121 | 20.878 | 8.627 |
| curated / CSS / example | on | 0.404 | 2.950 | 0.646 |
| curated / CSS / large | on | 4.551 | 46.822 | 9.204 |
| curated / HTML / example | on | 0.896 | 3.871 | 2.965 |
| curated / HTML / large | on | 9.381 | 59.314 | 42.496 |
| curated / C++ / example | on | 0.878 | 3.451 | 3.061 |
| curated / C++ / large | on | 6.699 | 49.715 | 41.687 |
| curated / Swift / example | on | 0.403 | 1.875 | 0.998 |
| curated / Swift / large | on | 4.210 | 27.819 | 14.123 |
| curated / Java / example | on | 0.278 | 1.229 | 0.752 |
| curated / Java / large | on | 3.066 | 17.908 | 10.748 |
| curated / Markdown / example | on | 0.589 | 1.496 | 2.153 |
| curated / Markdown / large | on | 4.361 | 18.726 | 28.122 |
| curated / TOML / example | on | 0.098 | 0.219 | 0.167 |
| curated / TOML / large | on | 1.299 | 3.182 | 2.347 |
| curated / YAML / example | on | 1.455 | 1.410 | unsupported |
| curated / YAML / large | on | 23.553 | 22.177 | unsupported |
| curated / JSON / example | on | 0.158 | 0.355 | 0.288 |
| curated / JSON / large | on | 2.421 | 5.705 | 4.630 |
| curated / Astro / example | on | 1.738 | 5.628 | 5.377 |
| curated / Astro / large | on | 16.247 | 65.800 | 64.654 |
| curated / Svelte / example | on | 1.574 | 5.609 | 6.371 |
| curated / Svelte / large | on | 18.624 | 89.526 | 101.121 |
| curated / Ruby / example | on | 0.231 | 1.868 | 0.828 |
| curated / Ruby / large | on | 2.955 | 29.536 | 12.847 |
| curated / Python / example | on | 0.374 | 1.773 | 1.008 |
| curated / Python / large | on | 4.302 | 27.655 | 14.560 |
| curated / Vue / example | on | 0.936 | 2.632 | 2.861 |
| curated / Vue / large | on | 10.022 | 38.053 | 43.405 |
| curated / MDX / example | on | 0.538 | 2.012 | 3.059 |
| curated / MDX / large | on | 5.604 | 29.631 | 46.202 |
| curated / SCSS / example | on | 0.349 | 3.150 | 0.628 |
| curated / SCSS / large | on | 3.125 | 41.534 | 7.659 |
| curated / Bash / example | on | 0.287 | 0.930 | 0.607 |
| curated / Bash / large | on | 4.496 | 15.331 | 10.066 |
| curated / TypeScript / example | off | 1.968 | 4.316 | 6.302 |
| curated / TypeScript / large | off | 27.881 | 63.168 | 94.002 |
| curated / TSX / example | off | 2.239 | 5.115 | 5.390 |
| curated / TSX / large | off | 28.841 | 63.806 | 73.774 |
| curated / Rust / example | off | 0.248 | 1.321 | 0.556 |
| curated / Rust / large | off | 3.209 | 18.983 | 7.265 |
| curated / CSS / example | off | 0.415 | 2.984 | 0.651 |
| curated / CSS / large | off | 4.348 | 41.978 | 8.299 |
| curated / HTML / example | off | 1.070 | 3.600 | 2.554 |
| curated / HTML / large | off | 16.345 | 58.880 | 42.847 |
| curated / C++ / example | off | 1.636 | 3.570 | 2.989 |
| curated / C++ / large | off | 15.271 | 48.518 | 39.009 |
| curated / Swift / example | off | 0.382 | 1.465 | 0.773 |
| curated / Swift / large | off | 5.056 | 21.520 | 11.626 |
| curated / Java / example | off | 0.317 | 1.161 | 0.739 |
| curated / Java / large | off | 3.404 | 14.735 | 9.289 |
| curated / Markdown / example | off | 0.381 | 1.098 | 1.548 |
| curated / Markdown / large | off | 5.260 | 17.391 | 25.557 |
| curated / TOML / example | off | 0.090 | 0.205 | 0.153 |
| curated / TOML / large | off | 1.281 | 3.054 | 2.292 |
| curated / YAML / example | off | 1.175 | 1.331 | unsupported |
| curated / YAML / large | off | 17.156 | 19.649 | unsupported |
| curated / JSON / example | off | 0.128 | 0.301 | 0.246 |
| curated / JSON / large | off | 2.263 | 5.371 | 4.398 |
| curated / Astro / example | off | 2.287 | 5.376 | 5.185 |
| curated / Astro / large | off | 21.795 | 55.482 | 57.723 |
| curated / Svelte / example | off | 2.388 | 5.709 | 6.225 |
| curated / Svelte / large | off | 30.943 | 77.466 | 91.539 |
| curated / Ruby / example | off | 0.252 | 1.656 | 0.735 |
| curated / Ruby / large | off | 3.526 | 26.688 | 11.246 |
| curated / Python / example | off | 0.335 | 1.551 | 0.876 |
| curated / Python / large | off | 4.822 | 25.037 | 13.901 |
| curated / Vue / example | off | 1.162 | 2.137 | 2.377 |
| curated / Vue / large | off | 17.171 | 30.522 | 34.575 |
| curated / MDX / example | off | 0.599 | 1.833 | 2.715 |
| curated / MDX / large | off | 7.490 | 26.278 | 40.022 |
| curated / SCSS / example | off | 0.289 | 3.011 | 0.577 |
| curated / SCSS / large | off | 4.008 | 47.187 | 7.982 |
| curated / Bash / example | off | 0.341 | 0.949 | 0.640 |
| curated / Bash / large | off | 5.065 | 15.260 | 10.409 |
| tiobe / Python / example | on | 0.258 | 1.472 | 0.850 |
| tiobe / Python / large | on | 3.766 | 22.808 | 12.724 |
| tiobe / C / example | on | 0.246 | 1.772 | 0.984 |
| tiobe / C / large | on | 3.228 | 26.948 | 15.271 |
| tiobe / C++ / example | on | 0.498 | 2.724 | 2.258 |
| tiobe / C++ / large | on | 5.929 | 42.506 | 35.084 |
| tiobe / Java / example | on | 0.193 | 1.017 | 0.636 |
| tiobe / Java / large | on | 2.689 | 15.958 | 9.741 |
| tiobe / C# / example | on | 0.305 | 1.204 | 1.875 |
| tiobe / C# / large | on | 4.127 | 17.341 | 28.996 |
| tiobe / JavaScript / example | on | 0.959 | 4.809 | 5.740 |
| tiobe / JavaScript / large | on | 11.163 | 74.023 | 86.649 |
| tiobe / Visual Basic / example | on | 0.269 | 1.049 | 0.353 |
| tiobe / Visual Basic / large | on | 4.391 | 17.518 | 5.860 |
| tiobe / SQL / example | on | 0.398 | 2.951 | 0.534 |
| tiobe / SQL / large | on | 4.875 | 44.576 | 7.120 |
| tiobe / R / example | on | 0.249 | 1.898 | 0.878 |
| tiobe / R / large | on | 2.974 | 28.119 | 12.953 |
| tiobe / Rust / example | on | 0.227 | 1.380 | 0.568 |
| tiobe / Rust / large | on | 3.047 | 21.410 | 8.301 |
| tiobe / Fortran / example | on | 0.578 | 2.036 | 1.328 |
| tiobe / Fortran / large | on | 5.873 | 29.016 | 17.993 |
| tiobe / Go / example | on | 0.311 | 1.546 | 0.665 |
| tiobe / Go / large | on | 4.003 | 22.758 | 9.435 |
| tiobe / Delphi/Object Pascal / example | on | 0.198 | 0.843 | 0.243 |
| tiobe / Delphi/Object Pascal / large | on | 2.842 | 13.178 | 3.549 |
| tiobe / PHP / example | on | 0.327 | 1.986 | 0.789 |
| tiobe / PHP / large | on | 3.167 | 28.379 | 10.037 |
| tiobe / Assembly language / example | on | 0.159 | 2.516 | 0.908 |
| tiobe / Assembly language / large | on | 1.817 | 40.810 | 13.134 |
| tiobe / Ada / example | on | 0.264 | 0.778 | 0.492 |
| tiobe / Ada / large | on | 3.287 | 11.114 | 6.905 |
| tiobe / Swift / example | on | 0.320 | 1.715 | 0.914 |
| tiobe / Swift / large | on | 3.752 | 25.269 | 12.682 |
| tiobe / Objective-C / example | on | 0.279 | 1.992 | 0.874 |
| tiobe / Objective-C / large | on | 3.584 | 32.336 | 13.357 |
| tiobe / COBOL / example | on | 1.119 | 5.112 | 0.805 |
| tiobe / COBOL / large | on | 14.938 | 73.303 | 10.214 |
| tiobe / Python / example | off | 0.380 | 1.659 | 0.968 |
| tiobe / Python / large | off | 4.663 | 24.800 | 14.094 |
| tiobe / C / example | off | 0.488 | 1.922 | 1.047 |
| tiobe / C / large | off | 6.368 | 29.392 | 15.448 |
| tiobe / C++ / example | off | 1.129 | 2.831 | 2.364 |
| tiobe / C++ / large | off | 14.362 | 43.316 | 36.019 |
| tiobe / Java / example | off | 0.250 | 1.031 | 0.661 |
| tiobe / Java / large | off | 4.000 | 17.646 | 10.977 |
| tiobe / C# / example | off | 0.858 | 1.284 | 1.942 |
| tiobe / C# / large | off | 12.646 | 19.018 | 31.665 |
| tiobe / JavaScript / example | off | 2.513 | 5.890 | 6.849 |
| tiobe / JavaScript / large | off | 30.225 | 77.106 | 90.908 |
| tiobe / Visual Basic / example | off | 0.273 | 1.074 | 0.365 |
| tiobe / Visual Basic / large | off | 3.999 | 17.484 | 5.312 |
| tiobe / SQL / example | off | 0.297 | 2.401 | 0.426 |
| tiobe / SQL / large | off | 4.192 | 38.403 | 6.141 |
| tiobe / R / example | off | 0.221 | 1.538 | 0.694 |
| tiobe / R / large | off | 3.175 | 24.761 | 10.922 |
| tiobe / Rust / example | off | 0.216 | 1.208 | 0.500 |
| tiobe / Rust / large | off | 3.046 | 18.366 | 7.530 |
| tiobe / Fortran / example | off | 0.574 | 1.847 | 1.179 |
| tiobe / Fortran / large | off | 7.619 | 28.650 | 17.486 |
| tiobe / Go / example | off | 0.480 | 1.623 | 0.750 |
| tiobe / Go / large | off | 5.222 | 21.610 | 8.719 |
| tiobe / Delphi/Object Pascal / example | off | 0.145 | 0.812 | 0.235 |
| tiobe / Delphi/Object Pascal / large | off | 2.152 | 12.939 | 3.484 |
| tiobe / PHP / example | off | 0.559 | 2.025 | 0.824 |
| tiobe / PHP / large | off | 5.028 | 28.783 | 9.594 |
| tiobe / Assembly language / example | off | 0.416 | 2.593 | 0.979 |
| tiobe / Assembly language / large | off | 5.216 | 40.870 | 13.416 |
| tiobe / Ada / example | off | 0.311 | 0.814 | 0.514 |
| tiobe / Ada / large | off | 3.511 | 11.343 | 6.939 |
| tiobe / Swift / example | off | 0.386 | 1.451 | 0.794 |
| tiobe / Swift / large | off | 5.110 | 22.033 | 11.362 |
| tiobe / Objective-C / example | off | 0.393 | 1.786 | 0.807 |
| tiobe / Objective-C / large | off | 5.295 | 27.912 | 11.582 |
| tiobe / COBOL / example | off | 0.914 | 4.440 | 0.662 |
| tiobe / COBOL / large | off | 13.516 | 70.753 | 9.285 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
