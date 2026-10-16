# Blacksmith process memory: linux-x86-64

Commit: 77bd49284792fea290fcd8d6a6bfe079dee256fb. Runner: blacksmith-4vcpu-ubuntu-2404. Node: v24.21.0.

Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.

| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |
| --- | --- | ---: | ---: | ---: |
| repository | ferriki | 65.7 [65.6–65.8] | 316.8 [316.7–316.9] | 318.4 [318.3–318.5] |
| repository | shiki-wasm | 92.9 [87.5–104.5] | 458.8 [444.6–469.1] | 463.1 [448.9–474.4] |
| repository | shiki-js | 83.4 [82.4–84.9] | 361.2 [350.6–382.3] | 365.8 [355.2–385.6] |
| large-typescript | ferriki | 62.5 [62.3–62.7] | 108.2 [108.0–108.4] | 110.6 [110.5–110.8] |
| large-typescript | shiki-wasm | 84.8 [80.1–89.3] | 334.3 [308.2–335.6] | 348.4 [319.3–351.4] |
| large-typescript | shiki-js | 72.7 [72.5–73.3] | 307.6 [306.2–332.2] | 318.8 [317.4–340.7] |

RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.

See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.
