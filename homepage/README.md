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

The homepage uses Ardo 6 and the shared `ferramenta-family/ferra` entry for
landing pages, documentation, navigation, code panels, and evidence tables.
It has no site stylesheet. Changes to shared presentation belong in Ferramenta,
with a kit specimen, before updating the pinned package commit here.

Ardo's build-time highlighting uses the default immutable asset service. No
legacy `FERRIKI_ASSETS_BASE_URL` override is needed. `scripts/write-site-data.mjs`
mirrors the release version, verified evidence reports, and lifecycle illustration
into the documentation package before development, type checking, and builds.
Their original repository files remain the source of truth.

`verify` checks that the committed homepage samples, including the
`@ferriki/vite` macro sample, still match the current build, checks the shape
of the committed footprint record, executes the marked guide examples against
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
