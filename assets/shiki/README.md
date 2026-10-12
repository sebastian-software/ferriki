# Ferriki Asset Catalogs

This directory contains the Ferriki-owned runtime assets.

The binary on-disk format is documented in
[`docs/asset-format.md`](../../docs/asset-format.md).

Catalogs:

- `languages/` — `.fkgram` grammars plus a `manifest.fkindex`
- `themes/` — `.fktheme` themes plus a `manifest.fkindex`
- `catalog.mjs` — generated enumerable Node loader metadata; it contains no
  grammar or theme payloads
- `release-manifest.json` — SHA-256, size and format version of every payload,
  for verified CDN loading (ADR 0013)
- `GRAMMAR-NOTICES.md` — original grammar sources and their archived license notices

These files are the product-side asset format consumed by Ferriki, not the raw
upstream source format. The Node package copies them during `build:native` via
`node/ferriki/scripts/sync-standard-assets.mjs`.

The historical `shiki` directory name remains the release CDN path. Grammar
selection and sources belong to Ferriki (ADR 0019). They are generated from
the normalized, pinned sources with:

- [`scripts/generate-ferriki-assets.mjs`](../../scripts/generate-ferriki-assets.mjs)
- [`scripts/generate-ferriki-catalog.mjs`](../../scripts/generate-ferriki-catalog.mjs)
- [`scripts/prepare-grammar-update.mjs`](../../scripts/prepare-grammar-update.mjs)
  prepares grouped updates from configured repositories; `sync-grammars.mjs`
  reproduces the accepted pins independently of Shiki
