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
generated runtime, locked napi-rs build driver, archive and consumer checks,
source/digest artifact receipts, release gates and npm publication/recovery. `node/native-npm.config.mjs` supplies product identity.
Assets, compatibility checks, public APIs and benchmark build receipts stay in
Ferriki. The existing local Ferroni experiment remains a locked build input.

The CLI catalog pins a full Ferramenta Git commit and the `packages/native`
subdirectory through pnpm. Normal and frozen installs fetch the ready-to-run
helpers automatically; no toolkit registry release, submodule setup, sibling
checkout or install-time build is required. The same dependency ships the
composite CI action for Rust target setup, musl toolchains and the product's
native build. The shared build and release Actions own native packaging orchestration.
Functional assertions and asset preparation remain in Ferriki; the common
consumer harness owns installation, subprocesses and cleanup.
End users install only `@ferriki/core` and its platform package.

## Consequences

Loader and build fixes are maintained centrally. Product releases, asset
publication policy and npm Trusted Publishing permissions remain owned by
Ferriki. The shared package implements the immutable-source gate; Ferriki
configures its required CI jobs, versioned Cargo manifests and asset checks. No Rust objects cross addon boundaries.

## History

- 2026-10-27: Accepted; unify family native packaging while retaining Ferriki's compatibility and release contracts.

- 2026-10-27: Adopt the published 0.1.0 toolkit and remove the bootstrap archive.

- 2026-10-27: Consume the toolkit and shared CI action through one full-SHA pnpm Git dependency, avoiding toolkit releases and contributor setup.

- 2026-10-27: Centralize the native npm release lifecycle, archive and public-install harnesses, and exact-source CI decisions; retain product asset and Vite assertions.
