import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  bundledLanguages,
  bundledLanguagesAlias,
  bundledThemes,
  codeToHtml,
  createCssVariablesTheme,
  createHighlighter,
  ShikiError,
} from "../ferriki/index.mjs";

import "./test-asset-env.mjs";

const contract = await readFile(
  new URL("../../docs/ferriki-1.0-api-contract.md", import.meta.url),
  "utf8",
);
const normalizedContract = contract.replace(/\|[ \t]+/g, "| ").replace(/[ \t]+\|/g, " |");
for (const row of [
  "| `bundledLanguages` / `bundledThemes` | Stable |",
  "| `themes` | Stable |",
  "| `styleMode` | Stable |",
  "| `regexPrefilter` | Stable |",
  "| `defaultColor` | Stable |",
  "| `transformers` | Stable |",
  "| `decorations` | Stable |",
  "| `colorReplacements` | Deferred |",
  "| ANSI input | Removed |",
  "| `theme: 'none'` | Stable |",
  "- A highlighter handle owns its native state and must be disposable.",
]) {
  assert(normalizedContract.includes(row), `API contract is missing the required row: ${row}`);
}

assert(Object.isFrozen(bundledLanguages));
assert(Object.isFrozen(bundledThemes));
assert(Object.isFrozen(bundledLanguagesAlias));
assert(Object.hasOwn(bundledLanguages, "typescript"));
assert(Object.hasOwn(bundledLanguagesAlias, "ts"));
assert(Object.hasOwn(bundledThemes, "nord"));

const cssTheme = createCssVariablesTheme({
  name: "contract-css",
  type: "light",
  variableDefaults: { foreground: "#111111", background: "#ffffff" },
});
assert.deepEqual(cssTheme, {
  name: "contract-css",
  type: "light",
  fg: "#111111",
  bg: "#ffffff",
  settings: [],
});

const highlighter = await createHighlighter({ themes: ["nord"] });
try {
  assert.equal(highlighter.getLoadedLanguages().includes("typescript"), false);
  await highlighter.loadLanguage(bundledLanguages.typescript);
  assert(highlighter.getLoadedLanguages().includes("typescript"));

  const single = highlighter.codeToHtml("const answer = 42", { lang: "typescript", theme: "nord" });
  assert(single.includes("const"));
  const dual = highlighter.codeToHtml("const answer = 42", {
    lang: "typescript",
    themes: { light: "vitesse-light", dark: "nord" },
    defaultColor: false,
  });
  assert.match(dual, /--shiki-light:/);
  assert.match(dual, /--shiki-dark:/);

  const shorthand = await codeToHtml("const answer = 42", { lang: "typescript", theme: "nord" });
  assert(shorthand.includes("const"));
} finally {
  highlighter.dispose();
}

assert.throws(
  () => highlighter.loadThemeSync("nord"),
  (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
);

for (const regexPrefilter of [true, false]) {
  const configured = await createHighlighter({
    regexPrefilter,
    langs: ["typescript"],
    themes: ["nord"],
  });
  try {
    const html = configured.codeToHtml("const answer = 42", { lang: "typescript", theme: "nord" });
    assert.equal(
      html,
      await codeToHtml("const answer = 42", { lang: "typescript", theme: "nord" }),
    );
  } finally {
    configured.dispose();
  }
}
for (const regexPrefilter of [null, 0, "false", {}]) {
  await assert.rejects(
    createHighlighter({ regexPrefilter }),
    (error) => error instanceof ShikiError && error.code === "ERR_USAGE",
  );
}

console.log("Ferriki 1.0 API contract verified");
