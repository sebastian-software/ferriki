# Typed token conversion: profile and optimization (#225)

Measured October 5, 2026 on an Apple M1 Pro, darwin-arm64, Node 24.15.0, with no other CPU-intensive work running. Three release builds use the same toolchain and workspace profile:

- **napi-v2**: `99c8cb7`, the napi-rs 2 JSON transport (release 0.12.0).
- **before**: `8799a6f`, the typed napi-rs 3 boundary from #224.
- **final**: this change.

**Result:** the typed boundary is now faster than the napi-rs 2 baseline on single- and multi-theme tokens, the native HTML path is unchanged to slightly faster, and the darwin-arm64 addon is 16 KiB smaller than before. All 234 outputs (156 token results, 78 HTML results) are byte-identical across the three builds, including property order and omitted optional fields.

## Where the time goes

`profile-native-boundary.mjs` times each phase inside one native call with a `--features profiling` build and counts Rust heap allocations. Sums of per-case medians over both corpora (19 TIOBE and 20 curated languages):

| Group            | Tokenizer |             DTO | N-API conversion before → final | Share of call, final |
| ---------------- | --------: | --------------: | ------------------------------: | -------------------: |
| example / single |   25.0 ms |         0.04 ms |                  3.42 → 2.67 ms |                 9.6% |
| large / single   |  395.0 ms |         0.62 ms |                53.45 → 40.94 ms |                 9.3% |
| example / multi  |   5095 ms |  0.80 → 0.38 ms |                  9.50 → 6.97 ms |                 0.1% |
| large / multi    |   5919 ms | 12.99 → 5.35 ms |               137.11 → 96.08 ms |                 1.6% |

The tokenizer dominates. Converting Rust results into the private DTOs costs well under 1%. The N-API conversion is the only boundary cost that matters, at about a tenth of a single-theme call. A steady-state samply profile of the whole single-theme corpus agrees: conversion was 11.5% of samples before and 9.0% after ([`samply-before-single.txt`](samply-before-single.txt), [`samply-final-single.txt`](samply-final-single.txt)).

Multi-theme calls spend more than 99% in the tokenizer: `ferroni::regcomp` dominates because every theme switch clears the compiled grammars (`SyncRegistry::set_theme` in `ferriki-textmate`), so each call compiles the grammar twice, with 34–72 million Rust allocations per corpus pass. That is a tokenizer defect outside this boundary and is tracked separately.

The facade adds little to the token path. The `styleMode: "classes"` path is the exception: native tokenization with scopes takes about 20 ms for the TIOBE examples, while the facade takes 114 ms, mostly in `classes.mjs` scope-class construction. That is also tracked separately.

## What the conversion cost before

The before profile of the conversion subtree ([`samply-before-single.txt`](samply-before-single.txt)) showed four avoidable costs beside V8's unavoidable property definition:

1. Every object's property names were passed as C strings, so V8 hashed and looked up each key in its string table for every object (`StringTable::LookupKey`, `InternalizeUtf8String`).
2. The shared color cache sat behind a thread-local and SipHash: `tlv_get_addr` plus `Sip13Rounds::write` and `color_value` cost about 12% of the conversion.
3. Every token string was decoded as UTF-8 (`Utf8DecoderBase`), although almost all token text is ASCII.
4. Multi-theme results rebuilt a `BTreeMap` per token in the DTO (and sorted already-sorted entries) and allocated a descriptor vector per token in the conversion.

Stock napi-rs object conversion would add per-property `napi_set_named_property` calls through JavaScript setter semantics, which is slower and turns a `__proto__` variant key into a prototype change. The own-property batching from #224 stays.

## Changes

- One `Writer` converts a whole result. It reads internalized property keys back from a template object once per Node environment and keeps them in a referenced array, released by an environment cleanup hook (worker threads included).
- Repeated colors and theme keys share one string handle through a per-result FNV map, with no thread-local state.
- ASCII strings use `napi_create_string_latin1`; everything else keeps UTF-8.
- Theme variants keep the core's sorted order in a `Vec`, and one descriptor buffer is reused for every token.

Two candidates were measured and rejected because the conversion phase did not change beyond noise: packed arrays built with `napi_create_array` (V8 still produces holey elements through `napi_set_element`), and an escapable handle scope per line.

After the change, the conversion subtree is 51% `napi_define_properties` and 17% `napi_set_element`: V8 property and element insertion that Node-API offers no cheaper way to perform.

## Allocation

Rust heap allocations per corpus pass, before → final:

| Group              |               DTO |    Conversion |
| ------------------ | ----------------: | ------------: |
| single (all sizes) |             0 → 0 |     728 → 180 |
| example / multi    |    16,082 → 8,041 |   8,765 → 182 |
| large / multi      | 255,242 → 127,621 | 128,345 → 182 |

JS heap growth per call, summed over all cases (`v8.getHeapStatistics()` after a full GC, result alive):

| Group  | napi-v2 |  before |   final |
| ------ | ------: | ------: | ------: |
| single | 26.1 MB | 12.6 MB | 12.6 MB |
| multi  | 55.4 MB | 41.9 MB | 35.4 MB |

The JSON transport allocated twice the JS heap for single-theme results. Sharing variant-key handles saves a further 15% on multi-theme results.

## Controlled token benchmark

`bench-native-boundary-paired.mjs` loads all three addons in each process, rotates their call order every round, checks that every engine returns the same JSON, and repeats the whole corpus in independent processes. Each value is the median over processes of the geometric mean of per-case median ratios against napi-v2; brackets give the range across processes.

| Group            | before vs napi-v2 |                                      final vs napi-v2 |
| ---------------- | ----------------: | ----------------------------------------------------: |
| example / single |   +3.39% / +3.05% | **−1.70%** [−2.68, +0.55] / **−1.75%** [−2.46, −0.41] |
| large / single   |   +2.76% / +2.67% | **−1.26%** [−1.53, −0.84] / **−1.57%** [−1.77, −0.91] |
| example / multi  |   +0.74% / +0.51% |         +0.09% [−0.75, +0.37] / −0.21% [−0.77, −0.08] |
| large / multi    |   +2.97% / +2.00% | **−0.86%** [−1.42, −0.63] / **−1.25%** [−1.47, −1.17] |
| native HTML, all |   −0.45% … +0.04% |                                       −0.44% … −0.74% |

Pairs are TIOBE / curated. Single and HTML: 6 processes × 20 rounds after 3 warm-ups. Multi: 3 processes × 5 rounds after 1 warm-up, because the grammar recompilation makes every multi-theme call slow. Across all single and HTML cases, final is −1.06% [−1.45%, −0.42%] against napi-v2, and before is +1.44% [+0.54%, +1.59%].

The native HTML path never crosses the token conversion. Before and after it is within ±1% of napi-v2; the paired runs do not reproduce the +7.99% curated HTML total that sequential timing reported in #224.

On a one-character input, the fixed cost of a call is 11.1 µs final, 10.8 µs before and 10.3 µs napi-v2. Reading the cached keys accounts for the 0.3 µs over before; any real snippet amortizes it.

## Size and loading

| darwin-arm64                     |     napi-v2 |               before |                final |
| -------------------------------- | ----------: | -------------------: | -------------------: |
| Addon file                       | 2,274,592 B | 2,325,312 B (+2.23%) | 2,308,928 B (+1.51%) |
| `__text` section                 | 1,514,412 B | 1,552,812 B (+2.54%) | 1,537,068 B (+1.50%) |
| Cold `require()` median, 30 runs |    0.984 ms |             0.993 ms |             0.990 ms |

The file size moves in 16 KiB steps (Mach-O page alignment); the `__text` size shows the actual code change. cargo-bloat on unstripped builds attributes the remaining growth over napi-v2 mostly to napi-rs 3 itself (`napi` 41.8 → 54.2 KiB) and the standard library (+15 KiB, generic code shifted by the new callbacks), while `ferriki_core` shrank from 45.0 to 37.7 KiB ([`bloat-*-crates.txt`](bloat-final-crates.txt); crate attribution is heuristic). Cold loading does not change measurably.

The `native-smoke` CI job now runs `measure-native-load.mjs` on all seven sidecar targets and writes size and cold-load numbers for the fresh build and the latest published sidecar to the job summary. The published 0.12.0 (napi-v2) sidecars are 2,291,152 B (darwin-arm64), 2,769,216 B (linux-x64-gnu), 2,374,784 B (linux-arm64-gnu), 2,791,800 B (linux-x64-musl), 2,385,880 B (linux-arm64-musl), 2,803,712 B (win32-x64-msvc) and 2,343,424 B (win32-arm64-msvc).

## Reproduce

Run from `node/` after `pnpm install` and `pnpm run build:native`. Build the comparison revisions with the same toolchain and keep their `.node` files outside the repository.

```sh
# Phase decomposition, allocations, JS heap and facade timings (builds target/profiling)
node scripts/profile-native-boundary.mjs --engine napi-v2=json:/path/to/v2.node --write phases.json

# Controlled paired benchmark; the first engine is the baseline
node scripts/bench-native-boundary-paired.mjs --engine napi-v2=json:/path/to/v2.node \
  --engine before=/path/to/before.node --engine final=../node/ferriki/ferriki.node \
  --processes 6 --rounds 20 --themes single,html --write paired.json

# CPU profile of a symbolized build (CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=none)
samply record --save-only --unstable-presymbolicate -r 4000 -o single.json.gz -- \
  node scripts/profile-token-workload.mjs --addon /path/to/symbolized.node --mode single --seconds 20
node scripts/summarize-samply-profile.mjs single.json.gz --since <steady-state epoch ms> \
  --focus 'HtmlRenderData(WithThemes)? as napi'

# Size and cold load against the latest published sidecar
node scripts/measure-native-load.mjs --addon build=ferriki/ferriki.node --published darwin-arm64
```

`profile-token-workload.mjs` prints the steady-state timestamp for `--since`. The compressed reports keep every sample.
