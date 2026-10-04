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
`Cargo.lock`. The npm package, its platform sidecars, `@ferriki/vite` and the
pnpm lockfile specifiers follow through typed `extra-files`. The Vite
integration shares the product version and depends on the matching
`@ferriki/core` version. Typed TOML `extra-files` also update only the local
crate versions in the separate `fuzz/Cargo.lock`; registry dependencies and
the private fuzz package version stay pinned. Merging the release pull request
tags `v<version>` and `publish.yml` publishes the npm packages and the crates
`ferriki-textmate`, `ferriki-asset-gen` and `ferriki` from that release. Product releases use
Trusted Publishing in both registries.

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

3. For each of the three crates, open _Settings → Trusted Publishing_ on
   crates.io and add a GitHub publisher: owner `sebastian-software`,
   repository `ferriki`, workflow `publish.yml`, no environment.
4. Re-run the failed `Publish to crates.io` job. It skips versions that are
   already in the index, so it turns green without publishing twice.

## One-time `@ferriki/vite` npm bootstrap

npm requires a package to exist before its Trusted Publisher can be configured.
Before the first product release that includes the Vite integration, seed the
package name with a prerelease that cannot occupy a product version or the
`latest`/`next` tags. This is a one-time registry write; do not perform it as
part of release verification.

1. Confirm the `@ferriki/core` version in `node/vite/package.json` is already
   public. Create a temporary npm publish token and keep its config outside the
   checkout. From the repository root, pack with pnpm so catalog dependencies
   become concrete, then publish a temporary copy with only its version
   changed:

   ```sh
   bootstrap_dir="$(mktemp -d)"
   trap 'rm -rf "$bootstrap_dir"' EXIT
   export npm_config_userconfig="$bootstrap_dir/npmrc"
   pnpm login --registry https://registry.npmjs.org
   pnpm --dir node/vite pack --pack-destination "$bootstrap_dir"
   tarball="$(find "$bootstrap_dir" -maxdepth 1 -name 'ferriki-vite-*.tgz' -print -quit)"
   test -n "$tarball"
   mkdir "$bootstrap_dir/package"
   tar -xzf "$tarball" --strip-components=1 -C "$bootstrap_dir/package"
   npm --prefix "$bootstrap_dir/package" pkg set version=0.0.0-bootstrap.0
   npm publish "$bootstrap_dir/package" --access public --tag bootstrap
   pnpm logout --registry https://registry.npmjs.org
   ```

   Keep the seed on the `bootstrap` dist-tag. Do not publish it with `latest`
   or `next`, and do not edit the checkout's package manifest.

2. In npm package settings, configure a Trusted Publisher for owner
   `sebastian-software`, repository `ferriki`, workflow `publish.yml`, and no
   GitHub environment. Enable direct publishing with `npm publish` in its
   allowed actions; the workflow publishes directly rather than staging a
   release. Revoke the temporary token and remove the temporary npm config
   after the seed publish.
3. The first product release then publishes its distinct product version from
   `publish.yml` with OIDC and npm provenance. The release verifier checks that
   version, not the bootstrap prerelease.

## Before dispatch

- [ ] The release PR is merged to `main` and the normal CI matrix is green.
- [ ] The package version, changelog, release-please manifest, and intended npm
      dist-tag agree.
- [ ] The generated release PR updates the main package, every platform
      manifest and `optionalDependency`, plus `@ferriki/vite`, its matching
      `@ferriki/core` dependency, and the Vite importer in `pnpm-lock.yaml`; no
      workflow step is needed to repair versions after generation.
- [ ] `fuzz/Cargo.lock` carries the product version for `ferriki-textmate` and
      `ferriki-asset-gen`. Using the fuzz workflow's pinned nightly,
      `cargo fetch --manifest-path fuzz/Cargo.toml --locked` and all four fuzz
      smoke jobs pass on the release PR without rewriting either lockfile.
- [ ] `pnpm run test:ferriki-compat:core`, `pnpm run lint`, and
      `pnpm run typecheck` pass from a clean checkout.
- [ ] The action SHAs in `.github/workflows/publish.yml` were reviewed and its
      target runners are available; each native matrix job has a timeout.
- [ ] npm Trusted Publishing is enabled for Ferriki and `@ferriki/vite` after
      the one-time Vite bootstrap above.
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
- [ ] Compare the "Native addon sizes" table in the release summary with the
      previous release's table, or with the previous sidecars' unpacked size
      on npm where that release has none. Explain in the release discussion
      every sidecar whose `ferriki.node` grew by more than a few percent.
- [ ] Confirm the GitHub release and npm metadata show the same version and
      dist-tag, and that crates.io lists the same version for all three crates.
- [ ] Install the published tarball in a clean consumer and run the public
      `@ferriki/core` smoke checks. The workflow also performs
      this install check against the public registry after publication: it
      confirms the packaged release manifest is pinned to the release commit,
      highlights from an empty cache through the CDN, and checks that
      `assets.ferriki.dev` serves every pinned payload with its SHA-256
      (ADR 0013).
- [ ] Confirm the public `@ferriki/vite` version and provenance, then import it
      with its Vite peer in a clean consumer. Before any registry publish, the
      workflow also tests the packed plugin against Vite 8.0.0 and the current
      Vite 8 release.
- [ ] Verify npm provenance on the main package, Vite integration, and all
      platform packages.

## Go/no-go and rollback

- [ ] An accountable maintainer records the manual 1.0 go/no-go decision in the
      release discussion.
- [ ] If publication is incomplete, stop promotion and document the failed
      target and recovery command; do not call the run successful.
- [ ] If a bad version is published, deprecate it with a migration message and
      publish a corrected version. Do not reuse the version number.
- [ ] Record the post-publish smoke result, GitHub release URL, npm version,
      provenance result, and any follow-up issue.
