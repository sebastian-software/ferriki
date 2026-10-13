# ADR 0020: Own a Curated Standard Grammar Catalog

## Status

Accepted

Last updated: 2026-10-13

## Context

The native runtime and binary asset format are already independent of Shiki.
The language catalog still came from Shiki's generated modules, including its
selection, metadata, and rewritten regex patterns. Issue #152 asks for owned
sources, useful defaults, and an extension path for languages outside that set.

CDN loading means reducing the catalog does not reduce a consumer's downloaded
payloads. The reason to curate is maintenance, provenance, and predictable
language coverage.

## Decision

- Ferriki owns the repository configuration in
  [`assets/grammars/repositories.json`](../assets/grammars/repositories.json)
  and language selectors in `catalog.json`. `sources.json` is a generated lock:
  one resolved commit per configured repository, the collection's submodule
  pins, and each original and normalized file's SHA-256 and license notice.
- Prefer maintained collections. The initial configuration uses VS Code and
  GitHub Linguist. Specialist grammars follow Linguist's aggregate pin rather
  than independent repository heads. Six justified exceptions provide Angular,
  Vue, Svelte, Astro, HTML/SVG tagged-template injections, and CSS-in-JS.
- Select common programming, web, document, configuration, and infrastructure
  languages by practical coverage. Primary languages are configured explicitly;
  supported required dependencies are discovered transitively. This is a
  maintained selection, not a popularity ranking or a promise to reproduce
  Shiki's entire catalog.
- Required dependencies are included transitively. Lazy embeddings name only
  languages in the standard catalog; applications explicitly load these or
  register external grammars. An optional GLSL embedding in C++ and its macro
  grammar is excluded because its previous source has no license notice.
  It remains an explicitly recorded external scope, `source.glsl`.
- JavaScript, TypeScript, JSX, and TSX load the standard HTML/SVG and CSS-in-JS
  injections automatically. Their dependency closure supplies HTML, stylesheet
  declarations, and template interpolation without extra consumer configuration.
- `prepare-grammar-update.mjs` resolves each repository ref once and creates a
  separate candidate and change report. VS Code discovery reads
  `contributes.grammars`; Linguist discovery reads its pinned aggregate tree and
  `.gitmodules`. It converts JSON, YAML, XML PLIST, and data-only CSON to JSON. YAML
  variables expand with cycle checks. Imports have an 8 MiB limit and a
  60-second request timeout. No Shiki build or package is needed for sync.
- `--locked` reproduces accepted snapshots without resolving moving refs.
  Native candidate validation precedes application. The weekly/manual Grammar
  updates workflow runs the compatibility gate and creates or refreshes one
  draft update PR on its dedicated `codex/grammar-updates` branch. A manual
  commit on that branch stops automatic replacement; concurrent changes are
  protected by a push lease. Merging and releasing remain maintainer actions.
  Passing candidates publish source and compiled objects to Bunny Storage before
  the metadata PR is opened. Normalized diffs remain workflow artifacts.
  Commit and payload hashes are generated, never maintained by hand. Newly
  discovered primary languages appear in the report instead of silently
  becoming defaults.
- Sublime's `.sublime-syntax` context-stack format and Tree-sitter descriptors
  are outside this TextMate converter. Supporting either needs a separate
  behavior-preserving port, not a YAML or JSON format conversion.
- Regex patterns are retained as authored except for narrow, reviewed grammar
  adaptations, such as Lit's SVG tag, interpolation in quoted attributes, and
  whitespace in Styled JSX templates.
  Local adaptations are small patches with
  a reason and an expected old value. Changes to that old value
  fail the sync for review. Advisory backtracking diagnostics remain the
  separate contract described in ADR 0014 and issue #153.
- The npm package provides `ferriki grammar fetch` for local files, URLs, and
  commit-pinned GitHub files containing JSON TextMate grammars. It validates
  registration and compilation with the native runtime, writes a reusable
  registration plus provenance lock, and supports an expected SHA-256.
  It does not execute extension code or install a VS Code extension.
- Users load the result through existing `langs`/`loadLanguage` registrations.
  Rust consumers use `register_language` or `register_language_json`.
  External dependencies and injections are explicit registrations.
- Source snapshots and generated files are materialized locally and ignored by
  Git. `assets/catalog.json` owns the compiled catalog metadata and theme source
  hashes; `sources.json` owns grammar source hashes. Bunny stores original,
  normalized, and compiled grammar bytes under `<id>/<sha256>` and themes under
  `themes/<id>/<sha256>`. ADR 0013 defines publication and legacy URL handling.
  The compatibility mirrors remain immutable test references.

## Consequences

- Core and backend languages work through the existing lazy CDN path, with
  aliases and required embedded grammars. First use still needs network access
  or a prepared cache (ADR 0013).
- Languages removed from the former catalog need external registration.
  The initial catalog transition ships in 1.1.0 under the one-time exception
  below. Removed IDs remain usable through external registration; adding
  standard languages is additive. Future removals of documented standard IDs
  or aliases require the normal major-release process.
- Shiki's full/web bundle-count snapshots no longer describe the product.
  They are explicitly excluded in the compatibility manifest. The release
  gate instead checks source hashes, catalog coverage, native compilation of
  every standard grammar, and external import behavior, while retaining the
  supported Shiki HTML fixtures.
- Historical loaded-language metadata expectations use reviewed Ferriki
  fixtures in the compatibility harness. The adapter changes only ID/alias
  list or count assertions; every HTML and theme snapshot remains unchanged.
- Immutable YAML color/merging fixtures retain their pinned grammar data in
  the native compatibility adapter. Current corpus comparisons register the
  same current grammar data in each engine; catalog updates do not silently
  compare different grammar versions.
- Native and WASM TextMate output agreement remains mandatory. The current
  VS Code YAML grammar uses a multi-codepoint hex escape that Shiki's
  JavaScript converter cannot translate. Only that precise conversion failure
  is reported as unsupported; it produces no timings or full-corpus JS totals.
  Unrelated conversion errors and HTML differences still fail validation.
- The dated TIOBE benchmark keeps its wider corpus by registering nonstandard
  grammars from its development-only reference package. Those test inputs do
  not enter the published standard catalog.
- The public CLI intentionally accepts JSON only. Users convert other formats
  before importing. Repository discovery and format conversion are provided by
  the maintainer pipeline.

## Release scope

Ship this initial catalog transition as Ferriki 1.1.0. This is a one-time
exception during the initial 1.x adoption period, limited to the standard
grammar selection and its IDs and aliases. It establishes the owned catalog
now rather than retaining the Shiki-derived selection through another major
cycle. Applications using a removed ID must register that grammar externally;
the [grammar guide](../docs/grammars.md) documents this migration. Existing
loading and rendering APIs and the theme catalog retain their contracts.
Future catalog removals and changes to other stable APIs follow the normal
semver policy; the published Rust semver gate remains in force.

The follow-up commit carries `Release-As: 1.1.0`; the PR's commit override
carries the same target for squash merges. This overrides the earlier major
marker for this transition without rewriting branch history or changing
global Release Please versioning. Release Please owns the synchronized
package and crate version updates.

## History

- 2026-10-12: Accepted and implemented for #152: repository snapshots from two
  collections and five justified exceptions, generated locks, candidate/replay
  commands, dependency closure, a weekly review workflow, and a native-validated
  external JSON importer.
- 2026-10-12: Added Zig, Elixir with EEx support, Gleam, Luau, Nix, and GDScript
  through the existing Linguist collection. Retained upstream TextMate formats
  and Apache-2.0 notices without adding source exceptions or syntax converters.
- 2026-10-12: Added Handlebars, Liquid, and Glimmer through the existing
  collections. Added the maintained Styled Components source for CSS-in-JS,
  automatic JavaScript/TypeScript/JSX/TSX injections, Lit SVG templates, and
  frontend behavior checks against the WASM reference.
- 2026-10-12: Documented maintainer activation, local updates, and review. The
  scheduled workflow refreshes one draft PR, preserves manual branch changes,
  and validates the complete candidate before publishing an update.
- 2026-10-13: Integrated with the released 1.0 baseline. Renumbered this record
  to 0020 because 0019 records Shadow DOM presentation, and classified the
  removal of standard IDs and aliases as a major-version transition.
- 2026-10-13: Targets 1.1.0 with a one-time exception for the initial standard
  catalog transition. Retains external-registration migration guidance and
  the normal guarantees for future catalog changes, stable APIs, and Rust.

- 2026-10-13: Keeps only selection, provenance, patches, notices, and catalog
  metadata in Git. Publishes immutable language/theme hash objects to Bunny,
  with normalized update diffs retained as review artifacts.
