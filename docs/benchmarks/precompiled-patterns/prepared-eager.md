# Prepared Eager loading and execution

The objective is lower startup cost than rebuilding source Eager, with ordinary
Eager execution from first use. Archive restoration has an accepted cost; source
Off remains a lower-cost reference rather than a loading-parity requirement.
This replaces the policy inference from the earlier [gzip and warm Auto diagnostics](2026-10-24.md).

## Reproduction

```sh
FERRIKI_BENCH_OUTPUT=/tmp/prepared-eager.json cargo test --release --offline -p ferriki-textmate \
  precompiled_bench::prepared_eager_startup -- --ignored --nocapture
```

Ferroni 2.7.0, macOS arm64, rustc 1.99.0, workspace release profile (fat LTO,
one codegen unit), dirty integration at `27067f589303813544e523fb5c7e3c40991851c9`.
Two complete final runs rotate four lanes through 20 fresh-registry samples after
one discarded round. Execution retains each grammar after exactly three document
passes, resets its document stack, and rotates at least 30 rounds within an 800 ms
case budget (maximum 5,000 rounds). No compilation, compression or tests run concurrently
with measured samples. CPU placement, thermals and unrelated system activity are uncontrolled.

Setup includes compressed SHA-256, buffer copy, bounded Zstd decompression, matched-pair
opening, theme construction and grammar construction. Startup adds the first full
binary-token document, including deferred scanner construction. Execution excludes
all setup. Network/file I/O, grammar JSON parsing, HTML rendering and teardown are
outside these timers. This is a tokenizer diagnostic, not end-to-end application startup.

Token arrays agree in every lane before interpreting timing. Each prepared lane
must load actual groups, report zero invalid groups, and complete without the
source scanner-assembly fallback. Raw samples include active
prefilter counts, grammar/fixture hashes, package sizes and separate phase timings.

## Final runs

Times are medians in milliseconds, shown as run A / run B.

| Language   | Source Off startup | Source Eager startup | Prepared static startup | Source Eager execution | Prepared static execution |
| ---------- | -----------------: | -------------------: | ----------------------: | ---------------------: | ------------------------: |
| cpp        |    37.928 / 38.203 |    143.699 / 144.585 |         67.955 / 68.083 |          0.434 / 0.443 |             0.416 / 0.419 |
| swift      |      6.450 / 6.609 |      33.564 / 34.004 |         15.511 / 15.648 |          0.184 / 0.188 |             0.174 / 0.177 |
| rust       |      0.892 / 0.890 |        3.629 / 3.605 |           1.680 / 1.677 |          0.134 / 0.134 |             0.131 / 0.131 |
| python     |      2.811 / 2.894 |      12.986 / 13.074 |           6.559 / 6.613 |          0.215 / 0.215 |             0.210 / 0.211 |
| json       |      0.223 / 0.222 |        0.464 / 0.468 |           0.387 / 0.383 |          0.135 / 0.135 |             0.131 / 0.132 |
| css        |      9.736 / 9.800 |      36.163 / 36.587 |         12.889 / 12.987 |          0.229 / 0.229 |             0.218 / 0.219 |
| typescript |    14.812 / 14.853 |      72.606 / 72.024 |         23.682 / 23.360 |          0.313 / 0.312 |             0.295 / 0.294 |

Prepared execution follows Eager across these workloads, while restoring the
archive costs less than source Eager preparation in every measured language.
For C++, startup falls from about 144 ms to 68 ms, a reduction of about 53%.
Complete static archives cost more to restore than source Off: decoding unused
reachable groups is material. That gap is an optimization opportunity within
the accepted restoration cost, rather than a failed parity requirement.
The C++ static package is 3,485,902 bytes versus
1,005,739 bytes when prepared from the measured snippet.
Sampled startup is 45.064 / 45.737 ms versus source Off
37.928 / 38.203 ms. This sampled case is trained on its own input and cannot
establish coverage or startup for held-out documents.

Standard generation chooses full reachable static coverage, including runtime list
ordering, duplicates, anchor variants, dependencies and injections. Runtime only
downloads/opens explicitly requested roots, whose archives already include their
dependency groups; dependency grammar definitions are still required. The matrix
above isolates one grammar and does not quantify that root-only transport saving.

A remaining performance opportunity is selective transport/decode of groups without
giving up static coverage. Ferroni’s stable API currently opens a whole uncompressed
pair; its records decode lazily after opening. Neither these results nor upstream’s
in-memory regex loading benchmark establish equal complete CDN startup. Per-pattern
helpers and input-dependent transition caches remain local by upstream contract.

## Reuse across builds

The runtime's digest-addressed disk cache can reuse the same downloaded packages
in successive processes when the cache directory persists. A new build process
still decompresses, validates and restores the prepared data; it avoids rebuilding
the serialized group automata from source. Grammar package regeneration follows
grammar/preparation changes, not edits to the highlighted document.

Within a running highlighter, existing scanner caches already reuse preparation
across repeated highlights and updates. Prepared archives preserve reusable work
across fresh registries and process starts as well. The fresh-registry timings
above characterize restoration versus source preparation with bytes in memory;
they do not measure filesystem-cache reuse, download amortization or the total
time of successive deployment builds.

## Catalog preparation

The initial enumeration also prepared standalone match/include scanners that the
tokenizer never requests. Restricting generation to stack states, injection roots
and capture-retokenization roots preserves every reachable static scanner group.
The 94 catalog sidecars shrink from 332,338,399 to 274,444,043 compressed bytes
(17.4% less). This full catalog is much larger than the earlier program-only
catalog; individual consumers fetch only requested roots and their grammar
closure. These files are optional CDN assets, not npm/crate contents.

The current format is FKBC002, programs v2, groups v3. It uses a checksummed
Zstd-19 frame with an explicitly checked 8 MiB maximum window, fixed-width
lengths, byte slices and one paired archive open. The earlier gzip/postcard
container and duplicate program indexing were discarded. Network transfer of
these larger files remains outside the measured boundary. Publishing them is
still a separate release step.

## Integration validation

- `cargo test --offline --workspace --all-features` passed, including the
  standard-sidecar/source comparison over 20 curated and 12 standard TIOBE
  fixtures with both prefilter settings, plus five loopback remote-asset tests.
- After the final Off-mode download/opening guard, root library tests (56),
  native-core unit tests (16), all-target/all-feature Clippy, formatting and the
  locked fuzz build passed. Node Off skips bytecode downloads; every Off
  highlighter skips opening group archives.
- `pnpm run test:ferriki-compat:core` passed after rebuilding the native addon.
  Its benchmark-comparison suite passed 31 tests and skipped the existing
  optional PHP/Phiki check because PHP is unavailable.
- `cargo deny --offline check`, the 21-record ADR checker and the immutable
  publication dry check passed. The latter verified 506 local objects and did
  not upload them.

Loopback-server checks ran outside the sandbox after its network restrictions
blocked their local binds. No PR, commit, CDN upload or release was created.

## Retained evidence

- [Run A](prepared-eager-a.json.gz)
- [Run B](prepared-eager-b.json.gz)
- [Official producer/consumer guide](https://github.com/sebastian-software/ferroni/blob/v2.7.0/docs/app/routes/guide/precompiled-eager.mdx)
- [Official TextMate startup boundary](https://github.com/sebastian-software/ferroni/blob/v2.7.0/benches/diagnostics/textmate-startup-20261024/README.md)
