import { ardo } from "ardo/vite";
import { defineConfig } from "vite";

import { rehypeFocusableTables } from "./app/rehype-focusable-tables.ts";

export default defineConfig({
  base: "/",
  plugins: [
    ardo({
      title: "Ferriki",
      description: "Shiki-compatible syntax highlighting with a native Rust core",
      githubPages: false,
      siteUrl: "https://ferriki.dev",
      markdown: { rehypePlugins: [rehypeFocusableTables] },
    }),
  ],
});
