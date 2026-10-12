# Historical template Web Component benchmark

This report measures the superseded template-based Web Component. It does not
measure the current `highlightedCode` property or shared constructed stylesheet.
The raw result and measurement details below remain unchanged historical
evidence. See the [property component report](PROPERTY-COMPONENT-REPORT.md) for
the current implementation.

Timed run: 2026-10-11. All eight renderer, style-mode, and workload pairs passed
the production-browser validation. The [raw result](results/2026-10-11-web-component.json.gz)
retains every sample and the full validation and provenance records. The older
[report](REPORT.md) and [result](results/2026-10-11.json.gz) remain historical
measurements of the React-host prototype.

On these workloads, style isolation is the benefit; the timings do not show a
broad speedup over an opaque light-DOM host. The shadow lane adds about 1.4 KiB
gzip of non-React client JavaScript. Per-root styles increase compressed SSR
HTML, while memoized theme and parent updates stay close to the light-DOM lane.

## Scope and method

This is a bounded consumer-side spike using the thin React `ShadowCode` adapter
and build-time `code()` descriptors. It compares a light-DOM React host with
the template Web Component path in `inline` and `classes` style modes, using one
large TSX block and a twelve-block mixed page. The measured adapter memoizes
serialized template markup per component instance using HTML/CSS and
template-generation inputs. The generated default-macro helper uses the same
strategy and is covered by separate integration checks. `className` and theme
attribute changes leave the markup reusable; the Web Component runtime itself
is unchanged. This benchmark does not measure all default macro CSS-delivery variants or
end-to-end use in a production application, so these results do not
characterize the full scope of issue #221. Client phases reuse prepared
descriptors; highlighting is not part of those intervals.

On the twelve-block `classes` workload, the memoized shadow lane measured
median React commit intervals of 0.7 ms for theme updates and 0.3 ms for parent
rerenders.

Each cell used a production Vite client and SSR build, 15 measured samples, and
4 warmups. SSR timing covers a warm `renderToString` call. Browser timings are
React commit intervals from the triggering call through the App layout-effect
timestamp. Template promotion, browser style calculation, and layout may happen
after that commit. The separately recorded second-`requestAnimationFrame`
proxy includes identity inspection and frame scheduling; it is not paint
timing. Browser assets were served locally. The benchmark validates visible
source, styles, line annotations, hydration, client-only mounting, theme
updates, node identity, and browser/React errors before timing.

The light-DOM lane uses one page-level base/theme stylesheet and the shared
macro-generated Vite CSS asset. Each Shadow DOM root embeds the descriptor's
`code.css` and local base/theme stylesheet. This repeated root CSS is included
in the complete SSR HTML byte totals below.

## Timing

Values are median milliseconds with the p10–p90 interval in brackets. SSR is
the `renderToString` interval; browser columns are React commit intervals.

| Style   | Page         | Renderer |                 SSR |     Hydration |     Client mount |  Theme update | Parent rerender |
| ------- | ------------ | -------- | ------------------: | ------------: | ---------------: | ------------: | --------------: |
| inline  | one large    | light    | 0.021 [0.015–0.033] | 3.4 [3.2–3.4] |    4.7 [4.3–5.1] | 0.6 [0.4–0.6] |   0.2 [0.1–0.2] |
| inline  | one large    | shadow   | 0.024 [0.017–0.034] | 3.7 [3.5–4.0] |    5.6 [5.4–6.2] | 0.6 [0.5–0.6] |   0.2 [0.1–0.2] |
| inline  | twelve mixed | light    | 0.066 [0.059–0.072] | 3.7 [3.6–5.2] | 10.4 [10.1–10.8] | 0.7 [0.6–0.7] |   0.2 [0.2–0.3] |
| inline  | twelve mixed | shadow   | 0.118 [0.103–0.130] | 4.1 [4.0–6.2] | 13.7 [13.1–14.5] | 0.7 [0.6–0.8] |   0.2 [0.1–0.3] |
| classes | one large    | light    | 0.020 [0.015–0.040] | 4.2 [4.0–4.3] | 12.6 [12.4–13.3] | 0.6 [0.5–0.6] |   0.2 [0.1–0.3] |
| classes | one large    | shadow   | 0.023 [0.018–0.038] | 4.4 [4.2–4.7] | 13.0 [12.8–13.5] | 0.5 [0.5–0.6] |   0.2 [0.1–0.3] |
| classes | twelve mixed | light    | 0.061 [0.046–0.071] | 5.4 [4.7–6.0] | 61.2 [60.0–62.3] | 0.7 [0.6–0.7] |   0.2 [0.2–0.3] |
| classes | twelve mixed | shadow   | 0.144 [0.131–0.159] | 5.1 [4.5–5.5] | 62.2 [60.9–64.0] | 0.7 [0.6–0.8] |   0.3 [0.2–0.3] |

## Payload

Complete `renderToString` HTML bytes are raw / gzip / Brotli. Embedded style
bytes are raw / gzip and are already part of the HTML totals.

| Style   | Page         | Renderer |                SSR HTML bytes |        Embedded style bytes |
| ------- | ------------ | -------- | ----------------------------: | --------------------------: |
| inline  | one large    | light    |        94,088 / 5,305 / 5,004 |          3,240 / 579 shared |
| inline  | one large    | shadow   |        94,163 / 5,442 / 5,117 |         3,302 / 698 in root |
| inline  | twelve mixed | light    |      674,970 / 32,778 / 5,961 |          3,240 / 579 shared |
| inline  | twelve mixed | shadow   |      711,994 / 36,820 / 6,089 |   39,635 / 982 across roots |
| classes | one large    | light    |   1,698,377 / 43,864 / 19,325 |          3,240 / 579 shared |
| classes | one large    | shadow   |   1,702,922 / 44,526 / 19,793 |       7,772 / 1,444 in root |
| classes | twelve mixed | light    | 12,494,982 / 325,228 / 22,900 |          3,240 / 579 shared |
| classes | twelve mixed | shadow   | 12,587,452 / 338,671 / 23,520 | 95,081 / 2,229 across roots |

Client payloads are raw / gzip / Brotli bytes. The non-React JavaScript subtotal
excludes the same dedicated React vendor chunk in every cell (219,033 / 67,377 /
63,375 bytes). The generated CSS asset is shared between renderers for each
style mode.

| Style   | Renderer |        Non-React JavaScript |             CSS asset |
| ------- | -------- | --------------------------: | --------------------: |
| inline  | light    |   127,326 / 11,128 / 10,001 |       512 / 314 / 246 |
| inline  | shadow   |   131,377 / 12,601 / 11,430 |       512 / 314 / 246 |
| classes | light    | 2,106,569 / 61,630 / 27,797 | 5,729 / 1,123 / 1,024 |
| classes | shadow   | 2,110,620 / 63,057 / 29,233 | 5,729 / 1,123 / 1,024 |

## Environment and provenance

Run environment: macOS 27.0.0 on Apple M1 Ultra (20 CPU cores, 64 GiB RAM),
Node v24.21.0, V8 13.6.233.17-node.53, Chromium 153.0.8010.12, React and
ReactDOM 19.3.0, scheduler 0.28.0, Playwright 1.63.0, and Vite 8.3.2. The
working tree was based on commit `78617ebd1c06abbc374409bddfcb739d79de928f`;
the raw JSON records its dirty state and native build receipt.

| Input                                     | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Native addon (`darwin-arm64`)             | `57eb3a00c4809c3742f6b363eaaa587b3e7d4d3207edb40ede3b85477a3f1157` |
| `node/scripts/bench-shadow-dom-spike.mjs` | `4cf73b9dbf8a63b5566076eb21e9e5590cc3432c65257659f9c5c49e59a7a30d` |
| `node/ferriki/web-component.mjs`          | `ea9909f056bdb80af85b864742b3c727d0626bb750293e26a90d86063f0f8993` |
| `node/examples/shadow-dom/ShadowCode.mjs` | `ae4fd86f867089a5d5965360aab933c65188ca787b887d3b8cb5843701a25b3c` |
| `node/vite/index.mjs`                     | `29a0ba77417ea574911ecf03b067b3dc02a4e0d5e8cd7e063fbbf349220ef103` |
| `node/vite/macro-scan.mjs`                | `81372475b7121b4260172958977c93f2aa42fb651e97bf68d480a8ee14cd624c` |
| `node/ferriki/src/index.mjs`              | `96349fb1ead14bfdb5405a88d3436d4d47bd8b4785b502b554a6dca2441f85ab` |
| `node/ferriki/classes.mjs`                | `43cb91c8d25d6235b82b02d41573169a14e45204e52ccc7a491f036dbd4d5bcf` |
| `node/ferriki/transformers.mjs`           | `23bdfeae0ea7031bab26f097c496ba171922f268519f499f6cff7f119424c5a0` |
| medium fixture (1,563 bytes)              | `1968d06ebaa61c62bca21db826639c5d57fbdd57f856870965a18c494f2f1edc` |
| large fixture (7,442 bytes)               | `412dd9dad6d38a896fc3ddcd81d9c956506c4c329c6b460ee96551e2b07bb5db` |

These figures describe this fixed local spike and workload only. They are
measurement evidence for review, not a general performance guarantee.
