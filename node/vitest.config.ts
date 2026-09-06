import process from "node:process";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

function compatPackage(entry: string) {
  return new URL(`./compat/upstream/shiki/packages/${entry}`, import.meta.url).pathname;
}

const ferrikiEntry = new URL("./ferriki/index.mjs", import.meta.url).pathname;
const virtualLangPrefix = "\0ferriki:lang:";
const virtualThemePrefix = "\0ferriki:theme:";

function defaultExportInteropExpression(source: string) {
  return [
    `${source}.default`,
    `Object.values(${source}).find(value => value && typeof value === 'object' && 'default' in value)?.default`,
    `Object.values(${source}).find(value => Array.isArray(value))`,
    `${source}`,
  ].join(" ?? ");
}

const backendEntry = new URL("./compat/harness/shiki-backend-entry.ts", import.meta.url).pathname;

export default defineConfig({
  plugins: [
    {
      // Honest-alias mode (FERRIKI_HONEST_ALIAS=1): route the mirrored
      // tests' remaining upstream entry points through the ferriki backend
      // entry, so the compat lane exercises the native path instead of
      // upstream JS against upstream JS (migration plan, Finding 0).
      name: "ferriki-honest-alias",
      enforce: "pre" as const,
      resolveId(source: string, importer?: string) {
        if (!process.env.FERRIKI_HONEST_ALIAS) return;
        if (source === "shiki/bundle/full" || source === "shiki/core") return backendEntry;
        if (
          source === "@shikijs/engine-javascript" ||
          source === "@shikijs/engine-oniguruma" ||
          source === "@shikijs/engine-oniguruma/wasm-inlined"
        ) {
          return backendEntry;
        }
        if (
          source === "../src" &&
          importer &&
          (importer.includes("/compat/upstream/shiki/packages/shiki/test/") ||
            importer.includes("/compat/upstream/shiki/packages/core/test/"))
        ) {
          return backendEntry;
        }
      },
    },
    tsconfigPaths(),
    {
      name: "ferriki-compat-subpath-loader",
      resolveId(id) {
        if (id.startsWith("@shikijs/langs/"))
          return `${virtualLangPrefix}${id.slice("@shikijs/langs/".length)}`;
        if (id.startsWith("@shikijs/themes/"))
          return `${virtualThemePrefix}${id.slice("@shikijs/themes/".length)}`;
      },
      load(id) {
        if (id.startsWith(virtualLangPrefix)) {
          const lang = id.slice(virtualLangPrefix.length);
          return `
import { bundledLanguages } from ${JSON.stringify(ferrikiEntry)}
const loader = bundledLanguages[${JSON.stringify(lang)}]
if (!loader)
  throw new Error(${JSON.stringify(`Unknown Ferriki bundled language: ${lang}`)})
const loaded = await loader()
export default ${defaultExportInteropExpression("loaded")}
`;
        }
        if (id.startsWith(virtualThemePrefix)) {
          const theme = id.slice(virtualThemePrefix.length);
          return `
import { bundledThemes } from ${JSON.stringify(ferrikiEntry)}
const loader = bundledThemes[${JSON.stringify(theme)}]
if (!loader)
  throw new Error(${JSON.stringify(`Unknown Ferriki bundled theme: ${theme}`)})
const loaded = await loader()
export default ${defaultExportInteropExpression("loaded")}
`;
        }
      },
    },
  ],
  resolve: {
    alias: [
      {
        find: /^shiki$/,
        replacement: new URL("./compat/harness/shiki-backend-entry.ts", import.meta.url).pathname,
      },
      {
        find: /^@shikijs\/primitive$/,
        replacement: compatPackage("primitive/src/index.ts"),
      },
      {
        find: /^@shikijs\/primitive\/textmate$/,
        replacement: compatPackage("primitive/src/textmate/index.ts"),
      },
      {
        find: /^@shikijs\/core$/,
        replacement: compatPackage("core/src/index.ts"),
      },
      {
        find: /^@shikijs\/core\/textmate$/,
        replacement: compatPackage("core/src/textmate.ts"),
      },
      {
        find: /^@shikijs\/engine-javascript$/,
        replacement: process.env.FERRIKI_HONEST_ALIAS
          ? backendEntry
          : compatPackage("engine-javascript/src/index.ts"),
      },
      {
        find: /^@shikijs\/engine-oniguruma$/,
        replacement: process.env.FERRIKI_HONEST_ALIAS
          ? backendEntry
          : compatPackage("engine-oniguruma/src/index.ts"),
      },
      {
        find: /^@shikijs\/engine-oniguruma\/wasm-inlined$/,
        replacement: process.env.FERRIKI_HONEST_ALIAS
          ? backendEntry
          : compatPackage("engine-oniguruma/src/wasm-inlined.ts"),
      },
      {
        find: /^@shikijs\/transformers$/,
        replacement: compatPackage("transformers/src/index.ts"),
      },
      {
        find: /^@shikijs\/twoslash$/,
        replacement: compatPackage("twoslash/src/index.ts"),
      },
      {
        find: /^@shikijs\/types$/,
        replacement: compatPackage("types/src/index.ts"),
      },
      {
        find: /^ferriki$/,
        replacement: new URL("./ferriki/index.mjs", import.meta.url).pathname,
      },
      {
        find: /^ferriki\/native$/,
        replacement: new URL("./ferriki/native.mjs", import.meta.url).pathname,
      },
    ],
  },
  test: {
    testTimeout: 30_000,
    reporters: "dot",
    exclude: ["**/node_modules/**"],
  },
});
