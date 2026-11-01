import { defineArdoConfig } from "ardo/config";

export default defineArdoConfig({
  title: "Ferriki",
  description:
    "Native TextMate highlighting for Rust, Node.js and Vite, with prepared language packages.",
  siteUrl: "https://ferriki.dev",
  icons: false,
  markdown: { headingAttributes: true },
  linkCheck: { level: "error" },
});
