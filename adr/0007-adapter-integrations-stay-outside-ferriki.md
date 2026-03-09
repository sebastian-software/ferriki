# ADR 0007: Adapter Integrations Stay Outside Ferriki

## Status

Accepted

## Context

Ferriki aims to be a Shiki-compatible highlighter with a leaner Rust core.
That goal does not require Ferriki to own every historical package from the
Shiki workspace.

Three integrations were still implicitly hanging around in Ferriki's optional
adapter lane:

- `markdown-it`
- `rehype`
- `vitepress-twoslash`

These packages are not highlighting-runtime features. They are adapters around
outputs Ferriki already provides, especially `codeToHtml` and `codeToHast`.
Treating them as Ferriki responsibilities would make the product boundary fuzzy
again and would pull framework-specific concerns back into the repository's
main scope.

## Decision

Ferriki does not treat `markdown-it`, `rehype`, or `vitepress-twoslash` as
product features.

They are out of scope for Ferriki itself because:

- they compose Ferriki outputs instead of defining the runtime
- they can live outside Ferriki without weakening the core highlighting product
- keeping them inside Ferriki would add ecosystem-specific maintenance pressure
  without improving the Rust-first architecture

Ferriki remains responsible for the outputs those integrations build on:

- `codeToHtml`
- `codeToHast`
- related direct highlighting APIs

## Consequences

- Ferriki CI and planning should not treat these integrations as required
  compatibility lanes.
- Ferriki documentation should describe them as out of scope instead of
  "not yet integrated".
- Consumers can build or keep such adapters externally against Ferriki's
  direct outputs.
- If Ferriki later takes on a higher-level integration again, that should be a
  fresh product decision, not an accidental inheritance from the old Shiki
  workspace.
