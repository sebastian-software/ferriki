# ADR 0023: Shared Native npm Tooling

## Status

Accepted

Last updated: 2026-10-27

## Context

The family engines need the same native Node.js packaging and independent npm
releases. Ferriki's existing platform and provenance contracts must survive
extraction rather than be replaced by less complete build templates.

## Decision

Use Ferramenta's `ferramenta-native` development package for the platform table,
generated runtime, locked napi-rs build driver, platform checks and source-pinned
publication recovery. `node/native-npm.config.mjs` supplies product identity.
Assets, compatibility checks, public APIs and benchmark build receipts stay in
Ferriki. The existing local Ferroni experiment remains a locked build input.

The CLI catalog pins a full Ferramenta Git commit and the `packages/native`
subdirectory through pnpm. Normal and frozen installs fetch the ready-to-run
helpers automatically; no toolkit registry release, submodule setup, sibling
checkout or install-time build is required. The same dependency ships the
composite CI action for Rust target setup, musl toolchains and the product's
native build. Functional checks and asset preparation remain in Ferriki.
End users install only `@ferriki/core` and its platform package.

## Consequences

Loader and build fixes are maintained centrally. Product releases, asset
publication, the immutable-source gate and npm Trusted Publishing remain owned
by Ferriki. No Rust objects cross addon boundaries.

## History

- 2026-10-27: Accepted; unify family native packaging while retaining Ferriki's compatibility and release contracts.

- 2026-10-27: Adopt the published 0.1.0 toolkit and remove the bootstrap archive.

- 2026-10-27: Consume the toolkit and shared CI action through one full-SHA pnpm Git dependency, avoiding toolkit releases and contributor setup.
