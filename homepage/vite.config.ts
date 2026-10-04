import { ardo } from "ardo/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, type Plugin } from "vite";

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
  plugins: [
    focusableMdxProvider,
    ardo({
      title: "Ferriki",
      description: "Native syntax highlighting for Node.js and Rust, with Shiki's HTML API",
      githubPages: false,
      siteUrl: "https://ferriki.dev",
    }),
  ],
});
