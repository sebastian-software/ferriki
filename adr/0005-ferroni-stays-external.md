# ADR 0005: Keep Ferroni As An External Dependency

## Status

Accepted

Last updated: 2026-09-30

## Context

Ferriki depends on Ferroni, but Ferroni is its own product and should not be
vendored into the Ferriki repository.

## Decision

Ferroni stays external.

- Ferriki depends on Ferroni through Cargo.
- Ferriki does not vendor Ferroni source into this repository.
- Only `ferriki-textmate` uses Ferroni, as the regex engine behind its scanner
  ([ADR 0010](0010-mechanical-vscode-textmate-port.md)). Repository-owned
  runtime code lives in the `ferriki` root crate and in `crates/`.
- Ferroni is an implementation dependency, not part of the public API. No
  Ferroni type appears in a public signature of the published crates;
  regex failures surface as the crate-owned `RegexError`
  ([ADR 0014](0014-rust-crate-semver-surface.md)).
- The workspace declares a Ferroni floor. Consumers resolve the newest
  compatible release, so CI should also test that version (#129).

## Consequences

- Dependency boundaries stay clear.
- Ferroni can evolve independently. A Ferroni major release does not force a
  Ferriki major release, because no Ferroni type is part of Ferriki's API.
- Ferriki avoids reintroducing the vendor-pattern that was already removed.

## History

- 2026-03-09: Accepted.
- 2026-09-30: Runtime code moved out of `ferriki-core`; Ferroni types left the public API in 0.6.0.
