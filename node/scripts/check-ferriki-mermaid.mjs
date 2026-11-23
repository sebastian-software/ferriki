import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fromHtml } from "hast-util-from-html";
import { createHighlighter } from "../ferriki/index.mjs";
import { createEngine, theme } from "./tiobe-benchmark.mjs";
import "./test-asset-env.mjs";

// Flowchart excerpt from Ferrigura's docs/diagrams/flowchart.md at de42bfc.
// The remaining small examples exercise a diagram-specific body rule, not just
// its header. The local C4 injection supplies the call and argument scopes.
const examples = [
  ["flowchart LR\n  model[FlowchartDiagram] --> data[get_data]", "model", /entity-name-tag-node/],
  ["classDiagram\n class Animal", "Animal", /entity-name-type-class/],
  ["stateDiagram-v2\n [*] --> Still", "Still", /variable-state-name/],
  ["erDiagram\n CUSTOMER ||--o{ ORDER : places", "CUSTOMER", /entity-name-operand-first/],
  ["requirementDiagram\n requirement test {\n id: 1\n }", "test", /entity-name-requirement/],
  ["mindmap\n root((Root))", "root", /entity-name-tag-node/],
  ["sequenceDiagram\n participant Alice", "participant", /storage-modifier-participant/],
  ["gantt\n dateFormat YYYY-MM-DD", "dateFormat", /storage-type-date_2d_format/],
  ["timeline\n 2023 : Event", "Event", /entity-name-event/],
  ["journey\n section Work", "Work", /string-unquoted-section_2d_description/],
  ["gitGraph\n commit", "commit", /keyword-operator-git/],
  ['pie\n "A" : 4', "4", /constant-numeric-decimal/],
  ["quadrantChart\n x-axis Low --> High", "x-axis", /keyword-operator-axis/],
  ["sankey-beta\n A,B,10", "10", /constant-numeric-data/],
  ["zenuml\n Alice.method()", "method", /entity-name-function-message/],
  ['C4Context\n Person(a, "A")', "C4Context", /keyword-control-c4c/],
  ["info", "info", /keyword-control-engine/],
];
const grammar = JSON.parse(
  await readFile(
    new URL("../../assets/upstream/curated/grammars/mermaid.json", import.meta.url),
    "utf8",
  ),
);
assert.deepEqual(grammar.fileTypes, ["mmd", "mermaid"]);

const highlighter = await createHighlighter({ langs: ["mermaid"], themes: [theme] });
const reference = await createEngine("shiki-wasm", { textmate: "mermaid" });
try {
  for (const [code, expected, scope] of examples) {
    const colored = highlighter.codeToHtml(code, { lang: "mermaid", theme });
    assert.equal(colored, reference.html(code), code);
    const html = highlighter.codeToHtml(code, {
      lang: "mermaid",
      theme,
      styleMode: "classes",
    });
    const found = [];
    function visit(node, classes = []) {
      const scopes = [...classes, ...(node.properties?.className ?? [])];
      if (node.type === "text" && node.value === expected) found.push(scopes.join(" "));
      for (const child of node.children ?? []) visit(child, scopes);
    }
    visit(fromHtml(html, { fragment: true }));
    assert(
      found.some((scopes) => scope.test(scopes)),
      `${code}: ${expected} missing ${scope}`,
    );
  }
  for (const alias of ["mmd", "mermaid example"]) {
    assert.equal(
      highlighter.codeToHtml("info", { lang: alias, theme }),
      highlighter.codeToHtml("info", { lang: "mermaid", theme }),
    );
  }
} finally {
  highlighter.dispose();
  reference.dispose();
}
console.log(`Mermaid grammar coverage verified: ${examples.length} examples`);
