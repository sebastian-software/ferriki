# Prepared code renderers: light DOM, Shadow DOM, references, and DSD

This benchmark compares four ways to present the same build-prepared Ferriki
code blocks: an equivalent light-DOM baseline, the `highlightedCode` property
adapter, reference-backed custom-element hosts, and Declarative Shadow DOM
(DSD). Both Ferriki style modes (`inline` and `classes`) and both fixture sizes
(`one-large` and `twelve-mixed`) are included, for 16 renderer/style/workload
pairs. The result is a bounded local comparison, not a general product
performance claim.

The [reference and DSD report](REFERENCE-DSD-REPORT.md) uses the final
[reserved-host raw result](results/2026-10-11-reference-dsd-reserved.json.gz).
The earlier [transport-only raw snapshot](results/2026-10-11-reference-dsd.json.gz)
is preserved unchanged; it predates host sizing. The
[property-component report](PROPERTY-COMPONENT-REPORT.md) and its
[raw JSON](results/2026-10-11-property-component.json.gz), the
[template-component report](WEB-COMPONENT-REPORT.md), and the
[React-host report](REPORT.md) remain historical records.

The [hydration breakdown](HYDRATION-BREAKDOWN.md) explains the historical
44.1 ms inline/reference interval using separate Chrome traces and controls.
Browser style/layout/paint work falls inside the reference timer but precedes
the light-DOM timer. This difference does not establish matching React CPU
overhead. Its [raw profile](results/2026-10-11-inline-hydration-profile.json.gz)
and [trace analysis](results/2026-10-11-inline-hydration-breakdown.json.gz) are
retained separately from the historical snapshots.

Retained JSON results use lossless gzip compression; decompression restores the
original bytes, including recorded hashes and source snapshots. For inspection:

```sh
gzip -dc benchmarks/shadow-dom-spike/results/2026-10-11-inline-hydration-profile.json.gz
```

The runner writes ordinary JSON. Use a fresh output path for new runs and
compress it separately if retaining it; do not overwrite dated evidence.

The [benchmark harness](../../scripts/bench-shadow-dom-spike.mjs) uses the same
`code()` descriptors, themes, line-number and selection annotations, component
tree, and medium/large source fixtures in each lane. The reference and DSD
lanes use thin adapters that pass a short semantic ID and static sizing style
object to React. A separate registry maps IDs to trusted prepared HTML; those
strings are not React props. Module-level sizing objects derive their line
count from prepared source, including trailing blank lines. The timing run
includes the resulting reserved-host presentation but excludes sizing-object
creation at module evaluation. This measures reference transport and runtime,
not the full Vite-generated default `Code` helper startup.

Without JavaScript, the lanes have distinct contracts. Light DOM is highlighted
in the document tree. The property lane retains exact plain-source fallback
text until its browser registration runs. A reference host has no block
content until JavaScript registers its reference, but reserves positive height
from the prepared source line count to reduce layout shift. DSD renders the
highlighted text and styles before JavaScript: each shadow root has a marked
link to the same CSS asset URL, with no duplicated inline stylesheet. On
registration, a matching DSD root and its code nodes are retained, registered
links are removed, and all roots adopt the shared constructed stylesheet. A
partially registered DSD page keeps both the existing nodes and the marked
stylesheet link for unresolved references. The three-engine integration check
measures host and next-sibling geometry before registration and after fill,
including custom line-height, padding, borders, and reference changes.

## Measurement boundaries

SSR timing covers a warm `renderToString` call for the light, property, and
reference lanes. For DSD, the timed interval includes both `renderToString` and
`renderCodeElementShadows` postprocessing. Module loading, output inspection,
external CSS response preparation, and network response writing are outside
that interval. DSD's external stylesheet is reported separately from HTML,
with raw, gzip, and Brotli byte counts for the CSS asset. The report describes
one shared stylesheet URL; it does not count actual HTTP requests.

The browser records custom-element registration and reference/block setup
separately as `presentationSetupMs`. Hydration, client-only mount, theme change,
and parent rerender are elapsed wall-clock intervals from the React call or
event to the App's layout-effect commit timestamp. They are not isolated React
CPU measurements and do not show that React walks or owns the shadow-tree
nodes. Asset loading, document parsing, module evaluation, and the follow-up
node-identity inspection are outside the commit intervals. The separate
commit-to-second-`requestAnimationFrame` value is a next-frame proxy, not an
exact paint measurement.

Use `--profile --profile-samples 15 --profile-warmup 4` for the focused inline
twelve-block experiment. It builds light, reference, and DSD production lanes,
rotates immediate hydration, pre-hydration geometry/frames, synchronous-commit
controls, and client-only mounting, and collects four separate compressed
Chrome traces. It does not change the default benchmark's timing boundary.
`scripts/analyze-shadow-dom-trace.mjs <trace.json[.gz]>` clips main-thread
events to its User Timing marks and partitions overlapping intervals without
double counting. The [breakdown report](HYDRATION-BREAKDOWN.md) records the
exact replay command and interpretation limits.

Validation runs every renderer/style/workload pair against production Vite
assets before collecting timings. It checks exact source and annotations,
computed style parity, SSR hydration and client-only mounting, theme and parent
updates, code-node identity, and each lane's distinct no-JavaScript behavior.
For reference and DSD it checks source-derived reserved height and matching
geometry. Any correctness failure stops the benchmark before timed samples
are written. The separate three-engine
[integration check](../../scripts/check-shadow-dom-spike.mjs) covers unknown
DSD references, partial and late CSS registration, marked-link retention and
removal, DSD node and shared-sheet identity, collisions, CSR reference and
geometry changes, and the property/HMR path in Chromium, Firefox, and WebKit.
Those additional integration cases are not repeated as timed assertions in
every benchmark pair.

## Reproducing the run

Build the native addon with the ordinary workspace workflow first. The pinned
benchmark dependencies live outside the workspace manifests and lockfile.

```sh
cd node
pnpm install
pnpm run build:native

FERRIKI_SHADOW_BENCH_DEPS_ROOT=/private/tmp/ferriki-react-jsx-spike-deps \
  node scripts/bench-shadow-dom-spike.mjs \
  --validate-only --write /private/tmp/ferriki-shadow-dom-validation.json

FERRIKI_SHADOW_BENCH_DEPS_ROOT=/private/tmp/ferriki-react-jsx-spike-deps \
  node scripts/bench-shadow-dom-spike.mjs \
  --samples 15 --warmup 4 \
  --write /private/tmp/ferriki-shadow-dom-measurement.json
```

The runner checks the pinned React, ReactDOM, scheduler, Playwright, and
workspace Vite versions, confirms the SSR build resolves the same React
installation as the browser fixture, and verifies the native build receipt.
The JSON output records all raw timing samples, summaries, correctness
evidence, source and fixture hashes, dependency/browser versions, native
receipt, Git state, and machine details. `--validate-only` builds and checks
all 16 pairs without collecting timed samples.

Compare absolute measurements and their spread. Do not treat a single commit
interval as complete startup cost or the RAF proxy as paint time.
