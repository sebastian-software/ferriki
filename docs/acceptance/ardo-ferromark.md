# Ardo and Ferromark production acceptance

This acceptance belongs to Ferriki issue #14. The homepage fixture in
`homepage/app/routes/evidence/compatibility.mdx` is compiled as part of the real
Ardo site build, and `homepage/scripts/verify-ardo-acceptance.mjs` checks the
generated HTML. The fixture covers TypeScript, TSX, HTML with embedded CSS and
JavaScript, an unknown-language fallback, dual themes, title and label metadata,
line numbers, and a highlighted line.

## Registry gate

Run the production acceptance only after Ardo 5, Ferromark 3.1.0, and
`@ferriki/core` 0.10.0 are published. Regenerate `homepage/pnpm-lock.yaml` from
the registry and keep the resulting registry resolutions and integrity values.
Then run `pnpm install --frozen-lockfile` and `pnpm run build` from `homepage/`.
Do not use local tarball paths, workspace overrides, or hand-authored lock
entries as evidence for this gate.

Until the candidate packages are published, the current main lockfile still
resolves Ardo 4.2.0 while the homepage manifest requests Ardo 5. A frozen
install and candidate site build must wait for real registry resolutions; do
not edit the lockfile to imitate them.

## Preparation evidence (2026-10-03)

At Ferriki main `e0e05c8f378e5afffa95159a6125c11044aae163`, the four-fence
corpus built successfully against the unchanged main lockfile and Ardo 4.2.0.
The run used `pnpm install --frozen-lockfile --store-dir
/private/tmp/ferriki-14-pnpm-store` followed by `pnpm build` on macOS arm64
with Node 24.21.0 and pnpm 10.34.5. The lockfile SHA-256 was
`1e00152c77342c2f6a41b77fc58f5d9a779bb63d79b91d6bb1f3d31b7a393a96`; the
fixture corpus SHA-256 was
`be71440bb815f448cacd039ff2909139f6b2099b7036d82fc321105122a00d04`. The
receipt and generated HTML are saved locally at
`/private/tmp/ferriki-14-baseline-evidence-20261003/receipt.json` and
`/private/tmp/ferriki-14-baseline-evidence-20261003/compatibility.html`.
This is baseline correctness evidence only; no timing or memory claim was
measured.

A separate local native-addon JSX-to-React SSR proof passed, including negative
checks for a missing title, syntax-highlighting class, and line annotation. It
does not exercise the published Ardo 5 integration or satisfy the registry
gate. The candidate production integration remains blocked until the required
packages are available and the lockfile can be regenerated from the registry.

## Output and failure review

Save the generated `homepage/build/client/evidence/compatibility/index.html` for
both the baseline and candidate builds. Compare the four titled code blocks,
record intentional markup or token differences, and inspect that code remains
escaped and metadata stays attached to the correct block. The acceptance
assertions check structure and source preservation; they do not declare the two
HTML outputs byte-identical.

The homepage build covers a missing-language fallback. The separate adapter
tests must cover a forced highlighting error falling back to plain text, a
throwing render callback, and a subsequent successful compile to prove the
failure leaves no stale state. Keep those checks in the Ardo and Ferromark
integration releases rather than simulating them in the homepage.

## Rollback acceptance

If production adoption must be rolled back, revert the complete migration
commit that changed the homepage package manifest, real registry lockfile,
fixture, and native-output verifier. Restore the previous Ardo 4.2.0 package
resolution with its matching checked-in lockfile; do not downgrade only Ardo
while leaving the Ardo 5 output assertions enabled. From `homepage/`, run
`pnpm install --frozen-lockfile` and the normal `pnpm run build`. The build must
pass the current benchmark provenance and internal-link checks as well as the
site build. Save the reverted commit, package versions, lockfile hash, exact
commands, and build result as rollback evidence. This rollback check has not
been run.

## Build-time and memory comparison

Compare the current Ardo 4.2.0 homepage baseline with the published Ardo 5 and
Ferromark 3 candidate from the same Ferriki source commit containing the
fixture. Keep the homepage source and corpus identical; vary only the published
dependency resolution and its real lockfile. Record exact package versions,
lockfile hashes, Ferriki commit and dirty state, Node and pnpm versions, OS and
architecture, CPU, cache state, and the exact command.

Use the same machine and build command for both lanes. For the warm-cache lane,
run one unmeasured warm-up, then alternate paired builds with `homepage/build`
removed between runs. Keep raw elapsed-time and peak-resident-memory readings,
report the median and spread, and repeat until the result is stable. Report a
cold Ferriki asset cache as a separate first-use lane, using a fresh cache
directory for each candidate run and including the downloads. Keep dependency
installation outside the build measurement and record it as a separate step.
On macOS, `/usr/bin/time -l` reports elapsed time and maximum resident set size;
on Linux, `/usr/bin/time -v` reports elapsed time and maximum resident set size.
Do not compare readings across operating systems.

No build-time or memory claim is made until both registry lanes have completed
with the same corpus and environment and the raw measurements are retained.
