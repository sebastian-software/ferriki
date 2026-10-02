# ADR 0004: Separate Core Product Scope From Optional Adapter Lanes

## Status

Accepted

Last updated: 2026-10-02

## Context

The old Shiki-shaped workspace included core highlighting behavior together with
Markdown, rehype, VitePress, Twoslash, colorized brackets, and other adapters.
Treating all of that as the Ferriki core would make the product boundary fuzzy
again.

## Decision

Ferriki distinguishes between:

- core product scope: highlighting runtime and direct outputs
- optional adapter lanes: framework and ecosystem integrations

Core scope includes APIs such as `createHighlighter`, `codeToHtml`,
`codeToTokens`, and related runtime behavior. Adapter lanes are validated
separately and do not define the core release boundary by default. Ferriki
owns the optional `@ferriki/vite` build adapter; that package does not add Vite
or framework integration to the core runtime.

## Consequences

- The core product can stay lean without pretending every historical ecosystem
  package is equally central.
- Compatibility work can be prioritized rationally.
- Optional integrations can remain supported without dictating core
  architecture.
- Specific adapter integrations that stay outside Ferriki are captured in
  [ADR 0007](0007-adapter-integrations-stay-outside-ferriki.md).
- The Vite adapter has its own optional installable package and tests, and is
  published in the shared Ferriki product release. Its presence does not make
  other framework integrations part of Ferriki core.
- The same boundary applies to Rust consumers: the published crates provide
  highlighting and rendering primitives, and Markdown integration such as the
  Ferromark adapter lives in the consumer
  ([ADR 0012](0012-publishable-rust-highlighter.md)).

## History

- 2026-03-09: Accepted.
- 2026-07-09: Linked the adapter decisions of ADR 0007.
- 2026-09-30: Extends the boundary to Rust consumers.
- 2026-10-02: Adds an optional Vite build adapter outside the core runtime.
