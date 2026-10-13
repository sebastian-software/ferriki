# ADR 0006: Lazy Loading For Shiki-Derived Assets

## Status

Accepted

Last updated: 2026-10-13

## Context

Ferriki needs Shiki-compatible grammars, language metadata, and themes, but it
should not carry the old JavaScript bundle architecture as its runtime truth.

Fully embedding all bundled grammars and themes into the Rust core would keep
too much unused data resident by default and would scale poorly as the standard
catalog grows. At the same time, Ferriki still needs a reproducible,
upstream-driven source for the standard language and theme catalog.

## Decision

Ferriki loads and registers its standard assets lazily.

- Ferriki owns standard grammar selection, original source pins, language
  metadata, aliases, and embedded-language metadata (ADR 0020). Existing theme
  snapshots remain supported.
- Ferriki maintains these inputs as data assets, not as JavaScript runtime code.
  `ferriki-asset-gen` turns normalized, locally materialized source data into
  binary catalogs in the ignored `assets/standard/` directory ([ADR 0015](0015-postcard-asset-codec.md)).
- The Rust core owns efficient registration, compilation, and caching after an
  asset is loaded.
- Themes and grammars use the same conceptual loading path as user-provided
  assets.
- Standard assets are never eagerly embedded runtime state. How a consumer
  obtains the payloads (a release-pinned CDN, an optional offline package, or
  an embedded catalog) is decided in
  [ADR 0013](0013-cdn-loaded-standard-assets.md). Sources and payloads live
  in immutable Bunny Storage objects; Git retains reviewed metadata, pins,
  patches, and license notices.

## Consequences

- Ferriki avoids a large always-on in-memory catalog for 100+ languages/themes.
- External themes remain first-class and are not second to built-in themes.
- Supported Shiki HTML behavior is checked through the compatibility mirror,
  while the standard language selection belongs to Ferriki.
- The JS bundle-based asset layer is gone. The Ferriki-owned pipeline
  generates the catalogs, and a release manifest pins every payload by digest.
- ADR 0020 settles the curated grammar source list proposed in #152 without
  changing the lazy loading model.

## History

- 2026-03-09: Accepted.
- 2026-09-30: The Ferriki-owned pipeline replaced the JS bundle assets; delivery of payloads moved to ADR 0013.
- 2026-10-12: Ferriki owns curated grammar sources and metadata per ADR 0020.
- 2026-10-13: Sources and generated data moved out of Git into immutable Bunny Storage; metadata compiles offline.
