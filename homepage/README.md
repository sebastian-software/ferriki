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
FERRIKI_ASSETS_BASE_URL=https://raw.githubusercontent.com/sebastian-software/ferriki \
  pnpm --dir homepage verify
```

Ardo 5 and Ferromark 3.1 still embed a legacy commit-based Ferriki catalog.
After the [public CDN cutoff](../docs/migrations/legacy-cdn.md), their build-time
downloads use the pinned GitHub files through `FERRIKI_ASSETS_BASE_URL`. CI sets
this override only for the homepage build. Use the same override for `pnpm dev`
or `pnpm build` locally. Remove it when the embedded Ferriki dependency adopts
the immutable Storage catalog; current Ferriki consumers use the default CDN.

`verify` checks that the committed homepage samples, including the
`@ferriki/vite` macro sample, still match the current build, checks the shape
of the committed footprint record, executes the marked guide examples against
packed Ferriki packages using the seeded cache, checks links and fragments in
the built site, and runs responsive layout, axe accessibility, and keyboard
navigation checks in Chromium. The homepage CI workflow also runs the packed
Vite adapter consumer check.

The [Ferriki vs Prism page](app/routes/guide/ferriki-vs-prism.mdx) renders the
fixed inputs in `scripts/prism-inputs.json`. The native and Prism HTML, selected
token classifications, versions, and build identities are captured in
`app/data/prism-comparison.json`. The renderer checks source preservation for
both highlighters and exact Ferriki/Shiki WebAssembly HTML parity. These are
quality examples, separate from the retained performance measurements.

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
