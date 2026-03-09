# Ferriki Repo Transition Plan

Goal: move Ferriki into `git@github.com:sebastian-software/ferriki.git` as a standalone project with fresh product history, while preserving a strict, reproducible compatibility pipeline against the official Shiki release-tag test corpus.

## Phase 0 - Freeze the boundary

- [x] Define the final Ferriki-owned path set to export:
  - [x] `crates/ferriki-core`
  - [x] `node/ferriki`
  - [x] `node/compat/harness`
  - [x] selected `node/scripts/`
  - [x] selected planning docs
- [x] Explicitly mark legacy paths that must not be exported.
- [x] Decide which Ferriki-owned paths are worth carrying filtered history for.
- [ ] Write down the active Shiki compatibility baseline policy:
  - [ ] exactly one approved upstream tag at a time
  - [ ] release-tag based, not `main` based
  - [ ] no direct edits in the mirrored upstream area

Boundary source of truth:

- `plans/ferriki-repo-export-boundary.json`

First-pass export set summary:

- export:
  - `crates/ferriki-core`
  - `node/ferriki`
  - `node/compat/harness`
  - selected root Rust config plus selected `node/` workspace config
  - selected `node/scripts/`
  - planning docs needed to preserve transition rationale
- import fresh in new repo:
  - `node/compat/upstream/shiki`
- do not export:
  - `packages/**`
  - broad Shiki docs and blog content
  - generated Node workspace artifacts outside the supported package surface
  - vendored or placeholder Ferroni paths
  - workbench-only diagnostics and engine-js reporting artifacts

Important normalization rule:

 - exported root config files such as `Cargo.toml` and the `node/` workspace configs are inputs to the new repo, not guaranteed final forms
- during cutover they must be reduced so the new repository no longer references removed `packages/*` paths

Exit criteria:

- there is a written export boundary
- there is a written compatibility baseline policy

## Phase 1 - Prepare the workbench repo for export

- [ ] Move remaining Ferriki-owned logic into final-looking target paths.
- [ ] Minimize dependence on legacy `packages/*` paths for product runtime.
- [ ] Keep compatibility glue isolated from upstream-derived test content.
- [ ] Remove or quarantine branch-local test drift from official Shiki-derived files.

Exit criteria:

- Ferriki-owned code already resembles the final repository layout
- upstream-derived content and Ferriki-owned glue are clearly separated

## Phase 2 - Define the upstream import contract

- [ ] Enumerate the exact upstream Shiki paths that must be mirrored.
- [ ] Include all dependent fixtures, snapshots, themes, grammars, and helpers required by those tests.
- [ ] Create a metadata format for imported compatibility baselines, for example `node/compat/upstream/shiki/.source.json`.
- [ ] Decide how the harness maps upstream imports onto `node/ferriki`.

Exit criteria:

- the import path set is complete enough to run the mirrored suite
- the source metadata format is fixed

## Phase 3 - Build the sync tooling

- [ ] Add a script to import the approved Shiki release tag into `node/compat/upstream/shiki`.
- [ ] Make the script record:
  - [ ] upstream tag
  - [ ] upstream commit SHA
  - [ ] import date
  - [ ] imported path set
- [ ] Add a validation mode that checks whether the mirror has drifted locally.
- [ ] Keep the import process mechanical and repeatable.

Exit criteria:

- the compatibility mirror can be refreshed from a single approved upstream tag
- the repository can prove the mirror has not been hand-edited

## Phase 4 - Export into the new Ferriki repository

- [ ] Create `git@github.com:sebastian-software/ferriki.git`.
- [x] Export tooling exists for the Ferriki-owned path boundary.
- [ ] Export Ferriki-owned paths from the workbench repo into the new repository.
- [ ] Preserve filtered history only for the selected Ferriki-owned paths.
- [ ] Import the Shiki compatibility mirror fresh into `node/compat/upstream/shiki`.
- [ ] Bring over the compatibility harness and wire it to the mirrored suite.

Current export tools:

- `node ./node/scripts/export-ferriki-repo.mjs --target-dir <path>`
- reads `plans/ferriki-repo-export-boundary.json`
- copies the approved first-pass export set into a target directory outside the workbench repo
- writes `.ferriki-export.json` metadata into the target by default
- follow with:
  - `node ./node/scripts/normalize-exported-ferriki-repo.mjs --target-dir <path>`
  - this rewrites exported `node/` workspace files and harness files away from workbench-specific `packages/*` assumptions

Exit criteria:

- the new repository contains only the intended Ferriki-owned paths plus the upstream compatibility mirror
- the final layout no longer depends on the old Shiki monorepo shape

## Phase 5 - Re-establish validation in the new repo

- [ ] Restore native build commands for `node/ferriki`.
- [ ] Restore Rust crate test commands for `crates/ferriki-core`.
- [ ] Restore the mirrored Shiki compatibility suite against the Ferriki harness.
- [ ] Add a dedicated command for updating the approved Shiki baseline.

Exit criteria:

- the new repository can build, test, and run the compatibility suite on its own
- the Shiki baseline update path is documented and executable

## Phase 6 - Add CI policy gates

- [ ] Add a job that runs the Ferriki build and core tests.
- [ ] Add a job that runs the mirrored Shiki compatibility suite.
- [ ] Add a job that fails if mirrored upstream files were edited directly.
- [ ] Expose the currently verified Shiki tag in CI output or release metadata.
- [ ] Optionally add a non-blocking watcher against Shiki `main`.

Exit criteria:

- compatibility provenance is enforced automatically
- the public compatibility claim is backed by CI

## Phase 7 - Cut over documentation and release identity

- [ ] Update README and docs for the new repository location and product framing.
- [ ] State the verified Shiki baseline explicitly, for example `verified against shiki@v4.0.1`.
- [ ] Document how to update the compatibility mirror to a newer Shiki tag.
- [ ] Document the rule that upstream mirror files are not edited locally.

Exit criteria:

- contributors can understand the repo split and compatibility policy without prior context
- the public "Shiki v4 compatible" claim is grounded in a specific verified release tag

## Cross-Cutting Rules

- [ ] `ferroni` remains an external dependency.
- [ ] Upstream compatibility content is mirrored, not adapted in place.
- [ ] Ferriki-specific glue lives only outside `node/compat/upstream/shiki`.
- [ ] Only one approved Shiki release tag is active at a time.
- [ ] `main` may be observed, but it does not define compatibility policy.

## Immediate Next Work Items

- [x] Restore any branch-local Shiki test files to the official upstream state before export.
- [x] Carve out `node/compat/harness` as a first-class path in the current workbench repo.
- [x] Prototype the Shiki-tag import script against the currently approved baseline.
- [x] Decide the exact filtered-history export set for the first migration pass.
