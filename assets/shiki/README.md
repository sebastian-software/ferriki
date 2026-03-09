# Ferriki Asset Catalogs

Ferriki-owned runtime assets will be generated into this directory.

Planned catalogs:

- `languages/`
- `themes/`

These files are the product-side asset format consumed by Ferriki, not the raw
upstream source format.

They can be generated from the normalized upstream mirror with:

- [`scripts/generate-ferriki-assets.mjs`](/Users/sebastian/Workspace/oss-released/ferriki/scripts/generate-ferriki-assets.mjs)
- or the bootstrap helper
  [`scripts/bootstrap-ferriki-assets-from-shiki-mirror.mjs`](/Users/sebastian/Workspace/oss-released/ferriki/scripts/bootstrap-ferriki-assets-from-shiki-mirror.mjs)
  when only the checked-in Shiki mirror is available
