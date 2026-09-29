# ADR 0001: Rust-First Runtime Architecture

## Status

Accepted

Last updated: 2026-09-30

## Context

Ferriki started from a Shiki-shaped repository, but the target product is not a
multi-runtime JavaScript project. The goal is a native highlighting runtime
with a thin Node-facing compatibility layer.

## Decision

Ferriki is Rust-first.

- Runtime behavior belongs in Rust.
- JavaScript exists to host the native addon, expose the public API, and keep
  the compatibility contract stable.
- New business logic should not be added in JavaScript unless it is strictly
  binding-related.

## Consequences

- Grammar handling, tokenization, theme application, state behavior, and HTML,
  HAST and line rendering live in the Rust `ferriki` crate. `ferriki-core` is
  only the N-API host ([ADR 0012](0012-publishable-rust-highlighter.md)).
- The JavaScript layer keeps the facade, addon loading, the catalog projection,
  and transformer and decoration dispatch, the bounded exception of
  [ADR 0008](0008-transformers-and-decorations-stay-in-js.md).
- Token JSON is a compatibility surface, not the preferred internal pipeline.
  Results cross the N-API boundary as JSON strings; for object-heavy APIs such
  as `codeToHast` and `codeToTokensBase` that cost is measurable (#147).
- Architectural cleanliness is prioritized over preserving the old Shiki
  package topology.

## History

- 2026-03-09: Accepted.
- 2026-09-30: Consequences describe the implemented split between the Rust crates and the JS facade.
