# Upstream Asset Sources

This directory is reserved for upstream raw asset sources that Ferriki turns
into its own asset catalogs.

Primary upstream mirror:

- `textmate-grammars-themes`

These sources are not the product runtime format. Ferriki converts them into
its own asset representation under `assets/shiki/`.

Current mirror workflow:

1. Sync a local `textmate-grammars-themes` checkout plus Shiki metadata into
   `assets/upstream/textmate-grammars-themes/` with
   [`scripts/sync-textmate-grammars-themes.mjs`](/Users/sebastian/Workspace/oss-released/ferriki/scripts/sync-textmate-grammars-themes.mjs).
2. Generate Ferriki-owned binary catalogs from that normalized upstream layout
   with `cargo run -p ferriki-asset-gen -- generate ...`.

Bootstrap workflow:

- When only the mirrored Shiki workspace is available, use
  [`scripts/bootstrap-ferriki-assets-from-shiki-mirror.mjs`](/Users/sebastian/Workspace/oss-released/ferriki/scripts/bootstrap-ferriki-assets-from-shiki-mirror.mjs)
  to derive a normalized upstream layout plus Ferriki binary catalogs from the
  checked-in Shiki mirror.
