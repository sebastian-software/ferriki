# October 16 and October 24 language measurements

These are observations from two dated Blacksmith captures, not a controlled
before/after test of precompiled packages. Both use Shiki 4.5.0. Ferriki changes
from 1.1.1 / Ferroni 2.2.2 to 1.2.0 / Ferroni 2.7.0. Each row uses its own
original VM; controls, hardware and grammar assets can differ. Fixture SHA-256
matches are recorded below. Times are warm full-HTML medians in milliseconds;
positive change means a longer Ferriki render. Do not sum different VMs.

Original methods, samples and build receipts are in the [capture index](README.md).

## linux-x86-64 / curated

| Language / size | Same fixture | Old Ferriki | New Ferriki | Ferriki change | Old Shiki/WASM | New Shiki/WASM |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript / example | yes | 3.526 | 0.801 | -77.3% | 9.814 | 3.538 |
| TypeScript / large | yes | 17.994 | 11.201 | -37.7% | 95.810 | 55.273 |
| TSX / example | yes | 3.229 | 0.952 | -70.5% | 8.026 | 4.073 |
| TSX / large | yes | 21.213 | 13.682 | -35.5% | 106.071 | 64.670 |
| Rust / example | yes | 0.596 | 0.220 | -63.0% | 1.815 | 1.251 |
| Rust / large | yes | 4.228 | 2.936 | -30.6% | 25.390 | 18.664 |
| CSS / example | yes | 0.987 | 0.346 | -64.9% | 3.686 | 2.432 |
| CSS / large | yes | 5.996 | 4.541 | -24.3% | 47.229 | 37.331 |
| HTML / example | yes | 2.039 | 0.714 | -65.0% | 5.552 | 3.304 |
| HTML / large | yes | 15.100 | 9.812 | -35.0% | 96.364 | 52.206 |
| C++ / example | yes | 2.230 | 0.538 | -75.9% | 5.374 | 2.658 |
| C++ / large | yes | 11.172 | 6.804 | -39.1% | 57.374 | 40.152 |
| Swift / example | yes | 0.739 | 0.284 | -61.5% | 2.043 | 1.452 |
| Swift / large | yes | 5.235 | 3.371 | -35.6% | 26.632 | 21.699 |
| Java / example | yes | 0.445 | 0.243 | -45.5% | 1.353 | 1.101 |
| Java / large | yes | 4.537 | 2.963 | -34.7% | 23.138 | 16.192 |
| Markdown / example | yes | 0.975 | 0.384 | -60.7% | 1.996 | 1.148 |
| Markdown / large | yes | 5.625 | 4.423 | -21.4% | 19.463 | 16.931 |
| TOML / example | yes | 0.116 | 0.095 | -17.9% | 0.252 | 0.214 |
| TOML / large | yes | 1.556 | 1.311 | -15.7% | 3.483 | 3.288 |
| YAML / example | yes | 2.074 | 1.591 | -23.3% | 1.674 | 1.286 |
| YAML / large | yes | 32.342 | 24.083 | -25.5% | 25.102 | 19.144 |
| JSON / example | yes | 0.184 | 0.165 | -10.3% | 0.408 | 0.345 |
| JSON / large | yes | 2.911 | 2.587 | -11.1% | 6.737 | 5.413 |
| Astro / example | yes | 3.581 | 1.358 | -62.1% | 8.209 | 4.293 |
| Astro / large | yes | 19.869 | 15.676 | -21.1% | 69.016 | 53.788 |
| Svelte / example | yes | 2.398 | 1.245 | -48.1% | 6.618 | 4.435 |
| Svelte / large | yes | 23.926 | 17.246 | -27.9% | 110.504 | 69.157 |
| Ruby / example | yes | 0.327 | 0.244 | -25.4% | 1.824 | 1.594 |
| Ruby / large | yes | 3.407 | 2.798 | -17.9% | 26.525 | 24.320 |
| Python / example | yes | 0.383 | 0.335 | -12.6% | 1.703 | 1.631 |
| Python / large | yes | 4.851 | 4.192 | -13.6% | 26.364 | 24.426 |
| Vue / example | yes | 0.932 | 0.672 | -27.9% | 2.328 | 2.023 |
| Vue / large | yes | 10.752 | 9.018 | -16.1% | 36.399 | 32.022 |
| MDX / example | yes | 0.582 | 0.453 | -22.2% | 1.970 | 1.753 |
| MDX / large | yes | 7.425 | 5.437 | -26.8% | 31.318 | 27.152 |
| SCSS / example | yes | 0.596 | 0.278 | -53.3% | 3.339 | 2.556 |
| SCSS / large | yes | 4.720 | 3.228 | -31.6% | 51.754 | 39.704 |
| Bash / example | yes | 0.550 | 0.342 | -37.9% | 1.263 | 0.972 |
| Bash / large | yes | 5.686 | 4.243 | -25.4% | 17.195 | 13.711 |

## linux-x86-64 / tiobe

| Language / size | Same fixture | Old Ferriki | New Ferriki | Ferriki change | Old Shiki/WASM | New Shiki/WASM |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Python / example | yes | 0.995 | 0.383 | -61.5% | 2.426 | 1.855 |
| Python / large | yes | 5.526 | 4.823 | -12.7% | 28.703 | 27.491 |
| C / example | yes | 0.876 | 0.312 | -64.3% | 2.804 | 1.910 |
| C / large | yes | 5.192 | 4.279 | -17.6% | 35.249 | 35.116 |
| C++ / example | yes | 1.987 | 0.605 | -69.6% | 4.647 | 2.972 |
| C++ / large | yes | 10.680 | 7.754 | -27.4% | 52.525 | 45.712 |
| Java / example | yes | 0.354 | 0.277 | -21.9% | 1.291 | 1.251 |
| Java / large | yes | 3.990 | 3.379 | -15.3% | 19.092 | 18.060 |
| C# / example | yes | 0.763 | 0.428 | -44.0% | 1.693 | 1.408 |
| C# / large | yes | 6.165 | 5.143 | -16.6% | 21.988 | 20.244 |
| JavaScript / example | yes | 2.006 | 0.987 | -50.8% | 6.293 | 5.060 |
| JavaScript / large | yes | 15.067 | 14.057 | -6.7% | 86.896 | 79.737 |
| Visual Basic / example | yes | 0.459 | 0.376 | -18.1% | 1.214 | 1.124 |
| Visual Basic / large | yes | 5.779 | 4.839 | -16.3% | 20.208 | 16.468 |
| SQL / example | yes | 0.586 | 6.125 | +944.3% | 2.452 | 2.337 |
| SQL / large | yes | 5.312 | 95.304 | +1694.3% | 37.060 | 34.624 |
| R / example | yes | 0.556 | 0.259 | -53.4% | 2.019 | 1.717 |
| R / large | yes | 3.860 | 3.336 | -13.6% | 27.058 | 25.413 |
| Rust / example | yes | 0.487 | 0.249 | -48.8% | 1.606 | 1.428 |
| Rust / large | yes | 4.467 | 3.347 | -25.1% | 26.728 | 21.725 |
| Fortran / example | yes | 1.288 | 0.557 | -56.7% | 2.724 | 1.989 |
| Fortran / large | yes | 8.783 | 7.319 | -16.7% | 36.923 | 30.233 |
| Go / example | yes | 0.780 | 0.343 | -56.1% | 2.139 | 1.516 |
| Go / large | yes | 4.907 | 4.138 | -15.7% | 23.253 | 22.626 |
| Delphi/Object Pascal / example | yes | 0.261 | 0.213 | -18.4% | 0.895 | 0.872 |
| Delphi/Object Pascal / large | yes | 3.595 | 2.820 | -21.6% | 14.191 | 13.372 |
| PHP / example | yes | 0.955 | 0.299 | -68.7% | 2.700 | 1.897 |
| PHP / large | yes | 4.617 | 3.586 | -22.3% | 31.223 | 28.267 |
| Assembly language / example | yes | 0.445 | 0.189 | -57.5% | 2.744 | 2.495 |
| Assembly language / large | yes | 2.461 | 1.920 | -22.0% | 41.096 | 38.360 |
| Ada / example | yes | 0.471 | 0.304 | -35.5% | 1.037 | 0.870 |
| Ada / large | yes | 4.715 | 3.734 | -20.8% | 14.238 | 12.024 |
| Swift / example | yes | 0.853 | 0.328 | -61.6% | 2.272 | 1.657 |
| Swift / large | yes | 5.703 | 4.032 | -29.3% | 27.800 | 24.724 |
| Objective-C / example | yes | 0.580 | 0.319 | -45.1% | 2.280 | 2.000 |
| Objective-C / large | yes | 4.870 | 4.031 | -17.2% | 32.530 | 30.685 |
| COBOL / example | yes | 1.371 | 0.921 | -32.8% | 4.311 | 4.018 |
| COBOL / large | yes | 16.078 | 12.594 | -21.7% | 65.847 | 61.814 |

## macos-arm64 / curated

| Language / size | Same fixture | Old Ferriki | New Ferriki | Ferriki change | Old Shiki/WASM | New Shiki/WASM |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript / example | yes | 1.080 | 1.126 | +4.3% | 4.312 | 4.431 |
| TypeScript / large | yes | 12.138 | 11.554 | -4.8% | 65.691 | 63.605 |
| TSX / example | yes | 1.168 | 1.064 | -8.9% | 4.617 | 4.693 |
| TSX / large | yes | 13.787 | 14.013 | +1.6% | 73.165 | 73.587 |
| Rust / example | yes | 0.212 | 0.179 | -15.5% | 1.322 | 1.239 |
| Rust / large | yes | 3.121 | 2.654 | -15.0% | 20.878 | 19.371 |
| CSS / example | yes | 0.404 | 0.293 | -27.4% | 2.950 | 2.803 |
| CSS / large | yes | 4.551 | 3.626 | -20.3% | 46.822 | 39.107 |
| HTML / example | yes | 0.896 | 0.577 | -35.7% | 3.871 | 3.239 |
| HTML / large | yes | 9.381 | 8.258 | -12.0% | 59.314 | 50.762 |
| C++ / example | yes | 0.878 | 0.420 | -52.1% | 3.451 | 2.610 |
| C++ / large | yes | 6.699 | 5.224 | -22.0% | 49.715 | 38.737 |
| Swift / example | yes | 0.403 | 0.208 | -48.3% | 1.875 | 1.401 |
| Swift / large | yes | 4.210 | 3.063 | -27.2% | 27.819 | 22.905 |
| Java / example | yes | 0.278 | 0.207 | -25.6% | 1.229 | 1.118 |
| Java / large | yes | 3.066 | 3.071 | +0.2% | 17.908 | 18.303 |
| Markdown / example | yes | 0.589 | 0.501 | -15.0% | 1.496 | 1.484 |
| Markdown / large | yes | 4.361 | 4.326 | -0.8% | 18.726 | 19.855 |
| TOML / example | yes | 0.098 | 0.093 | -5.4% | 0.219 | 0.209 |
| TOML / large | yes | 1.299 | 1.368 | +5.3% | 3.182 | 3.189 |
| YAML / example | yes | 1.455 | 1.377 | -5.3% | 1.410 | 1.392 |
| YAML / large | yes | 23.553 | 21.142 | -10.2% | 22.177 | 21.270 |
| JSON / example | yes | 0.158 | 0.145 | -8.3% | 0.355 | 0.320 |
| JSON / large | yes | 2.421 | 2.270 | -6.2% | 5.705 | 5.070 |
| Astro / example | yes | 1.738 | 1.648 | -5.2% | 5.628 | 5.400 |
| Astro / large | yes | 16.247 | 14.161 | -12.8% | 65.800 | 60.977 |
| Svelte / example | yes | 1.574 | 1.459 | -7.3% | 5.609 | 5.094 |
| Svelte / large | yes | 18.624 | 15.806 | -15.1% | 89.526 | 73.827 |
| Ruby / example | yes | 0.231 | 0.205 | -11.5% | 1.868 | 1.792 |
| Ruby / large | yes | 2.955 | 2.863 | -3.1% | 29.536 | 28.949 |
| Python / example | yes | 0.374 | 0.319 | -14.5% | 1.773 | 1.642 |
| Python / large | yes | 4.302 | 4.096 | -4.8% | 27.655 | 26.531 |
| Vue / example | yes | 0.936 | 0.652 | -30.3% | 2.632 | 2.129 |
| Vue / large | yes | 10.022 | 8.138 | -18.8% | 38.053 | 31.188 |
| MDX / example | yes | 0.538 | 0.360 | -33.1% | 2.012 | 1.663 |
| MDX / large | yes | 5.604 | 4.790 | -14.5% | 29.631 | 26.991 |
| SCSS / example | yes | 0.349 | 0.361 | +3.2% | 3.150 | 3.132 |
| SCSS / large | yes | 3.125 | 3.174 | +1.6% | 41.534 | 47.158 |
| Bash / example | yes | 0.287 | 0.266 | -7.3% | 0.930 | 0.870 |
| Bash / large | yes | 4.496 | 3.840 | -14.6% | 15.331 | 13.185 |

## macos-arm64 / tiobe

| Language / size | Same fixture | Old Ferriki | New Ferriki | Ferriki change | Old Shiki/WASM | New Shiki/WASM |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Python / example | yes | 0.258 | 0.385 | +49.3% | 1.472 | 1.777 |
| Python / large | yes | 3.766 | 3.877 | +2.9% | 22.808 | 25.063 |
| C / example | yes | 0.246 | 0.283 | +15.2% | 1.772 | 1.894 |
| C / large | yes | 3.228 | 3.437 | +6.5% | 26.948 | 29.166 |
| C++ / example | yes | 0.498 | 0.678 | +36.2% | 2.724 | 3.278 |
| C++ / large | yes | 5.929 | 5.927 | -0.0% | 42.506 | 47.387 |
| Java / example | yes | 0.193 | 0.207 | +7.2% | 1.017 | 1.088 |
| Java / large | yes | 2.689 | 2.931 | +9.0% | 15.958 | 17.285 |
| C# / example | yes | 0.305 | 0.370 | +21.0% | 1.204 | 1.299 |
| C# / large | yes | 4.127 | 4.342 | +5.2% | 17.341 | 19.594 |
| JavaScript / example | yes | 0.959 | 1.197 | +24.7% | 4.809 | 5.647 |
| JavaScript / large | yes | 11.163 | 12.433 | +11.4% | 74.023 | 84.863 |
| Visual Basic / example | yes | 0.269 | 0.335 | +24.5% | 1.049 | 1.175 |
| Visual Basic / large | yes | 4.391 | 4.694 | +6.9% | 17.518 | 18.160 |
| SQL / example | yes | 0.398 | 4.798 | +1104.6% | 2.951 | 2.727 |
| SQL / large | yes | 4.875 | 83.691 | +1616.9% | 44.576 | 44.524 |
| R / example | yes | 0.249 | 0.225 | -9.6% | 1.898 | 1.914 |
| R / large | yes | 2.974 | 2.713 | -8.8% | 28.119 | 28.267 |
| Rust / example | yes | 0.227 | 0.203 | -10.9% | 1.380 | 1.342 |
| Rust / large | yes | 3.047 | 2.491 | -18.3% | 21.410 | 19.027 |
| Fortran / example | yes | 0.578 | 0.574 | -0.7% | 2.036 | 1.947 |
| Fortran / large | yes | 5.873 | 5.768 | -1.8% | 29.016 | 27.949 |
| Go / example | yes | 0.311 | 0.304 | -2.0% | 1.546 | 1.458 |
| Go / large | yes | 4.003 | 3.478 | -13.1% | 22.758 | 21.843 |
| Delphi/Object Pascal / example | yes | 0.198 | 0.161 | -18.4% | 0.843 | 0.792 |
| Delphi/Object Pascal / large | yes | 2.842 | 2.573 | -9.5% | 13.178 | 13.127 |
| PHP / example | yes | 0.327 | 0.303 | -7.1% | 1.986 | 2.054 |
| PHP / large | yes | 3.167 | 3.007 | -5.1% | 28.379 | 30.176 |
| Assembly language / example | yes | 0.159 | 0.210 | +32.0% | 2.516 | 2.607 |
| Assembly language / large | yes | 1.817 | 1.830 | +0.7% | 40.810 | 42.154 |
| Ada / example | yes | 0.264 | 0.273 | +3.4% | 0.778 | 0.823 |
| Ada / large | yes | 3.287 | 3.334 | +1.4% | 11.114 | 12.128 |
| Swift / example | yes | 0.320 | 0.357 | +11.7% | 1.715 | 1.800 |
| Swift / large | yes | 3.752 | 3.442 | -8.3% | 25.269 | 26.199 |
| Objective-C / example | yes | 0.279 | 0.334 | +19.4% | 1.992 | 2.110 |
| Objective-C / large | yes | 3.584 | 3.287 | -8.3% | 32.336 | 30.896 |
| COBOL / example | yes | 1.119 | 0.855 | -23.6% | 5.112 | 4.664 |
| COBOL / large | yes | 14.938 | 11.761 | -21.3% | 73.303 | 73.786 |
