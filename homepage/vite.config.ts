import { ardo } from "ardo/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, type Plugin } from "vite";

import grammarSources from "../assets/grammars/sources.json" with { type: "json" };

const ferrikiMdxProvider = normalizePath(
  fileURLToPath(new URL("app/mdx-provider.tsx", import.meta.url)),
);
const ferrikiMdxProviderImporters = new Set([
  ferrikiMdxProvider,
  normalizePath(fileURLToPath(new URL("app/focusable-pre.tsx", import.meta.url))),
]);

const focusableMdxProvider: Plugin = {
  name: "ferriki-focusable-mdx-provider",
  enforce: "pre",
  resolveId(source, importer) {
    if (
      source === "ardo/mdx-provider" &&
      !ferrikiMdxProviderImporters.has(normalizePath(importer?.split("?")[0] ?? ""))
    ) {
      return ferrikiMdxProvider;
    }
    return null;
  },
};

export default defineConfig({
  base: "/",
  // Keep the website in sync with the accepted catalog without sending source
  // commits, license notices, or grammar payloads to the browser.
  define: {
    __FERRIKI_GRAMMAR_CATALOG__: JSON.stringify(
      grammarSources.languages.map((entry) => ({
        id: entry.id,
        name: entry.display_name,
        aliases: entry.aliases,
        role: entry.role,
      })),
    ),
  },
  plugins: [
    focusableMdxProvider,
    ardo({
      title: "Ferriki",
      description:
        "Beautiful, ready-to-display code for docs and site builds, with native TextMate highlighting for Node.js and Rust.",
      githubPages: false,
      siteUrl: "https://ferriki.dev",
    }),
  ],
});
