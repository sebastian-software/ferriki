# ADR 0011: Freeze the Ferriki 1.0 Node API Contract

## Status

Accepted

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
keeps Rust crates and ecosystem adapters outside the public Ferriki package.

## Consequences

- API implementation and declaration work now has an explicit acceptance target.
- Compatibility tests can distinguish supported contracts from deferred Shiki
  behavior without inflating a parity score.
- Some currently exported stubs are intentionally removed before 1.0.
- Multi-theme output, enumerable catalogs, custom registrations, errors, and
  lifecycle behavior are required work rather than accidental extensions.
