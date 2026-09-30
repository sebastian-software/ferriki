# ADR 0011: Freeze the Ferriki 1.0 Node API Contract

## Status

Accepted

Last updated: 2026-09-30

## Context

Ferriki exposes a deliberately small native runtime behind a Shiki-shaped Node
facade. The current declarations still describe several partial projections,
compatibility stubs, and catch-all options. Implementing individual parity gaps
before deciding the supported surface would make the API, types, and Ardo
integration drift again.

## Decision

Adopt [`docs/ferriki-1.0-api-contract.md`](../docs/ferriki-1.0-api-contract.md)
as the normative 1.0 Node API matrix. It classifies every public export,
factory input, highlight option, output shape, lifecycle rule, and error policy
as Stable, Shim, Remove, or Non-goal.

The contract prioritizes the synchronous reusable highlighter path required by
Ferromark and Ardo, keeps transformers/decorations in the JavaScript layer, and
keeps ecosystem adapters outside the public Ferriki package. The npm package
exposes no Rust API; Rust consumers use the published crates of
[ADR 0012](0012-publishable-rust-highlighter.md).

The contract lists the `assets` option, its environment variables and the
sync/async download boundary of
[ADR 0013](0013-cdn-loaded-standard-assets.md). Before it is frozen at 1.0,
the public TypeScript declarations also need a type-level check against the
mirrored Shiki types, so the hand-written declarations cannot drift (#158).

## Consequences

- API implementation and declaration work now has an explicit acceptance target.
- Compatibility tests can distinguish supported contracts from deferred Shiki
  behavior without inflating a parity score.
- Some currently exported stubs are intentionally removed before 1.0.
- Multi-theme output, enumerable catalogs, custom registrations, errors, and
  lifecycle behavior are required work rather than accidental extensions.

## History

- 2026-09-05: Accepted.
- 2026-09-30: Lists the ADR 0013 options and the type conformance check the contract must cover before the freeze.
- 2026-09-30: The contract now lists the `assets` option and the download boundary (#141).
