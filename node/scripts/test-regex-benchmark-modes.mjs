import assert from "node:assert/strict";
import { test } from "node:test";
import { createHighlighter, createHighlighterCoreSync } from "../ferriki/index.mjs";
import { regexModes, validateRegexDiagnostics } from "./regex-benchmark-modes.mjs";
import "./test-asset-env.mjs";

test("source modes stay independent of prepared standard assets and preserve HTML", async () => {
  let expected;
  for (const mode of Object.values(regexModes)) {
    const highlighter = await createHighlighter({
      regexMode: mode,
      langs: ["sql"],
      themes: ["nord"],
    });
    try {
      const html = highlighter.codeToHtml("SELECT name FROM customers WHERE active = TRUE;", {
        lang: "sql",
        theme: "nord",
      });
      expected ??= html;
      assert.equal(html, expected);
      validateRegexDiagnostics(highlighter.getRegexDiagnostics(), mode, mode === "prepared");
    } finally {
      highlighter.dispose();
    }
  }
});

test("dynamic capture scanners obey explicit source policies without requiring archives", async () => {
  const grammar = {
    name: "mode-test",
    scopeName: "source.mode-test",
    patterns: [
      {
        begin: "<<(\\w+)",
        end: "^\\1$",
        name: "string.heredoc",
        patterns: [{ match: "value", name: "keyword" }],
      },
    ],
  };
  let expected;
  for (const mode of Object.values(regexModes)) {
    const highlighter = await createHighlighter({
      regexMode: mode,
      langs: [grammar],
      themes: ["nord"],
    });
    try {
      const html = highlighter.codeToHtml("<<END\nvalue\nEND", {
        lang: "mode-test",
        theme: "nord",
      });
      expected ??= html;
      assert.equal(html, expected);
      const snapshot = highlighter.getRegexDiagnostics();
      assert.ok(snapshot.dynamicScanners > 0);
      assert.equal(snapshot.preparedArchives, 0);
      validateRegexDiagnostics(snapshot, mode);
    } finally {
      highlighter.dispose();
    }
  }
});

test("ambiguous or invalid regex mode options fail at the facade boundary", async () => {
  for (const regexMode of [null, true, "AUTO", "on", {}]) {
    await assert.rejects(createHighlighter({ regexMode }), { code: "ERR_USAGE" });
    assert.throws(() => createHighlighterCoreSync({ regexMode }), { code: "ERR_USAGE" });
  }
  for (const regexMode of Object.values(regexModes))
    await assert.rejects(createHighlighter({ regexMode, regexPrefilter: true }), {
      code: "ERR_USAGE",
    });
});

test("diagnostic validation rejects source/archive contamination and mislabeled policies", () => {
  const source = {
    mode: "auto",
    staticScanners: 1,
    dynamicScanners: 0,
    autoScanners: 1,
    offScanners: 0,
    eagerScanners: 0,
    assemblyFallbacks: 0,
    preparedArchives: 0,
    loadedPreparedGroups: 0,
    invalidPreparedGroups: 0,
  };
  validateRegexDiagnostics(source, "auto");
  assert.throws(() => validateRegexDiagnostics({ ...source, preparedArchives: 1 }, "auto"));
  assert.throws(() =>
    validateRegexDiagnostics({ ...source, eagerScanners: 1, autoScanners: 0 }, "auto"),
  );
  assert.throws(() => validateRegexDiagnostics({ ...source, mode: "prepared" }, "prepared", true));
});
