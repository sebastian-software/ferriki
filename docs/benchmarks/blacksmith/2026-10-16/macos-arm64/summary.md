# Ferriki Blacksmith comparison: macos-arm64

Commit: c18c0127bad274072ee81f9e1e9d4dc142f978da. Runner: blacksmith-6vcpu-macos-26. CPU: Apple M4 Pro (Virtual). Node: v24.21.0.

Warm HTML medians reuse highlighters. Cold measurements use fresh processes and include imports, setup and one full-corpus render; process creation and asset downloads are excluded. Smaller values are faster. The prefilter is enabled by default. These are observations on this host, not a comparison with an earlier Ferroni release.

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| Repository / warm total | on | 76.035 | 402.980 | unsupported |
| Repository / cold total | on | 538.832 | 1292.384 | unsupported |
| Repository / warm total | off | 106.373 | 381.236 | unsupported |
| Repository / cold total | off | 360.412 | 1179.689 | unsupported |

## JSON and Astro with reused highlighters

| Language | Size | Prefilter on ms | Prefilter off ms | Off vs. on |
| --- | --- | ---: | ---: | ---: |
| JSON | example | 0.124 | 0.155 | 25.56% |
| JSON | large | 1.877 | 2.293 | 22.17% |
| Astro | example | 1.190 | 2.373 | 99.46% |
| Astro | large | 13.004 | 23.226 | 78.61% |

## All warm workloads

| Corpus / workload | Prefilter | Ferriki ms | Shiki WASM ms | Shiki JS ms |
| --- | --- | ---: | ---: | ---: |
| curated / TypeScript / example | on | 1.211 | 6.248 | 15.946 |
| curated / TypeScript / large | on | 11.514 | 91.911 | 245.216 |
| curated / TSX / example | on | 1.523 | 8.434 | 18.844 |
| curated / TSX / large | on | 14.776 | 119.086 | 273.420 |
| curated / Rust / example | on | 0.202 | 1.260 | 0.916 |
| curated / Rust / large | on | 2.900 | 20.086 | 14.043 |
| curated / CSS / example | on | 0.438 | 3.046 | 0.724 |
| curated / CSS / large | on | 4.836 | 46.658 | 10.735 |
| curated / HTML / example | on | 1.032 | 6.189 | 8.508 |
| curated / HTML / large | on | 9.695 | 96.172 | 129.486 |
| curated / C++ / example | on | 0.752 | 3.374 | 4.972 |
| curated / C++ / large | on | 6.455 | 46.598 | 73.041 |
| curated / Swift / example | on | 0.249 | 1.491 | 0.979 |
| curated / Swift / large | on | 3.404 | 22.109 | 15.105 |
| curated / Java / example | on | 0.180 | 0.963 | 0.858 |
| curated / Java / large | on | 2.700 | 15.419 | 13.752 |
| curated / Markdown / example | on | 0.296 | 1.071 | 2.055 |
| curated / Markdown / large | on | 4.191 | 17.964 | 37.337 |
| curated / TOML / example | on | 0.080 | 0.186 | 0.142 |
| curated / TOML / large | on | 1.071 | 2.629 | 1.937 |
| curated / YAML / example | on | 1.245 | 1.148 | unsupported |
| curated / YAML / large | on | 20.059 | 18.380 | unsupported |
| curated / JSON / example | on | 0.124 | 0.283 | 0.251 |
| curated / JSON / large | on | 1.877 | 4.415 | 3.924 |
| curated / Astro / example | on | 1.190 | 8.653 | 16.675 |
| curated / Astro / large | on | 13.004 | 103.747 | 199.618 |
| curated / Svelte / example | on | 1.178 | 8.758 | 21.514 |
| curated / Svelte / large | on | 14.522 | 134.028 | 324.917 |
| curated / Ruby / example | on | 0.162 | 1.511 | 1.317 |
| curated / Ruby / large | on | 2.322 | 23.401 | 20.495 |
| curated / Python / example | on | 0.231 | 1.390 | 1.109 |
| curated / Python / large | on | 3.468 | 21.371 | 17.042 |
| curated / Vue / example | on | 0.537 | 1.909 | 2.811 |
| curated / Vue / large | on | 7.709 | 28.629 | 43.797 |
| curated / MDX / example | on | 0.327 | 1.559 | 3.690 |
| curated / MDX / large | on | 4.367 | 22.773 | 57.405 |
| curated / SCSS / example | on | 0.191 | 2.567 | 0.540 |
| curated / SCSS / large | on | 2.839 | 40.330 | 8.046 |
| curated / Bash / example | on | 0.236 | 0.801 | 0.580 |
| curated / Bash / large | on | 3.583 | 12.278 | 8.925 |
| curated / TypeScript / example | off | 1.621 | 4.892 | 13.481 |
| curated / TypeScript / large | off | 23.243 | 74.076 | 202.580 |
| curated / TSX / example | off | 1.775 | 6.176 | 14.204 |
| curated / TSX / large | off | 28.411 | 104.348 | 239.056 |
| curated / Rust / example | off | 0.210 | 1.195 | 0.851 |
| curated / Rust / large | off | 3.035 | 18.182 | 12.816 |
| curated / CSS / example | off | 0.300 | 2.648 | 0.594 |
| curated / CSS / large | off | 4.445 | 42.061 | 9.139 |
| curated / HTML / example | off | 1.140 | 5.491 | 7.339 |
| curated / HTML / large | off | 17.641 | 95.950 | 128.211 |
| curated / C++ / example | off | 1.919 | 4.046 | 6.025 |
| curated / C++ / large | off | 18.735 | 53.216 | 86.795 |
| curated / Swift / example | off | 0.623 | 1.929 | 1.294 |
| curated / Swift / large | off | 6.048 | 25.347 | 16.597 |
| curated / Java / example | off | 0.294 | 1.150 | 1.026 |
| curated / Java / large | off | 4.105 | 18.584 | 16.953 |
| curated / Markdown / example | off | 0.511 | 1.348 | 2.562 |
| curated / Markdown / large | off | 5.649 | 18.282 | 38.159 |
| curated / TOML / example | off | 0.093 | 0.213 | 0.160 |
| curated / TOML / large | off | 1.371 | 3.333 | 2.476 |
| curated / YAML / example | off | 1.324 | 1.542 | unsupported |
| curated / YAML / large | off | 20.728 | 23.782 | unsupported |
| curated / JSON / example | off | 0.155 | 0.346 | 0.304 |
| curated / JSON / large | off | 2.293 | 5.396 | 4.811 |
| curated / Astro / example | off | 2.373 | 10.745 | 20.364 |
| curated / Astro / large | off | 23.226 | 122.247 | 232.882 |
| curated / Svelte / example | off | 1.879 | 8.782 | 21.476 |
| curated / Svelte / large | off | 26.809 | 134.446 | 337.940 |
| curated / Ruby / example | off | 0.217 | 1.527 | 1.329 |
| curated / Ruby / large | off | 3.156 | 23.504 | 20.596 |
| curated / Python / example | off | 0.284 | 1.380 | 1.099 |
| curated / Python / large | off | 4.175 | 21.252 | 16.845 |
| curated / Vue / example | off | 1.048 | 1.911 | 2.820 |
| curated / Vue / large | off | 15.668 | 28.946 | 44.282 |
| curated / MDX / example | off | 0.549 | 1.703 | 3.952 |
| curated / MDX / large | off | 7.936 | 26.401 | 66.460 |
| curated / SCSS / example | off | 0.283 | 2.965 | 0.652 |
| curated / SCSS / large | off | 4.062 | 46.305 | 9.697 |
| curated / Bash / example | off | 0.331 | 0.925 | 0.673 |
| curated / Bash / large | off | 4.805 | 14.314 | 10.484 |
| tiobe / Python / example | on | 0.287 | 1.628 | 1.284 |
| tiobe / Python / large | on | 4.093 | 24.409 | 19.743 |
| tiobe / C / example | on | 0.225 | 1.791 | 1.562 |
| tiobe / C / large | on | 3.263 | 27.129 | 23.964 |
| tiobe / C++ / example | on | 0.556 | 3.063 | 4.581 |
| tiobe / C++ / large | on | 6.329 | 44.922 | 69.619 |
| tiobe / Java / example | on | 0.199 | 1.056 | 0.945 |
| tiobe / Java / large | on | 2.906 | 16.590 | 14.554 |
| tiobe / C# / example | on | 0.313 | 1.225 | 3.207 |
| tiobe / C# / large | on | 4.367 | 18.017 | 49.783 |
| tiobe / JavaScript / example | on | 1.202 | 7.847 | 16.511 |
| tiobe / JavaScript / large | on | 12.326 | 118.172 | 253.670 |
| tiobe / Visual Basic / example | on | 0.298 | 1.083 | 0.489 |
| tiobe / Visual Basic / large | on | 4.379 | 17.116 | 7.650 |
| tiobe / SQL / example | on | 0.312 | 2.607 | 0.660 |
| tiobe / SQL / large | on | 4.463 | 40.946 | 9.656 |
| tiobe / R / example | on | 0.210 | 1.739 | 1.176 |
| tiobe / R / large | on | 2.664 | 25.719 | 17.099 |
| tiobe / Rust / example | on | 0.184 | 1.168 | 0.838 |
| tiobe / Rust / large | on | 2.700 | 18.046 | 13.143 |
| tiobe / Fortran / example | on | 0.417 | 1.681 | 1.270 |
| tiobe / Fortran / large | on | 5.433 | 25.495 | 18.703 |
| tiobe / Go / example | on | 0.253 | 1.289 | 0.840 |
| tiobe / Go / large | on | 3.460 | 19.785 | 12.596 |
| tiobe / Delphi/Object Pascal / example | on | 0.157 | 0.742 | 0.230 |
| tiobe / Delphi/Object Pascal / large | on | 2.560 | 11.692 | 3.504 |
| tiobe / PHP / example | on | 0.233 | 1.655 | 0.877 |
| tiobe / PHP / large | on | 2.897 | 25.601 | 13.398 |
| tiobe / Assembly language / example | on | 0.144 | 2.270 | 1.350 |
| tiobe / Assembly language / large | on | 1.678 | 35.401 | 20.754 |
| tiobe / Ada / example | on | 0.203 | 0.640 | 0.440 |
| tiobe / Ada / large | on | 3.045 | 10.014 | 6.817 |
| tiobe / Swift / example | on | 0.260 | 1.449 | 0.961 |
| tiobe / Swift / large | on | 3.467 | 23.371 | 15.776 |
| tiobe / Objective-C / example | on | 0.279 | 1.933 | 1.315 |
| tiobe / Objective-C / large | on | 3.334 | 28.555 | 19.223 |
| tiobe / COBOL / example | on | 1.001 | 4.694 | 1.167 |
| tiobe / COBOL / large | on | 13.772 | 70.296 | 15.899 |
| tiobe / Python / example | off | 0.335 | 1.530 | 1.229 |
| tiobe / Python / large | off | 4.607 | 23.272 | 18.719 |
| tiobe / C / example | off | 0.402 | 1.687 | 1.458 |
| tiobe / C / large | off | 5.535 | 25.732 | 22.450 |
| tiobe / C++ / example | off | 0.931 | 2.590 | 3.913 |
| tiobe / C++ / large | off | 13.011 | 38.510 | 60.632 |
| tiobe / Java / example | off | 0.222 | 0.934 | 0.827 |
| tiobe / Java / large | off | 3.260 | 14.199 | 12.649 |
| tiobe / C# / example | off | 0.733 | 1.087 | 2.779 |
| tiobe / C# / large | off | 11.114 | 15.930 | 43.567 |
| tiobe / JavaScript / example | off | 1.912 | 6.540 | 14.025 |
| tiobe / JavaScript / large | off | 28.039 | 101.345 | 220.786 |
| tiobe / Visual Basic / example | off | 0.237 | 0.938 | 0.407 |
| tiobe / Visual Basic / large | off | 3.618 | 14.745 | 6.300 |
| tiobe / SQL / example | off | 0.250 | 2.217 | 0.540 |
| tiobe / SQL / large | off | 3.755 | 35.176 | 8.339 |
| tiobe / R / example | off | 0.195 | 1.441 | 0.984 |
| tiobe / R / large | off | 2.838 | 22.435 | 15.132 |
| tiobe / Rust / example | off | 0.189 | 1.087 | 0.764 |
| tiobe / Rust / large | off | 2.856 | 16.977 | 11.798 |
| tiobe / Fortran / example | off | 0.441 | 1.518 | 1.124 |
| tiobe / Fortran / large | off | 6.367 | 23.244 | 17.622 |
| tiobe / Go / example | off | 0.320 | 1.201 | 0.768 |
| tiobe / Go / large | off | 4.744 | 18.246 | 11.630 |
| tiobe / Delphi/Object Pascal / example | off | 0.115 | 0.699 | 0.210 |
| tiobe / Delphi/Object Pascal / large | off | 1.775 | 11.061 | 3.222 |
| tiobe / PHP / example | off | 0.286 | 1.524 | 0.777 |
| tiobe / PHP / large | off | 4.104 | 23.678 | 11.738 |
| tiobe / Assembly language / example | off | 0.299 | 2.135 | 1.294 |
| tiobe / Assembly language / large | off | 4.425 | 34.836 | 20.302 |
| tiobe / Ada / example | off | 0.217 | 0.668 | 0.457 |
| tiobe / Ada / large | off | 3.571 | 11.670 | 8.074 |
| tiobe / Swift / example | off | 0.543 | 1.861 | 1.264 |
| tiobe / Swift / large | off | 6.056 | 26.287 | 18.103 |
| tiobe / Objective-C / example | off | 0.579 | 2.270 | 1.579 |
| tiobe / Objective-C / large | off | 6.451 | 33.794 | 23.051 |
| tiobe / COBOL / example | off | 1.060 | 4.816 | 1.236 |
| tiobe / COBOL / large | off | 15.409 | 80.057 | 18.742 |

All required source and exact TextMate HTML checks passed. Prism uses independent grammars and is retained in raw reports without a TextMate parity claim.

Artifacts retain raw JSON samples, logs, native build receipt, runner context and SHA256SUMS. Optional Phiki availability and output differences are recorded in the repository reports.
