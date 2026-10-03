import assert from "node:assert/strict";
import { createHighlighter, ShikiError } from "../ferriki/index.mjs";

import "./test-asset-env.mjs";

const highlighter = await createHighlighter({ themes: ["nord"] });
const ansi = `${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`;
try {
  assert.throws(
    () => highlighter.codeToHtml(ansi, { lang: "ansi", theme: "nord" }),
    (error) =>
      error instanceof ShikiError && /ANSI control sequences are not supported/.test(error.message),
  );
} finally {
  highlighter.dispose();
}

console.log("Ferriki ANSI contract verified");
