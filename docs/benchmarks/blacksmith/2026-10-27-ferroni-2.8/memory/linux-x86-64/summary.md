# Blacksmith process memory: linux-x86-64

Commit: ee1ad3a881544112f659c4b3d83eddca263bfd02. Runner: blacksmith-4vcpu-ubuntu-2404. Node: v24.21.0.

Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.

| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |
| --- | --- | ---: | ---: | ---: |
| repository | Ferriki source Off | 66.3 [66.0–66.4] | 141.3 [141.1–141.6] | 143.2 [143.0–143.5] |
| repository | Ferriki source Auto (lazy DFA) | 66.1 [66.1–66.2] | 253.4 [253.3–253.7] | 255.3 [255.2–255.6] |
| repository | Ferriki source Eager | 66.2 [66.1–66.3] | 256.0 [255.7–256.2] | 257.8 [257.6–258.0] |
| repository | Ferriki prepared Eager | 69.4 [69.2–69.5] | 243.0 [242.9–243.2] | 244.8 [244.8–245.0] |
| repository | Shiki WASM | 89.3 [87.6–97.2] | 441.7 [435.8–459.5] | 446.7 [441.0–465.5] |
| repository | Shiki JS | 84.1 [82.6–84.3] | 343.8 [342.3–344.7] | 349.6 [348.0–351.6] |
| large-typescript | Ferriki source Off | 63.1 [62.9–63.2] | 86.6 [86.4–86.8] | 88.5 [88.3–88.7] |
| large-typescript | Ferriki source Auto (lazy DFA) | 62.9 [62.9–63.1] | 102.5 [102.4–102.6] | 104.9 [104.8–105.0] |
| large-typescript | Ferriki source Eager | 63.0 [62.8–63.2] | 103.9 [103.8–104.1] | 106.2 [106.1–106.4] |
| large-typescript | Ferriki prepared Eager | 64.2 [64.0–64.4] | 102.9 [102.7–103.1] | 104.6 [104.4–104.7] |
| large-typescript | Shiki WASM | 80.5 [79.7–80.7] | 308.6 [299.7–346.8] | 317.4 [310.7–357.0] |
| large-typescript | Shiki JS | 72.6 [72.4–72.8] | 287.0 [285.7–304.8] | 297.2 [294.9–315.8] |

RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.

See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.
