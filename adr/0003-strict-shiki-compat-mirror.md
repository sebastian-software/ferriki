# ADR 0003: Use A Strict Mirrored Shiki Compatibility Suite

## Status

Accepted

## Context

Ferriki wants to claim Shiki compatibility in a way that is externally
checkable. That requires more than hand-maintained local tests.

## Decision

Ferriki mirrors the relevant upstream Shiki release-tag suite under
`node/compat/upstream/shiki` and does not edit those mirrored files in place.

- One approved Shiki release tag is active at a time.
- The mirror is tag-based, not `main`-based.
- Ferriki-specific adaptation happens outside the mirror.

## Consequences

- Compatibility can be grounded in a concrete upstream baseline.
- Drift between Ferriki and the official Shiki contract becomes more visible.
- Updating compatibility requires a deliberate baseline refresh, not ad hoc test
  edits.
