# ADR 0017: Prioritize HTML Output for Node Consumers

## Status

Accepted

Last updated: 2026-10-01

## Context

Ferriki's Node API exposes HTML, HAST, and token outputs. HTML is ready to use
in the consuming page, and Ferriki now supports both inline styles and nested
scope classes with resolved theme CSS ([ADR 0016](0016-optional-nested-scope-class-output.md)).
The Rust API has separate token consumers, including Ferromark
([ADR 0012](0012-publishable-rust-highlighter.md)).

The recorded Shiki comparison is from Ferriki 0.4.1 at `be45fef5` and measures
14 documents. It is useful historical evidence, not a current performance
claim. The explanation in issue #147 that N-API constructs one JavaScript
object per token does not match the current JSON-string transport described in
[ADR 0001](0001-rust-first-architecture.md). There are no measured Node API
usage figures establishing how common any output shape is; the HTML and CSS
priority below is product judgment.

## Decision

- For Node consumers, HTML is the primary output and performance path. This
  includes `codeToHtml` with its existing inline-style default,
  `styleMode: "classes"` for scope classes with consumer-provided CSS, and
  `codeToHtmlWithCss` for HTML plus resolved theme CSS.
- While HAST and token APIs remain exposed, keep their documented output and
  behavior correct. Performance parity with Shiki is not a release gate for
  those structured outputs.
- Whether to retain every public Node HAST and token export in the 1.0 contract
  remains open and must be decided before that contract is frozen. Until that
  decision changes the contract, the current API matrix remains in force. This
  question is limited to public Node exports; it does not propose removing the
  native tokenizer, Rust token APIs used by consumers such as Ferromark, or the
  internal HAST transformation pipeline.

## Consequences

- Node documentation and any future performance work center on HTML rendering
  and the inline or CSS-class styling paths.
- HAST and token output remain supported according to the current Node API
  contract, but no relative performance promise is attached to them.
- The historical benchmark remains useful for its measured revision and must
  not be presented as a current comparison. A new performance claim requires a
  new measurement against the current runtime.
- The 1.0 API review must settle public Node HAST and token export retention
  before the contract is frozen. That choice does not change Rust API
  commitments or internal implementation boundaries.

## History

- 2026-10-01: Accepted the HTML and CSS priority; leaves pre-1.0 retention of public Node HAST and token exports open.
