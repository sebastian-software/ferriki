# Ferroni 2.2.1 local integration check

Measured October 16, 2026, on an Apple M1 Ultra, macOS 27.0.1 arm64,
Node 24.21.0, rustc 1.99.0. This is a local diagnostic, not a refresh of
the published Blacksmith results or a portable speed claim.

## Update and upstream impact

Ferriki's dependency floor and root/fuzz lockfiles move from registry Ferroni
2.1.0 to 2.2.1. No transitive dependency changes or runtime API adaptations
are needed. Ferroni still declares Rust 1.94, matching Ferriki's MSRV.

The [2.2.0 release](https://github.com/sebastian-software/ferroni/releases/tag/v2.2.0)
improves scanner DFA construction/search, ASCII lookbehinds, failed guards,
lazy loops, bounded repeats, graphemes, and compilation. It also fixes
prefilter cache-clear tracking and matching/compiler edge cases. The
[2.1.2](https://github.com/sebastian-software/ferroni/releases/tag/v2.1.2),
[2.1.3](https://github.com/sebastian-software/ferroni/releases/tag/v2.1.3), and
[2.2.1](https://github.com/sebastian-software/ferroni/releases/tag/v2.2.1)
releases add lookbehind, backreference, character-search and capture-search
improvements. These internals can benefit Ferriki through its existing scanner.

`RegexBuilder::dfa` and single-regex iterator/API optimizations do not require
local adoption: Ferriki uses `Scanner`, not the single-regex API. Its existing
`dfa-prefilter` feature and automatic multi-pattern prefilter remain enabled.
No architectural decision or public API changes.

## Warm HTML results

The existing paired native HTML harness measures all 20 curated languages,
one fixture and its 16-fold repetition: 40 cases, four independent workers,
eight warmups and 20 timed rounds per engine/case. Calls alternate engine
order. Outputs must match exactly before timing, and their hashes must also
match across workers. All output checks passed.

The median per-worker geometric mean of candidate/baseline case-median
ratios changes by **-0.96%**, with workers ranging from -1.73% to -0.47%.
Small inputs change by -1.33%; large inputs by -0.67%. This is effectively
flat overall: the sum of the 40 pooled case medians actually rises from
213.50 to 215.69 ms (+1.02%). Equal weighting of case ratios and adding
absolute durations answer different questions.

A separate follow-up repeats six large cases with four fresh workers,
16 warmups and 40 timed rounds. Negative changes mean less elapsed time.

| Language | 2.1.0 median, ms | 2.2.1 median, ms | Median worker change | Worker range |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 15.116 | 16.408 | +8.87% | +8.33% to +9.27% |
| TSX | 18.702 | 19.828 | +5.89% | +4.89% to +8.41% |
| CSS | 6.443 | 5.889 | -8.76% | -9.70% to -4.68% |
| Astro | 21.600 | 22.245 | +3.21% | +1.89% to +4.38% |
| Ruby | 4.093 | 3.741 | -9.18% | -14.40% to -5.58% |
| SCSS | 4.824 | 4.587 | -4.61% | -5.44% to -3.41% |

The time columns pool samples; the change column takes the median of
per-worker ratios. A general highlighting speedup is not established.
The TypeScript/TSX regressions repeat and deserve an upstream investigation.

## First use and addon size

Six fresh processes per version/language/size measure seven languages:
TypeScript, C++, SCSS, Rust, HTML, JSON and Astro. Each process times addon
loading, offline theme/grammar setup, and its first HTML render. Process
startup, fixture I/O and downloads are excluded. Version order alternates.
Every paired output hash matches.

The geometric mean of the 14 candidate/baseline median total-time ratios is
**-7.88%**. Large TypeScript changes from 135.40 to 117.00 ms, SCSS from
120.75 to 90.86 ms, and Astro from 166.17 to 148.05 ms. Tiny JSON is roughly
unchanged. These are first-use measurements with warm OS file caches.

The stripped ordinary release addon shrinks from 3,021,536 to 2,888,448 bytes
(-4.40%). Both builds use fat LTO and one codegen unit.

## Should the DFA build immediately?

Keep the automatic scanner policy. `ScannerConfig::prefilter_warmup(0)`
builds on the first search and also enables tiny sets that automatic mode
skips. This is distinct from `RegexBuilder::dfa(true)` for single regexes.
See the versioned [scanner configuration](https://docs.rs/ferroni/2.2.1/ferroni/scanner/struct.ScannerConfig.html).

The experimental [patch](eager-prefilter.patch) changes only that setting
on Ferroni 2.2.1. It is retained as evidence and is not applied to the runtime.

- Warmed HTML: six languages, both sizes, three workers, eight warmups and
  20 rounds. Immediate construction changes elapsed time by +0.94% overall
  (worker range -0.14% to +2.82%) and +2.59% for large inputs. Large Astro
  changes by +19.37%; there is no broad steady-state benefit.
- First use: four languages (TypeScript, C++, SCSS, Astro), both sizes,
  four fresh processes per cell. The geometric mean of the eight total-time
  median ratios is +44.26%. Small SCSS changes from 36.39 to 90.12 ms;
  small TypeScript from 59.79 to 112.06 ms. All paired outputs match.

Short-lived dynamic end/while scanners do not necessarily recover the cost
of building a DFA. The automatic policy waits for 32 searches and skips tiny
sets; the update retains that policy.

## Remaining engine work

As checked on October 16, Ferriki's only open issue is
[#267](https://github.com/sebastian-software/ferriki/issues/267), retiring legacy
CDN paths. It is unrelated to regex execution. The old latest-Ferroni CI,
theme-switch recompilation and pattern-cache tasks are already resolved;
the latest-compatible workflow and cached theme-independent grammars exist.

Two concrete performance follow-ups remain from this inspection:

1. Isolate the repeatable TypeScript/TSX regression between 2.1.0 and 2.2.1
   using the retained same-source fixture/build evidence.
2. Selective static-pattern reuse in scanner lists that also contain dynamic
   backreferences remains unavailable in Ferroni's all-or-nothing cache API.
   Ferriki deliberately bypasses the shared cache for these lists to avoid
   retaining every captured pattern. This is an optimization opportunity,
   not a correctness defect; ADR 0010 already records it.

Ferroni's open functional proposal
[#159](https://github.com/sebastian-software/ferroni/issues/159) concerns opt-in
Onigmo syntax. Ferriki currently selects Oniguruma syntax, so it does not
block this integration. Browser/WASM highlighting remains a separate product
scope decision under ADR 0009. No new issues were published.

## Evidence and reproduction

The ordinary builds share Ferriki commit
`38ff71c30e153f342eedc2887a628f6e38e257eb`, compiler, features, flags,
fixtures and assets. The baseline was freshly built before changing the
dependency. The candidate changes only the root dependency requirement and
root/fuzz Ferroni lock entries. All tracked Rust files and manifests were
compared after normalizing that one requirement. The receipt's Rust-source
fingerprint includes Cargo.toml, so the manifest bump changes that hash.
The separate historical syntect harness still describes its pinned 0.13.0
experiment and was not used or updated.

- [Context and input hashes](context.json), [baseline receipt](baseline-build.json),
  [candidate receipt](candidate-build.json), [eager receipt](eager-build.json).
- Raw samples: [warm](warm.json.gz), [follow-up](followup.json.gz),
  [first use](cold.json), [eager warm](eager-warm.json.gz),
  [eager first use](eager-cold.json).
- [Summary](summary.json), regenerated with `node summarize.mjs` in this
  directory. Temporary addon binaries are not committed; their hashes and
  sizes are in the warm reports and build receipts.

Build ordinary release addons with `pnpm run build:native` in `node/`, saving
each version outside the checkout. From `node/`, with `FERRIKI_BENCH_ADDON_DIR`
pointing at the saved addons:

```sh
node scripts/bench-native-boundary-paired.mjs \
  --engine ferroni-2.1.0="$FERRIKI_BENCH_ADDON_DIR/ferroni-2.1.0.node" \
  --engine ferroni-2.2.1="$FERRIKI_BENCH_ADDON_DIR/ferroni-2.2.1.node" \
  --processes 4 --rounds 20 --warmups 8 --themes html \
  --sizes example,large --corpora curated --write /tmp/warm.json
```

The follow-up uses `--sizes large --rounds 40 --warmups 16` and
`--languages typescript,tsx,css,ruby,astro,scss`. The eager comparison uses
the same six languages, both sizes, three workers, eight warmups and 20
rounds, with the two 2.2.1 addons named `auto` and `eager`.

From the repository root, run `cold-first-html.mjs` in this directory with
`FERRIKI_BENCH_ADDON_DIR` set. Its default is the seven-language, six-round
version comparison. The eager run additionally sets:

```sh
export FERRIKI_BENCH_ENGINES=2.2.1,2.2.1-eager
export FERRIKI_BENCH_LANGUAGES=typescript,cpp,scss,astro
export FERRIKI_BENCH_ROUNDS=4
export FERRIKI_BENCH_OUTPUT=./eager-cold.json
```

All timings ran sequentially, without concurrent builds, tests or profiles.
They cover the native HTML boundary with cached assets, not networking,
JavaScript transformers, memory use, all Rust features or other platforms.

## Validation

[Check results](validation/checks.json) retain the commands and outcomes.
Workspace tests with all features, format, Clippy with warnings denied, the
Rust 1.94 all-target/all-feature check, the mandatory core compatibility gate,
the TextMate gate, decision-record validation and lint for the two evidence
scripts passed. The core gate rebuilt the ordinary automatic-prefilter addon
after the experiment; its SHA-256 matches the measured candidate receipt.
HTTP-server tests and the core gate ran outside the sandbox after its loopback
restrictions blocked their local servers. Existing documented upstream test
exclusions and the optional comparator skip remain in the gate logs.

`cargo deny check advisories bans licenses sources` fails on four advisories
for **pre-existing rustls 0.23.45**, unchanged by this Ferroni update:
[RUSTSEC-2026-0346](https://rustsec.org/advisories/RUSTSEC-2026-0346),
[0347](https://rustsec.org/advisories/RUSTSEC-2026-0347),
[0348](https://rustsec.org/advisories/RUSTSEC-2026-0348), and
[0349](https://rustsec.org/advisories/RUSTSEC-2026-0349).
The advisory database recommends rustls >=0.23.46. Bans, licenses and sources
pass; Ferroni has no finding. A separate rustls update remains necessary;
this check is not green and no advisory suppression was added.
