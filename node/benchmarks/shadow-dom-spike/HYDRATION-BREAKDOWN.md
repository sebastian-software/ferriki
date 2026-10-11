# Where the hydration interval goes

The historical **44.1 ms** inline/reference hydration figure measures elapsed time from the call to `hydrateRoot` to the App's layout-effect commit timestamp. It does not measure 44.1 ms of React execution. Follow-up tracing shows that most of this interval is pending browser rendering work after custom-element registration. React's scheduled hydration runs afterward.

The light-DOM comparison completes similar browser work **before** that timer starts. The original numbers remain valid for their stated call-to-commit boundary, but their difference cannot establish a corresponding React overhead or complete-startup difference.

## Evidence and scope

The [retained profile](results/2026-10-11-inline-hydration-profile.json.gz) was collected on 2026-10-11 with 15 untraced samples and four warmups per condition. It uses production React/ReactDOM 19.3.0, scheduler 0.28.0, Vite 8.3.2, Playwright 1.63.0, and Chromium 153.0.8010.12 on an Apple M1 Ultra running macOS 27.0.0 and Node v24.21.0. All 12 measured-source hashes and four compressed trace hashes were checked and matched.

The workload is unchanged: six medium and six large TSX blocks, inline token styles, both theme aliases, line numbers, and selection annotations. It contains 1,662 source lines including trailing blank lines, 10,686 content elements, and 10,662 spans. Hosts reserve their full height; no `maxLines` cap is applied. These are thin `code()` adapters, not the complete generated `Code` helper.

The [historical reserved-host result](results/2026-10-11-reference-dsd-reserved.json.gz) and its 44.1 ms median remain unchanged. Current runtime/source hashes are recorded separately in the follow-up. The new immediate-reference median is **42.2 ms [41.6–44.4]**, reproducing the same behavior. Detailed trace figures below come from separate diagnostic runs with tracing and CPU sampling enabled, rather than from the median of the untraced runs.

## The measured sequence

Reference registration upgrades the existing empty hosts, installs the shared sheet, parses prepared HTML through `template.innerHTML`, and moves it into each shadow root. This synchronous registration is timed separately: **9.7 ms [9.5–10.2]** in the follow-up. In its diagnostic trace, registration takes 10.045 ms, including 7.540 ms in `ParseHTML` events. None of that HTML parsing is inside the hydration interval.

`hydrateRoot` creates the root, attaches event handling, and schedules work. Its synchronous call takes **0.5 ms [0.4–0.5]** in the reference samples. The browser then processes pending style, layout, prepaint, and paint work before React's scheduler callback runs. The timer remains active until the App's layout effect.

Inspection of the pinned production React source confirms that hydration matches the outer host and advances through its light-DOM children and siblings. The reference host has no React children. This path does not access `shadowRoot`, parse the prepared code, or create token fibers. The harness's baseline shadow-node inspection precedes the start timestamp, and its post-commit inspection follows the end timestamp. React's documented [hydration contract](https://react.dev/reference/react-dom/client/hydrateRoot) is attachment to existing server HTML; the light-DOM baseline does not write `dangerouslySetInnerHTML` again during this matching production hydration.

## A representative reference trace

The [reference immediate trace](results/2026-10-11-inline-hydration-profile-traces/reference-immediate.trace.json.gz) spans **43.976 ms** from the hydration-start mark to the App-commit mark:

| Work inside that interval                                | Elapsed ms |
| -------------------------------------------------------- | ---------: |
| Synchronous `hydrateRoot` call                           |      0.585 |
| React scheduling microtask callback                      |      0.223 |
| Browser style update (`UpdateLayoutTree`)                |     15.969 |
| Browser layout (`Layout`)                                |     17.043 |
| Browser prepaint (`PrePaint`)                            |      4.702 |
| Browser paint (`Paint`, overlapping events counted once) |      1.093 |
| React scheduler callback through the commit mark         |      3.231 |
| Remaining main-task intervals                            |      1.091 |
| Intervals outside recorded main tasks                    |      0.039 |
| Total                                                    |     43.976 |

The browser rendering events account for **38.807 ms**, about 88% of this trace. The synchronous React call and its two observed callbacks account for approximately **4.0 ms**. These are elapsed timeline intervals, not an isolated CPU accounting of every React function. The V8 CPU-profile summaries span navigation through post-commit checks and must not be attributed entirely to hydration.

The [light-DOM trace](results/2026-10-11-inline-hydration-profile-traces/light-immediate.trace.json.gz) records **42.005 ms** of style, layout, prepaint, and paint before `hydrateRoot` starts. Its subsequent call-to-commit interval is 4.547 ms, with only a 0.002 ms prepaint event and no style/layout/paint events. The baseline's real rendering cost exists; the original hydration timer excludes it.

The [machine-readable breakdown](results/2026-10-11-inline-hydration-breakdown.json.gz) retains clipped intervals and events for all four traces. Nested events are partitioned without double counting. Its validation checks that partitions sum to each window, trace hashes match, and trace timestamps agree with rounded User Timing measurements within 0.25 ms.

## Controls that move the work

All figures are medians in milliseconds, with p10–p90 ranges for the commit interval. The setup-to-commit column includes the control's preceding work, but excludes document parsing, imports, network, and earlier page rendering. It is not complete startup time. Columns are summarized independently; their medians need not add exactly.

| Hydration condition                   | Registry setup | Work inserted before hydration | Call to commit [p10–p90] | Setup start to commit | Commit to second rAF |
| ------------------------------------- | -------------: | -----------------------------: | -----------------------: | --------------------: | -------------------: |
| Light DOM, immediate                  |            0.0 |                              — |            3.6 [3.5–3.7] |                   3.8 |                 22.7 |
| Reference, immediate                  |            9.7 |                              — |         42.2 [41.6–44.4] |                  51.9 |                 16.1 |
| Reference, forced style/layout read   |            9.7 |                           31.9 |         10.5 [10.0–10.8] |                  52.3 |                 15.2 |
| Reference, wait for two rAF callbacks |            9.8 |                           43.7 |            5.3 [5.1–6.0] |                  58.7 |                 25.7 |
| Reference, `flushSync` control        |            9.8 |                              — |            3.0 [2.9–3.1] |                  12.9 |                 43.8 |
| DSD, immediate                        |            1.3 |                              — |         23.7 [23.5–24.5] |                  25.2 |                  1.1 |

The forced geometry read moves style and layout before hydration. Its [trace](results/2026-10-11-inline-hydration-profile-traces/reference-preflush.trace.json.gz) shows 33.248 ms of style/layout in that read, while prepaint and paint still run before the scheduled React callback. Waiting for two frames also moves presentation work before hydration, leaving scheduling and React work in the smaller interval.

The synchronous control is particularly clear: its [trace](results/2026-10-11-inline-hydration-profile-traces/reference-flushsync.trace.json.gz) reaches the commit mark in 3.579 ms with no style/layout/prepaint/paint events inside that interval. Those rendering events then consume 38.787 ms **after** the commit. The work has changed order; it has not disappeared. The second-rAF column is a frame proxy, not an exact paint measurement, and includes post-commit identity inspection. `flushSync` is used here as a diagnostic control, not as a proposed runtime change.

The DSD result remains an elapsed interval. No separate DSD timeline was collected in this focused run, so the reference trace's detailed percentages should not be applied to DSD.

## Client-only construction

When both variants start with an empty container, the follow-up measures **10.2 ms [9.9–10.2]** to commit for light-DOM HTML and **12.8 ms [12.6–13.1]** for references. The DSD adapter also takes 12.8 ms on this client-only path. Reference registry setup adds a separately timed 0.7 ms; actual host connection and HTML construction happen during the mount. Browser presentation follows the commit in both lanes.

This is a small, measurable construction overhead in the fixture, rather than the roughly 40 ms React penalty implied by reading the hydration table as CPU time. Shadow DOM isolates CSS and token ownership, while HTML parsing and browser layout remain necessary. These results do not establish a universal startup speedup for either renderer.

## Replay and validation

Using the pinned temporary dependency installation described in the [harness guide](README.md), run from `node/` and write a fresh result rather than overwriting the retained snapshot:

```sh
FERRIKI_SHADOW_BENCH_DEPS_ROOT=/private/tmp/ferriki-react-jsx-spike-deps node scripts/bench-shadow-dom-spike.mjs --profile --profile-samples 15 --profile-warmup 4 --write /private/tmp/ferriki-hydration-profile.json
node scripts/analyze-shadow-dom-trace.mjs benchmarks/shadow-dom-spike/results/2026-10-11-inline-hydration-profile-traces/reference-immediate.trace.json.gz
```

The profiler rotates nine conditions, validates the three production renderer lanes for text, annotations, styles, hydration, mount, theme/parent updates, and node identity, and checks errors and identity on each controlled page. Four diagnostic traces are collected separately. The existing default harness path was also checked with `--validate-only`: all 16 renderer/style/workload pairs passed without browser warnings. Syntax, lint, formatting, trace integrity, and interval-partition checks passed. No production runtime behavior was changed for this investigation.
