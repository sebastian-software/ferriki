# Ferriki release checklist

This checklist applies to every pre-1.0 release candidate and to the final
1.0 go/no-go. A green Release workflow is not by itself evidence that npm was
published: the release summary must say whether it created a release, skipped
publication, or published successfully.

## Release authority

Ferriki intentionally uses a Node-owned Release Please component at
`node/ferriki`. The repository root is a virtual Cargo workspace and all Rust
members are implementation crates with `publish = false`, so the standards
Rust+Node template cannot be applied until Ferriki has a real, publishable root
Cargo product. The npm sidecars remain part of the same product and are updated
through typed Release Please `extra-files` entries, including the pnpm lockfile.

## Before dispatch

- [ ] The release PR is merged to `main` and the normal CI matrix is green.
- [ ] The package version, changelog, release-please manifest, and intended npm
      dist-tag agree.
- [ ] The generated release PR updates the main package, every platform
      manifest, and every platform `optionalDependency`; no workflow step is
      needed to repair versions after generation.
- [ ] `pnpm run test:ferriki-compat:core`, `pnpm run lint`, and
      `pnpm run typecheck` pass from a clean checkout.
- [ ] The action SHAs in `.github/workflows/publish.yml` were reviewed and its
      target runners are available; each native matrix job has a timeout.
- [ ] npm trusted publishing/provenance is enabled for the Ferriki package.

## Release-candidate run

- [ ] Run the normal publish workflow first; use `force-publish` only for an
      intentional backfill of the manifest version. Use the `next` dist-tag for
      a release candidate and record the manual go/no-go decision.
- [ ] Confirm every documented target build completes and every platform
      package has the same version as the main package.
- [ ] Confirm the workflow summary distinguishes “no release” from
      “published” and records failed or skipped target jobs.
- [ ] Confirm the GitHub release and npm metadata show the same version and
      dist-tag.
- [ ] Install the published tarball in a clean consumer and run the public
      `ferriki` plus `ferriki/native` smoke checks. The workflow also performs
      this install check against the public registry after publication.
- [ ] Verify npm provenance on the main package and all platform packages.

## Go/no-go and rollback

- [ ] An accountable maintainer records the manual 1.0 go/no-go decision in the
      release discussion.
- [ ] If publication is incomplete, stop promotion and document the failed
      target and recovery command; do not call the run successful.
- [ ] If a bad version is published, deprecate it with a migration message and
      publish a corrected version. Do not reuse the version number.
- [ ] Record the post-publish smoke result, GitHub release URL, npm version,
      provenance result, and any follow-up issue.
