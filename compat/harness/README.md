# Ferriki Compatibility Harness

This directory contains Ferriki-owned glue that allows the upstream Shiki
compatibility suite to run against the Ferriki npm package.

Rules:

- Upstream-mirrored tests and fixtures do not live here.
- Files here may adapt imports, runners, and environment setup.
- Ferriki-specific compatibility logic belongs here instead of inside
  upstream-derived test files.
