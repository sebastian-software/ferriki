# ADR 0003: Use A Strict Mirrored Shiki Compatibility Suite

## Status

Accepted

Last updated: 2026-09-30

## Context

Ferriki wants to claim Shiki compatibility in a way that is externally
checkable. That requires more than hand-maintained local tests.

## Decision

Ferriki mirrors the relevant upstream Shiki release-tag suite under
`node/compat/upstream/shiki` and does not edit those mirrored files in place.

- One approved Shiki release tag is active at a time.
- The mirror is tag-based, not `main`-based.
- Ferriki-specific adaptation happens outside the mirror.
- The active tag and commit are recorded in
  `node/compat/upstream/shiki/.source.json`. The core gate verifies the mirror
  against its checksum manifest, and `check-docs-drift.mjs` keeps the baseline
  stated in the docs in step with it.
- The vscode-textmate mirror of [ADR 0010](0010-mechanical-vscode-textmate-port.md)
  follows the same rules.

## Consequences

- Compatibility can be grounded in a concrete upstream baseline.
- Drift between Ferriki and the official Shiki contract becomes more visible.
- Updating compatibility requires a deliberate baseline refresh, not ad hoc test
  edits.

## History

- 2026-03-09: Accepted.
- 2026-09-30: Names where the active baseline is recorded and how the mirror is verified.
