# Local source data

`curated/` contains ignored, materialized normalized grammar and theme sources.
Git stores source selectors, pins, patches, license archives, and catalog
metadata. Original sources and generated runtime data live in immutable Bunny
Storage objects. They are verified by SHA-256 before local use.

Run `node scripts/materialize-assets.mjs --sources --payloads` before source
checks. See [the grammar guide](../../docs/grammars.md#maintain-the-standard-catalog)
for updates, publication, and recovery. The compatibility-only bootstrap
helpers use `assets/compat/`; they are separate from the standard catalog.
