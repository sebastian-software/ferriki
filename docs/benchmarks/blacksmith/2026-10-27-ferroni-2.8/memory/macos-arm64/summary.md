# Blacksmith process memory: macos-arm64

Commit: ee1ad3a881544112f659c4b3d83eddca263bfd02. Runner: blacksmith-6vcpu-macos-26. Node: v24.21.0.

Six fresh processes per engine and scenario. MiB (2^20 bytes); median [min–max]. Absolute whole-process RSS, including Node, Rust and WASM. Lower uses less resident memory. Peak includes startup through the last render checkpoint. Exact HTML agreement passed before measurement.

| Scenario | Engine | Initialized RSS | Final RSS after GC | Peak RSS |
| --- | --- | ---: | ---: | ---: |
| repository | Ferriki source Off | 65.3 [65.1–65.4] | 143.2 [143.0–143.4] | 145.1 [144.9–145.3] |
| repository | Ferriki source Auto (lazy DFA) | 65.2 [65.2–65.5] | 272.2 [272.0–272.7] | 274.2 [273.9–274.7] |
| repository | Ferriki source Eager | 65.3 [65.2–65.3] | 273.6 [273.4–273.9] | 275.6 [275.4–275.9] |
| repository | Ferriki prepared Eager | 69.0 [68.9–69.1] | 249.0 [248.9–249.1] | 251.0 [250.9–251.0] |
| repository | Shiki WASM | 87.0 [86.3–97.1] | 450.8 [448.5–453.4] | 456.2 [453.5–458.6] |
| repository | Shiki JS | 83.3 [83.0–84.2] | 332.5 [331.0–337.2] | 339.1 [335.5–342.6] |
| large-typescript | Ferriki source Off | 61.8 [61.7–62.0] | 85.2 [85.0–86.1] | 86.8 [86.7–87.7] |
| large-typescript | Ferriki source Auto (lazy DFA) | 61.8 [61.7–61.9] | 102.9 [102.8–103.1] | 104.6 [104.5–104.8] |
| large-typescript | Ferriki source Eager | 61.7 [61.7–61.9] | 103.9 [103.6–104.2] | 105.6 [105.2–105.8] |
| large-typescript | Ferriki prepared Eager | 63.3 [63.2–63.5] | 101.3 [101.2–101.6] | 103.0 [102.8–103.2] |
| large-typescript | Shiki WASM | 79.4 [79.0–79.7] | 328.4 [317.0–333.0] | 334.3 [327.5–344.1] |
| large-typescript | Shiki JS | 70.5 [70.0–70.8] | 294.9 [287.2–305.9] | 300.7 [298.1–317.2] |

RSS includes the Node runtime, native code, WASM and allocator retention. V8 heap/external/ArrayBuffer fields are diagnostic subsets, not native allocation counters. Forced GC does not force native allocators or WASM to return pages to the OS. Fixed sequential workloads are not a leak, concurrency or capacity test. Compare within a host, not across operating systems.

See memory.json for baseline, every checkpoint, V8 diagnostic fields, output validation and individual samples.
