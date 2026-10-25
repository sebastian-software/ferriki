# Ferriki regex modes: linux-x86-64

Commit: ff25d172e86137e8f88a123fcebd409f5e4d2c3c. Node: v24.21.0.
comparison: AMD EPYC (4 cores).
curated: AMD EPYC (4 cores).
tiobe: AMD EPYC (4 cores).

Source Off, Auto (lazy DFA), Eager and prepared Eager are separate contenders. Source contenders do not open prepared archives. All contenders share each corpus VM and rotate within timing rounds. Prepared groups are used only where standard packages exist; custom-only grammars retain source fallback.

Warm medians reuse highlighters. First use includes imports, setup and one repository corpus render in a fresh process; downloads and process creation are excluded. Diagnostics are captured outside timed calls and confirm policy/archive use, not complete group coverage.

| Workload | Ferriki source Off | Ferriki source Auto (lazy DFA) | Ferriki source Eager | Ferriki prepared Eager | Shiki WASM | Shiki JS | Prism (independent grammars) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Repository / warm ms | 149.131 | 106.707 | 106.276 | 192.486 | 376.536 | unsupported | unsupported |
| Repository / first use ms | 253.798 | 449.868 | 558.463 | 954.952 | 1170.832 | unsupported | unsupported |
| curated / TypeScript / example ms | 1.739 | 0.756 | 0.726 | 0.712 | 3.548 | 4.402 | 0.199 |
| curated / TypeScript / large ms | 26.029 | 10.908 | 10.730 | 10.672 | 54.887 | 67.676 | 2.132 |
| curated / TSX / example ms | 1.906 | 0.908 | 0.876 | 0.863 | 4.098 | 3.894 | 0.310 |
| curated / TSX / large ms | 28.569 | 13.257 | 13.164 | 13.156 | 64.223 | 60.326 | 3.585 |
| curated / Rust / example ms | 0.252 | 0.197 | 0.187 | 0.182 | 1.259 | 0.585 | 0.103 |
| curated / Rust / large ms | 3.296 | 2.780 | 2.760 | 2.717 | 18.886 | 8.027 | 1.068 |
| curated / CSS / example ms | 0.331 | 0.319 | 0.304 | 0.291 | 2.433 | 0.652 | 0.081 |
| curated / CSS / large ms | 4.083 | 4.299 | 4.280 | 4.106 | 37.228 | 9.476 | 0.993 |
| curated / HTML / example ms | 1.103 | 0.667 | 0.654 | 0.629 | 3.296 | 2.515 | 0.217 |
| curated / HTML / large ms | 15.950 | 9.663 | 9.708 | 9.533 | 52.162 | 38.872 | 2.803 |
| curated / C++ / example ms | 1.122 | 0.500 | 0.480 | 0.449 | 2.706 | 2.705 | 0.107 |
| curated / C++ / large ms | 15.745 | 6.703 | 6.620 | 6.440 | 40.341 | 38.691 | 1.127 |
| curated / Swift / example ms | 0.436 | 0.265 | 0.247 | 0.235 | 1.453 | 0.889 | 0.086 |
| curated / Swift / large ms | 5.442 | 3.370 | 3.257 | 3.126 | 21.363 | 12.098 | 0.983 |
| curated / Java / example ms | 0.325 | 0.224 | 0.209 | 0.204 | 1.111 | 0.734 | 0.103 |
| curated / Java / large ms | 3.885 | 2.836 | 2.795 | 2.763 | 16.179 | 10.163 | 1.277 |
| curated / Markdown / example ms | 0.482 | 0.338 | 0.318 | 0.301 | 1.163 | 1.560 | 0.146 |
| curated / Markdown / large ms | 5.957 | 4.368 | 4.263 | 4.133 | 16.730 | 23.026 | 1.381 |
| curated / TOML / example ms | 0.093 | 0.085 | 0.087 | 0.086 | 0.216 | 0.172 | 0.031 |
| curated / TOML / large ms | 1.288 | 1.250 | 1.287 | 1.263 | 3.229 | 2.600 | 0.441 |
| curated / YAML / example ms | 1.209 | 1.511 | 1.495 | 1.479 | 1.279 | unsupported | 0.061 |
| curated / YAML / large ms | 17.883 | 23.830 | 23.800 | 23.763 | 18.873 | unsupported | 0.571 |
| curated / JSON / example ms | 0.143 | 0.136 | 0.157 | 0.153 | 0.353 | 0.300 | 0.049 |
| curated / JSON / large ms | 2.234 | 2.166 | 2.471 | 2.424 | 5.406 | 4.649 | 0.728 |
| curated / Astro / example ms | 2.002 | 1.331 | 1.586 | 1.240 | 4.372 | 3.939 | unsupported |
| curated / Astro / large ms | 22.806 | 15.489 | 20.103 | 15.329 | 53.385 | 51.167 | unsupported |
| curated / Svelte / example ms | 2.062 | 1.201 | 1.346 | 1.134 | 4.506 | 4.651 | unsupported |
| curated / Svelte / large ms | 30.185 | 16.741 | 19.451 | 16.716 | 68.688 | 71.528 | unsupported |
| curated / Ruby / example ms | 0.312 | 0.201 | 0.195 | 0.189 | 1.602 | 0.812 | 0.114 |
| curated / Ruby / large ms | 3.703 | 2.693 | 2.726 | 2.678 | 24.378 | 10.851 | 1.286 |
| curated / Python / example ms | 0.407 | 0.300 | 0.282 | 0.273 | 1.622 | 0.974 | 0.130 |
| curated / Python / large ms | 5.003 | 4.055 | 3.994 | 3.928 | 24.180 | 13.427 | 1.502 |
| curated / Vue / example ms | 1.209 | 0.632 | 0.604 | 0.590 | 2.037 | 2.121 | unsupported |
| curated / Vue / large ms | 17.835 | 9.109 | 8.915 | 8.796 | 32.265 | 33.227 | unsupported |
| curated / MDX / example ms | 0.682 | 0.418 | 0.390 | 0.369 | 1.769 | 2.381 | unsupported |
| curated / MDX / large ms | 8.934 | 5.654 | 5.447 | 5.235 | 26.546 | 36.488 | unsupported |
| curated / SCSS / example ms | 0.339 | 0.255 | 0.240 | 0.227 | 2.560 | 0.647 | 0.129 |
| curated / SCSS / large ms | 4.045 | 3.275 | 3.231 | 3.075 | 39.115 | 8.721 | 1.528 |
| curated / Bash / example ms | 0.398 | 0.303 | 0.289 | 0.281 | 0.979 | 0.697 | 0.119 |
| curated / Bash / large ms | 4.884 | 4.050 | 4.008 | 3.952 | 13.705 | 9.807 | 1.300 |
| tiobe / Python / example ms | 0.407 | 0.303 | 0.285 | 0.275 | 1.636 | 0.979 | 0.130 |
| tiobe / Python / large ms | 5.047 | 4.133 | 4.066 | 4.010 | 24.280 | 13.589 | 1.515 |
| tiobe / C / example ms | 0.482 | 0.245 | 0.228 | 0.222 | 1.680 | 1.005 | 0.092 |
| tiobe / C / large ms | 6.198 | 3.225 | 3.185 | 3.142 | 24.985 | 14.308 | 1.119 |
| tiobe / C++ / example ms | 1.132 | 0.503 | 0.484 | 0.454 | 2.711 | 2.700 | 0.108 |
| tiobe / C++ / large ms | 15.740 | 6.699 | 6.678 | 6.469 | 40.496 | 39.717 | 1.104 |
| tiobe / Java / example ms | 0.325 | 0.225 | 0.210 | 0.205 | 1.117 | 0.732 | 0.104 |
| tiobe / Java / large ms | 3.875 | 2.845 | 2.809 | 2.770 | 16.383 | 10.119 | 1.297 |
| tiobe / C# / example ms | 0.919 | 0.333 | 0.315 | 0.306 | 1.232 | 1.666 | 0.221 |
| tiobe / C# / large ms | 12.942 | 4.349 | 4.297 | 4.195 | 17.401 | 23.818 | 2.462 |
| tiobe / JavaScript / example ms | 2.065 | 0.842 | 0.811 | 0.795 | 4.431 | 4.576 | 0.237 |
| tiobe / JavaScript / large ms | 30.863 | 11.995 | 11.767 | 11.829 | 68.954 | 70.200 | 2.259 |
| tiobe / Visual Basic / example ms | 0.318 | 0.294 | 0.290 | 0.275 | 1.001 | 0.416 | 0.058 |
| tiobe / Visual Basic / large ms | 4.287 | 4.121 | 4.201 | 4.072 | 14.743 | 5.811 | 0.713 |
| tiobe / SQL / example ms | 0.336 | 0.284 | 0.271 | 5.412 | 2.036 | 0.494 | 0.076 |
| tiobe / SQL / large ms | 3.994 | 3.779 | 3.773 | 83.688 | 30.787 | 6.561 | 0.896 |
| tiobe / R / example ms | 0.269 | 0.196 | 0.187 | 0.181 | 1.445 | 0.743 | 0.055 |
| tiobe / R / large ms | 3.388 | 2.713 | 2.706 | 2.637 | 21.976 | 10.594 | 0.721 |
| tiobe / Rust / example ms | 0.251 | 0.196 | 0.185 | 0.183 | 1.244 | 0.579 | 0.101 |
| tiobe / Rust / large ms | 3.292 | 2.779 | 2.755 | 2.715 | 18.742 | 8.161 | 1.067 |
| tiobe / Fortran / example ms | 0.629 | 0.433 | 0.418 | 0.405 | 1.750 | 1.159 | 0.072 |
| tiobe / Fortran / large ms | 8.237 | 6.135 | 6.014 | 5.958 | 26.436 | 16.796 | 0.802 |
| tiobe / Go / example ms | 0.445 | 0.286 | 0.267 | 0.255 | 1.364 | 0.685 | 0.068 |
| tiobe / Go / large ms | 5.579 | 3.597 | 3.535 | 3.351 | 19.939 | 9.057 | 0.807 |
| tiobe / Delphi/Object Pascal / example ms | 0.144 | 0.179 | 0.168 | 0.161 | 0.768 | 0.263 | 0.074 |
| tiobe / Delphi/Object Pascal / large ms | 1.963 | 2.406 | 2.350 | 2.302 | 11.576 | 3.723 | 0.864 |
| tiobe / PHP / example ms | 0.391 | 0.235 | 0.219 | 0.208 | 1.672 | 0.773 | 0.166 |
| tiobe / PHP / large ms | 4.841 | 3.043 | 3.007 | 2.911 | 25.265 | 9.881 | 1.507 |
| tiobe / Assembly language / example ms | 0.311 | 0.136 | 0.119 | 0.113 | 2.230 | 0.877 | 0.038 |
| tiobe / Assembly language / large ms | 3.703 | 1.610 | 1.549 | 1.518 | 34.059 | 11.813 | 0.366 |
| tiobe / Ada / example ms | 0.264 | 0.232 | 0.223 | 0.210 | 0.755 | 0.517 | 0.077 |
| tiobe / Ada / large ms | 3.304 | 3.080 | 3.053 | 2.977 | 10.710 | 7.063 | 0.988 |
| tiobe / Swift / example ms | 0.432 | 0.266 | 0.247 | 0.234 | 1.447 | 0.885 | 0.085 |
| tiobe / Swift / large ms | 5.500 | 3.459 | 3.369 | 3.212 | 21.363 | 12.121 | 0.972 |
| tiobe / Objective-C / example ms | 0.467 | 0.246 | 0.232 | 0.219 | 1.740 | 0.919 | 0.077 |
| tiobe / Objective-C / large ms | 6.000 | 3.286 | 3.226 | 3.157 | 26.419 | 12.849 | 0.877 |
| tiobe / COBOL / example ms | 0.803 | 0.719 | 0.706 | 0.698 | 3.542 | 0.738 | 0.079 |
| tiobe / COBOL / large ms | 11.041 | 10.705 | 10.595 | 10.668 | 54.901 | 9.933 | 0.988 |

All required exact native/Shiki HTML checks and regex-mode diagnostics passed. Prism uses independent grammars and has no TextMate parity claim.

