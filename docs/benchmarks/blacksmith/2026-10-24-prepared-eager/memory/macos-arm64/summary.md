# Blacksmith process memory: macos-arm64

Commit: 2b16844ed26da3d58a8198e362cd467f777bea7d. Runner: blacksmith-6vcpu-macos-26. Node: v24.21.0.

Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.

| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |
| --- | --- | ---: | ---: | ---: |
| repository | ferriki | 937.9 [937.9–937.9] | 1071.3 [1071.2–1071.4] | 1073.2 [1073.1–1073.3] |
| repository | shiki-wasm | 86.9 [85.8–88.7] | 451.9 [448.3–454.8] | 457.0 [453.8–459.7] |
| repository | shiki-js | 84.2 [83.3–84.4] | 333.6 [330.3–338.4] | 339.5 [336.4–344.3] |
| large-typescript | ferriki | 172.0 [171.8–172.2] | 205.6 [205.5–205.8] | 207.3 [207.1–207.4] |
| large-typescript | shiki-wasm | 79.6 [79.3–83.2] | 304.9 [302.8–330.4] | 319.5 [318.4–341.4] |
| large-typescript | shiki-js | 70.6 [70.4–70.8] | 292.0 [285.2–300.7] | 300.5 [296.3–306.9] |

RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.

See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.
