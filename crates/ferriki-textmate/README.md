# ferriki-textmate

`ferriki-textmate` is Ferriki's pure-Rust TextMate grammar interpreter.

It is a mechanical port of the vscode-textmate release pinned in
[`node/compat/upstream/vscode-textmate/.source.json`](https://github.com/sebastian-software/ferriki/blob/main/node/compat/upstream/vscode-textmate/.source.json).
The upstream source and test mirror is read-only; Rust adaptations and test
harnesses live in this crate.

The crate owns grammar models, selector matching, themes, compiled rules,
tokenization, and state stacks. Asset catalogs and rendering live in the
publishable `ferriki` crate; `ferriki-core` contains the N-API host, as refined
by ADR 0012. The package includes the upstream vscode-textmate license and
third-party notices alongside Ferriki's MIT and Apache-2.0 license texts.

## Public API

The public surface follows vscode-textmate's `main.ts` exports: `SyncRegistry`,
`Grammar` with its configuration and tokenize results (`GrammarConfiguration`,
`TokenizeLineResult`, `TokenizeLineResult2`, `TokenizeLineResultWithScopes`,
`TokenizeLineResultWithThemes`), `StateStack`, raw grammar and theme input
(`RawGrammar`, `parse_raw_grammar`, `ParseRawGrammarError`, `PlistError`,
`RawTheme`, `RawThemeScope`, `RawThemeSetting`, `RawThemeStyle`, `Theme`,
`ThemeError`), regex errors (`RegexError`), and token metadata
(`EmbeddedLanguages`, `EncodedTokenAttributes`, `FontStyle`, `StandardTokenType`,
`Token`, `FontInfo`). The modules of the port are private, so an upstream sync
or an internal refactor does not break consumers. Input and result types are
`#[non_exhaustive]`: build input types from `Default` with their `with_*`
setters and read results through their public fields. The `__oracle` module
exists only for the vscode-textmate oracle tests and carries no semver guarantee.

### Regex policies and diagnostics

Select a scanner acceleration policy per compiled grammar with `RegexMode`
(`Off`, `Auto`, `Eager`, or the default `Prepared`) via
`GrammarConfiguration::with_regex_mode` (or the boolean shorthand
`with_regex_prefilter`). Call `SyncRegistry::regex_diagnostics` to inspect
scanner-construction and archive counters in `RegexDiagnostics`. Call
`Grammar::backtracking_warnings` after tokenizing to retrieve advisory
`BacktrackingWarning` findings (`BacktrackingRisk::NestedQuantifier` or
`BacktrackingRisk::OverlappingAlternation`) from scanners compiled so far.

### Precompiled patterns and cooperating packages

`precompile_grammar_patterns` generates deterministic compressed archives of a
grammar's static patterns. `SyncRegistry::precompile_patterns(scope, samples)`
prepares Ferroni's stable Eager group/program pairs using the registry's
dependencies and injections; empty samples prepare all statically known scanner
lists. `SyncRegistry::precompile_pattern_packages(scopes)` prepares a full
catalog as cooperating language packages that delegate exact foreign scanner
groups to their owning language packages (container version 3).
`supports_precompiled_patterns_version` checks whether a combined `formatVersion`
value from release metadata (encoding container, Ferroni program, and group
versions — not a bare container generation number such as `2` or `3`, which
returns `false`) is supported by this runtime, `decompress_precompiled_patterns`
validates transport limits and decompresses a container for persistent caches,
and `index_precompiled_patterns` builds a compact local record index over a
decoded container.

Attach trusted bytes before tokenization with
`SyncRegistry::add_precompiled_patterns` (`impl Into<Arc<[u8]>>`),
`SyncRegistry::add_precompiled_patterns_from_slice` (borrowed bytes),
`SyncRegistry::add_precompiled_patterns_owned` (owned `Vec<u8>`), or
`SyncRegistry::add_precompiled_patterns_file` (an open decoded container `File`
paired with its `index_precompiled_patterns` index for on-demand record reads).
Patterns load lazily; missing or incompatible programs compile from source.
Dynamic end/while patterns retain their runtime behavior.
`PrecompiledPatternsError` keeps engine details private, and
`PRECOMPILED_PATTERNS_VERSION` identifies the prepared container version.
Standard Ferriki sidecars use complete static preparation and Zstd transport.
Measure loading, first use and execution separately; search scratch and
transition caches stay local.

The ordinary program-only API remains available:
`Grammar::compile_all_scanners()` prepares reachable rules,
`SyncRegistry::export_precompiled_patterns()` exports raw programs, and
`SyncRegistry::add_precompiled_patterns()` (or its `_from_slice` / `_owned`
variants) accepts the resulting bytes. `PRECOMPILED_PATTERNS_FORMAT_VERSION`
describes that raw format; `PRECOMPILED_PATTERNS_VERSION` separately describes
the prepared container. Raw imports preserve the caller's acceleration policy.

The opt-in `prepared-load-profile` feature adds phase clocks for diagnostic
builds. Set `FERRIKI_PROFILE_PREPARED_PAIRS=1` to emit JSON lines on stderr for
indexed record reads and insertion. Ordinary builds contain no clocks. The separate
`benchmarks/prepared-startup-profile` probe combines these observations with
Ferroni's load phases; instrumented timings are not production benchmarks.
