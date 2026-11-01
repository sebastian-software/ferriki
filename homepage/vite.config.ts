import { defineConfig } from "vite";

import grammarSources from "../assets/grammars/sources.json" with { type: "json" };

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
});
