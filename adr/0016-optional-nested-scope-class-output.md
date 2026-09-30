# ADR 0016: Optional Nested Scope Classes With Resolved Theme CSS

## Status

Accepted

Last updated: 2026-09-30

## Context

Consumers need simple CSS customization and theme switching without losing the
scope detail used by TextMate themes. Unordered classes alone cannot distinguish
scope order or repetition. Converting TextMate selectors to CSS selectors would
also need to reproduce TextMate precedence and inheritance independently.

The [class-highlighting experiment](../docs/experiments/class-highlighting.md)
compared flat classes, nested scopes, and path identifiers. Nested scopes retained
the tested distinctions while ordinary category selectors covered simple tasks.
Its curated results do not establish coverage of 95% of user requirements.

## Decision

Offer nested scope classes as an optional output mode. Inline output remains the
default. Preserve raw grammar boundaries, ancestor order, and repeated scopes;
share adjacent ancestors within each line. Readable token and wrapper classes
provide both category styling and detailed context selectors.

Existing themes remain unchanged. The native TextMate engine resolves their
styles, and the renderer extracts those declarations into deduplicated CSS
classes with zero selector specificity. CSS covers the rendered content;
consumers collect styles from every rendered block. Prepared theme maps switch
through an attribute without retokenizing or replacing token elements.

This does not add another theme interpreter or grammar engine. Rust owns grammar
boundaries, scope paths, and theme resolution. The Rust renderer supports nested
classes and CSS extraction. The Node facade applies the corresponding HAST
projection after JavaScript transformers and decorations, preserving the boundary
of [ADR 0008](0008-transformers-and-decorations-stay-in-js.md).

The [class-output guide](../docs/class-highlighting.md) defines the public class
contract and integration rules. Enforcement lives in
[`src/render.rs`](../src/render.rs),
[`node/ferriki/classes.mjs`](../node/ferriki/classes.mjs), and the mandatory
[`check:classes` gate](../node/scripts/check-class-highlighting.mjs).

## Consequences

- Simple CSS themes need no TextMate theme file. Detailed rules can use ordinary
  child and descendant selectors without exposing generated style identifiers.
- Theme JSON can be reused, but new content or newly added themes require a
  render/build step. Generated CSS is not a universal stylesheet for future code.
- Scope wrappers increase DOM size. Scope names depend on grammars and may
  change with grammar updates. Large-document and cross-browser costs need
  separate measurement.
- Classes mode skips whitespace and equal-style token merging. Transformers
  that assume flat output and sanitizers that remove wrappers need adaptation.
- The existing default output and upstream mirrors remain unchanged.

## History

- 2026-09-30: Accepted the optional nested-scope output and reuse of native theme resolution.
