# Rust fuzzing

These cargo-fuzz targets exercise Ferriki's raw TextMate grammar parser and
compiler, fkgram asset decoder, line tokenizer, theme application, serialized
state-stack continuation decoder, `.fkbc`/`.fkix` precompiled archive decoders,
decoration planner/renderer, and theme HTML/CSS rendering. They live in a
standalone Cargo workspace with their own lockfile, so fuzz dependencies do not
change the release workspace.

Install the toolchain and runner used by CI:

    rustup toolchain install nightly-2026-07-20 --component rustfmt
    cargo +nightly-2026-07-20 install cargo-fuzz --version 0.13.2 --locked

List the targets:

    cargo +nightly-2026-07-20 fuzz list --fuzz-dir fuzz

Run one target for a minute:

    cargo +nightly-2026-07-20 fuzz run --fuzz-dir fuzz tokenize_line -- \
      -max_total_time=60 \
      -timeout=10 \
      -max_len=65536 \
      -malloc_limit_mb=256 \
      -rss_limit_mb=1024

The targets are `parse_raw_grammar`, `decode_fkgram`, `tokenize_line`,
`theme_application`, `deserialize_state_stack`, `decode_precompiled_archives`,
`decorations`, and `theme_render`. Each target reads its seed corpus from
`fuzz/corpus/<target>/`. Minimized crashes are written under
`fuzz/artifacts/<target>/`; rerun a crash by passing its file path after the
target name. Panics, sanitizer findings, assertions, and libFuzzer timeouts
fail the run. Rejected JSON, plist, state-stack, and archive codec errors are
expected for malformed input.

Bounds and coverage:

- `parse_raw_grammar` caps raw input at 64 KiB, dispatches JSON and XML
  property lists (including bare `<dict>`/`<array>` and BOM-prefixed roots),
  compiles valid grammars up to 16 KiB (`compile_all_scanners`), and tokenizes
  sample lines with a 10 ms per-line time limit.
- `decode_fkgram` caps input at 64 KiB and parses any decoded embedded grammar.
- `tokenize_line` converts arbitrary bytes to bounded UTF-8 (16 KiB, up to 8
  lines of 4 KiB each, 100 ms per line) against a fixed grammar and asserts
  UTF-16 offset bounds and binary token pairing.
- `theme_application` caps input at 16 KiB, parses candidate `RawTheme` JSON,
  and applies it to the fixed grammar.
- `deserialize_state_stack` caps input at 64 KiB, fuzzes
  `Grammar::deserialize_state_stack` on both raw input and live
  fingerprint-matched JSON objects against a fixed grammar with nested rules,
  `while` rules, and dynamic backreferences, then resumes tokenization with a
  10 ms time limit and round-trips serialization.
- `decode_precompiled_archives` caps input at 64 KiB and exercises
  `decompress_precompiled_patterns`, `SyncRegistry::add_precompiled_patterns_owned`,
  `index_precompiled_patterns`, and `IndexedArchive::open` (via
  `SyncRegistry::add_precompiled_patterns_file`) plus lazy tokenization on
  attached archives.
- `decorations` caps structured input at 4 KiB and exercises UTF-8/UTF-16
  `resolve_ranges`, `DecorationBoundaries::split_tokens`, `decoration_sections`,
  `plan_decoration_mutations` (including arbitrary node graphs), and
  `render_html_with_decorations`.
- `theme_render` caps input at 16 KiB and exercises `parse_theme_data`,
  `Theme::create_from_raw_theme`, `render_html`, `render_html_with_css`, and
  `render_html_with_themes`.

Keep small, meaningful examples in each corpus. The checked-in `seed-*` files
cover valid JSON, plist (including bare `<dict>`/`<array>`), encoded grammars,
UTF-8 lines, themes, serialized state stacks, precompiled/indexed archives, and
structured decoration inputs. libFuzzer's generated hash-named inputs are
ignored; add a new named seed when it reaches a useful path that the existing
corpus misses.

Pull requests run each target for 30 seconds. The weekly scheduled run uses
10 minutes per target. CI runs on Linux with cargo-fuzz's default Address
Sanitizer. macOS runs are useful local smoke checks, but they do not replace the
Linux CI result.
