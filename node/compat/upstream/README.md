# Upstream Compatibility Mirrors

This directory is reserved for strict upstream compatibility mirrors.

Rules:

- mirrored upstream files are imported mechanically
- mirrored upstream files are not edited for Ferriki-specific behavior
- Ferriki-specific glue lives outside this directory, under `node/compat/harness`

The first intended mirror is `node/compat/upstream/shiki`, sourced from the official
Shiki repository at a single approved release tag.

Path manifests:

- `node/compat/upstream/shiki-paths.json`: full mirrored path set currently tracked in the workbench repo
- `node/compat/upstream/shiki-core-paths.json`: core highlighting contract paths
- `node/compat/upstream/shiki-optional-paths.json`: optional adapter and add-on lanes kept outside the main Ferriki core gate
