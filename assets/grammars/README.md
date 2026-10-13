# Ferriki Grammar Sources

The maintenance unit is a repository snapshot. Source selection and generated
pins are separate:

- `repositories.json` configures repository IDs, moving refs, discovery adapters,
  license paths, Linguist modules, and the reason for each scoped exception.
  The two collections are VS Code and GitHub Linguist; the six exceptions
  provide Angular, Vue, Svelte, Astro, HTML/SVG tagged templates, and CSS-in-JS.
- `catalog.json` selects languages by repository, module, path or scope. It owns
  stable IDs, aliases, variants, embedding policy, and reviewed grammar patches.
  Required supported dependencies are discovered transitively. Document and
  component languages have an explicit lazy policy.
- `sources.json` is generated. It locks one commit per repository, Linguist's
  submodule commits, original file URLs and hashes, normalized hashes, and
  archived license notices. Maintainers do not hand-edit pins or hashes.

VS Code discovery reads `contributes.grammars` without executing package scripts.
Linguist discovery follows `.gitmodules` and the aggregate commit's gitlinks;
individual specialists are not tracked at their own branch heads. JSON, YAML,
XML PLIST, and data-only CSON are converted to TextMate JSON. Tree-sitter grammar
references and Sublime `.sublime-syntax` state machines are not converted.

```sh
node scripts/prepare-grammar-update.mjs --output-dir /tmp/ferriki-candidate
node scripts/validate-grammar-candidate.mjs /tmp/ferriki-candidate
node scripts/apply-grammar-update.mjs /tmp/ferriki-candidate
pnpm -C node run test:ferriki-compat:core
```

Preparation refuses an existing output directory and leaves the current catalog
alone. `report.json` lists changed files and notices, discovered candidates,
external scope references, and patches already fixed upstream. A source move,
ambiguous selection, invalid format, or mismatched patch fails for review.

`prepare-grammar-update.mjs --locked` reproduces the accepted repository
snapshots. `sync-grammars.mjs` reproduces the normalized files from locked source
URLs; `sync-grammars.mjs --check` verifies committed data without network access.
Repository lookups use `GH_TOKEN`/`GITHUB_TOKEN` or the authenticated GitHub CLI.

The weekly/manual [**Grammar updates** workflow](../../.github/workflows/grammar-updates.yml)
prepares, validates, applies, and tests a candidate before creating or updating
one draft PR on `codex/grammar-updates`. Reports and candidate files are retained
as workflow artifacts for 14 days. See the [maintainer procedure](../../docs/grammars.md#automatic-update-pull-requests)
for activation, manual runs, review, and failure recovery.

Each locked grammar records its role, source selector provenance, repository
and module pin, original and normalized SHA-256, license identifier, pinned
license URL, and archived notice addressed by SHA-256. Optional `patch_file`
points at reviewed JSON-pointer replacements with a reason and expected old
value. `external_embedded_scopes` records deliberate exclusions, such as the
unlicensed GLSL embedding formerly used by C++.

See [the grammar guide](../../docs/grammars.md) and
[ADR 0020](../../adr/0020-curated-grammar-sources.md).
