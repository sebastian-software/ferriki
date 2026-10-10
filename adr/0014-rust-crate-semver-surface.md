# ADR 0014: Semver Surface of the Published Rust Crates

## Status

Accepted

Last updated: 2026-10-10

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
- **Common traits.** Public types implement `Debug`, and `Clone` and
  `PartialEq` where the data allows; types that hold large payloads implement
  `Debug` by hand without printing them.
- **MSRV.** `rust-version` in the workspace `Cargo.toml` is the only source. It
  follows the Ferramenta policy of the four latest stable releases, and raising
  it in a minor release is not a breaking change.

## Consequences

- An upstream sync, a Ferroni major or a codec change no longer forces a
  Ferriki major by itself.
- Callers cannot use struct literals or exhaustive matches on our types, and
  must use constructors, setters and wildcard arms. The N-API host converts
  these results to private typed binding objects without changing the
  published Rust types.
- Port code that only the old public surface reached now has no caller; it
  stays for upstream parity with an explicit `dead_code` allowance
  ([ADR 0010](0010-mechanical-vscode-textmate-port.md)).
- Adding a field or an error kind is a minor change; renaming or removing one
  is still a major change.

## Validation and review triggers

- `tests/public_api.rs` exercises the documented surface.
- Building with `RUSTFLAGS="-W unnameable_types"` reports no public item that
  leaks an unnameable type; this is a manual check today.
- After 1.0, add `cargo semver-checks` to CI and revisit this record when it
  reports a break that the rules above did not prevent.
- Revisit the `doc(hidden)` rule if the crates stop sharing one version or the
  release tooling starts preserving exact requirements.

## History

- 2026-09-30: Accepted. Implemented in 0.6.0 (#135, #159).
- 2026-10-01: Includes the documented combined scope/binary result used by the highlighter (#172).
- 2026-10-01: Named multi-theme result types join the public contract with UTF-8 offsets (#183).
- 2026-10-03: Adds owned lazy backtracking diagnostics to the documented `ferriki-textmate` and `ferriki` surfaces (#153).

- 2026-10-05: Records the private typed N-API conversion instead of JSON transport (#217); the published Rust serialized shapes stay unchanged.

- 2026-10-10: Explicitly keeps native decoration primitives within the semver-exempt Node bridge (#122).

- 2026-10-10: Records the complete native declarative HTML lane without changing callback or stable Rust API commitments.
