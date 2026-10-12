# Reference and Declarative Shadow DOM benchmark

Final reserved-host run: 2026-10-11. The [reserved-host raw JSON result](results/2026-10-11-reference-dsd-reserved.json.gz) contains 15 measured samples, four warmups, correctness evidence, source hashes, environment details, and the native build receipt. All 16 production renderer/style/workload pairs passed validation before timing.

The earlier [transport-only raw snapshot](results/2026-10-11-reference-dsd.json.gz) is preserved unchanged. It measured reference and DSD hosts before line-count reservation was added; the tables below use only the final reserved-host result.

This snapshot predates the optional `maxLines` visible-line cap. It measures uncapped reservations and does not establish performance or geometry results for capped blocks.

The [follow-up hydration breakdown](HYDRATION-BREAKDOWN.md) attributes the inline twelve-block interval with Chrome traces and timing controls. Most of the reference interval is pending browser style, layout, prepaint, and paint work after registration; the light-DOM trace completes similar work before its hydration timer starts. The historical figures below remain unchanged, but their difference does not establish equivalent React CPU overhead or complete-startup cost.

The comparison covers four renderers—light DOM, the existing highlightedCode property adapter, reference-backed hosts, and Declarative Shadow DOM (DSD)—in both inline and classes modes. Workloads are one large TSX block and twelve mixed TSX blocks (six medium and six large). The same prepared descriptors are reused in all renderer lanes.

For the classes-mode twelve-block case, references keep SSR transport small while hydration setup and commit remain similar to the property lane: setup is 60.1 ms for references versus 60.5 ms for property hosts, and commit is 122.4 ms versus 124.0 ms. DSD preserves highlighted output before JavaScript and reduces SSR from 26.417 ms to 1.441 ms, setup from 60.5 ms to 1.7 ms, and hydration commit from 124.0 ms to 80.0 ms. Client-only mount, theme, and parent-update intervals are close among the three shadow lanes; light DOM remains cheaper to hydrate. These are elapsed wall-clock intervals: parsing, asset loading, module evaluation, and React CPU isolation are outside the measured commit.

## Scope and behavior

The light-DOM and property lanes remain the existing baselines. The property lane passes the full descriptor to ShadowCode; its SSR host carries highlighted HTML in the highlightedCode attribute and plain source fallback children. Reference and DSD use a thin React adapter that passes a short semantic ID (medium or large) and a static sizing style object. Prepared HTML and CSS stay in the external registry; React receives no highlighted HTML prop.

The sizing objects are computed once at App module evaluation with codeElementSizing from the prepared source line count, splitting CRLF, CR, or LF and including trailing blank lines. The medium and large source blocks reserve 1,092 px and 4,725 px at the default 21 px line height. The size calculation is outside presentationSetupMs and the React commit intervals.

Without JavaScript, reference hosts have no code content but reserve positive height. DSD has highlighted shadow content and styles before JavaScript. The no-JavaScript validation checks the expected source-derived min-block-size and confirms reference and DSD host geometry match for both workloads. Each DSD root points to the same external CSS asset URL; byte sizes are recorded separately and do not imply a measured HTTP request count.

These reference IDs are benchmark adapters, not the generated default macro helper. This run does not measure the helper's full-hash IDs, lazy registration path, or complete startup cost. Server-rendered JSX uses the lowercase code-ref attribute; codeRef is the CSR/imperative property convenience.

## Timing boundaries

SSR timing measures a warm renderToString call for light DOM, the property adapter, and reference hosts. For DSD, the timed interval includes renderToString plus renderCodeElementShadows postprocessing. Module loading, source fixture loading, CSS response preparation, output inspection, and network response writing are outside the SSR interval.

Browser hydration, client-only mount, theme update, and parent rerender are elapsed wall-clock time from the React call or triggering event to the App layout-effect commit timestamp. They are not isolated React CPU time and do not show that React walks or owns shadow-tree nodes. Custom-element registration and block/reference registration are recorded separately as presentationSetupMs. Module evaluation, including static sizing-object creation, page parsing, asset loading, and later node-identity inspection are outside the commit interval. The commit-to-second-requestAnimationFrame value is a next-frame proxy, not exact paint timing.

The figures below are medians with p10–p90 ranges from 15 measured samples. Byte sizes are raw / gzip / Brotli. DSD external CSS is a separate asset and is not included in its SSR HTML byte count.

## SSR time and payload

| Style   | Workload     | Renderer               | SSR ms, median [p10–p90] | HTML raw / gzip / Brotli bytes | DSD CSS raw / gzip / Brotli bytes |
| ------- | ------------ | ---------------------- | -----------------------: | -----------------------------: | --------------------------------: |
| inline  | one-large    | Light DOM              |      0.014 [0.010–0.034] |         94,184 / 5,339 / 5,027 |                                 — |
| inline  | one-large    | Property Shadow DOM    |      0.296 [0.285–0.353] |        135,497 / 7,598 / 6,941 |                                 — |
| inline  | one-large    | Reference host         |      0.017 [0.011–0.039] |                670 / 334 / 292 |                                 — |
| inline  | one-large    | Declarative Shadow DOM |      0.036 [0.027–0.055] |         91,138 / 4,928 / 4,641 |                 3,663 / 740 / 641 |
| inline  | twelve-mixed | Light DOM              |      0.031 [0.026–0.051] |       675,066 / 32,816 / 5,985 |                                 — |
| inline  | twelve-mixed | Property Shadow DOM    |      2.079 [2.009–3.651] |     1,001,326 / 53,396 / 8,372 |                                 — |
| inline  | twelve-mixed | Reference host         |      0.047 [0.042–0.068] |              4,759 / 469 / 385 |                                 — |
| inline  | twelve-mixed | Declarative Shadow DOM |      0.235 [0.197–0.266] |       675,739 / 33,361 / 5,627 |                 3,663 / 740 / 641 |
| classes | one-large    | Light DOM              |      0.021 [0.012–0.047] |    1,698,473 / 43,900 / 19,351 |                                 — |
| classes | one-large    | Property Shadow DOM    |      3.577 [3.500–3.722] |    1,838,578 / 48,075 / 21,671 |                                 — |
| classes | one-large    | Reference host         |      0.022 [0.014–0.042] |                670 / 334 / 292 |                                 — |
| classes | one-large    | Declarative Shadow DOM |      0.252 [0.210–0.308] |    1,695,427 / 43,478 / 18,867 |            12,904 / 1,594 / 1,413 |
| classes | twelve-mixed | Light DOM              |      0.066 [0.038–0.076] |  12,495,078 / 325,262 / 22,940 |                                 — |
| classes | twelve-mixed | Property Shadow DOM    |   26.417 [25.949–34.095] |  13,540,354 / 360,955 / 25,800 |                                 — |
| classes | twelve-mixed | Reference host         |      0.079 [0.049–0.089] |              4,759 / 469 / 385 |                                 — |
| classes | twelve-mixed | Declarative Shadow DOM |      1.441 [1.396–1.641] |  12,495,751 / 326,778 / 22,647 |            12,904 / 1,594 / 1,413 |

The DSD CSS sizes are the same across both workloads within a style mode because the external asset contains shared base/theme rules and the class rules for both prepared blocks. Inline mode uses 3,663 / 740 / 641 bytes; classes mode uses 12,904 / 1,594 / 1,413. These are asset sizes, not measured request counts.

## Browser commit intervals and setup

Setup H/M is presentationSetupMs for hydration and client-mount page modes. Light DOM has no custom-element setup. Other columns are elapsed milliseconds to the corresponding React commit.

### inline — one-large

| Renderer               |                Setup H / M ms | Hydration commit ms | Client-mount commit ms | Theme update ms | Parent rerender ms |
| ---------------------- | ----------------------------: | ------------------: | ---------------------: | --------------: | -----------------: |
| Light DOM              | 0.0 [0.0–0.0] / 0.0 [0.0–0.0] |       3.2 [3.1–3.4] |          4.5 [4.3–4.7] |   0.5 [0.5–0.6] |      0.2 [0.1–0.2] |
| Property Shadow DOM    | 2.5 [2.3–3.6] / 0.8 [0.8–1.0] |    14.1 [13.6–14.8] |          5.2 [5.1–5.5] |   0.5 [0.5–0.6] |      0.2 [0.2–0.3] |
| Reference host         | 2.3 [2.2–2.4] / 0.8 [0.7–0.9] |    14.2 [13.7–14.5] |          5.1 [5.0–5.5] |   0.6 [0.5–0.7] |      0.2 [0.2–0.3] |
| Declarative Shadow DOM | 1.0 [0.9–1.1] / 0.8 [0.7–0.8] |     13.8 [6.5–14.1] |          5.1 [5.0–5.4] |   0.6 [0.5–0.6] |      0.2 [0.2–0.3] |

### inline — twelve-mixed

| Renderer               |                   Setup H / M ms | Hydration commit ms | Client-mount commit ms | Theme update ms | Parent rerender ms |
| ---------------------- | -------------------------------: | ------------------: | ---------------------: | --------------: | -----------------: |
| Light DOM              |    0.0 [0.0–0.0] / 0.0 [0.0–0.0] |       3.6 [3.5–3.8] |       10.4 [10.1–10.8] |   0.7 [0.6–0.7] |      0.2 [0.2–0.3] |
| Property Shadow DOM    | 10.4 [10.0–11.2] / 0.8 [0.7–0.9] |    44.5 [43.6–45.1] |       13.2 [12.9–13.7] |   0.7 [0.6–0.8] |      0.3 [0.2–0.3] |
| Reference host         |  10.1 [9.7–10.4] / 0.8 [0.7–0.8] |    44.1 [43.4–46.2] |       13.2 [12.9–13.5] |   0.7 [0.5–0.8] |      0.2 [0.2–0.4] |
| Declarative Shadow DOM |    1.3 [1.2–1.4] / 0.7 [0.7–0.9] |    24.8 [24.1–25.8] |       13.2 [13.0–13.5] |   0.7 [0.6–0.7] |      0.3 [0.2–0.3] |

### classes — one-large

| Renderer               |                  Setup H / M ms | Hydration commit ms | Client-mount commit ms | Theme update ms | Parent rerender ms |
| ---------------------- | ------------------------------: | ------------------: | ---------------------: | --------------: | -----------------: |
| Light DOM              |   0.0 [0.0–0.0] / 0.0 [0.0–0.0] |       4.1 [3.9–4.4] |       12.5 [12.3–12.8] |   0.5 [0.5–0.6] |      0.2 [0.1–0.2] |
| Property Shadow DOM    | 10.0 [9.9–10.4] / 1.0 [1.0–1.1] |    25.2 [24.9–25.7] |       12.8 [12.6–13.2] |   0.6 [0.5–0.6] |      0.2 [0.1–0.3] |
| Reference host         |  9.9 [9.7–10.3] / 1.0 [0.8–1.0] |    24.8 [24.4–25.7] |       12.6 [12.5–13.2] |   0.5 [0.5–0.6] |      0.2 [0.1–0.2] |
| Declarative Shadow DOM |   1.4 [1.3–1.9] / 1.0 [0.9–1.0] |    14.3 [13.9–14.8] |       12.8 [12.4–13.1] |   0.5 [0.5–0.6] |      0.2 [0.1–0.2] |

### classes — twelve-mixed

| Renderer               |                   Setup H / M ms | Hydration commit ms | Client-mount commit ms | Theme update ms | Parent rerender ms |
| ---------------------- | -------------------------------: | ------------------: | ---------------------: | --------------: | -----------------: |
| Light DOM              |    0.0 [0.0–0.0] / 0.0 [0.0–0.0] |       5.5 [5.1–6.0] |       62.3 [61.0–63.4] |   0.7 [0.6–0.7] |      0.2 [0.1–0.3] |
| Property Shadow DOM    | 60.5 [59.2–61.7] / 1.0 [1.0–1.1] | 124.0 [122.1–128.4] |       63.6 [62.7–65.1] |   0.7 [0.7–0.8] |      0.3 [0.2–0.4] |
| Reference host         | 60.1 [59.4–61.1] / 0.9 [0.9–1.0] | 122.4 [120.9–124.1] |       63.4 [62.7–63.7] |   0.7 [0.6–0.7] |      0.3 [0.2–0.3] |
| Declarative Shadow DOM |    1.7 [1.6–1.8] / 1.0 [0.9–1.1] |    80.0 [78.9–81.9] |       63.2 [62.5–63.8] |   0.7 [0.6–0.8] |      0.2 [0.2–0.3] |

The setup value is separate from the following commit interval. Reference and DSD setup times are direct defineCodeElement registry calls; module evaluation and complete generated-helper startup are outside this value.

Registration can leave browser presentation work pending even after its synchronous setup timer ends. That work can run before scheduled React hydration and contribute to the call-to-commit interval; see the [trace attribution and controls](HYDRATION-BREAKDOWN.md).

## Client assets

Non-React JavaScript excludes the dedicated React vendor chunk when Vite emits one. Vite CSS is the production client build's emitted CSS. These adapters use `code()` and retain ordinary Vite CSS delivery; default-only React `Code` macros register their CSS directly and require no page CSS asset. DSD's /ferriki-code.css is served outside that Vite output and is listed separately with the SSR payload.

| Style   | Renderer               | Non-React JavaScript raw / gzip / Brotli bytes | Vite CSS raw / gzip / Brotli bytes |
| ------- | ---------------------- | ---------------------------------------------: | ---------------------------------: |
| inline  | Light DOM              |                      127,605 / 11,204 / 10,079 |                    512 / 314 / 246 |
| inline  | Property Shadow DOM    |                      134,523 / 13,419 / 12,241 |                    512 / 314 / 246 |
| inline  | Reference host         |                      134,965 / 13,604 / 12,415 |                    512 / 314 / 246 |
| inline  | Declarative Shadow DOM |                      134,959 / 13,604 / 12,415 |                    512 / 314 / 246 |
| classes | Light DOM              |                    2,106,848 / 61,697 / 27,868 |              5,729 / 1,123 / 1,024 |
| classes | Property Shadow DOM    |                    2,113,766 / 63,850 / 30,045 |              5,729 / 1,123 / 1,024 |
| classes | Reference host         |                    2,114,208 / 64,032 / 30,230 |              5,729 / 1,123 / 1,024 |
| classes | Declarative Shadow DOM |                    2,114,202 / 64,032 / 30,230 |              5,729 / 1,123 / 1,024 |

The emitted Vite CSS total is shared across renderer lanes within each style mode. Reference sizing adds a small amount of client JavaScript. DSD also carries an external CSS asset; both resources should be counted in a transfer comparison. The report records one shared CSS asset URL, not actual request counts.

## Correctness gates and limits

The final production validation passed all 16 renderer/style/workload pairs with zero browser warnings. It checks source and annotation parity, computed styles, no-JavaScript behavior, expected source-derived host reservation, matching reference/DSD no-JS geometry, SSR hydration, client-only mounting, theme/parent updates, and node identity. The separate check-shadow-dom-spike.mjs integration matrix passed Chromium, Firefox, and WebKit in both style modes. It covers unknown DSD references, partial and late block/CSS registration, marked-link retention/removal, matching DSD root/code-node identity, shared stylesheet identity, collisions, CSR reference changes and geometry changes, and the existing property/HMR path; those additional cases are not repeated as timed assertions in every benchmark pair.

The results are a bounded local comparison. Reference SSR is empty without JavaScript, though it reserves the measured height; DSD additionally supplies highlighted no-JS content. Manual adapters use short semantic IDs and direct registration, not the generated macro helper's full-hash IDs, lazy registration or complete startup cost. Browser commit intervals are wall-clock time, not isolated React CPU measurements. Parsing, network/asset loading, and module evaluation are excluded from commit/setup timings. The DSD link count is measured in markup, but actual fetch/cache behavior is not.

## Environment and provenance

Measured at 2026-10-11T13:23:45.437Z on macOS 27.0.0, Apple M1 Ultra (20 logical CPUs, 64 GiB RAM), Node v24.21.0, Chromium 153.0.8010.12. React/ReactDOM 19.3.0, scheduler 0.28.0, Playwright 1.63.0, and Vite 8.3.2 were used.

The native addon target was darwin-arm64, SHA-256 57eb3a00c4809c3742f6b363eaaa587b3e7d4d3207edb40ede3b85477a3f1157. The raw JSON records the build receipt, repository state, fixtures, dependency/browser versions, machine details, and 12 source hashes. All recorded measured-source hashes were checked after timing and matched the frozen files. The transport-only raw snapshot and earlier property, template-component, and React-host reports/results are preserved unchanged.

See the [harness guide](README.md), [benchmark harness](../../scripts/bench-shadow-dom-spike.mjs), and [three-engine integration check](../../scripts/check-shadow-dom-spike.mjs).
