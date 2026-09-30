/* eslint-disable security/detect-non-literal-fs-filename -- Both artifact paths are fixed relative to this script. */
import { readFileSync, writeFileSync } from "node:fs";

import { createHighlighter } from "../../node/ferriki/index.mjs";
import { TEST_ASSET_CACHE_DIR } from "../../node/scripts/test-asset-env.mjs";

// Payloads come from the cache that `build:native` seeds, not the network.
process.env.FERRIKI_CACHE_DIR ??= TEST_ASSET_CACHE_DIR;
process.env.FERRIKI_ASSETS_REMOTE ??= "0";

const target = new URL("../app/data/class-sample.json", import.meta.url);
const input = '"hello"\n{"message":"hello", "escaped":"line\\n"}';
const highlighter = await createHighlighter({
  langs: ["json"],
  themes: ["monokai", "github-light"],
});
try {
  const output = highlighter.codeToHtmlWithCss(input, {
    lang: "json",
    themes: { light: "github-light", dark: "monokai" },
  });
  const artifact = { input, ...output };
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(readFileSync(target, "utf8"))) !== JSON.stringify(artifact))
      throw new Error("Class sample drifted. Run pnpm class-sample:write.");
  } else writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`);
} finally {
  highlighter.dispose();
}
console.log("Class sample matches the current Ferriki build.");
