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

The initial dependency is the reviewed bootstrap archive under `node/vendor`.
After the first tooling release, adopt its exact registry version and remove
the archive. End users install only `@ferriki/core` and its platform package.

## Consequences

Loader and build fixes are maintained centrally. Product releases, asset
publication, the immutable-source gate and npm Trusted Publishing remain owned
by Ferriki. No Rust objects cross addon boundaries.

## History

- 2026-10-27: Accepted; unify family native packaging while retaining Ferriki's compatibility and release contracts.
