import { ardo } from "ardo/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  plugins: [
    ardo({
      title: "Ferriki",
      description: "Shiki-compatible syntax highlighting with a native Rust core",
      githubPages: false,
      siteUrl: "https://ferriki.dev",
    }),
  ],
});
