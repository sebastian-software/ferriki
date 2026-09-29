# Ferriki release checklist

This checklist applies to every pre-1.0 release candidate and to the final
1.0 go/no-go. A green Release workflow is not by itself evidence that npm was
published: the release summary must say whether it created a release, skipped
publication, or published successfully.

## Release authority

Ferriki follows the organization's release blueprint (ADR 0012, section
"Release"). The repository root is the `ferriki` Cargo package with
`release-type: rust`, so one Release Please pull request versions the root
package, every workspace member, their path-dependency requirements and
`Cargo.lock`. The npm package, its platform sidecars and the pnpm lockfile
specifiers follow through typed `extra-files`. Merging the release pull request
tags `v<version>` and `publish.yml` publishes npm and the crates
`ferriki-textmate`, `ferriki-asset-gen` and `ferriki` from that release. Both
registries use Trusted Publishing.

Before 1.0, `bump-minor-pre-major` keeps a breaking change on a minor bump
(`0.4.0` → `0.5.0`) instead of cutting `1.0.0` implicitly. The 1.0 release is a
deliberate act: it needs the go/no-go below and a `Release-As: 1.0.0` commit
footer.

## One-time crates.io bootstrap

crates.io offers Trusted Publishing only for crates that already exist. The
first Rust release is therefore published once by hand; every later release is
automatic.

1. Merge the release pull request. The `Publish to crates.io` job of that run
   is expected to fail once, because the crates do not exist yet. The npm jobs
   are independent and publish as usual.
2. Create a crates.io API token with the `publish-new` scope, then publish the
   three crates from the release tag. Cargo publishes them in dependency order
   and verifies `ferriki` against the two freshly packaged crates:

   ```sh
   git fetch --tags origin
   git checkout v<version>
   cargo login
   cargo publish --locked -p ferriki-textmate -p ferriki-asset-gen -p ferriki
   cargo logout
   ```

   Revoke the token afterwards; it is not needed again.
3. For each of the three crates, open *Settings → Trusted Publishing* on
   crates.io and add a GitHub publisher: owner `sebastian-software`,
   repository `ferriki`, workflow `publish.yml`, no environment.
4. Re-run the failed `Publish to crates.io` job. It skips versions that are
   already in the index, so it turns green without publishing twice.

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
- [ ] crates.io Trusted Publishing is configured for `ferriki-textmate`,
      `ferriki-asset-gen` and `ferriki` (after the one-time bootstrap above).

## Release-candidate run

- [ ] Run the normal publish workflow first; use `force-publish` only for an
      intentional backfill of the manifest version. Use the `next` dist-tag for
      a release candidate and record the manual go/no-go decision.
- [ ] Confirm every documented target build completes and every platform
      package has the same version as the main package.
- [ ] Confirm the workflow summary distinguishes “no release” from
      “published” and records failed or skipped target jobs.
- [ ] Confirm the GitHub release and npm metadata show the same version and
      dist-tag, and that crates.io lists the same version for all three crates.
- [ ] Install the published tarball in a clean consumer and run the public
      `@ferriki/core` smoke checks. The workflow also performs
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
