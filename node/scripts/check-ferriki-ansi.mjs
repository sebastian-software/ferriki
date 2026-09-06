import assert from "node:assert/strict";

import { createHighlighter, ShikiError } from "../ferriki/index.mjs";

const highlighter = await createHighlighter({ themes: ["nord"] });
const ansi = `${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`;
try {
  for (const render of [
    () => highlighter.codeToHtml(ansi, { lang: "ansi", theme: "nord" }),
    () => highlighter.codeToHast(ansi, { lang: "ansi", theme: "nord" }),
    () => highlighter.codeToTokens(ansi, { lang: "ansi", theme: "nord" }),
  ]) {
    assert.throws(
      render,
      (error) =>
        error instanceof ShikiError &&
        /ANSI control sequences are not supported/.test(error.message),
    );
  }
} finally {
  highlighter.dispose();
}

console.log("Ferriki ANSI contract verified");
