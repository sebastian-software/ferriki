// The exact bytes of the two generated wrapper files. `build-wrapper.mjs`
// writes them and `verify-wrapper.mjs` checks them, so the shape lives here
// once instead of in two copies that can drift apart.
export const WRAPPER_RUNTIME = [
  "/* This file is generated from src/index.mjs. Run `pnpm run build` after changing the source. */",
  'export * from "./src/index.mjs";',
  "",
].join("\n");

export const WRAPPER_TYPES = [
  "/* This file is generated from src/api.mts. Run `pnpm run build` after changing the source. */",
  'export * from "./src/api.mjs";',
  "",
].join("\n");
