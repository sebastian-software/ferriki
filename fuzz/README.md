# Rust fuzzing

These cargo-fuzz targets exercise Ferriki's raw TextMate grammar parser,
fkgram asset decoder, line tokenizer, and theme application. They live in a
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

The targets are parse_raw_grammar, decode_fkgram, tokenize_line, and
theme_application. Each target reads its seed corpus from
fuzz/corpus/<target>/. Minimized crashes are written under
fuzz/artifacts/<target>/; rerun a crash by passing its file path after the
target name. Panics, sanitizer findings, assertions, and libFuzzer timeouts
fail the run. Rejected JSON and asset codec errors are expected for malformed
input.

The grammar and fkgram targets cap inputs at 64 KiB. Theme input is capped
at 16 KiB. Tokenization converts arbitrary bytes to bounded UTF-8, processes at
most eight lines of 4 KiB each, and gives each line 100 ms. It uses a fixed
grammar with simple regular expressions so the line target explores tokenizer
state and the combined scope/binary output without compiling attacker-controlled
regexes. The target checks UTF-16 offset bounds and binary token pairing. The
theme target parses each candidate theme and applies it to that same bounded
grammar. A tokenizer time-limit result is retained as a valid outcome; the
outer libFuzzer timeout reports a genuinely stuck input as a failure.

Keep small, meaningful examples in each corpus. The checked-in seed-* files
cover valid JSON, plist, encoded grammar, UTF-8 lines, and themes. libFuzzer's
generated hash-named inputs are ignored; add a new named seed when it reaches a
useful path that the existing corpus misses.

Pull requests run each target for 30 seconds. The weekly scheduled run uses
10 minutes per target. CI runs on Linux with cargo-fuzz's default Address
Sanitizer. macOS runs are useful local smoke checks, but they do not replace the
Linux CI result.
