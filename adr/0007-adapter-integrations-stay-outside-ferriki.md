# ADR 0007: Adapter Integrations Stay Outside Ferriki

## Status

Accepted

Last updated: 2026-10-03

## Context

Ferriki aims to keep familiar Shiki-shaped HTML highlighting with a lean Rust
core. That goal does not require Ferriki to own every historical package from
the Shiki workspace.

Several integrations remain separate from the core product:

- `markdown-it`
- `rehype`
- `vitepress-twoslash`

Issue #194 proposed a small build-time Vite adapter for ordinary HTML and
intrinsic JSX code blocks. The product boundary is an optional package, not
runtime behavior inside `@ferriki/core`.

These packages are not highlighting-runtime features. They are adapters around
the HTML rendering and transformer hooks Ferriki provides. Treating them as
Ferriki responsibilities would make the product boundary fuzzy again and
would pull framework-specific concerns back into the repository's main scope.

## Decision

Ferriki does not treat `markdown-it`, `rehype`, or `vitepress-twoslash` as
core product features. Ferriki does publish `@ferriki/vite` as an optional
build-time adapter for opted-in HTML and static intrinsic JSX blocks.

The excluded adapters are out of scope for Ferriki because:

- they compose Ferriki outputs instead of defining the runtime
- they can live outside Ferriki without weakening the core highlighting product
- keeping them inside Ferriki would add ecosystem-specific maintenance pressure
  without improving the Rust-first architecture

Ferriki remains responsible for the outputs those integrations build on:

- `codeToHtml`
- `codeToHtmlWithCss`
- HTML transformer and decoration behavior

Public Node HAST and token result methods, including the serializer helper, are
removed before 1.0 under [ADR 0017](0017-node-html-output-priority.md). The
internal hook pipeline still uses typed HAST nodes and token payloads.

The Vite adapter is deliberately narrow. It consumes
`data-highlight="auto"` and a static `data-language`, emits final highlighted
markup and CSS during Vite transforms, and leaves dynamic or ambiguous JSX
unchanged. A Markdown compiler must expose intermediate JSX before lowering;
other adapters remain out of scope unless accepted in a future product
decision.

## Consequences

- Ferriki CI and planning should not treat these integrations as required
  compatibility lanes.
- `@ferriki/vite` is installed and tested separately from the core API, while
  sharing the product version and publication workflow.
- Ferriki documentation should describe them as out of scope instead of
  "not yet integrated".
- Consumers can build or keep such adapters externally against Ferriki's
  public HTML API and transformer hooks. Adapter work that currently depends
  on public Node HAST output must align with the pre-1.0 contract before it
  targets Ferriki 1.0; this record does not state a release or publication
  status for that work.
- The Rust counterpart follows the same rule: the Ferromark adapter belongs to
  Ferromark ([ADR 0012](0012-publishable-rust-highlighter.md)).
- If Ferriki later takes on a higher-level integration again, that should be a
  fresh product decision, not an accidental inheritance from the old Shiki
  workspace.

## History

- 2026-03-09: Accepted.
- 2026-09-30: Notes the Ardo and Ferromark integrations that follow this boundary.
- 2026-10-02: Accepts a narrow, optional Vite build adapter for static HTML and JSX.
- 2026-10-03: Updates adapter boundaries for the HTML-only public Node output contract (#207).
