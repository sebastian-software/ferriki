# Complete native before/after comparison

> **Historical archive:** Measured September 30–October 1, 2026, against Ferriki 0.7.0 from baseline `0abac9c679c61d08f66f2e22eae73a61eaacb498` and two candidate runs. “Public tokens” below refers to the former Node token API; these timings describe their recorded revisions only, not the current HTML-only Node API or current performance.

All 19 supported languages, both fixture sizes, HTML and the then-public Node token API on the recorded revisions. Positive percentages mean slower. Every cell preserves its output hashes and exact Shiki WASM parity across all three runs. Scratch is unsupported at rank 15.

| Language             | Size    | API    | Before ms | After 1 ms | After 2 ms | Change 1 | Change 2 |
| -------------------- | ------- | ------ | --------: | ---------: | ---------: | -------: | -------: |
| Python               | example | html   |     1.127 |      0.997 |      0.989 |  -11.53% |  -12.28% |
| Python               | example | tokens |     1.580 |      1.119 |      1.082 |  -29.15% |  -31.53% |
| Python               | large   | html   |    15.782 |     15.051 |     14.917 |   -4.63% |   -5.48% |
| Python               | large   | tokens |    22.712 |     16.462 |     15.833 |  -27.52% |  -30.29% |
| C                    | example | html   |     1.389 |      1.249 |      1.317 |  -10.11% |   -5.18% |
| C                    | example | tokens |     1.748 |      1.063 |      1.044 |  -39.16% |  -40.28% |
| C                    | large   | html   |    19.415 |     19.323 |     18.531 |   -0.48% |   -4.56% |
| C                    | large   | tokens |    24.880 |     16.013 |     14.970 |  -35.64% |  -39.83% |
| C++                  | example | html   |     5.314 |      5.311 |      5.042 |   -0.05% |   -5.12% |
| C++                  | example | tokens |     9.285 |      5.173 |      4.835 |  -44.29% |  -47.93% |
| C++                  | large   | html   |    79.906 |     75.323 |     74.205 |   -5.73% |   -7.13% |
| C++                  | large   | tokens |   146.599 |     73.332 |     73.626 |  -49.98% |  -49.78% |
| Java                 | example | html   |     1.489 |      1.343 |      1.382 |   -9.81% |   -7.13% |
| Java                 | example | tokens |     2.491 |      1.437 |      1.444 |  -42.30% |  -42.03% |
| Java                 | large   | html   |    22.724 |     20.949 |     21.016 |   -7.81% |   -7.52% |
| Java                 | large   | tokens |    37.221 |     22.754 |     22.267 |  -38.87% |  -40.18% |
| C#                   | example | html   |     1.836 |      1.855 |      1.784 |   +1.01% |   -2.85% |
| C#                   | example | tokens |     2.721 |      1.612 |      1.559 |  -40.76% |  -42.69% |
| C#                   | large   | html   |    27.915 |     27.270 |     26.843 |   -2.31% |   -3.84% |
| C#                   | large   | tokens |    41.182 |     23.498 |     23.276 |  -42.94% |  -43.48% |
| JavaScript           | example | html   |     2.230 |      2.314 |      2.134 |   +3.76% |   -4.29% |
| JavaScript           | example | tokens |     3.272 |      2.328 |      2.129 |  -28.84% |  -34.91% |
| JavaScript           | large   | html   |    31.444 |     31.082 |     31.134 |   -1.15% |   -0.99% |
| JavaScript           | large   | tokens |    49.730 |     31.799 |     30.226 |  -36.06% |  -39.22% |
| Visual Basic         | example | html   |     0.883 |      0.878 |      0.821 |   -0.60% |   -7.07% |
| Visual Basic         | example | tokens |     1.548 |      1.137 |      1.028 |  -26.50% |  -33.60% |
| Visual Basic         | large   | html   |    13.721 |     13.620 |     12.969 |   -0.74% |   -5.48% |
| Visual Basic         | large   | tokens |    23.532 |     16.126 |     15.723 |  -31.47% |  -33.18% |
| SQL                  | example | html   |     2.587 |      2.423 |      2.434 |   -6.32% |   -5.92% |
| SQL                  | example | tokens |     4.178 |      2.166 |      2.191 |  -48.16% |  -47.57% |
| SQL                  | large   | html   |    40.014 |     38.267 |     38.754 |   -4.37% |   -3.15% |
| SQL                  | large   | tokens |    64.589 |     33.625 |     34.822 |  -47.94% |  -46.09% |
| R                    | example | html   |     0.829 |      0.743 |      0.791 |  -10.36% |   -4.55% |
| R                    | example | tokens |     0.845 |      0.650 |      0.684 |  -23.03% |  -19.03% |
| R                    | large   | html   |    13.746 |     13.143 |     13.097 |   -4.38% |   -4.72% |
| R                    | large   | tokens |    12.703 |      9.987 |     10.098 |  -21.38% |  -20.51% |
| Rust                 | example | html   |     0.870 |      0.799 |      0.847 |   -8.07% |   -2.61% |
| Rust                 | example | tokens |     1.228 |      0.910 |      0.963 |  -25.95% |  -21.57% |
| Rust                 | large   | html   |    13.477 |     12.986 |     13.447 |   -3.64% |   -0.22% |
| Rust                 | large   | tokens |    18.033 |     14.073 |     14.009 |  -21.96% |  -22.31% |
| Fortran              | example | html   |     2.060 |      1.933 |      1.930 |   -6.18% |   -6.31% |
| Fortran              | example | tokens |     3.254 |      1.930 |      1.964 |  -40.69% |  -39.64% |
| Fortran              | large   | html   |    29.729 |     28.859 |     28.811 |   -2.93% |   -3.09% |
| Fortran              | large   | tokens |    49.212 |     29.032 |     27.687 |  -41.01% |  -43.74% |
| Go                   | example | html   |     1.025 |      1.053 |      1.105 |   +2.75% |   +7.75% |
| Go                   | example | tokens |     1.338 |      0.887 |      0.938 |  -33.69% |  -29.88% |
| Go                   | large   | html   |    15.217 |     15.097 |     14.589 |   -0.79% |   -4.13% |
| Go                   | large   | tokens |    19.897 |     13.279 |     12.928 |  -33.26% |  -35.03% |
| Delphi/Object Pascal | example | html   |     0.858 |      0.816 |      0.770 |   -4.82% |  -10.19% |
| Delphi/Object Pascal | example | tokens |     0.982 |      0.582 |      0.564 |  -40.75% |  -42.54% |
| Delphi/Object Pascal | large   | html   |    13.967 |     13.305 |     12.936 |   -4.74% |   -7.38% |
| Delphi/Object Pascal | large   | tokens |    15.419 |      8.977 |      8.763 |  -41.78% |  -43.17% |
| PHP                  | example | html   |     1.606 |      1.657 |      1.538 |   +3.20% |   -4.25% |
| PHP                  | example | tokens |     2.284 |      1.621 |      1.485 |  -29.03% |  -34.99% |
| PHP                  | large   | html   |    19.931 |     19.749 |     18.635 |   -0.91% |   -6.50% |
| PHP                  | large   | tokens |    31.369 |     20.311 |     20.537 |  -35.25% |  -34.53% |
| Assembly language    | example | html   |     1.083 |      1.014 |      0.981 |   -6.34% |   -9.44% |
| Assembly language    | example | tokens |     1.520 |      0.830 |      0.803 |  -45.37% |  -47.18% |
| Assembly language    | large   | html   |    15.388 |     15.003 |     14.816 |   -2.50% |   -3.71% |
| Assembly language    | large   | tokens |    20.802 |     11.874 |     11.602 |  -42.92% |  -44.23% |
| Ada                  | example | html   |     1.071 |      0.937 |      0.910 |  -12.45% |  -14.98% |
| Ada                  | example | tokens |     1.134 |      0.739 |      0.687 |  -34.87% |  -39.42% |
| Ada                  | large   | html   |    14.324 |     14.315 |     14.526 |   -0.07% |   +1.41% |
| Ada                  | large   | tokens |    15.761 |     11.065 |     10.381 |  -29.80% |  -34.14% |
| Swift                | example | html   |     1.192 |      1.154 |      1.095 |   -3.15% |   -8.18% |
| Swift                | example | tokens |     1.715 |      1.184 |      1.179 |  -30.93% |  -31.21% |
| Swift                | large   | html   |    16.707 |     16.337 |     15.771 |   -2.21% |   -5.60% |
| Swift                | large   | tokens |    24.541 |     16.657 |     17.166 |  -32.12% |  -30.05% |
| Objective-C          | example | html   |     1.369 |      1.314 |      1.318 |   -4.00% |   -3.72% |
| Objective-C          | example | tokens |     2.103 |      1.344 |      1.407 |  -36.11% |  -33.12% |
| Objective-C          | large   | html   |    19.616 |     18.210 |     18.352 |   -7.17% |   -6.44% |
| Objective-C          | large   | tokens |    29.654 |     19.343 |     19.478 |  -34.77% |  -34.31% |
| COBOL                | example | html   |     2.744 |      2.543 |      2.556 |   -7.34% |   -6.85% |
| COBOL                | example | tokens |     4.555 |      2.305 |      2.353 |  -49.41% |  -48.35% |
| COBOL                | large   | html   |    42.039 |     39.509 |     40.103 |   -6.02% |   -4.61% |
| COBOL                | large   | tokens |    69.714 |     35.915 |     35.665 |  -48.48% |  -48.84% |
