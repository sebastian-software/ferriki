# Upstream Compatibility Mirrors

This directory is reserved for strict upstream compatibility mirrors.

Rules:

- mirrored upstream files are imported mechanically
- mirrored upstream files are not edited for Ferriki-specific behavior
- Ferriki-specific glue lives outside this directory, under `node/compat/harness`

The mirror is `node/compat/upstream/shiki`, sourced from the official
Shiki repository at a single approved release tag — currently v4.3.1
(see `shiki/.source.json` for the exact tag and commit).

Path manifests:

- `node/compat/upstream/shiki-paths.json`: full mirrored path set
- `node/compat/upstream/shiki-core-paths.json`: core highlighting contract paths
- `node/compat/upstream/shiki-optional-paths.json`: optional adapter and add-on lanes kept outside the main Ferriki core gate

Normal compatibility preparation is mirror-safe. `pnpm run prepare:compat`
runs the upstream language and theme generators in a temporary checkout, copies
only their ignored `dist/` output into the working tree, and verifies that the
tracked mirror is unchanged. `pnpm run build:compat` uses the same preparation
path and skips the upstream packages whose `build` scripts would regenerate
tracked files.

To intentionally update the mirror, use the sync script with a local Shiki
checkout and an explicit release tag, then review and commit the resulting
upstream-only diff:

```sh
node ./scripts/sync-shiki-compat.mjs \
  --source-repo /path/to/shiki \
  --paths-file ./compat/upstream/shiki-paths.json \
  --ref v4.3.1
```

The same command with `--check` validates an existing mirror against the tag in
`.source.json`. Generated outputs are never updated by ordinary install, build,
or test commands.
