# Decoded prepared-cache timings on Blacksmith

Measured October 25, 2026 at `ff25d172e86137e8f88a123fcebd409f5e4d2c3c` in [the successful workflow](https://github.com/sebastian-software/ferriki/actions/runs/40198189046). All six timing jobs and both evidence merges passed. The later commit only synchronizes the separate fuzz lockfile; it does not change runtime code.

This capture uses persistent decoded prepared containers. Source Off, source Auto, source Eager, Prepared, Shiki WASM, Shiki JS and Prism retain their existing identities and grammar/output gates. Only requested grammar roots and dependencies load. The repository workload requests 14 languages; it does not load the entire catalog.

## Repository results

Milliseconds; lower is faster. Reused values sum per-document medians for the same 14 files on one corpus VM. First use includes module imports, highlighter setup and a complete first render in ten fresh processes. Untimed setup/output validation has already populated the decoded cache. Downloads, package generation, first decoded-cache fill and process creation are excluded.

| Host / phase             | Source Off | Source Auto | Source Eager | Prepared | Shiki WASM |
| ------------------------ | ---------: | ----------: | -----------: | -------: | ---------: |
| Linux x86-64 / reused    |    149.131 |     106.707 |      106.276 |  192.486 |    376.536 |
| Linux x86-64 / first use |    253.798 |     449.868 |      558.463 |  954.952 |   1170.832 |
| macOS ARM64 / reused     |    117.168 |      78.077 |       77.183 |  111.239 |    324.776 |
| macOS ARM64 / first use  |    212.247 |     327.011 |      404.824 |  501.929 |   1102.931 |

Full-corpus Shiki JS remains unsupported because of its YAML conversion limit. All supported native/Shiki HTML agreement checks passed, with actual prepared-group loading and no invalid groups or assembly fallbacks. Prism remains an independent-grammar comparator.

## Interpretation

The [earlier capture](../2026-10-25-regex-modes/README.md) is retained unchanged. macOS prepared first use changes from 619.943 to 501.929 ms, while source Eager changes from 413.725 to 404.824 ms and Shiki WASM from 1099.914 to 1102.931 ms. The separate [frozen-input local diagnostic](../../precompiled-patterns/decoded-cache/README.md) isolates setup and first cache fill without relying on cross-VM differences.

Linux absolute first-use values are higher in this run: Prepared 817.980 → 954.952 ms, source Eager 445.894 → 558.463 ms, and Shiki WASM 958.419 → 1170.832 ms. Reused source and Shiki values are also about 24–26% higher. Since the unchanged Shiki comparator moved with the native controls on a different VM, this does not establish a cache regression. Prepared/Shiki first-use time is 0.853 in the earlier VM and 0.816 in this one; these within-VM ratios are descriptive, not a controlled before/after effect estimate.

Prepared still takes longer than source Eager for full-corpus first use on both profiles. The loader change does not fix execution differences. SQL is retained in the raw corpus and tables but is not investigated further here. No Source-Off startup, Source-Eager execution or whole-build parity is claimed.

## Evidence and reproduction

`<profile>/` retains every original merged report, context, process log, validation and SHA-256 record. Large files are losslessly gzipped; checksums continue to describe their original bytes. The merged context records each corpus VM independently. No timing aggregate crosses corpus VMs.

The website’s current timing overview and all 156 curated/TIOBE language rows are generated from this capture. The earlier memory tables retain their original workflow and are explicitly labeled as predating the decoded cache. No new memory measurement or memory target is implied.

Run `node scripts/publish-decoded-cache-evidence.mjs --check` to verify original checksums, output gates, build provenance and generated timing data. The homepage build runs this check. Start the workflow with suite `timings` and platform `both` to repeat the capture.
