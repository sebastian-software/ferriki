# Property-based Web Component benchmark

Timed run: 2026-10-11. All eight production renderer, style-mode, and workload
pairs passed validation. The [raw result](results/2026-10-11-property-component.json.gz)
retains 15 measured samples and four warmups per cell and phase, correctness
evidence, source hashes, and the native build receipt.

The measured element takes `highlightedCode` as a string property and all roots
adopt one constructed stylesheet. Inline colors remain in the HTML; classes
rules and the component's base/theme-switching rules are shared. Validation
confirmed identical computed styles, exact source, preserved token nodes on
hydration/theme/parent updates, and zero per-root style tags.

The benefit demonstrated here is CSS isolation and shared stylesheet ownership.
This run does not demonstrate a general speedup over an opaque light-DOM HTML
host. The property interface makes SSR substantially more expensive: the
highlighted HTML is escaped into an attribute and the source is also rendered
as a plain fallback. Browser upgrade adds a separate HTML parsing and style
installation interval before hydration. Theme and parent updates remain small.

## Scope and timing boundaries

The harness compares the thin `ShadowCode` adapter with an opaque light-DOM
React host using the same build-time `code()` descriptors, theme map, annotations,
and component tree. It includes one large TSX block and twelve blocks alternating
the medium and large fixtures. Highlighting is outside client commit intervals.

Both adapter lanes retain the descriptor macro's ordinary Vite CSS asset. The
shadow lane additionally registers that CSS in its shared stylesheet; the light
lane emits equivalent base/theme rules once per page. This is a direct-element
adapter comparison. Default-only React `Code` macros deliver their CSS exclusively
to the shared shadow stylesheet and are covered by separate integration checks;
their complete production payload is not measured here.

SSR measures warm `renderToString` only. Browser commits start immediately before
the React call or update event and end at the layout-effect timestamp, before
DOM identity inspection. The shadow element is registered before hydration;
`presentationSetupMs` separately records synchronous CSS registration and the
upgrade of existing SSR hosts. Client-only setup has no SSR hosts to upgrade.
Neither interval includes document parsing, asset loading, or module evaluation.
These are bounded intervals, not complete startup or paint measurements. The
raw result also retains a commit-to-second-RAF proxy, which includes subsequent
DOM inspection and scheduling and must not be called exact paint timing.

The hydration interval is elapsed time until React commits, not isolated React
CPU time. React does not traverse the highlighted shadow nodes. Scheduler delays
and browser work can contribute to elapsed time, so these results do not isolate
the cause of the higher hydration interval. The observed SSR cost and byte
increase include escaping the HTML property into an attribute and rendering
the source fallback. A separate content-reference transport has not been measured.

Without JavaScript, the shadow lane preserves exact plain-source fallback text
without token spans; the light lane remains highlighted. Hydration has no
recoverable errors. All shadow roots adopt the same stylesheet object and
contain no local style tags.

## Timing results

Milliseconds, median [p10–p90]. “Setup” is the separate pre-hydration registration
and SSR upgrade interval; do not read the hydration column alone as startup cost.

| Style   | Page         | Renderer |                    SSR |            Setup |           Hydration |     Client mount |  Theme update | Parent rerender |
| ------- | ------------ | -------- | ---------------------: | ---------------: | ------------------: | ---------------: | ------------: | --------------: |
| inline  | one large    | light    |    0.019 [0.013–0.051] |    0.0 [0.0–0.0] |       3.3 [3.1–3.9] |    4.9 [4.6–5.2] | 0.6 [0.5–0.6] |   0.2 [0.1–0.2] |
| inline  | one large    | shadow   |    0.310 [0.286–0.336] |    2.3 [2.2–2.5] |    14.2 [13.9–14.8] |    5.3 [5.0–5.7] | 0.6 [0.5–0.7] |   0.2 [0.1–0.3] |
| inline  | twelve mixed | light    |    0.045 [0.030–0.075] |    0.0 [0.0–0.0] |       3.6 [3.4–3.9] | 10.6 [10.3–11.2] | 0.6 [0.6–0.7] |   0.2 [0.1–0.3] |
| inline  | twelve mixed | shadow   |    2.219 [2.147–4.089] |  10.2 [9.9–10.7] |    45.1 [38.3–47.1] | 13.4 [12.8–13.7] | 0.7 [0.7–0.9] |   0.3 [0.2–0.3] |
| classes | one large    | light    |    0.023 [0.014–0.047] |    0.0 [0.0–0.0] |       4.0 [3.8–4.3] | 12.9 [12.6–13.1] | 0.6 [0.5–0.6] |   0.2 [0.0–0.2] |
| classes | one large    | shadow   |    3.674 [3.492–3.908] |  10.0 [9.8–10.2] |    25.6 [25.1–26.8] | 13.1 [12.9–13.5] | 0.6 [0.5–0.7] |   0.2 [0.1–0.3] |
| classes | twelve mixed | light    |    0.066 [0.037–0.078] |    0.0 [0.0–0.0] |       4.8 [4.6–5.3] | 63.2 [60.3–64.6] | 0.7 [0.6–0.8] |   0.2 [0.2–0.3] |
| classes | twelve mixed | shadow   | 26.994 [26.384–34.771] | 61.2 [59.2–61.7] | 124.0 [119.0–126.3] | 65.1 [63.1–66.0] | 0.8 [0.7–0.9] |   0.3 [0.2–0.4] |

Client-only registration is 0.7–1.0 ms at the median in the shadow cells;
the code DOM is then created inside the reported mount interval. Light cells
have no corresponding registration interval. The raw samples record setup
and commits separately for both initial modes.

## Payload

Complete `renderToString(App)` bytes are raw / gzip / Brotli. The light-DOM
shared style tag is already included in these totals. Shadow SSR has no
style tag; its constructed CSS is delivered in JavaScript.

| Style   | Page         | Renderer |                SSR HTML bytes | Embedded stylesheet bytes |
| ------- | ------------ | -------- | ----------------------------: | ------------------------: |
| inline  | one large    | light    |        94,088 / 5,305 / 5,004 |                     3,240 |
| inline  | one large    | shadow   |       135,497 / 7,598 / 6,941 |                         0 |
| inline  | twelve mixed | light    |      674,970 / 32,778 / 5,961 |                     3,240 |
| inline  | twelve mixed | shadow   |    1,001,326 / 53,396 / 8,372 |                         0 |
| classes | one large    | light    |   1,698,377 / 43,864 / 19,325 |                     3,240 |
| classes | one large    | shadow   |   1,838,578 / 48,075 / 21,671 |                         0 |
| classes | twelve mixed | light    | 12,494,982 / 325,228 / 22,900 |                     3,240 |
| classes | twelve mixed | shadow   | 13,540,354 / 360,955 / 25,800 |                         0 |

Client assets below use raw / gzip / Brotli bytes. The dedicated React chunk
is identical between cells and is excluded from the non-React subtotal.

| Style   | Renderer |        Non-React JavaScript |             CSS asset |
| ------- | -------- | --------------------------: | --------------------: |
| inline  | light    |   127,425 / 11,155 / 10,026 |       512 / 314 / 246 |
| inline  | shadow   |   131,593 / 12,626 / 11,463 |       512 / 314 / 246 |
| classes | light    | 2,106,668 / 61,656 / 27,825 | 5,729 / 1,123 / 1,024 |
| classes | shadow   | 2,110,836 / 63,078 / 29,266 | 5,729 / 1,123 / 1,024 |

The shadow lane adds about 1.4 KiB gzip of non-React JavaScript. Its SSR HTML
is larger in every cell. On twelve inline blocks, HTML grows from 32,778
to 53,396 gzip bytes; on twelve classes blocks it grows from 325,228 to
360,955 gzip bytes. These transport and initialization costs belong in any
decision about adopting this interface.

## Environment and provenance

Run environment: macOS 27.0.0 on Apple M1 Ultra (20 CPU cores, 64 GiB RAM),
Node v24.21.0, V8 13.6.233.17-node.53, Chromium 153.0.8010.12, React and
ReactDOM 19.3.0, scheduler 0.28.0, Playwright 1.63.0, and Vite 8.3.2.
The working tree was based on `78617ebd1c06abbc374409bddfcb739d79de928f`;
the raw result preserves its dirty state and machine load. No other agent
browser or benchmark run was active during timed collection.

| Input                                                  | SHA-256                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| Native addon (`darwin-arm64`)                          | `57eb3a00c4809c3742f6b363eaaa587b3e7d4d3207edb40ede3b85477a3f1157` |
| `node/vite/index.mjs`                                  | `6da3303428edcbe93a8f555159219d1517d78d554de72bdc9461146e986fafef` |
| `node/vite/macro-scan.mjs`                             | `1bfe722ae9f6e7eba6b341657fd616e73dc1418ed61aa861d851305fee7022a8` |
| `node/ferriki/src/index.mjs`                           | `96349fb1ead14bfdb5405a88d3436d4d47bd8b4785b502b554a6dca2441f85ab` |
| `node/ferriki/classes.mjs`                             | `43cb91c8d25d6235b82b02d41573169a14e45204e52ccc7a491f036dbd4d5bcf` |
| `node/ferriki/transformers.mjs`                        | `23bdfeae0ea7031bab26f097c496ba171922f268519f499f6cff7f119424c5a0` |
| `node/ferriki/web-component.mjs`                       | `58e401044b54789e133bfc55076e78c78aafe330f32b1f60fed811d819f73bb1` |
| `node/examples/shadow-dom/ShadowCode.mjs`              | `0e14b6bd3cec7f25569dc7b398903b7f38a165c27828e2e5b279d86198280c00` |
| `node/benchmarks/shadow-dom-spike/fixtures/medium.tsx` | `1968d06ebaa61c62bca21db826639c5d57fbdd57f856870965a18c494f2f1edc` |
| `node/benchmarks/shadow-dom-spike/fixtures/large.tsx`  | `412dd9dad6d38a896fc3ddcd81d9c956506c4c329c6b460ee96551e2b07bb5db` |
| `node/scripts/bench-shadow-dom-spike.mjs`              | `a9f1eba0bbce3dd6581976ad13df87bfff72ad388257f60469e497070d402b62` |

The [React-host](REPORT.md) and [template-component](WEB-COMPONENT-REPORT.md)
reports describe superseded implementations. Their raw evidence is retained;
they do not measure this property interface or shared stylesheet. See the
[harness guide](README.md) to reproduce this run.
