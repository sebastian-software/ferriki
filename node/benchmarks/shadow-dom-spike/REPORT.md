# Prepared code in Shadow DOM: historical React-host prototype

**Evidence status:** The [2026-10-11 raw report](results/2026-10-11.json.gz) and measurements below are historical prototype evidence. They measure the React-host implementation recorded by the original component and harness hashes in that JSON, not the final Web Component. The fixture files have since been copied into this standalone benchmark directory without changing their bytes; the raw JSON keeps its original paths and hashes as provenance. Rerun the benchmark against the final component before making performance claims about it.

**Prototype finding:** This comparison found no broad performance advantage for rendering prepared code in Shadow DOM. Warm server rendering and hydration commit times were close. Client-only mounting in inline mode rose from 10.6 to 13.3 ms for twelve blocks; classes mode stayed close. Client JavaScript plus CSS grew by about 0.30–0.32 KiB gzip. Shadow DOM's useful result in this prototype is CSS isolation; it does not reduce token span counts.

The production Vite comparison used the same prepared Ferriki blocks and page structure in light DOM and declarative Shadow DOM, for both `inline` and `classes` styling. Workloads were one large TSX block and a 12-block page alternating six medium and six large blocks. The existing React `Code` macro's render hook was sufficient for the demo; no native or public API changed. The light-DOM path already places the prepared markup behind React's `dangerouslySetInnerHTML`, so the benchmark does not establish a React reconciliation saving from Shadow DOM. The equal span counts are measured evidence; any claim about internal React work is an inference from that opaque-markup path.

## Correctness and scope

All eight production cells passed validation before timing: `inline`/`classes` × light/shadow × one-large/twelve-mixed. The run retained 480 browser phase samples and 120 SSR samples, with no browser warnings. Validation checked exact visible source, line and selected-line annotations, computed theme/token styles, SSR hydration, client-only mounting, theme changes, parent rerenders, and declarative Shadow DOM with JavaScript disabled. No hydration mismatch or console error occurred. Source text and computed styles matched between the renderers, and host/root/pre/token identities stayed stable through the measured updates.

Token span counts were identical between light and shadow renderers for each style mode: 338 medium and 1,439 large spans for `inline`, and 1,295 medium and 5,930 large spans for `classes`. The extra Shadow DOM wrappers do not remove those token nodes.

Separate React-host-prototype integration checks also passed the mandatory core compatibility gate and 55 Vite tests. Its demo checks covered CSS conflicts, SSR without JavaScript, Strict Mode, hydration identity, theme font flags, copy, selection, accessibility, find, and HMR; those are integration results, not benchmark timing evidence for the final Web Component.

## Method and environment

The historical run used 15 measured samples after four warmups on Apple M1 Ultra (Darwin 27.0.0, arm64), Node v24.21.0, React and ReactDOM 19.3.0, Playwright 1.63.0, Vite 8.3.2, and local Chromium 153.0.8010.12. The fixtures were `medium.tsx` (1,563 bytes, 51 lines) and `large.tsx` (7,442 bytes, 224 lines). The complete original commit, fixture/component/harness hashes, native addon receipt, and runtime provenance are retained in the [raw JSON](results/2026-10-11.json.gz); these hashes identify the historical run, not the updated standalone harness or final Web Component.

SSR timing is a warm `renderToString` call only; fixture setup, output inspection, response writing, transfer, and document parsing are outside the interval. Browser commit timing begins immediately before the React trigger and stops at the App layout-effect commit timestamp. It does not wait for a following paint or layout. The separate commit-to-second-`requestAnimationFrame` proxy includes identity inspection and frame scheduling, so it is not exact paint timing. Asset transfer, page parsing, and setup finish before browser timing begins. Values below are absolute milliseconds as median [p10–p90], without percentage comparisons for the short update commits.

The SSR byte table reports complete `renderToString(App)` markup, including controls, wrappers, and embedded style tags, but excludes the document shell and external assets. Each cell's deterministic byte count is shown as raw / gzip / Brotli. CSS embedded in Shadow DOM is also measured separately below; it is already included in the SSR markup totals.

## Timings

Milliseconds, median [p10–p90]. `one large` is the large fixture; `12 mixed` has six medium and six large blocks.

| Style   | Workload  | Renderer |          SSR render | Hydration commit |     Client mount |  Theme update | Parent rerender |
| ------- | --------- | -------- | ------------------: | ---------------: | ---------------: | ------------: | --------------: |
| Inline  | One large | Light    | 0.020 [0.016–0.028] |    3.2 [3.1–3.4] |    4.6 [4.5–4.9] | 0.6 [0.5–0.7] |   0.2 [0.1–0.2] |
| Inline  | One large | Shadow   | 0.019 [0.014–0.028] |    3.4 [3.2–3.5] |    5.2 [5.0–5.5] | 0.6 [0.5–0.7] |   0.2 [0.1–0.3] |
| Inline  | 12 mixed  | Light    | 0.066 [0.051–0.076] |    3.6 [3.5–3.8] | 10.6 [10.2–10.8] | 0.7 [0.6–0.7] |   0.2 [0.2–0.2] |
| Inline  | 12 mixed  | Shadow   | 0.076 [0.072–0.103] |    3.8 [3.6–3.9] | 13.3 [12.7–13.8] | 0.7 [0.6–0.8] |   0.2 [0.1–0.3] |
| Classes | One large | Light    | 0.020 [0.015–0.034] |    4.0 [3.8–4.3] | 12.5 [12.2–12.9] | 0.6 [0.5–0.7] |   0.2 [0.1–0.2] |
| Classes | One large | Shadow   | 0.019 [0.015–0.037] |    4.0 [3.8–4.2] | 12.6 [12.0–12.9] | 0.5 [0.5–0.6] |   0.2 [0.1–0.2] |
| Classes | 12 mixed  | Light    | 0.066 [0.048–0.092] |    4.8 [4.6–5.0] | 61.4 [60.7–62.9] | 0.7 [0.6–0.7] |   0.2 [0.2–0.3] |
| Classes | 12 mixed  | Shadow   | 0.077 [0.072–0.133] |    4.3 [4.2–4.5] | 61.7 [60.6–62.3] | 0.7 [0.6–0.8] |   0.2 [0.1–0.3] |

## SSR markup size

Raw / gzip / Brotli bytes for complete server-rendered App markup:

| Style   | Workload  |                     Light DOM |                    Shadow DOM |       Shadow minus light |
| ------- | --------- | ----------------------------: | ----------------------------: | -----------------------: |
| Inline  | One large |        94,251 / 5,423 / 5,112 |        94,308 / 5,547 / 5,216 |        +57 / +124 / +104 |
| Inline  | 12 mixed  |      675,045 / 32,890 / 6,066 |      713,734 / 37,568 / 6,175 |  +38,689 / +4,678 / +109 |
| Classes | One large |   1,698,540 / 43,997 / 19,452 |   1,703,067 / 44,640 / 19,903 |     +4,527 / +643 / +451 |
| Classes | 12 mixed  | 12,495,057 / 325,362 / 22,989 | 12,589,192 / 340,280 / 23,645 | +94,135 / +14,918 / +656 |

## CSS and client payload

Light DOM emits the shared base/theme stylesheet once per page (3,411 raw bytes, 685 gzip bytes). Shadow DOM embeds the generated code CSS and the same component rules per root. In `inline` mode each root contains 3,473 CSS bytes; twelve roots produce 41,687 bytes of concatenated style text (1,112 gzip). In `classes` mode a medium root contains 8,244 bytes and a large root 7,943 bytes; twelve roots produce 97,133 bytes of concatenated style text (2,427 gzip). These combined style measurements join the style texts with one newline between them. The shared generated Vite CSS asset is present in both renderers: 512 / 314 / 246 bytes (raw / gzip / Brotli) for inline, and 5,729 / 1,123 / 1,024 for classes.

The production client payload sums non-React JavaScript and CSS asset sizes; gzip and Brotli are measured per file. All four cells emitted the same content-hashed React vendor chunk (`react-vendor-DXX8aoIR.js`); each style pair also emitted the same content-hashed Vite CSS asset and byte counts. The dedicated React/ReactDOM/Scheduler chunk is excluded because it is shared by both lanes, so the payload delta is in non-React JavaScript/helper code.

| Style   | Light DOM raw / gzip / Brotli | Shadow DOM raw / gzip / Brotli | Shadow minus light |
| ------- | ----------------------------: | -----------------------------: | -----------------: |
| Inline  |     128,998 / 11,331 / 10,138 |      129,684 / 11,659 / 10,451 | +686 / +328 / +313 |
| Classes |   2,113,458 / 62,626 / 28,695 |    2,114,144 / 62,937 / 29,013 | +686 / +311 / +318 |

The result supports Shadow DOM as an opt-in styling boundary, not as a general performance optimization. Existing per-root CSS is repeated inside SSR markup, especially in the classes lane, while React's prepared code markup is already opaque in the light-DOM baseline. A broader performance claim would need a different hypothesis and measurement.

## Reproduction and artifacts

Reproduce the temporary dependency setup and production run with the exact commands in the [benchmark README](README.md). The retained [harness](../../scripts/bench-shadow-dom-spike.mjs) can run correctness-only validation or timed samples. The [consumer demo](../../examples/shadow-dom/README.md) shows the existing React `Code` macro's render-hook integration; it adds no Ferriki native or public API surface.
