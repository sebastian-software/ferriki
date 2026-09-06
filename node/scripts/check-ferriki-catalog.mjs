import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { languageCatalog, themeCatalog } from "../ferriki/assets/shiki/catalog.mjs";
import {
  bundledLanguages,
  bundledLanguagesAlias,
  bundledThemes,
  createHighlighter,
} from "../ferriki/index.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const assetRoot = join(packageDir, "ferriki", "assets", "shiki");

assert(Object.isFrozen(bundledLanguages), "bundledLanguages must be immutable");
assert(Object.isFrozen(bundledThemes), "bundledThemes must be immutable");
assert(Object.isFrozen(bundledLanguagesAlias), "bundledLanguagesAlias must be immutable");
assert(languageCatalog.length > 0, "language catalog is empty");
assert(themeCatalog.length > 0, "theme catalog is empty");

const languageIds = new Set(languageCatalog.map((entry) => entry.id));
const languageKeys = new Set(languageCatalog.flatMap((entry) => [entry.id, ...entry.aliases]));
assert.deepEqual(Object.keys(bundledLanguages), [...languageKeys].sort(compareIds));
assert.deepEqual(
  Object.keys(bundledLanguagesAlias),
  languageCatalog.flatMap((entry) => entry.aliases).sort(compareIds),
);

for (const entry of languageCatalog) {
  await assertAsset(join(assetRoot, "languages", entry.assetFile));
  const registration = (await bundledLanguages[entry.id]())[0];
  assert.equal(registration.name, entry.id);
  assert.equal(registration.scopeName, entry.scopeName);
  assert.deepEqual(registration.aliases, entry.aliases);
  for (const alias of entry.aliases) {
    assert.equal(bundledLanguagesAlias[alias], entry.id);
    assert.equal((await bundledLanguages[alias]())[0].name, entry.id);
  }
}

for (const entry of themeCatalog) {
  await assertAsset(join(assetRoot, "themes", entry.assetFile));
  const registration = await bundledThemes[entry.id]();
  assert.equal(registration.name, entry.id);
  assert.equal(registration.type, entry.themeType || undefined);
}

assert.equal(Object.hasOwn(bundledLanguages, "not-a-real-language"), false);
assert.equal(Object.hasOwn(bundledThemes, "not-a-real-theme"), false);
assert.equal(Object.hasOwn(bundledLanguagesAlias, "not-a-real-alias"), false);
assert(languageIds.has("typescript"), "typescript must be enumerable");
assert(languageIds.has("vue"), "vue must be enumerable");
assert(Object.hasOwn(bundledLanguagesAlias, "ts"), "typescript alias must be enumerable");
assert(Object.hasOwn(bundledThemes, "nord"), "nord must be enumerable");

const highlighter = await createHighlighter({
  langs: [bundledLanguages.typescript(), bundledLanguages.vue()],
  themes: [bundledThemes.nord()],
});
try {
  const typescript = highlighter.codeToHtml("const answer: number = 42", {
    lang: "typescript",
    theme: "nord",
  });
  assert.match(typescript, /const/);
  const vue = highlighter.codeToHtml('<script setup lang="ts">const answer = 42</script>', {
    lang: "vue",
    theme: "nord",
  });
  assert.match(vue, /script/);
} finally {
  highlighter.dispose();
}

const [languageFiles, themeFiles] = await Promise.all([
  readdir(join(assetRoot, "languages")),
  readdir(join(assetRoot, "themes")),
]);
assert.equal(
  languageFiles.filter((file) => file.endsWith(".fkgram")).length,
  languageCatalog.length,
);
assert.equal(themeFiles.filter((file) => file.endsWith(".fktheme")).length, themeCatalog.length);

console.log(
  `Ferriki catalogs verified: ${languageCatalog.length} languages, ${themeCatalog.length} themes, ${Object.keys(bundledLanguagesAlias).length} aliases`,
);

async function assertAsset(file) {
  await access(file, constants.R_OK);
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
