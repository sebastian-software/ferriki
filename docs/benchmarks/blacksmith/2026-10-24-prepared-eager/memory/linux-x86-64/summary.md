# Blacksmith process memory: linux-x86-64

Commit: 2b16844ed26da3d58a8198e362cd467f777bea7d. Runner: blacksmith-4vcpu-ubuntu-2404. Node: v24.21.0.

Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.

| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |
| --- | --- | ---: | ---: | ---: |
| repository | ferriki | 552.5 [552.3–552.7] | 689.0 [688.9–689.2] | 750.7 [750.6–751.0] |
| repository | shiki-wasm | 96.1 [87.8–106.9] | 454.8 [447.6–474.9] | 459.8 [453.0–479.6] |
| repository | shiki-js | 83.2 [82.4–84.5] | 358.7 [356.0–369.8] | 362.7 [360.8–375.2] |
| large-typescript | ferriki | 121.4 [121.2–121.6] | 151.4 [151.2–151.5] | 172.5 [172.2–172.7] |
| large-typescript | shiki-wasm | 89.2 [88.9–89.7] | 333.8 [321.8–334.6] | 345.1 [332.9–345.9] |
| large-typescript | shiki-js | 72.7 [72.4–73.0] | 309.3 [306.3–310.2] | 320.6 [317.6–321.5] |

RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.

See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.
