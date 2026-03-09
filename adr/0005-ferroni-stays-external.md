# ADR 0005: Keep Ferroni As An External Dependency

## Status

Accepted

## Context

Ferriki depends on Ferroni, but Ferroni is its own product and should not be
vendored into the Ferriki repository.

## Decision

Ferroni stays external.

- Ferriki depends on Ferroni through Cargo.
- Ferriki does not vendor Ferroni source into this repository.
- Repository-owned runtime code lives in `crates/ferriki-core`.

## Consequences

- Dependency boundaries stay clear.
- Ferroni can evolve independently.
- Ferriki avoids reintroducing the vendor-pattern that was already removed.
