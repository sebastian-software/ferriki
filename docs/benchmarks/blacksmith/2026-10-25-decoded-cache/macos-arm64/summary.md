# Ferriki regex modes: macos-arm64

Commit: ff25d172e86137e8f88a123fcebd409f5e4d2c3c. Node: v24.21.0.
comparison: Apple M4 Pro (Virtual) (6 cores).
curated: Apple M4 Pro (Virtual) (6 cores).
tiobe: Apple M4 Pro (Virtual) (6 cores).

Source Off, Auto (lazy DFA), Eager and prepared Eager are separate contenders. Source contenders do not open prepared archives. All contenders share each corpus VM and rotate within timing rounds. Prepared groups are used only where standard packages exist; custom-only grammars retain source fallback.

Warm medians reuse highlighters. First use includes imports, setup and one repository corpus render in a fresh process; downloads and process creation are excluded. Diagnostics are captured outside timed calls and confirm policy/archive use, not complete group coverage.

| Workload | Ferriki source Off | Ferriki source Auto (lazy DFA) | Ferriki source Eager | Ferriki prepared Eager | Shiki WASM | Shiki JS | Prism (independent grammars) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Repository / warm ms | 117.168 | 78.077 | 77.183 | 111.239 | 324.776 | unsupported | unsupported |
| Repository / first use ms | 212.247 | 327.011 | 404.824 | 501.929 | 1102.931 | unsupported | unsupported |
| curated / TypeScript / example ms | 1.860 | 0.899 | 0.826 | 0.819 | 3.971 | 5.695 | 0.223 |
| curated / TypeScript / large ms | 24.907 | 9.838 | 9.684 | 9.565 | 54.451 | 80.668 | 2.288 |
| curated / TSX / example ms | 1.903 | 0.917 | 0.881 | 0.885 | 4.322 | 4.558 | 0.324 |
| curated / TSX / large ms | 29.789 | 12.660 | 12.391 | 12.710 | 69.514 | 73.932 | 4.111 |
| curated / Rust / example ms | 0.196 | 0.156 | 0.152 | 0.153 | 1.194 | 0.497 | 0.090 |
| curated / Rust / large ms | 2.925 | 2.435 | 2.373 | 2.398 | 18.494 | 7.425 | 1.236 |
| curated / CSS / example ms | 0.273 | 0.302 | 0.302 | 0.300 | 2.812 | 0.579 | 0.081 |
| curated / CSS / large ms | 3.626 | 3.850 | 3.819 | 3.677 | 42.748 | 8.228 | 1.002 |
| curated / HTML / example ms | 1.003 | 0.599 | 0.592 | 0.598 | 3.418 | 2.466 | 0.198 |
| curated / HTML / large ms | 14.532 | 8.049 | 8.082 | 8.093 | 53.082 | 38.160 | 2.404 |
| curated / C++ / example ms | 0.951 | 0.417 | 0.407 | 0.402 | 2.766 | 2.266 | 0.102 |
| curated / C++ / large ms | 13.508 | 5.499 | 5.498 | 5.304 | 42.730 | 36.389 | 1.191 |
| curated / Swift / example ms | 0.329 | 0.196 | 0.188 | 0.186 | 1.383 | 0.723 | 0.074 |
| curated / Swift / large ms | 4.885 | 2.930 | 2.855 | 2.822 | 22.173 | 11.086 | 1.018 |
| curated / Java / example ms | 0.252 | 0.185 | 0.182 | 0.182 | 1.063 | 0.674 | 0.101 |
| curated / Java / large ms | 3.699 | 2.660 | 2.635 | 2.760 | 16.250 | 10.580 | 1.415 |
| curated / Markdown / example ms | 0.408 | 0.297 | 0.286 | 0.279 | 1.188 | 1.684 | 0.132 |
| curated / Markdown / large ms | 4.751 | 3.468 | 3.395 | 3.343 | 15.592 | 22.695 | 1.457 |
| curated / TOML / example ms | 0.077 | 0.074 | 0.076 | 0.076 | 0.193 | 0.142 | 0.032 |
| curated / TOML / large ms | 1.257 | 1.241 | 1.263 | 1.259 | 3.249 | 2.336 | 0.554 |
| curated / YAML / example ms | 1.017 | 1.268 | 1.258 | 1.256 | 1.347 | unsupported | 0.053 |
| curated / YAML / large ms | 15.500 | 19.186 | 19.507 | 19.553 | 19.923 | unsupported | 0.657 |
| curated / JSON / example ms | 0.122 | 0.119 | 0.134 | 0.134 | 0.309 | 0.249 | 0.051 |
| curated / JSON / large ms | 1.862 | 1.809 | 2.020 | 2.011 | 4.758 | 3.854 | 0.808 |
| curated / Astro / example ms | 1.879 | 1.178 | 1.342 | 1.110 | 4.557 | 4.286 | unsupported |
| curated / Astro / large ms | 20.709 | 12.688 | 15.446 | 12.535 | 53.875 | 53.060 | unsupported |
| curated / Svelte / example ms | 1.985 | 1.114 | 1.205 | 1.083 | 4.669 | 5.229 | unsupported |
| curated / Svelte / large ms | 27.805 | 14.005 | 15.644 | 14.145 | 69.124 | 77.905 | unsupported |
| curated / Ruby / example ms | 0.208 | 0.146 | 0.147 | 0.145 | 1.546 | 0.662 | 0.085 |
| curated / Ruby / large ms | 3.125 | 2.206 | 2.247 | 2.227 | 24.022 | 10.217 | 1.286 |
| curated / Python / example ms | 0.285 | 0.226 | 0.220 | 0.220 | 1.410 | 0.779 | 0.104 |
| curated / Python / large ms | 4.237 | 3.438 | 3.391 | 3.392 | 21.649 | 11.699 | 1.488 |
| curated / Vue / example ms | 1.125 | 0.581 | 0.561 | 0.563 | 2.076 | 2.261 | unsupported |
| curated / Vue / large ms | 16.873 | 7.904 | 7.817 | 7.907 | 31.222 | 34.869 | unsupported |
| curated / MDX / example ms | 0.719 | 0.477 | 0.444 | 0.430 | 2.045 | 3.078 | unsupported |
| curated / MDX / large ms | 7.344 | 4.767 | 4.518 | 4.473 | 25.733 | 39.493 | unsupported |
| curated / SCSS / example ms | 0.255 | 0.224 | 0.218 | 0.209 | 2.755 | 0.530 | 0.146 |
| curated / SCSS / large ms | 3.652 | 3.029 | 2.977 | 2.824 | 43.958 | 7.717 | 2.000 |
| curated / Bash / example ms | 0.284 | 0.237 | 0.234 | 0.236 | 0.868 | 0.576 | 0.098 |
| curated / Bash / large ms | 4.229 | 3.630 | 3.552 | 3.517 | 13.161 | 8.547 | 1.420 |
| tiobe / Python / example ms | 0.375 | 0.303 | 0.288 | 0.286 | 1.671 | 0.972 | 0.136 |
| tiobe / Python / large ms | 4.735 | 3.898 | 3.748 | 3.833 | 25.276 | 13.907 | 1.671 |
| tiobe / C / example ms | 0.422 | 0.233 | 0.221 | 0.225 | 1.774 | 0.963 | 0.096 |
| tiobe / C / large ms | 5.539 | 2.956 | 2.851 | 2.872 | 26.412 | 14.323 | 1.210 |
| tiobe / C++ / example ms | 1.343 | 0.699 | 0.658 | 0.653 | 3.490 | 3.097 | 0.133 |
| tiobe / C++ / large ms | 14.269 | 5.806 | 6.006 | 5.868 | 46.825 | 38.681 | 1.252 |
| tiobe / Java / example ms | 0.277 | 0.210 | 0.202 | 0.206 | 1.086 | 0.691 | 0.107 |
| tiobe / Java / large ms | 3.681 | 2.750 | 2.746 | 2.728 | 16.183 | 10.001 | 1.385 |
| tiobe / C# / example ms | 0.854 | 0.319 | 0.307 | 0.308 | 1.291 | 1.970 | 0.210 |
| tiobe / C# / large ms | 11.960 | 3.891 | 3.890 | 3.786 | 17.558 | 28.480 | 2.565 |
| tiobe / JavaScript / example ms | 2.346 | 1.136 | 1.068 | 1.073 | 5.434 | 6.648 | 0.282 |
| tiobe / JavaScript / large ms | 32.265 | 11.797 | 11.787 | 11.589 | 79.555 | 94.844 | 2.581 |
| tiobe / Visual Basic / example ms | 0.269 | 0.277 | 0.275 | 0.267 | 1.084 | 0.388 | 0.060 |
| tiobe / Visual Basic / large ms | 3.999 | 3.995 | 4.093 | 3.925 | 16.180 | 5.447 | 0.772 |
| tiobe / SQL / example ms | 0.310 | 0.276 | 0.264 | 4.479 | 2.524 | 0.474 | 0.090 |
| tiobe / SQL / large ms | 4.341 | 4.091 | 4.043 | 76.791 | 42.287 | 6.793 | 1.126 |
| tiobe / R / example ms | 0.186 | 0.143 | 0.143 | 0.143 | 1.475 | 0.642 | 0.048 |
| tiobe / R / large ms | 2.862 | 2.208 | 2.217 | 2.215 | 23.439 | 10.095 | 0.737 |
| tiobe / Rust / example ms | 0.177 | 0.144 | 0.141 | 0.143 | 1.097 | 0.449 | 0.081 |
| tiobe / Rust / large ms | 2.797 | 2.275 | 2.236 | 2.237 | 17.118 | 6.787 | 1.171 |
| tiobe / Fortran / example ms | 0.450 | 0.336 | 0.344 | 0.320 | 1.609 | 1.018 | 0.069 |
| tiobe / Fortran / large ms | 6.220 | 4.585 | 4.789 | 4.514 | 23.484 | 14.399 | 0.886 |
| tiobe / Go / example ms | 0.316 | 0.198 | 0.195 | 0.187 | 1.190 | 0.502 | 0.054 |
| tiobe / Go / large ms | 4.734 | 3.042 | 3.030 | 2.862 | 18.250 | 7.321 | 0.795 |
| tiobe / Delphi/Object Pascal / example ms | 0.105 | 0.127 | 0.128 | 0.127 | 0.709 | 0.189 | 0.057 |
| tiobe / Delphi/Object Pascal / large ms | 1.623 | 2.012 | 2.013 | 2.007 | 11.374 | 2.830 | 0.896 |
| tiobe / PHP / example ms | 0.255 | 0.154 | 0.152 | 0.152 | 1.503 | 0.539 | 0.111 |
| tiobe / PHP / large ms | 3.741 | 2.333 | 2.318 | 2.328 | 23.434 | 8.033 | 1.623 |
| tiobe / Assembly language / example ms | 0.228 | 0.088 | 0.085 | 0.085 | 2.118 | 0.699 | 0.027 |
| tiobe / Assembly language / large ms | 3.308 | 1.288 | 1.256 | 1.262 | 33.039 | 10.072 | 0.372 |
| tiobe / Ada / example ms | 0.169 | 0.161 | 0.161 | 0.156 | 0.588 | 0.364 | 0.064 |
| tiobe / Ada / large ms | 2.529 | 2.486 | 2.488 | 2.430 | 9.160 | 5.533 | 0.987 |
| tiobe / Swift / example ms | 0.302 | 0.179 | 0.174 | 0.173 | 1.297 | 0.671 | 0.068 |
| tiobe / Swift / large ms | 4.503 | 2.747 | 2.682 | 2.645 | 19.712 | 9.991 | 0.951 |
| tiobe / Objective-C / example ms | 0.328 | 0.170 | 0.167 | 0.164 | 1.629 | 0.699 | 0.063 |
| tiobe / Objective-C / large ms | 5.329 | 2.940 | 2.873 | 2.796 | 26.993 | 11.546 | 0.961 |
| tiobe / COBOL / example ms | 0.922 | 0.855 | 0.829 | 0.824 | 5.201 | 0.825 | 0.108 |
| tiobe / COBOL / large ms | 12.755 | 12.428 | 12.826 | 12.606 | 82.826 | 10.870 | 1.184 |

All required exact native/Shiki HTML checks and regex-mode diagnostics passed. Prism uses independent grammars and has no TextMate parity claim.

