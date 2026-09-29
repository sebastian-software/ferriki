# ADR 0006: Lazy Loading For Shiki-Derived Assets

## Status

Accepted

Last updated: 2026-09-30

## Context

Ferriki needs Shiki-compatible grammars, language metadata, and themes, but it
should not carry the old JavaScript bundle architecture as its runtime truth.

Fully embedding all bundled grammars and themes into the Rust core would keep
too much unused data resident by default and would scale poorly as the standard
catalog grows. At the same time, Ferriki still needs a reproducible,
upstream-driven source for the standard language and theme catalog.

## Decision

Ferriki uses Shiki-derived assets and loads and registers them lazily.

- Shiki remains the upstream source for standard grammars, language metadata,
  aliases, embedded-language metadata, and standard themes.
- Ferriki mirrors those inputs as data assets, not as JavaScript runtime code.
  `ferriki-asset-gen` turns the normalized upstream mirror into the binary
  catalogs under `assets/shiki/` ([ADR 0015](0015-postcard-asset-codec.md)).
- The Rust core owns efficient registration, compilation, and caching after an
  asset is loaded.
- Themes and grammars use the same conceptual loading path as user-provided
  assets.
- Standard assets are never eagerly embedded runtime state. How a consumer
  obtains the payloads (a release-pinned CDN, an optional offline package, or
  an embedded catalog) is decided in
  [ADR 0013](0013-cdn-loaded-standard-assets.md).

## Consequences

- Ferriki avoids a large always-on in-memory catalog for 100+ languages/themes.
- External themes remain first-class and are not second to built-in themes.
- Standard Shiki compatibility can still be preserved through mirrored asset
  sync, while the runtime stays Rust-first.
- The JS bundle-based asset layer is gone. The Ferriki-owned pipeline
  generates the catalogs, and a release manifest pins every payload by digest.
- Which grammars the standard set should contain, instead of mirroring the
  whole Shiki collection, is an open proposal (#152). It would change the
  source list, not this loading model.

## History

- 2026-03-09: Accepted.
- 2026-09-30: The Ferriki-owned pipeline replaced the JS bundle assets; delivery of payloads moved to ADR 0013.
