/* eslint-disable security/detect-non-literal-fs-filename -- The artifact path is fixed relative to this script. */
// Runs the landing page's build-time macro sample through the @ferriki/vite
// adapter in this repository and commits the module it emitted as-is: the page
// shows the adapter's real transform output, never a hand-written imitation.
// Run after `pnpm run build:native` in `node/`.
//
//   node scripts/render-macro-sample.mjs          # write app/data/macro-sample.json
//   node scripts/render-macro-sample.mjs --check  # fail when the committed file drifted
import { readFileSync, writeFileSync } from "node:fs";

import { createHighlighter } from "../../node/ferriki/index.mjs";
import { TEST_ASSET_CACHE_DIR } from "../../node/scripts/test-asset-env.mjs";
import { ferriki } from "../../node/vite/index.mjs";

// Payloads come from the cache that `build:native` seeds, not the network.
process.env.FERRIKI_CACHE_DIR ??= TEST_ASSET_CACHE_DIR;
process.env.FERRIKI_ASSETS_REMOTE ??= "0";

const artifact = new URL("../app/data/macro-sample.json", import.meta.url);
const id = "/src/Answer.tsx";
const input = `import { Code } from "@ferriki/core/react/macro";

export function Answer() {
  return (
    <Code
      language="ts"
      source={\`export const answer = 42;\`}
    />
  );
}
`;

// The adapter's default options: one theme, inline styles.
const plugin = ferriki();
const warnings = [];
// The two context methods the transform uses; Vite's and Rolldown's `error` throw.
const context = {
  warn(message) {
    warnings.push(message);
  },
  error(error) {
    throw error;
  },
};
const result = await plugin.transform.handler.call(context, input, id);
if (!result) throw new Error("@ferriki/vite left the macro sample unchanged.");
if (warnings.length > 0) throw new Error(`@ferriki/vite warned:\n${warnings.join("\n")}`);
const output = result.code;
const highlighter = await createHighlighter({ langs: ["tsx"], themes: ["github-dark"] });
const inputHtml = highlighter.codeToHtml(input, { lang: "tsx", theme: "github-dark" });
const outputHtml = highlighter.codeToHtml(output, { lang: "tsx", theme: "github-dark" });
highlighter.dispose();

if (process.argv.includes("--check")) {
  const committed = JSON.parse(readFileSync(artifact, "utf8"));
  if (
    committed.input !== input ||
    committed.output !== output ||
    committed.inputHtml !== inputHtml ||
    committed.outputHtml !== outputHtml
  ) {
    throw new Error(
      "The landing page macro sample changed. Run pnpm macro-sample:write and commit the result.",
    );
  }
  console.log("The committed macro sample matches the current @ferriki/vite output.");
} else {
  const { version } = JSON.parse(
    readFileSync(new URL("../../node/vite/package.json", import.meta.url), "utf8"),
  );
  writeFileSync(
    artifact,
    `${JSON.stringify({ version, id, input, output, inputHtml, outputHtml }, null, 2)}\n`,
  );
  console.log("Wrote app/data/macro-sample.json from @ferriki/vite's transform.");
}
