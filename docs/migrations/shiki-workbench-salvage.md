# Shiki workbench salvage audit

Date: 2026-07-13

## Source

The former local `shiki-fork` workbench ended at commit `aa27f4ea` on
`codex/engine-ferroni`. Its branch contains 174 commits not present on the
current Shiki upstream branch and diverged from upstream at
`213f19bf464423795f20ce51fe73fe7bb5d45e00`.

The workbench was useful migration scaffolding, not the intended long-term
product repository. This document records how its unique work maps to the
current Ferriki and Ferroni repositories before the workbench is archived.

## Work already represented in Ferriki

- The Rust-first product boundary is implemented by `crates/ferriki-core` and
  the Node-facing package under `node/ferriki`.
- Ferriki-specific compatibility glue lives outside the upstream mirror under
  `node/compat`, matching the boundary developed in the workbench.
- The strict Shiki mirror policy and single-version compatibility baseline are
  preserved by ADR 0003 and the current compatibility tooling.
- The decision to keep Ferroni external is preserved by ADR 0005; the
  transitional vendored `crates/ferroni` workbench path is intentionally gone.
- Native grammar registration, themes, rendering, state handling, asset
  generation, and lazy Shiki-derived assets have continued in the standalone
  repository beyond the workbench implementation.

## Work intentionally not transferred

- Direct edits to Shiki-owned packages, snapshots, and fixtures. The current
  mirror must stay mechanically attributable to an approved upstream release.
- The old Shiki monorepo package topology and engine-selection infrastructure.
  Ferriki exposes one native runtime and one Node integration surface.
- Vendored Ferroni source and the early `engine-ferroni` package. Ferroni now
  has its own repository, release history, compatibility suite, and scanner
  API.
- Framework adapters and unrelated Shiki packages that sit above the core
  highlighting contract.
- Workbench-only export scripts. Their target repository already exists and
  the exported boundaries are now enforced by the repository layout and ADRs.

## Historical work categories

The 174 commits fall into four useful groups:

1. Ferroni scanner integration and early native performance experiments.
2. Ferriki grammar, theme, rendering, state, and parity implementation.
3. Compatibility harness, upstream-test restoration, and repository-boundary
   design.
4. Transitional export and normalization tooling used to cut the standalone
   Ferriki repository.

The first two groups have evolved in the standalone products. The third group
is represented by the current mirror/harness policy. The fourth completed its
purpose during repository extraction.

## Conclusion

No workbench source file should be copied wholesale into the current product:
doing so would reintroduce the fork-shaped structure that the extraction was
designed to remove. The durable value is the decision record above and the
full archived Git history of the workbench. Future compatibility changes must
be implemented in Ferriki-owned paths and verified against the strict upstream
mirror.
