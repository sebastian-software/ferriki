import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { createHighlighter, createHighlighterCoreSync } from "../ferriki/index.mjs";
import { regexModes, validateRegexDiagnostics } from "./regex-benchmark-modes.mjs";
import "./test-asset-env.mjs";

test("policy evidence can be validated without generated facade assets", () => {
  const root = mkdtempSync(join(os.tmpdir(), "ferriki-policy-evidence-"));
  try {
    mkdirSync(join(root, "node/scripts"), { recursive: true });
    mkdirSync(join(root, "assets"));
    copyFileSync(
      new URL("./regex-benchmark-modes.mjs", import.meta.url),
      join(root, "node/scripts/modes.mjs"),
    );
    copyFileSync(
      new URL("../../assets/catalog.json", import.meta.url),
      join(root, "assets/catalog.json"),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {usesStandardGrammar} from './node/scripts/modes.mjs'; if (!usesStandardGrammar({textmate:'sql'})) process.exit(1);",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("Markdown keeps optional language packages lazy and reuses registered Rust", async () => {
  const highlighter = await createHighlighter({ langs: ["markdown"], themes: ["nord"] });
  let reference;
  try {
    assert.ok(!highlighter.getLoadedLanguages().includes("rust"));
    assert.equal(highlighter.getRegexDiagnostics().preparedArchives, 1);
    await highlighter.loadLanguage("rust");
    assert.ok(highlighter.getLoadedLanguages().includes("rust"));
    assert.equal(highlighter.getRegexDiagnostics().preparedArchives, 2);
    const code = '```rust\nfn main() { let message = "hello"; }\n```';
    const options = { lang: "markdown", theme: "nord" };
    reference = await createHighlighter({
      langs: ["markdown", "rust"],
      themes: ["nord"],
      regexMode: "eager",
    });
    assert.equal(highlighter.codeToHtml(code, options), reference.codeToHtml(code, options));
    validateRegexDiagnostics(highlighter.getRegexDiagnostics(), "prepared", true);
  } finally {
    reference?.dispose();
    highlighter.dispose();
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
