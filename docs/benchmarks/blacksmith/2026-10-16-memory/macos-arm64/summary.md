# Blacksmith process memory: macos-arm64

Commit: 77bd49284792fea290fcd8d6a6bfe079dee256fb. Runner: blacksmith-6vcpu-macos-26. Node: v24.21.0.

Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.

| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |
| --- | --- | ---: | ---: | ---: |
| repository | ferriki | 65.0 [64.9–65.1] | 330.5 [330.1–331.5] | 332.2 [331.9–333.2] |
| repository | shiki-wasm | 87.1 [86.0–90.5] | 451.6 [447.4–460.2] | 456.4 [452.6–465.0] |
| repository | shiki-js | 83.6 [82.3–84.5] | 332.0 [329.7–339.5] | 336.5 [334.0–344.1] |
| large-typescript | ferriki | 61.4 [61.0–61.6] | 109.5 [109.2–109.9] | 111.2 [110.9–111.6] |
| large-typescript | shiki-wasm | 79.3 [79.1–80.0] | 306.9 [302.6–323.0] | 319.3 [318.5–338.5] |
| large-typescript | shiki-js | 70.5 [70.1–70.5] | 290.2 [285.7–296.1] | 299.5 [296.4–301.9] |

RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.

See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.
