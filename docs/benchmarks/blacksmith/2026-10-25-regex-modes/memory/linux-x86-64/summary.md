# Blacksmith process memory: linux-x86-64

Commit: 8aba6dd009fa09a3eed895e1764b2f04dbef0f1b. Runner: blacksmith-4vcpu-ubuntu-2404. Node: v24.21.0.

Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.

| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |
| --- | --- | ---: | ---: | ---: |
| repository | Ferriki source Off | 66.2 [66.1–66.4] | 140.2 [139.9–140.5] | 142.1 [141.8–142.4] |
| repository | Ferriki source Auto (lazy DFA) | 66.2 [66.1–66.3] | 252.4 [252.1–252.9] | 254.3 [254.0–254.8] |
| repository | Ferriki source Eager | 66.2 [66.1–66.4] | 254.8 [254.7–254.9] | 256.7 [256.6–256.8] |
| repository | Ferriki prepared Eager | 552.3 [552.2–552.4] | 689.1 [689.0–689.2] | 750.6 [750.5–750.8] |
| repository | Shiki WASM | 88.6 [87.9–91.6] | 438.6 [437.9–441.5] | 445.0 [442.8–446.4] |
| repository | Shiki JS | 83.0 [82.5–83.8] | 341.7 [340.8–347.8] | 347.5 [346.1–353.8] |
| large-typescript | Ferriki source Off | 63.0 [62.8–63.2] | 86.3 [86.2–86.5] | 88.1 [88.1–88.4] |
| large-typescript | Ferriki source Auto (lazy DFA) | 62.9 [62.8–63.2] | 102.2 [102.1–102.5] | 104.4 [104.3–104.7] |
| large-typescript | Ferriki source Eager | 63.1 [62.8–63.1] | 103.7 [103.5–103.8] | 106.1 [105.8–106.3] |
| large-typescript | Ferriki prepared Eager | 121.5 [121.4–121.6] | 151.2 [151.1–151.3] | 172.6 [172.5–172.6] |
| large-typescript | Shiki WASM | 80.8 [80.7–81.0] | 306.9 [305.5–307.9] | 317.0 [315.8–318.3] |
| large-typescript | Shiki JS | 72.9 [72.4–73.1] | 287.8 [287.2–305.0] | 298.5 [297.8–315.9] |

RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.

See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.
