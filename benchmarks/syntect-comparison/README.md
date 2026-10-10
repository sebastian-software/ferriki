# Rust syntect comparison

This standalone package measures complete Rust HTML-highlighting calls for
syntect 5.3.0 with regex-onig and regex-fancy, and Ferriki 0.13.0. It is a
descriptive highlighter comparison on a pinned common document set, not an
output-parity test, regex-engine microbenchmark, or speedup claim.

## Inputs and syntax resolution

The source files come from Ferriki's curated 20-format fixture set, pinned from
Ferroni commit
[0136c99d3aad9aad9eeaa025692124e94420153d](https://github.com/sebastian-software/ferroni/tree/0136c99d3aad9aad9eeaa025692124e94420153d/benches).
A no-timing probe asks syntect 5.3.0's bundled default SyntaxSet for each
fixture's exact extension. The shared benchmark corpus includes the 11 formats
for which syntect resolves a non-plain grammar:

| Fixture | Resolved syntect default syntax |
| --- | --- |
| Java | Java |
| C++ | C++ |
| CSS | CSS |
| HTML | HTML |
| JSON | JSON |
| Markdown | Markdown |
| Python | Python |
| Ruby | Ruby |
| Rust | Rust |
| Shell | Bourne Again Shell (bash) |
| YAML | YAML |

Astro (astro), Svelte (svelte), Swift (swift), TSX (tsx), Vue (vue),
MDX (mdx), SCSS (scss), TOML (toml), and TypeScript (ts) have no exact
extension mapping in that bundled default set. The harness excludes and hashes
each file rather than substituting a different grammar. probe-syntect prints
all 20 resolutions and the complete default syntax-name list without collecting
timings. Reports retain every selected syntax name and every excluded fixture's
reason and source hash.

The fixtures were copied into Ferriki from the pinned Ferroni revision; the
current source paths and hashes are present in every JSON report. They remain
unchanged throughout each run, with their before/after manifest hashes recorded
and compared.

## Engines

Syntect is pinned to 5.3.0 and built in two isolated feature configurations.
Both enable default-syntaxes, default-themes, and html with Cargo's default
feature bundle disabled. One explicitly selects regex-onig; the other selects
regex-fancy. Ferriki is the root package path dependency at version 0.13.0,
with its network feature disabled. The package has its own Cargo workspace and
lockfile, so it adds no dependency to the published workspace.

Syntect renders with its built-in base16-ocean.dark theme and
highlighted_html_for_string. Ferriki renders with the built-in nord theme
through Highlighter::highlight and render_html. Each report records the
binary SHA-256 before and after measurement, selected Cargo feature, exact build
command, release profile, Rust flags, target, lockfile hash, source revision,
asset-manifest hash, machine, and compiler version.

The grammars, themes, scope mappings, output markup, and language semantics
differ. These are real highlighter workflows, not equal work. Timing does not
establish equivalent highlighting or a speedup for another corpus.

## Measurement lanes

- **Fresh in-process engine, first corpus pass:** ten repetitions create a new
  engine instance, time its setup separately, then render every selected
  document once. “First use” means the first corpus pass on a fresh engine
  instance in the already-running benchmark process. It excludes process
  startup and does not imply cold operating-system caches.
- **Warmed reuse:** a separate engine instance renders five warmup corpus
  passes, then 30 timed renders per document. Document order rotates each
  round. Setup and correctness validation are outside the timed region.
- Each rendering sample includes the library's high-level API through HTML
  output. Result writing, input validation, and summary calculation are outside
  the timed region. Outputs are consumed after timing.
- Before timing, every selected output must preserve the visible source text
  and contain highlighted span markup. Syntect's pre output and Ferriki's
  code output are decoded according to their HTML wrappers. Serialized HTML
  and colors are not compared.
- The report retains raw nanoseconds and per-round document orders. Its
  summary uses the median setup sample and the range of per-document medians
  for first use and warmed reuse. No cross-engine aggregate or ratio is
  calculated.
- Two independent capture rounds rotate engine order. Round A is
  syntect-onig, syntect-fancy, ferriki-only; round B reverses the outside
  engines: ferriki-only, syntect-fancy, syntect-onig. Each report records
  the round and position in that order.

## Prepare and validate

Run from the repository root with the pinned Rust toolchain. The targets below
are isolated from other worktrees.

    cargo fmt --manifest-path benchmarks/syntect-comparison/Cargo.toml -- --check

    CARGO_TARGET_DIR=/tmp/ferriki-syntect-onig \
      cargo build --manifest-path benchmarks/syntect-comparison/Cargo.toml \
      --release --locked --no-default-features --features syntect-onig
    CARGO_TARGET_DIR=/tmp/ferriki-syntect-fancy \
      cargo build --manifest-path benchmarks/syntect-comparison/Cargo.toml \
      --release --locked --no-default-features --features syntect-fancy
    CARGO_TARGET_DIR=/tmp/ferriki-syntect-ferriki \
      cargo build --manifest-path benchmarks/syntect-comparison/Cargo.toml \
      --release --locked --no-default-features --features ferriki-only

    /tmp/ferriki-syntect-onig/release/ferriki-syntect-comparison probe-syntect
    /tmp/ferriki-syntect-onig/release/ferriki-syntect-comparison validate
    /tmp/ferriki-syntect-fancy/release/ferriki-syntect-comparison validate
    /tmp/ferriki-syntect-ferriki/release/ferriki-syntect-comparison validate

validate checks the selected exact syntax mappings, source preservation, and
span markup. It does not collect timing samples. After all builds and
validations finish and the host is idle, capture the six reports serially
inside a coordinated timing window:

    /tmp/ferriki-syntect-onig/release/ferriki-syntect-comparison \
      measure /tmp/syntect-onig-A.json --capture-round A \
      --capture-order syntect-onig,syntect-fancy,ferriki-only
    /tmp/ferriki-syntect-fancy/release/ferriki-syntect-comparison \
      measure /tmp/syntect-fancy-A.json --capture-round A \
      --capture-order syntect-onig,syntect-fancy,ferriki-only
    /tmp/ferriki-syntect-ferriki/release/ferriki-syntect-comparison \
      measure /tmp/ferriki-A.json --capture-round A \
      --capture-order syntect-onig,syntect-fancy,ferriki-only
    /tmp/ferriki-syntect-ferriki/release/ferriki-syntect-comparison \
      measure /tmp/ferriki-B.json --capture-round B \
      --capture-order ferriki-only,syntect-fancy,syntect-onig
    /tmp/ferriki-syntect-fancy/release/ferriki-syntect-comparison \
      measure /tmp/syntect-fancy-B.json --capture-round B \
      --capture-order ferriki-only,syntect-fancy,syntect-onig
    /tmp/ferriki-syntect-onig/release/ferriki-syntect-comparison \
      measure /tmp/syntect-onig-B.json --capture-round B \
      --capture-order ferriki-only,syntect-fancy,syntect-onig

measure requires at least 10 first-use repetitions, one warmup round, and 30
warm samples per document. Preserve every report, the support-probe outputs,
binary hashes, and checksums alongside the result summary.
