import assert from "node:assert/strict";
import { createHighlighter } from "../ferriki/index.mjs";
import "./test-asset-env.mjs";

// Loading only Mermaid must register all three standard injections.
const highlighter = await createHighlighter({ langs: ["mermaid"], themes: ["github-dark"] });
try {
  for (const [source, expected] of [
    ['packet\n 0-7: "Field"', "exact-meta-ferriki_2d_mermaid-packet"],
    ['C4Context\nPerson(p, "Person")', "exact-support-function-c4-ferriki-mermaid"],
    ["zenuml\n // **important**", "exact-markup-bold-zenuml-ferriki-mermaid"],
  ]) {
    const html = highlighter.codeToHtml(source, {
      lang: "mermaid",
      theme: "github-dark",
      styleMode: "classes",
    });
    assert(html.includes(expected), `Mermaid did not load its injection: ${expected}`);
  }
} finally {
  highlighter.dispose();
}
console.log("Mermaid loads local injections through the standard catalog");
