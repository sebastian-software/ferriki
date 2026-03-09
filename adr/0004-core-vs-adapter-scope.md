# ADR 0004: Separate Core Product Scope From Optional Adapter Lanes

## Status

Accepted

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
separately and do not define the core release boundary by default.

## Consequences

- The core product can stay lean without pretending every historical ecosystem
  package is equally central.
- Compatibility work can be prioritized rationally.
- Optional integrations can remain supported without dictating core
  architecture.
