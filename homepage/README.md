# Homepage checks

From the repository root, prepare the native package and its local asset cache,
install the homepage dependencies, install Playwright's browser, then run the
full homepage verification:

```sh
pnpm --dir node install --frozen-lockfile
pnpm --dir node run build:compat
pnpm --dir node run build:native
pnpm --dir homepage install --frozen-lockfile
pnpm --dir homepage exec playwright install chromium
pnpm --dir homepage verify
```

The homepage uses Ardo 6 and the shared `ferramenta-family/monografie` page
system (Ferramenta ADR-0012): every page wears its header and footer and reads
on its paper, and the documentation uses its documentation pages
(`monografie-docs.css` and the Ardo adapter `monografie-ardo.css`) for the
reading layout, navigation, code panels, and evidence tables. The one site
stylesheet, `app/components/homepage-specimens.css`, holds the homepage's own
specimens and two temporary code-contrast fits for the documentation;
`scripts/verify-build.mjs` fails on a selector there without an `fk-` class, on
any rendered `ferra-` or `fam-` class other than Ferra's identity assets, and on
an import of the Ferra or original stylesheets. Changes to shared presentation belong in
Ferramenta, with a kit specimen, before updating the pinned package commit here.

Ardo's build-time highlighting uses the default immutable asset service. No
legacy `FERRIKI_ASSETS_BASE_URL` override is needed. `scripts/write-site-data.mjs`
mirrors the release version, the minimum Rust and Node.js versions, the theme
count, verified evidence reports, and lifecycle illustration into the
documentation package before development, type checking, and builds. Their
original repository files remain the source of truth.

Every specimen on the homepage is real output of the published npm packages.
`pnpm homepage-samples:write` installs `@ferriki/core` and `@ferriki/vite` at
the versions in `node/ferriki/package.json` and `node/vite/package.json` into a
temporary directory, renders the specimens, and writes
`app/data/homepage-samples.json` with those versions in `renderedWith`; the
page credits them. Run it again after a release. `pnpm homepage-samples:check`
renders again with the recorded versions and fails when the file drifted. The
figures beside the specimens come from the verified reports in
`app/data/evidence/`, through `app/components/homepage-data.ts`, which fails the
build when a report no longer supports what the copy says.

`verify` checks that the committed homepage samples still match the published
packages, checks the shape of the committed footprint record, executes the marked guide examples against
packed Ferriki packages using the seeded cache, checks links and fragments in
the built site, and runs responsive layout, axe accessibility, and keyboard
navigation checks in Chromium at eight widths from 320 to 1440 pixels. The homepage CI workflow also runs the packed
Vite adapter consumer check.

The [Ferriki vs Prism page](app/routes/guide/ferriki-vs-prism.mdx) renders the
fixed inputs in `scripts/prism-inputs.json`. The native and Prism HTML, selected
token classifications, versions, and build identities are captured in
`app/data/prism-comparison.json`. The renderer checks source preservation for
both highlighters and exact Ferriki/Shiki WebAssembly HTML parity. These are
quality examples, separate from the retained performance measurements. Prism’s
token colors use the same palette through generated presentation attributes;
the token stream and source are unchanged.

After editing the inputs, format them before generating the capture so its
fixture checksum describes the committed file:

```sh
pnpm --dir homepage exec oxfmt --write scripts/prism-inputs.json
pnpm --dir homepage prism-sample:write
pnpm --dir homepage exec oxfmt --write app/data/prism-comparison.json
pnpm --dir homepage prism-sample:check
```

The browser checks exercise every example, including Prism's explicit
unsupported Astro state, with unchanged source in both panels and axe checks
for each selected state.

The footprint page states sizes measured on linux-x64-gnu. After a change to
the Rust sources or the npm package, commit it, run `build:native`, then
`pnpm --dir homepage footprint:write` on that platform and commit the record.
