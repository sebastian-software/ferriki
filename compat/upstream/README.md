# Upstream Compatibility Mirrors

This directory is reserved for strict upstream compatibility mirrors.

Rules:

- mirrored upstream files are imported mechanically
- mirrored upstream files are not edited for Ferriki-specific behavior
- Ferriki-specific glue lives outside this directory, under `compat/harness`

The first intended mirror is `compat/upstream/shiki`, sourced from the official
Shiki repository at a single approved release tag.

Path manifests:

- `compat/upstream/shiki-paths.json`: full mirrored path set currently tracked in the workbench repo
- `compat/upstream/shiki-core-paths.json`: core highlighting contract paths
- `compat/upstream/shiki-optional-paths.json`: optional adapter and add-on lanes kept outside the main Ferriki core gate
