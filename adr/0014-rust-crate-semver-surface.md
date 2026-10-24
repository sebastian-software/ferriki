# ADR 0014: Semver Surface of the Published Rust Crates

## Status

Accepted

Last updated: 2026-10-24

## Context

`ferriki`, `ferriki-textmate` and `ferriki-asset-gen` share one version with
the npm package ([ADR 0012](0012-publishable-rust-highlighter.md)). A breaking
change in any of the three crates therefore forces a major release of the
whole product, npm included. After 1.0 that makes every accidental public item
expensive.

A public-API audit before 1.0 (#135) found three kinds of accidental surface:

- the mechanical port exposed all of its modules, so every upstream sync of
  [ADR 0010](0010-mechanical-vscode-textmate-port.md) would have been a
  semver break;
- third-party types (Ferroni's scanner and error types, `bincode::Error`)
  appeared in public signatures, so their majors would have forced ours;
- option and result structs with exhaustive public fields could not grow
  toward Shiki parity without a break.

One mechanism is not available: Release Please's `rust` strategy rewrites the
version requirement of internal path dependencies to the plain new version on
every release, so an exact `=` requirement between the crates does not survive.
`ferriki` X.Y can therefore resolve `ferriki-asset-gen` X.(Y+1).

## Decision

Each crate publishes a deliberate, curated surface.

- **Private modules, root re-exports.** Modules are private; the public API is
  the list of re-exports at the crate root. `ferriki-textmate` follows
  vscode-textmate's `main.ts` exports, plus the documented combined scope/binary
  result extension from [ADR 0010](0010-mechanical-vscode-textmate-port.md) and
  crate-owned advisory backtracking diagnostics (#153). These extensions are
  documented and have the same semver guarantee as other results.
- **No third-party types in public signatures.** Engine and codec types stay
  behind crate-owned errors (`RegexError`, `CodecError`). `serde` and
  `serde_json` are the accepted exception: they are stable 1.x crates, and
  serde derives are part of the documented serialized shape.
- **Precompiled patterns.** `precompile_grammar_patterns`,
  `PRECOMPILED_PATTERNS_VERSION`, `PrecompiledPatternsError` and
  `SyncRegistry::add_precompiled_patterns` are documented public extensions
  used between the published generator and tokenizer crates. Errors and bytes
  remain crate-owned; Ferroni types stay private. Archive compatibility is
  independently versioned and source compilation remains available (ADR 0021).
  `SyncRegistry::precompile_patterns` additionally prepares static or sample-driven Eager
  groups through the same owned byte/error boundary. The existing
  `Grammar::compile_all_scanners`, `SyncRegistry::export_precompiled_patterns`,
  raw `PRECOMPILED_PATTERNS_FORMAT_VERSION`, and `Into<Arc<[u8]>>` import contract
  remain available alongside the prepared container API.
- **Non-exhaustive by default.** Input types that callers build are
  `#[non_exhaustive]` and come with `Default` and `with_*` setters; a setter
  takes the field's type, `Option` included. Result types are
  `#[non_exhaustive]` with public fields for reading. Error-kind enums are
  `#[non_exhaustive]`. Small enums that mirror a closed upstream contract, such
  as `StandardTokenType` or `RawThemeScope`, stay exhaustive.
- **`#[doc(hidden)]` only inside one crate's contract.** It is allowed for
  bridges to the unpublished N-API host (`ferriki::__private`) and for test
  oracles (`ferriki_textmate::__oracle`), which carry no semver guarantee. It is
  never used for items one published crate needs from another; those items are
  public, documented and non-exhaustive, because the version requirement
  between the crates is a caret range.
- **Native decoration policy.** Typed range, token-slice, tree-edit plans,
  and the complete declarative renderer
  are private implementation primitives in `ferriki::__private`, used only by
  the unpublished N-API host. They add no stable Rust decoration or HAST API;
  UTF-16 support is a Node compatibility mode, not a change to public Rust
  UTF-8 token offsets (ADR 0008, #122).
- **Serialized shapes are part of the contract.** Typed Rust fields serialize
  to the documented JSON shape that Rust consumers rely on (for example
  `fontStyle` as integer bits), and tests pin it.
- **Public multi-theme results.** `HighlightTokensWithThemesResult`,
  `HighlightThemeToken`, `HighlightThemeTokenStyle`, and `HighlightThemeMetadata`
  are documented, owned, non-exhaustive results produced by `Highlighter`.
  Public token offsets are UTF-8 bytes; the semver-exempt N-API bridge retains
  its UTF-16 convention using the same result shapes.
- **Backtracking diagnostics.** `BacktrackingWarning` and `BacktrackingRisk`
  are owned, non-exhaustive results. They expose Ferroni's advisory findings
  without exposing Ferroni types, and report only scanners compiled so far by
  lazy tokenization; they do not provide a complete grammar lint. Both
  `ferriki-textmate::Grammar` and `ferriki::Highlighter` expose a snapshot.
- **Precompiled scanner archives.** `SyncRegistry::export_precompiled_patterns`,
  `SyncRegistry::add_precompiled_patterns` and `Grammar::compile_all_scanners`
  are documented `ferriki-textmate` extensions with the usual semver
  guarantee; `ferriki-asset-gen` and `ferriki` will call them (#325). The
  archive bytes are Ferroni's format: `PRECOMPILED_PATTERNS_FORMAT_VERSION`
  names it and may change in any release, and readers reject other versions
  instead of migrating them. Errors surface as the crate-owned
  `PrecompiledPatternsError`, so no Ferroni type enters a public signature.
- **Common traits.** Public types implement `Debug`, and `Clone` and
  `PartialEq` where the data allows; types that hold large payloads implement
  `Debug` by hand without printing them.
- **MSRV.** `rust-version` in the workspace `Cargo.toml` is the only source. It
  follows the Ferramenta policy of the four latest stable releases, and raising
  it in a minor release is not a breaking change.
- **Released Rust baseline.** The `rust-semver` CI job runs pinned
  `cargo-semver-checks` for `ferriki`, `ferriki-textmate`, and
  `ferriki-asset-gen`, never the unpublished `ferriki-core`. For each public
  crate it compares against the newest non-yanked stable crates.io version of
  the current major, with default and all features. The latter includes
  `ferriki`'s optional `remote` API. The gate fails when the registry has no
  valid baseline or the candidate is older than a published version. While
  ordinary development still has the latest released manifest version, the
  check treats it as a minor update: additions are allowed, but major breaks
  are not. A new patch or minor candidate uses that release type instead.
- **Intentional major.** The first candidate of a next major fails the gate
  until its reviewed CI command explicitly passes `--allow-major <new-major>`.
  That selects the latest stable previous-major release and runs the check as
  a major update. The opt-in becomes invalid once a same-major release exists,
  so it must be removed after the first major release. Prerelease candidates
  and skipped major numbers are not accepted by this policy.

## Consequences

- An upstream sync, a Ferroni major or a codec change no longer forces a
  Ferriki major by itself.
- Callers cannot use struct literals or exhaustive matches on our types, and
  must use constructors, setters and wildcard arms. The N-API host converts
  these results to private typed binding objects without changing the
  published Rust types.
- **TextMate continuation snapshots.** `Grammar::serialize_state_stack` and
  `Grammar::deserialize_state_stack` provide an opaque JSON snapshot for
  process-portable tokenizer continuation. The snapshot is tied to the compiled
  grammar identity, carries rule and scope frames rather than theme attributes,
  and resolves attributes using the receiving grammar's current theme. It omits
  the full input but can retain matched fragments in dynamic backreferences and
  scope names. The versioned format rejects mismatched grammars and malformed
  data, and bounds snapshots to 1 MiB, 2,048 stack frames, 4,096 scope frames,
  64 KiB per dynamic pattern, and 100,000 cumulative validation steps. The
  fingerprint includes the ordered contributed-injection list and excludes
  source-location metadata.
- Port code that only the old public surface reached now has no caller; it
  stays for upstream parity with an explicit `dead_code` allowance
  ([ADR 0010](0010-mechanical-vscode-textmate-port.md)).
- Adding a field or an error kind is a minor change; renaming or removing one
  is still a major change.

## Validation and review triggers

- `tests/public_api.rs` exercises the documented surface.
- Building with `RUSTFLAGS="-W unnameable_types"` reports no public item that
  leaks an unnameable type; this is a manual check today.
- CI's pinned checker compares all three public crates to actual released
  sources. Its test proves that removing a released documented public type
  produces a deny-level finding. The hidden bridges `ferriki::__private` and
  `ferriki_textmate::__oracle` remain semver-exempt; neither bridge is a reason
  to downgrade or disable checks for documented public items. Review
  any checker finding against this boundary before changing the API or policy.
- Revisit the `doc(hidden)` rule if the crates stop sharing one version or the
  release tooling starts preserving exact requirements.

## History

- 2026-10-24: Preserve the ordinary raw archive API while accepting prepared
  Eager containers through the same registry import method.

- 2026-10-24: Define empty preparation samples as complete static scanner-list
  enumeration; nonempty samples retain encountered-group preparation.

- 2026-10-24: Add the stable sample-driven Eager preparation API while keeping
  Ferroni's program and group types private (ADR 0021).

- 2026-10-24: Document the owned public bridge for generating and attaching
  optional bytecode across published crate boundaries (#325).

- 2026-09-30: Accepted. Implemented in 0.6.0 (#135, #159).
- 2026-10-01: Includes the documented combined scope/binary result used by the highlighter (#172).
- 2026-10-01: Named multi-theme result types join the public contract with UTF-8 offsets (#183).
- 2026-10-03: Adds owned lazy backtracking diagnostics to the documented `ferriki-textmate` and `ferriki` surfaces (#153).

- 2026-10-05: Records the private typed N-API conversion instead of JSON transport (#217); the published Rust serialized shapes stay unchanged.

- 2026-10-10: Explicitly keeps native decoration primitives within the semver-exempt Node bridge (#122).

- 2026-10-10: Records the complete native declarative HTML lane without changing callback or stable Rust API commitments.
- 2026-10-11: Adds the released Rust semver baseline and explicit major-release policy (#254).
- 2026-10-21: Adds the versioned serializable TextMate continuation snapshot API used by Node grammar state (#291).
- 2026-10-22: Adds the precompiled scanner archive API to `ferriki-textmate` (#325).
