# README theme composition

## Status

Active. Update this document when the contract changes.

Last updated: 2026-10-01

## Decision

The project README is composed by native mdtheme from `README.md.src`. The
outer frame is Sebastian Software; Ferramenta is the inner frame. Footers close
in reverse order. The project content remains the main focus; shared branding
is compact and maintained upstream. The Ferramenta footer excludes this project
and includes sibling descriptions and the family icon.

Pin the CLI with mise and both Git theme revisions in mdtheme.yaml. CI checks
the generated output. Source and output are committed together. mdtheme is the
only tool that writes the root README; no other generator may append a second
company footer. Published subpackage READMEs keep their compact registry format
and existing generator.

## Consequences

Contributors edit the source, then regenerate. No JavaScript configuration or
Node installation is needed for the root README. Shared theme updates are
reviewable Git diffs. Rendering requires network access to the Git sources.

See [the contributor guide](../readme-theme.md) for commands.

## Theme badge placement

The project pins mdtheme 0.4.0 and uses one `mdtheme:badges:start` /
`mdtheme:badges:end` comment pair in `README.md.src`. Sebastian's
`badges-prepend.md` places its badge before the authored project badges.
Ferramenta's header and footer stay unchanged. Upgrade the CLI and lockfile
before adopting this theme revision. Keep badge markup outside raw HTML blocks.

## Published README badges

The root README keeps its project and registry badges in `README.md.src` inside
the mdtheme markers. The npm README uses a compact authored row for npm
version, license, and Node floor. Its generated family registry block stays
owned by `scripts/sync-readme-family.mjs`.

## History

- 2026-09-11: Adopted, with the theme badge placement.
- 2026-09-30: The organization's standards tooling was removed from this
  repository (#155); mdtheme remains the only README writer.
- 2026-10-01: Records the compact npm README badge row separately from the root badges.
