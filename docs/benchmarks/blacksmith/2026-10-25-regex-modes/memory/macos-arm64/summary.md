# Blacksmith process memory: macos-arm64

Commit: 8aba6dd009fa09a3eed895e1764b2f04dbef0f1b. Runner: blacksmith-6vcpu-macos-26. Node: v24.21.0.

Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.

| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |
| --- | --- | ---: | ---: | ---: |
| repository | Ferriki source Off | 65.2 [65.0–65.3] | 142.1 [142.0–142.4] | 144.0 [143.9–144.3] |
| repository | Ferriki source Auto (lazy DFA) | 65.1 [64.9–65.3] | 270.9 [270.7–271.1] | 272.8 [272.7–273.0] |
| repository | Ferriki source Eager | 65.2 [65.0–65.3] | 272.6 [272.5–273.1] | 274.5 [274.4–275.0] |
| repository | Ferriki prepared Eager | 938.0 [937.9–938.1] | 1071.3 [1071.3–1071.5] | 1073.2 [1073.2–1073.4] |
| repository | Shiki WASM | 87.3 [86.2–88.1] | 452.1 [444.4–459.0] | 457.6 [448.5–465.2] |
| repository | Shiki JS | 83.2 [82.9–84.4] | 333.1 [328.2–339.3] | 339.8 [333.8–344.5] |
| large-typescript | Ferriki source Off | 61.7 [61.7–61.8] | 85.6 [85.4–85.8] | 87.2 [87.1–87.4] |
| large-typescript | Ferriki source Auto (lazy DFA) | 61.7 [61.5–61.8] | 104.1 [103.9–104.5] | 105.7 [105.5–106.2] |
| large-typescript | Ferriki source Eager | 61.7 [61.6–61.8] | 105.1 [104.7–105.3] | 106.7 [106.3–106.9] |
| large-typescript | Ferriki prepared Eager | 172.3 [172.1–172.4] | 205.5 [205.4–205.9] | 207.2 [207.0–207.5] |
| large-typescript | Shiki WASM | 79.3 [79.2–79.5] | 315.6 [313.3–317.6] | 326.4 [323.9–328.2] |
| large-typescript | Shiki JS | 70.5 [70.1–70.9] | 288.8 [279.2–299.5] | 297.1 [289.8–310.7] |

RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.

See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.
