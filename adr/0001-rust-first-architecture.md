# ADR 0001: Rust-First Runtime Architecture

## Status

Accepted

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

- Rendering, grammar handling, theme application, and state behavior should move
  toward the native core over time.
- Token JSON is a compatibility surface, not the preferred internal pipeline.
- Architectural cleanliness is prioritized over preserving the old Shiki
  package topology.
