# Ferriki regex modes: linux-x86-64

Commit: 8aba6dd009fa09a3eed895e1764b2f04dbef0f1b. Node: v24.21.0.
comparison: AMD EPYC (4 cores).
curated: AMD EPYC (4 cores).
tiobe: AMD EPYC (4 cores).

Source Off, Auto (lazy DFA), Eager and prepared Eager are separate contenders. Source contenders do not open prepared archives. All contenders share each corpus VM and rotate within timing rounds. Prepared groups are used only where standard packages exist; custom-only grammars retain source fallback.

Warm medians reuse highlighters. First use includes imports, setup and one repository corpus render in a fresh process; downloads and process creation are excluded. Diagnostics are captured outside timed calls and confirm policy/archive use, not complete group coverage.

| Workload | Ferriki source Off | Ferriki source Auto (lazy DFA) | Ferriki source Eager | Ferriki prepared Eager | Shiki WASM | Shiki JS | Prism (independent grammars) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Repository / warm ms | 120.621 | 84.363 | 84.545 | 154.582 | 300.966 | unsupported | unsupported |
| Repository / first use ms | 214.878 | 354.143 | 445.894 | 817.980 | 958.419 | unsupported | unsupported |
| curated / TypeScript / example ms | 1.746 | 0.792 | 0.758 | 0.738 | 3.692 | 4.464 | 0.207 |
| curated / TypeScript / large ms | 25.990 | 10.921 | 10.846 | 10.840 | 56.883 | 68.917 | 2.087 |
| curated / TSX / example ms | 1.894 | 0.904 | 0.883 | 0.868 | 4.036 | 3.897 | 0.305 |
| curated / TSX / large ms | 28.695 | 13.352 | 13.291 | 13.274 | 63.319 | 60.705 | 3.529 |
| curated / Rust / example ms | 0.254 | 0.198 | 0.187 | 0.182 | 1.245 | 0.584 | 0.103 |
| curated / Rust / large ms | 3.298 | 2.775 | 2.755 | 2.716 | 18.426 | 7.837 | 1.052 |
| curated / CSS / example ms | 0.332 | 0.321 | 0.307 | 0.290 | 2.409 | 0.650 | 0.081 |
| curated / CSS / large ms | 4.163 | 4.424 | 4.371 | 4.220 | 36.999 | 9.308 | 0.940 |
| curated / HTML / example ms | 1.110 | 0.691 | 0.664 | 0.641 | 3.306 | 2.512 | 0.222 |
| curated / HTML / large ms | 15.966 | 9.651 | 9.722 | 9.558 | 51.391 | 38.676 | 2.450 |
| curated / C++ / example ms | 1.119 | 0.500 | 0.484 | 0.454 | 2.698 | 2.681 | 0.107 |
| curated / C++ / large ms | 15.800 | 6.664 | 6.663 | 6.437 | 39.840 | 38.727 | 1.079 |
| curated / Swift / example ms | 0.434 | 0.269 | 0.250 | 0.236 | 1.458 | 0.891 | 0.086 |
| curated / Swift / large ms | 5.467 | 3.444 | 3.328 | 3.216 | 21.631 | 12.045 | 0.960 |
| curated / Java / example ms | 0.325 | 0.226 | 0.210 | 0.204 | 1.107 | 0.737 | 0.103 |
| curated / Java / large ms | 3.916 | 2.928 | 2.868 | 2.832 | 16.002 | 10.084 | 1.167 |
| curated / Markdown / example ms | 0.484 | 0.339 | 0.317 | 0.301 | 1.165 | 1.559 | 0.147 |
| curated / Markdown / large ms | 5.972 | 4.350 | 4.302 | 4.188 | 16.666 | 22.980 | 1.374 |
| curated / TOML / example ms | 0.091 | 0.085 | 0.087 | 0.086 | 0.205 | 0.162 | 0.030 |
| curated / TOML / large ms | 1.285 | 1.261 | 1.292 | 1.264 | 3.136 | 2.478 | 0.438 |
| curated / YAML / example ms | 1.216 | 1.523 | 1.501 | 1.491 | 1.284 | unsupported | 0.061 |
| curated / YAML / large ms | 17.936 | 23.946 | 23.935 | 23.868 | 19.025 | unsupported | 0.558 |
| curated / JSON / example ms | 0.143 | 0.136 | 0.157 | 0.152 | 0.343 | 0.292 | 0.049 |
| curated / JSON / large ms | 2.228 | 2.167 | 2.477 | 2.421 | 5.315 | 4.582 | 0.726 |
| curated / Astro / example ms | 2.004 | 1.348 | 1.587 | 1.246 | 4.362 | 3.894 | unsupported |
| curated / Astro / large ms | 23.049 | 15.530 | 20.077 | 15.352 | 53.370 | 51.082 | unsupported |
| curated / Svelte / example ms | 2.046 | 1.202 | 1.333 | 1.132 | 4.449 | 4.610 | unsupported |
| curated / Svelte / large ms | 29.885 | 16.628 | 19.261 | 16.613 | 68.250 | 70.298 | unsupported |
| curated / Ruby / example ms | 0.311 | 0.202 | 0.196 | 0.188 | 1.592 | 0.801 | 0.115 |
| curated / Ruby / large ms | 3.707 | 2.709 | 2.739 | 2.673 | 24.206 | 10.749 | 1.285 |
| curated / Python / example ms | 0.404 | 0.301 | 0.282 | 0.273 | 1.604 | 0.959 | 0.127 |
| curated / Python / large ms | 5.039 | 4.069 | 4.019 | 3.940 | 23.922 | 13.408 | 1.489 |
| curated / Vue / example ms | 1.207 | 0.636 | 0.609 | 0.590 | 2.032 | 2.112 | unsupported |
| curated / Vue / large ms | 17.748 | 9.091 | 8.951 | 8.811 | 31.869 | 32.462 | unsupported |
| curated / MDX / example ms | 0.693 | 0.429 | 0.402 | 0.378 | 1.775 | 2.375 | unsupported |
| curated / MDX / large ms | 9.162 | 5.764 | 5.578 | 5.441 | 27.109 | 36.676 | unsupported |
| curated / SCSS / example ms | 0.337 | 0.255 | 0.240 | 0.227 | 2.521 | 0.639 | 0.127 |
| curated / SCSS / large ms | 4.034 | 3.265 | 3.215 | 3.054 | 38.922 | 8.678 | 1.545 |
| curated / Bash / example ms | 0.400 | 0.305 | 0.291 | 0.283 | 0.990 | 0.698 | 0.121 |
| curated / Bash / large ms | 4.923 | 4.097 | 4.086 | 4.039 | 13.682 | 9.737 | 1.307 |
| tiobe / Python / example ms | 0.647 | 0.563 | 0.542 | 0.517 | 2.036 | 1.281 | 0.184 |
| tiobe / Python / large ms | 5.926 | 4.856 | 4.684 | 4.560 | 28.281 | 16.891 | 1.727 |
| tiobe / C / example ms | 0.735 | 0.489 | 0.460 | 0.440 | 2.200 | 1.251 | 0.133 |
| tiobe / C / large ms | 7.160 | 3.717 | 3.667 | 3.551 | 28.896 | 16.566 | 1.214 |
| tiobe / C++ / example ms | 2.078 | 1.240 | 1.253 | 1.149 | 4.571 | 4.145 | 0.157 |
| tiobe / C++ / large ms | 18.060 | 7.807 | 7.939 | 7.569 | 48.860 | 47.574 | 1.278 |
| tiobe / Java / example ms | 0.507 | 0.427 | 0.399 | 0.378 | 1.422 | 0.933 | 0.150 |
| tiobe / Java / large ms | 4.684 | 3.440 | 3.295 | 3.237 | 18.609 | 11.792 | 1.365 |
| tiobe / C# / example ms | 1.345 | 0.733 | 0.723 | 0.689 | 1.876 | 2.307 | 0.349 |
| tiobe / C# / large ms | 15.076 | 5.276 | 5.109 | 4.889 | 21.116 | 30.813 | 2.852 |
| tiobe / JavaScript / example ms | 2.824 | 1.660 | 1.605 | 1.622 | 5.851 | 6.018 | 0.327 |
| tiobe / JavaScript / large ms | 34.116 | 13.597 | 13.693 | 13.553 | 80.971 | 83.338 | 2.668 |
| tiobe / Visual Basic / example ms | 0.398 | 0.426 | 0.418 | 0.404 | 1.190 | 0.553 | 0.088 |
| tiobe / Visual Basic / large ms | 4.936 | 4.723 | 4.727 | 4.629 | 16.681 | 6.992 | 0.823 |
| tiobe / SQL / example ms | 0.534 | 0.446 | 0.426 | 6.144 | 2.575 | 0.719 | 0.121 |
| tiobe / SQL / large ms | 5.013 | 4.418 | 4.375 | 94.555 | 36.406 | 8.515 | 1.147 |
| tiobe / R / example ms | 0.353 | 0.269 | 0.256 | 0.234 | 1.739 | 0.923 | 0.075 |
| tiobe / R / large ms | 4.145 | 3.214 | 3.144 | 3.021 | 25.700 | 12.935 | 0.812 |
| tiobe / Rust / example ms | 0.323 | 0.265 | 0.247 | 0.237 | 1.407 | 0.681 | 0.132 |
| tiobe / Rust / large ms | 3.981 | 3.197 | 3.124 | 3.069 | 21.550 | 9.789 | 1.285 |
| tiobe / Fortran / example ms | 1.166 | 1.154 | 1.184 | 1.111 | 2.733 | 1.747 | 0.110 |
| tiobe / Fortran / large ms | 9.260 | 6.986 | 6.802 | 6.727 | 30.864 | 19.811 | 0.937 |
| tiobe / Go / example ms | 0.567 | 0.420 | 0.400 | 0.372 | 1.664 | 0.853 | 0.094 |
| tiobe / Go / large ms | 6.820 | 4.443 | 4.310 | 4.067 | 23.833 | 11.580 | 0.939 |
| tiobe / Delphi/Object Pascal / example ms | 0.168 | 0.214 | 0.199 | 0.187 | 0.854 | 0.312 | 0.092 |
| tiobe / Delphi/Object Pascal / large ms | 2.293 | 2.758 | 2.675 | 2.628 | 12.429 | 4.188 | 0.952 |
| tiobe / PHP / example ms | 0.698 | 0.492 | 0.464 | 0.434 | 2.255 | 1.115 | 0.236 |
| tiobe / PHP / large ms | 5.879 | 3.538 | 3.450 | 3.341 | 30.491 | 12.179 | 1.730 |
| tiobe / Assembly language / example ms | 0.459 | 0.278 | 0.244 | 0.234 | 2.469 | 1.071 | 0.058 |
| tiobe / Assembly language / large ms | 4.340 | 1.849 | 1.769 | 1.762 | 36.456 | 13.285 | 0.428 |
| tiobe / Ada / example ms | 0.345 | 0.311 | 0.299 | 0.283 | 0.895 | 0.624 | 0.092 |
| tiobe / Ada / large ms | 4.066 | 3.657 | 3.578 | 3.440 | 12.318 | 8.339 | 1.113 |
| tiobe / Swift / example ms | 0.759 | 0.616 | 0.608 | 0.580 | 2.085 | 1.223 | 0.123 |
| tiobe / Swift / large ms | 6.702 | 4.169 | 3.966 | 3.758 | 25.407 | 16.218 | 1.258 |
| tiobe / Objective-C / example ms | 0.662 | 0.435 | 0.406 | 0.384 | 2.186 | 1.131 | 0.109 |
| tiobe / Objective-C / large ms | 7.215 | 3.848 | 3.750 | 3.579 | 32.256 | 16.134 | 1.005 |
| tiobe / COBOL / example ms | 1.309 | 1.136 | 1.093 | 1.064 | 4.290 | 1.126 | 0.144 |
| tiobe / COBOL / large ms | 12.937 | 12.259 | 11.981 | 11.989 | 61.030 | 12.772 | 1.150 |

All required exact native/Shiki HTML checks and regex-mode diagnostics passed. Prism uses independent grammars and has no TextMate parity claim.
