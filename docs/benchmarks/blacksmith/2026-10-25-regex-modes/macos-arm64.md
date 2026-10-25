# Ferriki regex modes: macos-arm64

Commit: 8aba6dd009fa09a3eed895e1764b2f04dbef0f1b. Node: v24.21.0.
comparison: Apple M4 Pro (Virtual) (6 cores).
curated: Apple M4 Pro (Virtual) (6 cores).
tiobe: Apple M4 Pro (Virtual) (6 cores).

Source Off, Auto (lazy DFA), Eager and prepared Eager are separate contenders. Source contenders do not open prepared archives. All contenders share each corpus VM and rotate within timing rounds. Prepared groups are used only where standard packages exist; custom-only grammars retain source fallback.

Warm medians reuse highlighters. First use includes imports, setup and one repository corpus render in a fresh process; downloads and process creation are excluded. Diagnostics are captured outside timed calls and confirm policy/archive use, not complete group coverage.

| Workload | Ferriki source Off | Ferriki source Auto (lazy DFA) | Ferriki source Eager | Ferriki prepared Eager | Shiki WASM | Shiki JS | Prism (independent grammars) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Repository / warm ms | 121.395 | 80.638 | 80.421 | 115.311 | 335.882 | unsupported | unsupported |
| Repository / first use ms | 219.734 | 338.459 | 413.725 | 619.943 | 1099.914 | unsupported | unsupported |
| curated / TypeScript / example ms | 1.752 | 0.832 | 0.789 | 0.803 | 3.759 | 5.450 | 0.212 |
| curated / TypeScript / large ms | 25.677 | 10.174 | 9.929 | 10.020 | 56.771 | 83.792 | 2.432 |
| curated / TSX / example ms | 1.959 | 1.051 | 1.008 | 1.042 | 4.455 | 4.658 | 0.327 |
| curated / TSX / large ms | 27.662 | 12.044 | 11.955 | 12.003 | 65.562 | 68.727 | 3.948 |
| curated / Rust / example ms | 0.183 | 0.148 | 0.149 | 0.147 | 1.130 | 0.460 | 0.082 |
| curated / Rust / large ms | 2.790 | 2.303 | 2.316 | 2.287 | 17.609 | 6.727 | 1.168 |
| curated / CSS / example ms | 0.242 | 0.261 | 0.254 | 0.251 | 2.542 | 0.519 | 0.070 |
| curated / CSS / large ms | 3.539 | 3.729 | 3.699 | 3.655 | 39.718 | 7.740 | 1.001 |
| curated / HTML / example ms | 1.017 | 0.618 | 0.599 | 0.601 | 3.410 | 2.519 | 0.207 |
| curated / HTML / large ms | 14.583 | 8.148 | 8.100 | 8.122 | 52.362 | 37.653 | 2.465 |
| curated / C++ / example ms | 0.927 | 0.406 | 0.396 | 0.391 | 2.725 | 2.238 | 0.099 |
| curated / C++ / large ms | 13.084 | 5.378 | 5.264 | 5.224 | 40.391 | 33.744 | 1.172 |
| curated / Swift / example ms | 0.328 | 0.201 | 0.195 | 0.191 | 1.395 | 0.723 | 0.074 |
| curated / Swift / large ms | 4.804 | 2.937 | 2.881 | 2.792 | 21.087 | 10.733 | 1.001 |
| curated / Java / example ms | 0.225 | 0.165 | 0.161 | 0.163 | 0.977 | 0.618 | 0.088 |
| curated / Java / large ms | 3.363 | 2.509 | 2.471 | 2.508 | 15.106 | 9.329 | 1.306 |
| curated / Markdown / example ms | 0.343 | 0.255 | 0.247 | 0.243 | 1.021 | 1.426 | 0.116 |
| curated / Markdown / large ms | 4.676 | 3.383 | 3.336 | 3.300 | 14.935 | 22.090 | 1.433 |
| curated / TOML / example ms | 0.073 | 0.072 | 0.074 | 0.074 | 0.177 | 0.132 | 0.030 |
| curated / TOML / large ms | 1.082 | 1.054 | 1.090 | 1.093 | 2.695 | 1.949 | 0.475 |
| curated / YAML / example ms | 0.966 | 1.201 | 1.191 | 1.186 | 1.228 | unsupported | 0.045 |
| curated / YAML / large ms | 15.174 | 19.136 | 18.868 | 18.785 | 19.545 | unsupported | 0.642 |
| curated / JSON / example ms | 0.117 | 0.115 | 0.129 | 0.129 | 0.293 | 0.237 | 0.050 |
| curated / JSON / large ms | 1.854 | 1.812 | 2.010 | 2.004 | 4.659 | 3.756 | 0.802 |
| curated / Astro / example ms | 1.881 | 1.197 | 1.356 | 1.148 | 4.642 | 4.300 | unsupported |
| curated / Astro / large ms | 21.303 | 13.340 | 16.394 | 13.152 | 57.380 | 55.651 | unsupported |
| curated / Svelte / example ms | 2.187 | 1.270 | 1.357 | 1.208 | 5.212 | 5.862 | unsupported |
| curated / Svelte / large ms | 27.879 | 14.194 | 15.937 | 14.130 | 69.905 | 79.217 | unsupported |
| curated / Ruby / example ms | 0.211 | 0.149 | 0.149 | 0.147 | 1.551 | 0.665 | 0.087 |
| curated / Ruby / large ms | 3.167 | 2.242 | 2.272 | 2.262 | 24.275 | 10.345 | 1.296 |
| curated / Python / example ms | 0.285 | 0.224 | 0.218 | 0.219 | 1.416 | 0.792 | 0.104 |
| curated / Python / large ms | 4.254 | 3.443 | 3.403 | 3.404 | 21.771 | 11.884 | 1.471 |
| curated / Vue / example ms | 1.121 | 0.580 | 0.565 | 0.567 | 2.046 | 2.251 | unsupported |
| curated / Vue / large ms | 18.075 | 8.296 | 8.177 | 8.329 | 33.333 | 36.414 | unsupported |
| curated / MDX / example ms | 0.624 | 0.399 | 0.381 | 0.380 | 1.923 | 2.799 | unsupported |
| curated / MDX / large ms | 7.732 | 4.841 | 4.685 | 4.783 | 27.523 | 42.230 | unsupported |
| curated / SCSS / example ms | 0.283 | 0.249 | 0.237 | 0.232 | 3.004 | 0.571 | 0.143 |
| curated / SCSS / large ms | 3.856 | 3.228 | 3.181 | 3.083 | 47.971 | 8.109 | 2.027 |
| curated / Bash / example ms | 0.267 | 0.224 | 0.221 | 0.222 | 0.826 | 0.544 | 0.088 |
| curated / Bash / large ms | 4.021 | 3.458 | 3.432 | 3.433 | 12.435 | 8.203 | 1.296 |
| tiobe / Python / example ms | 0.306 | 0.248 | 0.241 | 0.242 | 1.529 | 0.848 | 0.115 |
| tiobe / Python / large ms | 4.405 | 3.601 | 3.513 | 3.486 | 22.734 | 12.403 | 1.527 |
| tiobe / C / example ms | 0.395 | 0.211 | 0.202 | 0.208 | 1.743 | 0.979 | 0.098 |
| tiobe / C / large ms | 5.371 | 2.820 | 2.777 | 2.794 | 24.938 | 13.507 | 1.185 |
| tiobe / C++ / example ms | 0.980 | 0.444 | 0.436 | 0.429 | 2.800 | 2.280 | 0.103 |
| tiobe / C++ / large ms | 13.136 | 5.399 | 5.238 | 5.249 | 40.997 | 33.656 | 1.181 |
| tiobe / Java / example ms | 0.222 | 0.162 | 0.158 | 0.159 | 0.970 | 0.607 | 0.087 |
| tiobe / Java / large ms | 3.464 | 2.602 | 2.527 | 2.547 | 15.482 | 9.752 | 1.328 |
| tiobe / C# / example ms | 0.764 | 0.261 | 0.256 | 0.252 | 1.147 | 1.781 | 0.176 |
| tiobe / C# / large ms | 11.594 | 3.807 | 3.759 | 3.686 | 17.040 | 27.318 | 2.531 |
| tiobe / JavaScript / example ms | 2.040 | 0.838 | 0.812 | 0.809 | 4.655 | 5.428 | 0.229 |
| tiobe / JavaScript / large ms | 29.641 | 10.682 | 10.525 | 10.558 | 69.914 | 83.184 | 2.402 |
| tiobe / Visual Basic / example ms | 0.240 | 0.239 | 0.239 | 0.234 | 0.968 | 0.320 | 0.049 |
| tiobe / Visual Basic / large ms | 3.747 | 3.802 | 3.834 | 3.767 | 15.260 | 4.968 | 0.764 |
| tiobe / SQL / example ms | 0.273 | 0.249 | 0.239 | 4.306 | 2.453 | 0.430 | 0.077 |
| tiobe / SQL / large ms | 3.839 | 3.678 | 3.681 | 69.172 | 38.322 | 6.016 | 0.990 |
| tiobe / R / example ms | 0.199 | 0.153 | 0.152 | 0.152 | 1.525 | 0.671 | 0.051 |
| tiobe / R / large ms | 2.894 | 2.269 | 2.276 | 2.239 | 23.466 | 10.089 | 0.737 |
| tiobe / Rust / example ms | 0.184 | 0.149 | 0.146 | 0.147 | 1.139 | 0.460 | 0.083 |
| tiobe / Rust / large ms | 2.823 | 2.334 | 2.306 | 2.297 | 18.087 | 6.946 | 1.203 |
| tiobe / Fortran / example ms | 0.450 | 0.342 | 0.355 | 0.329 | 1.583 | 1.007 | 0.064 |
| tiobe / Fortran / large ms | 6.411 | 4.800 | 4.989 | 4.694 | 24.219 | 15.303 | 0.862 |
| tiobe / Go / example ms | 0.329 | 0.211 | 0.205 | 0.197 | 1.235 | 0.530 | 0.058 |
| tiobe / Go / large ms | 4.891 | 3.163 | 3.125 | 2.963 | 18.715 | 7.721 | 0.826 |
| tiobe / Delphi/Object Pascal / example ms | 0.108 | 0.131 | 0.131 | 0.130 | 0.742 | 0.196 | 0.061 |
| tiobe / Delphi/Object Pascal / large ms | 1.687 | 2.157 | 2.140 | 2.135 | 11.585 | 2.937 | 0.953 |
| tiobe / PHP / example ms | 0.283 | 0.173 | 0.168 | 0.167 | 1.587 | 0.584 | 0.122 |
| tiobe / PHP / large ms | 3.941 | 2.465 | 2.454 | 2.436 | 24.535 | 8.383 | 1.664 |
| tiobe / Assembly language / example ms | 0.254 | 0.107 | 0.102 | 0.099 | 2.263 | 0.798 | 0.034 |
| tiobe / Assembly language / large ms | 3.587 | 1.462 | 1.406 | 1.429 | 37.120 | 11.565 | 0.416 |
| tiobe / Ada / example ms | 0.188 | 0.180 | 0.177 | 0.172 | 0.634 | 0.398 | 0.068 |
| tiobe / Ada / large ms | 2.816 | 2.735 | 2.753 | 2.670 | 10.045 | 6.225 | 1.055 |
| tiobe / Swift / example ms | 0.327 | 0.201 | 0.194 | 0.193 | 1.392 | 0.733 | 0.076 |
| tiobe / Swift / large ms | 4.660 | 2.850 | 2.788 | 2.744 | 20.682 | 10.322 | 1.001 |
| tiobe / Objective-C / example ms | 0.347 | 0.188 | 0.184 | 0.180 | 1.705 | 0.743 | 0.068 |
| tiobe / Objective-C / large ms | 5.021 | 2.758 | 2.761 | 2.718 | 26.164 | 11.053 | 0.915 |
| tiobe / COBOL / example ms | 0.702 | 0.679 | 0.670 | 0.670 | 4.311 | 0.593 | 0.073 |
| tiobe / COBOL / large ms | 10.599 | 10.372 | 10.304 | 10.315 | 67.996 | 8.662 | 1.005 |

All required exact native/Shiki HTML checks and regex-mode diagnostics passed. Prism uses independent grammars and has no TextMate parity claim.
