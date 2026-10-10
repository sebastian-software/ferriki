# ADR 0001: Rust-First Runtime Architecture

## Status

Accepted

Last updated: 2026-10-10

## Context

Ferriki started from a Shiki-shaped repository, but the target product is not a
multi-runtime JavaScript project. The goal is a native highlighting runtime
with a thin Node-facing compatibility layer.

## Decision

Ferriki is Rust-first.

- Runtime behavior belongs in Rust.
- JavaScript exists to host the native addon, expose the public API, and keep
  the compatibility contract stable.
- The Node host uses built-in `fetch` to transport release-pinned standard
  assets; Rust still resolves manifests, plans downloads and verifies cached
  payloads ([ADR 0013](0013-cdn-loaded-standard-assets.md)).
- Product behavior stays in Rust except for Node host mechanics such as the
  standard-asset transport in ADR 0013. Rust retains asset resolution and
  integrity policy.

## Consequences

- Grammar handling, tokenization, theme application, state behavior, and HTML,
  HAST and line rendering live in the Rust `ferriki` crate. `ferriki-core` is
  only the N-API host ([ADR 0012](0012-publishable-rust-highlighter.md)).
- The JavaScript layer keeps the facade, addon loading, the catalog projection,
  and transformer callback dispatch and native decoration edit replay, the bounded exception of
  [ADR 0008](0008-transformers-and-decorations-stay-in-js.md).
- Token JSON is a compatibility surface, not the preferred internal pipeline.
  Structured Node results cross the N-API boundary as JSON strings and are
  parsed by the facade. The comparison in
  [`docs/benchmarks/shiki-comparison.json`](../docs/benchmarks/shiki-comparison.json)
  is a historical measurement from Ferriki 0.4.1 at `be45fef5`; it showed
  `codeToHast` behind Shiki + WASM on that corpus. It does not establish the
  per-token N-API object construction described in issue #147 as the cause, or
  describe current performance targets. Node output priority is recorded in
  [ADR 0017](0017-node-html-output-priority.md).
- Architectural cleanliness is prioritized over preserving the old Shiki
  package topology.

## History

- 2026-03-09: Accepted.
- 2026-09-30: Consequences describe the implemented split between the Rust crates and the JS facade.
- 2026-10-01: Clarifies the JSON-string N-API transport and dates the API comparison to Ferriki 0.4.1.
- 2026-10-02: Records Node's standard-asset transport as a host boundary while
  keeping manifest planning and cache verification in Rust.

- 2026-10-10: Records native decoration policy with JS object replay and callbacks (#122).
