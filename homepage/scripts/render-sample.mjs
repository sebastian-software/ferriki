/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed relative to this script. */
// Renders the landing page sample with the Ferriki build in this repository
// and commits the output as-is: the page shows what Ferriki produced, never a
// hand-written imitation. Run after `pnpm run build:native` in `node/`.
//
//   node scripts/render-sample.mjs          # write app/data/sample.json
//   node scripts/render-sample.mjs --check  # fail when the committed file drifted
import { readFileSync, writeFileSync } from "node:fs";

import { createHighlighter } from "../../node/ferriki/index.mjs";
import { TEST_ASSET_CACHE_DIR } from "../../node/scripts/test-asset-env.mjs";

// Payloads come from the cache that `build:native` seeds, not the network.
process.env.FERRIKI_CACHE_DIR ??= TEST_ASSET_CACHE_DIR;
process.env.FERRIKI_ASSETS_REMOTE ??= "0";

const artifact = new URL("../app/data/sample.json", import.meta.url);
const input = readFileSync(new URL("sample-input.html", import.meta.url), "utf8");
const lang = "html";
const theme = "github-dark";

const highlighter = await createHighlighter({ langs: [lang], themes: [theme] });
const output = highlighter.codeToHtml(input, { lang, theme });
highlighter.dispose();

if (process.argv.includes("--check")) {
  const committed = JSON.parse(readFileSync(artifact, "utf8"));
  // The recorded version names the release that produced the artifact; a later
  // release that reproduces it byte for byte does not rewrite that attribution.
  if (committed.input !== input || committed.output !== output) {
    throw new Error(
      "The landing page sample changed. Run pnpm sample:write and commit the result.",
    );
  }
  console.log("The committed landing page sample matches Ferriki's current output.");
} else {
  const { version } = JSON.parse(
    readFileSync(new URL("../../node/ferriki/package.json", import.meta.url), "utf8"),
  );
  writeFileSync(artifact, `${JSON.stringify({ version, lang, theme, input, output }, null, 2)}\n`);
  console.log("Wrote app/data/sample.json from Ferriki's codeToHtml.");
}
