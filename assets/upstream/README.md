# Upstream Asset Sources

This directory is reserved for upstream raw asset sources that Ferriki turns
into its own asset catalogs.

Standard normalized sources:

- `textmate-grammars-themes`

These sources are not the product runtime format. Ferriki converts them into
its own asset representation under `assets/shiki/`.

The directory name is retained from the original bootstrap. Ferriki owns the
grammar selection and metadata in
[`assets/grammars/catalog.json`](../grammars/catalog.json), with original
repository files pinned by commit and digest in
[`sources.json`](../grammars/sources.json). Theme snapshots remain unchanged.

Current workflow:

1. Prepare and validate repository updates with
   `scripts/prepare-grammar-update.mjs` and `scripts/validate-grammar-candidate.mjs`,
   then apply them with `scripts/apply-grammar-update.mjs`. The weekly/manual
   Grammar updates workflow runs the same path. `scripts/sync-grammars.mjs`
   reproduces the accepted pinned files.
2. Run `node scripts/generate-ferriki-assets.mjs` to generate the runtime
   catalogs and release manifest.
3. Run `node scripts/sync-grammars.mjs --check` to verify the committed source
   and metadata hashes without network access.

Compatibility-only helpers:

- The old Shiki bootstrap and `textmate-grammars-themes` sync helpers target
  `assets/compat/` by default. They are reference-data tools and are not the
  standard catalog pipeline. See [the grammar guide](../../docs/grammars.md).
