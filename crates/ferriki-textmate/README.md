# ferriki-textmate

`ferriki-textmate` is Ferriki's pure-Rust TextMate grammar interpreter.

It is a mechanical port of the vscode-textmate release pinned in
[`node/compat/upstream/vscode-textmate/.source.json`](../../node/compat/upstream/vscode-textmate/.source.json).
The upstream source and test mirror is read-only; Rust adaptations and test
harnesses live in this crate.

The crate owns grammar models, selector matching, themes, compiled rules,
tokenization, and state stacks. Asset catalogs and rendering live in the
publishable `ferriki` crate; `ferriki-core` contains the N-API host, as refined
by ADR 0012. The package includes the upstream vscode-textmate license and
third-party notices alongside Ferriki's MIT and Apache-2.0 license texts.

## Public API

The public surface follows vscode-textmate's `main.ts` exports: `SyncRegistry`,
`Grammar` with its tokenize results, `StateStack`, raw grammar and theme input
(`RawGrammar`, `RawTheme`, `RawThemeSetting`, `RawThemeStyle`), and token
metadata (`EncodedTokenAttributes`, `FontStyle`, `StandardTokenType`). The
modules of the port are private, so an upstream sync or an internal refactor
does not break consumers. Input and result types are `#[non_exhaustive]`:
build input types from `Default` with their `with_*` setters and read results
through their public fields. The `__oracle` module exists only for the
vscode-textmate oracle tests and carries no semver guarantee.

`precompile_grammar_patterns` generates deterministic compressed archives of a
grammar's static patterns. Attach trusted bytes with
`SyncRegistry::add_precompiled_patterns` before tokenization. Patterns load
lazily; missing or incompatible programs compile from source. Dynamic end/while
patterns retain their runtime behavior. `PrecompiledPatternsError` keeps engine
details private, and `PRECOMPILED_PATTERNS_VERSION` identifies the archive version.

`SyncRegistry::precompile_patterns(scope, samples)` prepares Ferroni 2.7's stable
Eager group/program pairs using the registry's dependencies and injections.
Attaching such a pair opts that root into Eager acceleration when prefiltering
is enabled. Sample coverage is partial, with ordinary Eager fallback for missing
groups. Empty samples prepare all statically known scanner lists instead.
Standard Ferriki sidecars use this complete static preparation and Zstd transport.
Captured end/while expansions retain their runtime behavior. Measure loading,
first use and execution separately; search scratch and transition caches stay local.

The ordinary program-only API remains available:
`Grammar::compile_all_scanners()` prepares reachable rules,
`SyncRegistry::export_precompiled_patterns()` exports raw programs, and
`SyncRegistry::add_precompiled_patterns()` accepts the resulting bytes or an
`Arc<[u8]>`. `PRECOMPILED_PATTERNS_FORMAT_VERSION` describes that raw format;
`PRECOMPILED_PATTERNS_VERSION` separately describes the prepared container.
Raw imports preserve the caller's acceleration policy.
