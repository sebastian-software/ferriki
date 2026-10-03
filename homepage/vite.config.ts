import { ardo } from "ardo/vite";
import { defineConfig } from "vite";

import { rehypeFocusableTables } from "./app/rehype-focusable-tables.ts";

export default defineConfig({
  base: "/",
  plugins: [
    ardo({
      title: "Ferriki",
      description: "Shiki-shaped HTML and CSS highlighting with a native Rust engine",
      githubPages: false,
      siteUrl: "https://ferriki.dev",
      markdown: { rehypePlugins: [rehypeFocusableTables] },
    }),
  ],
});
