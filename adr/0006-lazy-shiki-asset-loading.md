# ADR 0006: Lazy Loading For Shiki-Derived Assets

## Status

Accepted

## Context

Ferriki needs Shiki-compatible grammars, language metadata, and themes, but it
should not carry the old JavaScript bundle architecture as its runtime truth.

Fully embedding all bundled grammars and themes into the Rust core would keep
too much unused data resident by default and would scale poorly as the standard
catalog grows. At the same time, Ferriki still needs a reproducible,
upstream-driven source for the standard language and theme catalog.

## Decision

Ferriki ships Shiki-derived assets, but loads and registers them lazily.

- Shiki remains the upstream source for standard grammars, language metadata,
  aliases, embedded-language metadata, and standard themes.
- Ferriki mirrors those inputs as data assets, not as JavaScript runtime code.
- The Rust core owns efficient registration, compilation, and caching after an
  asset is loaded.
- Themes and grammars use the same conceptual loading path as user-provided
  assets.
- Standard assets may be shipped with Ferriki for convenience, but they are not
  treated as eagerly embedded runtime state.

## Consequences

- Ferriki avoids a large always-on in-memory catalog for 100+ languages/themes.
- External themes remain first-class and are not second to built-in themes.
- Standard Shiki compatibility can still be preserved through mirrored asset
  sync, while the runtime stays Rust-first.
- The current JS bundle-based asset layer is transitional and should be
  replaced by a Ferriki-owned asset pipeline.
