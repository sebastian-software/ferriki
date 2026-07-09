# Ferriki Asset Catalogs

This directory contains the Ferriki-owned runtime assets.

The binary on-disk format is documented in
[`docs/asset-format.md`](../../docs/asset-format.md).

Catalogs:

- `languages/` — `.fkgram` grammars plus a `manifest.fkindex`
- `themes/` — `.fktheme` themes plus a `manifest.fkindex`

These files are the product-side asset format consumed by Ferriki, not the raw
upstream source format. The Node package copies them during `build:native` via
`node/ferriki/scripts/sync-standard-assets.mjs`.

They are generated from the normalized upstream mirror with:

- [`scripts/generate-ferriki-assets.mjs`](../../scripts/generate-ferriki-assets.mjs)
- or the bootstrap helper
  [`scripts/bootstrap-ferriki-assets-from-shiki-mirror.mjs`](../../scripts/bootstrap-ferriki-assets-from-shiki-mirror.mjs)
  when only the checked-in Shiki mirror is available
