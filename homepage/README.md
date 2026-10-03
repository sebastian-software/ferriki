# Homepage checks

From the repository root, prepare the native package and its local asset cache,
install the homepage dependencies, install Playwright's browser, then run the
full homepage verification:

```sh
pnpm --dir node install --frozen-lockfile
pnpm --dir node run build:native
pnpm --dir homepage install --frozen-lockfile
pnpm --dir homepage exec playwright install chromium
pnpm --dir homepage verify
```

`verify` runs the committed homepage samples, executes the marked guide examples
against packed Ferriki packages using the seeded cache, checks links and
fragments in the built site, and runs responsive layout, axe accessibility, and
keyboard navigation checks in Chromium. The homepage CI workflow also runs the
packed optional Vite adapter consumer check.
