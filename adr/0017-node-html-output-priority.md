# ADR 0017: Prioritize HTML Output for Node Consumers

## Status

Accepted

Last updated: 2026-10-03

## Context

Ferriki's Node API previously exposed HTML, HAST, and token outputs. HTML is
ready to use in the consuming page, and Ferriki supports both inline styles
and nested scope classes with resolved theme CSS ([ADR
0016](0016-optional-nested-scope-class-output.md)). The Rust API has separate
token consumers, including Ferromark ([ADR
0012](0012-publishable-rust-highlighter.md)).

The recorded Shiki comparison is from Ferriki 0.4.1 at `be45fef5` and measures
14 documents. It is useful historical evidence, not a current performance
claim. The explanation in issue #147 that N-API constructs one JavaScript
object per token does not match the current JSON-string transport described in
[ADR 0001](0001-rust-first-architecture.md). There are no measured Node API
usage figures establishing how common any output shape is; the HTML and CSS
priority below is product judgment. Issue #207 settles the pre-1.0 output
surface based on that product judgment, rather than new usage or performance
measurements.

## Decision

- The Node API exposes HTML rendering as its only public output path. This
  includes `codeToHtml` with its inline-style default, `styleMode: "classes"`
  for scope classes with consumer-provided CSS, and `codeToHtmlWithCss` for
  HTML plus resolved theme CSS.
- Remove the public Node `codeToHast`, `codeToTokens`, `codeToTokensBase`,
  `codeToTokensWithThemes`, and `hastToHtml` methods before 1.0. Remove both
  the top-level shorthands and reusable-highlighter methods. Do not retain
  deprecated aliases or add a compatibility package for these methods. This
  is an intentional pre-1.0 breaking divergence from Shiki.
- Keep the JavaScript transformer and decoration pipeline for HTML rendering.
  Token payloads and Ferriki-typed HAST nodes remain callback data inside that
  pipeline, including `includeExplanation`-driven scope/type metadata, but
  callers cannot request them as a standalone Node result. Remove
  `codeToHast` and `codeToTokens` convenience methods from transformer contexts
  as well.
- Keep `getLastGrammarState(code, options)` as the source of serializable
  grammar state for HTML continuation. Do not expose token-result or HAST-result
  overloads. Keep the public Rust token APIs and native tokenizer unchanged.

## Consequences

- Node documentation and any future performance work center on HTML rendering
  and the inline or CSS-class styling paths.
- Structured HAST and token output is no longer part of the public Node
  contract. Transformer callbacks continue to receive the data needed by the
  supported HTML pipeline; Rust consumers retain their public token APIs.
- Before 1.0, code that imports a removed structured-output method must move
  to Ferriki HTML rendering or to the Rust API. No Node compatibility alias is
  promised after the removal.
- The historical benchmark remains useful for its measured revision and must
  not be presented as a current comparison. A new performance claim requires a
  new measurement against the current runtime.
- The decision changes the Node product boundary and Shiki migration guidance;
  it does not change Rust API commitments or remove the internal HAST
  transformation pipeline.

## History

- 2026-10-01: Accepted the HTML and CSS priority; leaves pre-1.0 retention of public Node HAST and token exports open.
- 2026-10-03: Resolves issue #207 by removing public Node HAST and token outputs before 1.0 while retaining HTML transformer data and Rust token APIs.
