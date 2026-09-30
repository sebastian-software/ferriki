# TIOBE 2026-09 highlighting benchmark

Measured 2026-09-30T07:18:39.476Z. Apple M1 Ultra, darwin-arm64, Node v24.21.0.

Ferriki 0.6.0; Ferroni 1.6.1; Shiki 4.4.3; Prism 1.30.0.

Warm medians in milliseconds per document. Smaller values are faster. Prism uses independent grammars and class-based HTML; it does not provide TextMate/color parity. A dagger marks a TextMate output mismatch; errors and timeouts are visible.

## HTML rendering

| Rank | Language             | Size        | Bytes | ferriki | shiki-wasm | shiki-js | prism |
| ---- | -------------------- | ----------- | ----- | ------: | ---------: | -------: | ----: |
| 1    | Python               | example     | 1364  |   1.034 |      2.424 |    1.829 | 0.180 |
| 1    | Python               | large       | 21824 |  15.774 |     36.605 |   27.216 | 2.189 |
| 2    | C                    | example     | 1081  |   1.363 |      2.617 |    2.302 | 0.139 |
| 2    | C                    | large       | 17296 |  19.821 |     39.330 |   34.241 | 1.677 |
| 3    | C++                  | example     | 937   |   5.421 |      4.154 |    6.970 | 0.171 |
| 3    | C++                  | large       | 14992 |  81.915 |     58.838 |  103.096 | 1.740 |
| 4    | Java                 | example     | 1116  |   1.453 |      1.625 |    1.410 | 0.160 |
| 4    | Java                 | large       | 17856 |  21.510 |     23.148 |   19.751 | 1.817 |
| 5    | C#                   | example     | 1050  |   1.795 |      1.734 |    4.064 | 0.294 |
| 5    | C#                   | large       | 16800 |  28.478 |     25.994 |   64.461 | 3.664 |
| 6    | JavaScript           | example     | 1222  |   2.186 |      3.496 |    8.559 | 0.336 |
| 6    | JavaScript           | large       | 19552 |  31.394 |     50.597 |  128.248 | 3.632 |
| 7    | Visual Basic         | example     | 1120  |   0.846 |      1.434 |    0.673 | 0.078 |
| 7    | Visual Basic         | large       | 17920 |  13.431 |     21.948 |   10.081 | 1.047 |
| 8    | SQL                  | example     | 1108  |   2.554 |      3.456 |    0.991 | 0.113 |
| 8    | SQL                  | large       | 17728 |  39.019 |     51.439 |   13.437 | 1.343 |
| 9    | R                    | example     | 982   |   0.772 |      0.968 |    1.198 | 0.077 |
| 9    | R                    | large       | 15712 |  13.288 |     14.386 |   18.247 | 1.039 |
| 10   | Rust                 | example     | 965   |   0.811 |      1.771 |    1.260 | 0.139 |
| 10   | Rust                 | large       | 15440 |  13.160 |     26.986 |   19.160 | 1.657 |
| 11   | Fortran              | example     | 1073  |   1.942 |      2.502 |    1.812 | 0.103 |
| 11   | Fortran              | large       | 17168 |  28.260 |     37.568 |   26.479 | 1.212 |
| 12   | Go                   | example     | 928   |   0.985 |      1.959 |    1.229 | 0.092 |
| 12   | Go                   | large       | 14848 |  14.791 |     29.219 |   18.049 | 1.152 |
| 13   | Delphi/Object Pascal | example     | 1122  |   0.821 |      1.140 |    0.375 | 0.110 |
| 13   | Delphi/Object Pascal | large       | 17952 |  12.966 |     16.787 |    4.821 | 1.362 |
| 14   | PHP                  | example     | 894   |   1.573 |      2.523 |    1.393 | 0.229 |
| 14   | PHP                  | large       | 14304 |  19.010 |     36.425 |   18.948 | 2.488 |
| 15   | Scratch              | unsupported | —     |       — |          — |        — |     — |
| 16   | Assembly language    | example     | 750   |   1.019 |      3.557 |    2.038 | 0.052 |
| 16   | Assembly language    | large       | 12000 |  15.075 |     55.029 |   30.401 | 0.563 |
| 17   | Ada                  | example     | 1209  |   0.904 |      1.012 |    0.662 | 0.108 |
| 17   | Ada                  | large       | 19344 |  14.111 |     15.067 |    9.737 | 1.497 |
| 18   | Swift                | example     | 969   |   1.159 |      2.185 |    1.521 | 0.124 |
| 18   | Swift                | large       | 15504 |  16.032 |     31.375 |   21.873 | 1.487 |
| 19   | Objective-C          | example     | 1275  |   1.273 |      2.611 |    1.790 | 0.109 |
| 19   | Objective-C          | large       | 20400 |  18.351 |     39.545 |   27.187 | 1.348 |
| 20   | COBOL                | example     | 1197  |   2.576 |      6.050 |    1.641 | 0.118 |
| 20   | COBOL                | large       | 19152 |  39.965 |     94.246 |   23.325 | 1.407 |

## Tokenization

| Rank | Language             | Size        | Bytes | ferriki | shiki-wasm | shiki-js | prism |
| ---- | -------------------- | ----------- | ----- | ------: | ---------: | -------: | ----: |
| 1    | Python               | example     | 1364  |   1.531 |      2.124 |    1.531 | 0.112 |
| 1    | Python               | large       | 21824 |  22.497 |     32.366 |   22.983 | 1.249 |
| 2    | C                    | example     | 1081  |   1.751 |      2.287 |    1.977 | 0.068 |
| 2    | C                    | large       | 17296 |  25.706 |     35.161 |   30.587 | 0.695 |
| 3    | C++                  | example     | 937   |   9.403 |      3.688 |    6.448 | 0.105 |
| 3    | C++                  | large       | 14992 | 146.413 |     54.969 |   98.299 | 0.887 |
| 4    | Java                 | example     | 1116  |   2.319 |      1.310 |    1.103 | 0.079 |
| 4    | Java                 | large       | 17856 |  36.400 |     20.110 |   16.855 | 0.885 |
| 5    | C#                   | example     | 1050  |   2.763 |      1.470 |    3.863 | 0.231 |
| 5    | C#                   | large       | 16800 |  42.166 |     21.861 |   59.957 | 2.696 |
| 6    | JavaScript           | example     | 1222  |   3.357 |      3.056 |    8.192 | 0.234 |
| 6    | JavaScript           | large       | 19552 |  48.027 |     44.411 |  123.460 | 2.317 |
| 7    | Visual Basic         | example     | 1120  |   1.482 |      1.238 |    0.492 | 0.029 |
| 7    | Visual Basic         | large       | 17920 |  23.060 |     19.391 |    7.508 | 0.338 |
| 8    | SQL                  | example     | 1108  |   4.071 |      3.062 |    0.669 | 0.048 |
| 8    | SQL                  | large       | 17728 |  63.335 |     47.549 |    9.604 | 0.514 |
| 9    | R                    | example     | 982   |   0.814 |      0.663 |    0.882 | 0.024 |
| 9    | R                    | large       | 15712 |  12.454 |     10.015 |   13.862 | 0.316 |
| 10   | Rust                 | example     | 965   |   1.147 |      1.506 |    1.004 | 0.077 |
| 10   | Rust                 | large       | 15440 |  17.484 |     23.243 |   15.251 | 0.810 |
| 11   | Fortran              | example     | 1073  |   3.081 |      2.188 |    1.524 | 0.051 |
| 11   | Fortran              | large       | 17168 |  46.411 |     33.488 |   23.342 | 0.517 |
| 12   | Go                   | example     | 928   |   1.290 |      1.689 |    0.985 | 0.041 |
| 12   | Go                   | large       | 14848 |  19.672 |     26.530 |   15.321 | 0.449 |
| 13   | Delphi/Object Pascal | example     | 1122  |   0.960 |      0.906 |    0.149 | 0.044 |
| 13   | Delphi/Object Pascal | large       | 17952 |  14.622 |     13.838 |    2.041 | 0.505 |
| 14   | PHP                  | example     | 894   |   2.109 |      2.181 |    1.112 | 0.146 |
| 14   | PHP                  | large       | 14304 |  29.475 |     33.197 |   15.938 | 1.629 |
| 15   | Scratch              | unsupported | —     |       — |          — |        — |     — |
| 16   | Assembly language    | example     | 750   |   1.401 |      3.348 |    1.804 | 0.024 |
| 16   | Assembly language    | large       | 12000 |  20.676 |     52.075 |   27.448 | 0.223 |
| 17   | Ada                  | example     | 1209  |   1.029 |      0.775 |    0.428 | 0.041 |
| 17   | Ada                  | large       | 19344 |  15.532 |     11.525 |    6.170 | 0.485 |
| 18   | Swift                | example     | 969   |   1.644 |      1.844 |    1.208 | 0.063 |
| 18   | Swift                | large       | 15504 |  23.452 |     27.462 |   17.766 | 0.647 |
| 19   | Objective-C          | example     | 1275  |   1.931 |      2.334 |    1.546 | 0.054 |
| 19   | Objective-C          | large       | 20400 |  28.549 |     35.657 |   23.097 | 0.535 |
| 20   | COBOL                | example     | 1197  |   4.304 |      5.752 |    1.331 | 0.060 |
| 20   | COBOL                | large       | 19152 |  66.426 |     90.526 |   19.935 | 0.631 |

- Scratch: Scratch is block-based; these engines have no Scratch source-text grammar. Project JSON is not Scratch syntax.
