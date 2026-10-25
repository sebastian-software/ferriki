import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Evidence-only runners do not build the facade's generated asset catalog.
const languageCatalog = JSON.parse(
  readFileSync(new URL("../../assets/catalog.json", import.meta.url), "utf8"),
).languages.entries;

const standardLanguages = new Set(languageCatalog.flatMap(({ id, aliases }) => [id, ...aliases]));
export const usesStandardGrammar = (language) =>
  [language.textmate, ...(language.embedded ?? [])].some((name) => standardLanguages.has(name));

export const regexModes = Object.freeze({
  "ferriki-off": "off",
  ferriki: "auto",
  "ferriki-eager": "eager",
  "ferriki-precompiled": "prepared",
});
export const regexModeEngines = [...Object.keys(regexModes), "shiki-wasm", "shiki-js", "prism"];
export const regexModeLabels = {
  "ferriki-off": "Ferriki source Off",
  ferriki: "Ferriki source Auto (lazy DFA)",
  "ferriki-eager": "Ferriki source Eager",
  "ferriki-precompiled": "Ferriki prepared Eager",
  "shiki-wasm": "Shiki WASM",
  "shiki-js": "Shiki JS",
  prism: "Prism (independent grammars)",
};

export function ferrikiRegexOptions(id, regexPrefilter = true) {
  if (id === "ferriki") return { regexMode: regexPrefilter ? "auto" : "off" };
  return Object.hasOwn(regexModes, id) ? { regexMode: regexModes[id] } : undefined;
}

export function validateRegexDiagnostics(value, mode, requirePrepared = false) {
  assert.equal(value.mode, mode, "Wrong runtime regex mode");
  for (const key of [
    "staticScanners",
    "dynamicScanners",
    "offScanners",
    "autoScanners",
    "eagerScanners",
    "assemblyFallbacks",
    "preparedArchives",
    "loadedPreparedGroups",
    "invalidPreparedGroups",
  ])
    assert.ok(
      Number.isSafeInteger(value[key]) && value[key] >= 0,
      `Missing regex diagnostic ${key}`,
    );
  assert.equal(
    value.staticScanners + value.dynamicScanners,
    value.offScanners + value.autoScanners + value.eagerScanners,
  );
  assert.ok(value.staticScanners + value.dynamicScanners > 0, "No scanners observed");
  assert.equal(value.invalidPreparedGroups, 0, "Invalid prepared group");
  assert.equal(value.assemblyFallbacks, 0, "Scanner assembly fallback");
  if (mode !== "prepared") {
    assert.equal(value.preparedArchives, 0, "Source mode opened prepared archives");
    assert.equal(value.loadedPreparedGroups, 0, "Source mode consumed prepared groups");
  }
  if (mode === "off") assert.equal(value.offScanners, value.staticScanners + value.dynamicScanners);
  if (mode === "auto")
    assert.equal(
      value.autoScanners,
      value.staticScanners + value.dynamicScanners,
      "Wrong Auto policy",
    );
  if (mode === "eager")
    assert.equal(
      value.eagerScanners,
      value.staticScanners + value.dynamicScanners,
      "Wrong Eager policy",
    );
  if (mode === "prepared")
    assert.equal(value.offScanners, 0, "Prepared unexpectedly disabled acceleration");
  if (requirePrepared) {
    assert.ok(value.preparedArchives > 0, "Standard prepared archive was not opened");
    assert.ok(value.loadedPreparedGroups > 0, "Prepared lane did not consume any archive groups");
  }
}
