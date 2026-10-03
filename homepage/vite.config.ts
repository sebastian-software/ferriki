import { ardo } from "ardo/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const ferrikiMdxProvider = fileURLToPath(new URL("app/mdx-provider.tsx", import.meta.url));

const focusableMdxProvider: Plugin = {
  name: "ferriki-focusable-mdx-provider",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "ardo/mdx-provider" && importer?.split("?")[0] !== ferrikiMdxProvider) {
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
      description: "Shiki-shaped HTML and CSS highlighting with a native Rust engine",
      githubPages: false,
      siteUrl: "https://ferriki.dev",
    }),
  ],
});
