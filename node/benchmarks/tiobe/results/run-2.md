# TIOBE 2026-09 highlighting benchmark

Measured 2026-09-30T07:21:54.090Z. Apple M1 Ultra, darwin-arm64, Node v24.21.0.

Ferriki 0.6.0; Ferroni 1.6.1; Shiki 4.4.3; Prism 1.30.0.

Warm medians in milliseconds per document. Smaller values are faster. Prism uses independent grammars and class-based HTML; it does not provide TextMate/color parity. A dagger marks a TextMate output mismatch; errors and timeouts are visible.

## HTML rendering

| Rank | Language             | Size        | Bytes | ferriki | shiki-wasm | shiki-js | prism |
| ---- | -------------------- | ----------- | ----- | ------: | ---------: | -------: | ----: |
| 1    | Python               | example     | 1364  |   1.000 |      2.324 |    1.735 | 0.173 |
| 1    | Python               | large       | 21824 |  15.076 |     34.998 |   25.902 | 2.122 |
| 2    | C                    | example     | 1081  |   1.292 |      2.482 |    2.138 | 0.129 |
| 2    | C                    | large       | 17296 |  18.855 |     37.127 |   32.350 | 1.618 |
| 3    | C++                  | example     | 937   |   5.043 |      3.825 |    6.452 | 0.161 |
| 3    | C++                  | large       | 14992 |  77.293 |     54.326 |   94.904 | 1.679 |
| 4    | Java                 | example     | 1116  |   1.445 |      1.596 |    1.373 | 0.151 |
| 4    | Java                 | large       | 17856 |  22.023 |     23.652 |   20.213 | 1.864 |
| 5    | C#                   | example     | 1050  |   1.842 |      1.761 |    4.155 | 0.302 |
| 5    | C#                   | large       | 16800 |  28.127 |     25.471 |   63.749 | 3.634 |
| 6    | JavaScript           | example     | 1222  |   2.156 |      3.422 |    8.375 | 0.324 |
| 6    | JavaScript           | large       | 19552 |  31.408 |     49.046 |  128.354 | 3.572 |
| 7    | Visual Basic         | example     | 1120  |   0.849 |      1.447 |    0.679 | 0.078 |
| 7    | Visual Basic         | large       | 17920 |  13.271 |     22.069 |   10.079 | 1.050 |
| 8    | SQL                  | example     | 1108  |   2.486 |      3.324 |    0.934 | 0.108 |
| 8    | SQL                  | large       | 17728 |  39.080 |     51.299 |   13.445 | 1.328 |
| 9    | R                    | example     | 982   |   0.765 |      0.961 |    1.179 | 0.074 |
| 9    | R                    | large       | 15712 |  13.307 |     14.456 |   18.610 | 1.053 |
| 10   | Rust                 | example     | 965   |   0.812 |      1.777 |    1.271 | 0.138 |
| 10   | Rust                 | large       | 15440 |  13.166 |     27.309 |   19.355 | 1.657 |
| 11   | Fortran              | example     | 1073  |   1.946 |      2.517 |    1.791 | 0.104 |
| 11   | Fortran              | large       | 17168 |  28.200 |     37.491 |   26.083 | 1.234 |
| 12   | Go                   | example     | 928   |   0.977 |      1.945 |    1.230 | 0.092 |
| 12   | Go                   | large       | 14848 |  14.755 |     29.063 |   18.052 | 1.158 |
| 13   | Delphi/Object Pascal | example     | 1122  |   0.799 |      1.092 |    0.347 | 0.101 |
| 13   | Delphi/Object Pascal | large       | 17952 |  13.069 |     16.824 |    4.912 | 1.342 |
| 14   | PHP                  | example     | 894   |   1.495 |      2.467 |    1.336 | 0.222 |
| 14   | PHP                  | large       | 14304 |  19.025 |     36.544 |   19.412 | 2.515 |
| 15   | Scratch              | unsupported | —     |       — |          — |        — |     — |
| 16   | Assembly language    | example     | 750   |   0.978 |      3.467 |    1.984 | 0.051 |
| 16   | Assembly language    | large       | 12000 |  14.772 |     53.561 |   29.542 | 0.552 |
| 17   | Ada                  | example     | 1209  |   0.885 |      1.002 |    0.656 | 0.107 |
| 17   | Ada                  | large       | 19344 |  13.737 |     14.581 |    9.371 | 1.473 |
| 18   | Swift                | example     | 969   |   1.094 |      2.093 |    1.434 | 0.118 |
| 18   | Swift                | large       | 15504 |  15.807 |     30.942 |   21.018 | 1.448 |
| 19   | Objective-C          | example     | 1275  |   1.301 |      2.657 |    1.810 | 0.113 |
| 19   | Objective-C          | large       | 20400 |  18.478 |     39.241 |   27.266 | 1.340 |
| 20   | COBOL                | example     | 1197  |   2.738 |      6.308 |    1.741 | 0.126 |
| 20   | COBOL                | large       | 19152 |  39.927 |     94.450 |   23.361 | 1.398 |

## Tokenization

| Rank | Language             | Size        | Bytes | ferriki | shiki-wasm | shiki-js | prism |
| ---- | -------------------- | ----------- | ----- | ------: | ---------: | -------: | ----: |
| 1    | Python               | example     | 1364  |   1.449 |      1.997 |    1.402 | 0.100 |
| 1    | Python               | large       | 21824 |  21.592 |     30.783 |   21.718 | 1.204 |
| 2    | C                    | example     | 1081  |   1.629 |      2.154 |    1.846 | 0.061 |
| 2    | C                    | large       | 17296 |  24.242 |     33.203 |   28.708 | 0.672 |
| 3    | C++                  | example     | 937   |   8.862 |      3.458 |    6.028 | 0.096 |
| 3    | C++                  | large       | 14992 | 141.471 |     52.025 |   93.375 | 0.870 |
| 4    | Java                 | example     | 1116  |   2.419 |      1.355 |    1.137 | 0.083 |
| 4    | Java                 | large       | 17856 |  37.435 |     20.620 |   17.170 | 0.912 |
| 5    | C#                   | example     | 1050  |   2.785 |      1.471 |    3.878 | 0.228 |
| 5    | C#                   | large       | 16800 |  42.186 |     21.693 |   59.899 | 2.667 |
| 6    | JavaScript           | example     | 1222  |   3.199 |      2.934 |    7.812 | 0.225 |
| 6    | JavaScript           | large       | 19552 |  47.527 |     44.351 |  122.593 | 2.226 |
| 7    | Visual Basic         | example     | 1120  |   1.483 |      1.241 |    0.491 | 0.029 |
| 7    | Visual Basic         | large       | 17920 |  23.077 |     19.367 |    7.471 | 0.339 |
| 8    | SQL                  | example     | 1108  |   4.038 |      3.033 |    0.657 | 0.047 |
| 8    | SQL                  | large       | 17728 |  63.385 |     47.576 |    9.604 | 0.521 |
| 9    | R                    | example     | 982   |   0.798 |      0.660 |    0.882 | 0.024 |
| 9    | R                    | large       | 15712 |  12.469 |     10.024 |   14.012 | 0.323 |
| 10   | Rust                 | example     | 965   |   1.149 |      1.508 |    1.004 | 0.077 |
| 10   | Rust                 | large       | 15440 |  17.561 |     23.370 |   15.330 | 0.809 |
| 11   | Fortran              | example     | 1073  |   3.089 |      2.199 |    1.499 | 0.051 |
| 11   | Fortran              | large       | 17168 |  46.721 |     33.503 |   22.801 | 0.516 |
| 12   | Go                   | example     | 928   |   1.294 |      1.689 |    0.989 | 0.041 |
| 12   | Go                   | large       | 14848 |  19.492 |     26.114 |   15.043 | 0.439 |
| 13   | Delphi/Object Pascal | example     | 1122  |   0.943 |      0.881 |    0.144 | 0.043 |
| 13   | Delphi/Object Pascal | large       | 17952 |  14.856 |     13.880 |    2.049 | 0.514 |
| 14   | PHP                  | example     | 894   |   2.140 |      2.204 |    1.125 | 0.150 |
| 14   | PHP                  | large       | 14304 |  29.160 |     33.087 |   15.849 | 1.600 |
| 15   | Scratch              | unsupported | —     |       — |          — |        — |     — |
| 16   | Assembly language    | example     | 750   |   1.345 |      3.251 |    1.739 | 0.022 |
| 16   | Assembly language    | large       | 12000 |  20.448 |     51.211 |   26.754 | 0.222 |
| 17   | Ada                  | example     | 1209  |   0.977 |      0.744 |    0.413 | 0.040 |
| 17   | Ada                  | large       | 19344 |  15.110 |     11.187 |    5.958 | 0.470 |
| 18   | Swift                | example     | 969   |   1.639 |      1.829 |    1.192 | 0.063 |
| 18   | Swift                | large       | 15504 |  23.529 |     27.617 |   17.782 | 0.652 |
| 19   | Objective-C          | example     | 1275  |   1.952 |      2.334 |    1.534 | 0.055 |
| 19   | Objective-C          | large       | 20400 |  29.099 |     36.098 |   23.338 | 0.540 |
| 20   | COBOL                | example     | 1197  |   4.351 |      5.825 |    1.341 | 0.057 |
| 20   | COBOL                | large       | 19152 |  66.803 |     90.851 |   19.929 | 0.618 |

- Scratch: Scratch is block-based; these engines have no Scratch source-text grammar. Project JSON is not Scratch syntax.
