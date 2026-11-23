import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fromHtml } from "hast-util-from-html";
import { createOnigurumaEngine, createHighlighter as createReference } from "shiki-benchmark";
import { createHighlighter } from "../ferriki/index.mjs";
import {
  standardGrammarRegistrations,
  standardThemeRegistrations,
} from "./standard-grammar-reference.mjs";
import "./test-asset-env.mjs";

const root = new URL("../../assets/grammars/local/", import.meta.url);
const fixtureRoot = new URL("../fixtures/mermaid-local/", import.meta.url);
const names = ["mermaid-diagrams", "mermaid-c4", "mermaid-zenuml-comments"];
const registrations = await Promise.all(
  names.map(async (name) => ({
    ...JSON.parse(await readFile(new URL(`${name}.tmLanguage.json`, root), "utf8")),
    name,
    injectTo: ["source.mermaid"],
  })),
);
const native = await createHighlighter({
  langs: [...registrations, "mermaid"],
  themes: ["github-dark"],
});
// The catalog may already contain these injections. The reference and its
// unmodified baseline both register the upstream closure exactly once.
const upstream = standardGrammarRegistrations(["mermaid"])
  .filter((grammar) => !names.includes(grammar.name))
  .map((grammar) => ({
    ...grammar,
    embeddedLangs: grammar.embeddedLangs?.filter((name) => !names.includes(name)),
  }));
const wasm = await createReference({
  langs: [...registrations, ...upstream],
  themes: standardThemeRegistrations(["github-dark"]),
  engine: createOnigurumaEngine(import("shiki-benchmark/wasm")),
});
const baseline = await createReference({
  langs: upstream,
  themes: standardThemeRegistrations(["github-dark"]),
  engine: createOnigurumaEngine(import("shiki-benchmark/wasm")),
});
function scopedText(html) {
  const tokens = [];
  function visit(node, classes = []) {
    const scope = [...classes, ...(node.properties?.className ?? [])];
    if (node.type === "text") tokens.push({ text: node.value, scopes: scope.join(" ") });
    for (const child of node.children ?? []) visit(child, scope);
  }
  visit(fromHtml(html, { fragment: true }));
  return tokens;
}
const opts = { lang: "mermaid", theme: "github-dark" };
function check(source) {
  assert.equal(native.codeToHtml(source, opts), wasm.codeToHtml(source, opts));
  return scopedText(native.codeToHtml(source, { ...opts, styleMode: "classes" }));
}
try {
  const specs = JSON.parse(await readFile(new URL("sources.json", fixtureRoot), "utf8"));
  const guide = await readFile(new URL("../../docs/mermaid-grammar.md", import.meta.url), "utf8");
  const listed = guide
    .split("<!-- local-mermaid-diagrams:start -->")[1]
    ?.split("<!-- local-mermaid-diagrams:end -->")[0];
  assert(listed, "Missing local diagram coverage list");
  assert.deepEqual(
    [...listed.matchAll(/^- ([a-z-]+)$/gm)].map((match) => match[1]).sort(),
    specs.map((entry) => entry.id).sort(),
    "Fixture index and coverage guide drifted",
  );
  for (const { id, body } of specs) {
    const source = await readFile(new URL(`${id}.mmd`, fixtureRoot), "utf8");
    const tokens = check(source);
    assert(
      tokens.some((token) =>
        token.scopes.includes(`leaf-keyword-control-${id.replaceAll("-", "_2d_")}-begin-mermaid`),
      ),
      `${id} header`,
    );
    assert(
      tokens.some(
        (token) =>
          token.text.includes(body) &&
          !token.scopes.includes(
            `leaf-keyword-control-${id.replaceAll("-", "_2d_")}-begin-mermaid`,
          ) &&
          /leaf-(?:keyword|entity|string|constant)-/.test(token.scopes) &&
          token.scopes.includes("meta-ferriki_2d_mermaid"),
      ),
      `${id} body: ${body}`,
    );
    const quotedAndCommented = check(`${source}\n"operation --> end"\n%% operation --> end`);
    assert(
      quotedAndCommented.some(
        (token) =>
          token.text.includes("operation --> end") &&
          token.scopes.includes("string-quoted-double-mermaid"),
      ),
      `${id}: quoted operator`,
    );
    assert(
      quotedAndCommented.some(
        (token) => token.text.includes("operation --> end") && token.scopes.includes("comment"),
      ),
      `${id}: comment operator`,
    );
  }
  const c4 = await readFile(new URL("c4.mmd", fixtureRoot), "utf8");
  for (const token of ["Person", "System", "Rel", "$link"]) {
    assert(
      check(c4).some(
        (t) => t.text === token && /leaf-(?:support-function|variable-parameter)/.test(t.scopes),
      ),
      `C4: ${token}`,
    );
  }
  for (const header of [
    "railroad-beta",
    "railroad-ebnf-beta",
    "railroad-abnf-beta",
    "railroad-peg-beta",
    "radar-beta:",
    "cynefin-beta:",
    "WARDLEY-BETA",
    "xychart horizontal",
    "architecture-beta title Example",
    'packet 0-7: "Field"',
    "agentflow-beta LR",
    "swimlane-beta TD",
  ]) {
    assert(
      check(`${header}\n`).some((token) => token.scopes.includes("meta-ferriki_2d_mermaid")),
      `variant: ${header}`,
    );
  }
  const upstream = JSON.parse(
    await readFile(
      new URL("../../assets/upstream/curated/grammars/mermaid.json", import.meta.url),
      "utf8",
    ),
  );
  const expected = [
    "#info",
    "#directive",
    "#comment",
    "#flowchart",
    "#sequence-diagram",
    "#class-diagram",
    "#state-diagram",
    "#er-diagram",
    "#user-journey",
    "#gantt",
    "#pie-chart",
    "#quad-chart",
    "#requirement-diagram",
    "#gitgraph",
    "#c4c-diagram",
    "#mindmap",
    "#timeline",
    "#zenuml",
    "#sankey",
  ].sort();
  assert.deepEqual(
    upstream.repository.main.patterns.map((pattern) => pattern.include).sort(),
    expected,
    "Upstream entry points changed; review the local overlay and coverage guide",
  );
  const packet = '---\ntitle: Packet\n---\npacket-beta\n 0-7: "first\nsecond"\n +8: "next"';
  const packetTokens = check(packet);
  assert(
    packetTokens.some(
      (token) =>
        token.text.includes("second") && token.scopes.includes("string-quoted-double-mermaid"),
    ),
    "multiline packet label",
  );
  assert(
    packetTokens.some(
      (token) =>
        token.text.includes("next") && token.scopes.includes("string-quoted-double-mermaid"),
    ),
    "packet state after multiline label",
  );
  const zen = "zenuml\n // **important** and `code`\n Alice.method()";
  assert(
    check(zen).some((t) => t.text.includes("important") && t.scopes.includes("markup-bold-zenuml")),
  );
  const stringsAndComments = 'block\n columns 2\n a["columns --> end"]\n %% columns --> end';
  const protectedTokens = check(stringsAndComments);
  assert(
    protectedTokens.some(
      (t) => t.text.includes("columns --> end") && t.scopes.includes("string-quoted-double"),
    ),
  );
  assert(
    protectedTokens.some((t) => t.text.includes("columns --> end") && t.scopes.includes("comment")),
  );
  for (const source of [
    'kanban\n id["operation --> end"]',
    'ishikawa-beta\n "operation --> end"',
    'treeView-beta\n "operation --> end"',
  ]) {
    assert(
      check(source).some(
        (token) =>
          token.text.includes("operation --> end") &&
          token.scopes.includes("string-quoted-double-mermaid"),
      ),
      `quoted label: ${source}`,
    );
  }
  const malformed = 'packet\n 0-7: "unclosed\n```\nflowchart LR\n  A --> B';
  const resumed = check(malformed);
  assert(
    resumed.some(
      (t) =>
        t.text === "flowchart" &&
        t.scopes.includes("keyword-control-flowchart") &&
        !t.scopes.includes("meta-ferriki_2d_mermaid"),
    ),
    "unclosed string must end at a fence",
  );
  const badC4 = 'C4Context\nPerson(p, "unclosed\n```\nflowchart LR\n  A --> B';
  assert(
    check(badC4).some(
      (t) =>
        t.text === "flowchart" &&
        t.scopes.includes("keyword-control-flowchart") &&
        !t.scopes.includes("meta-function_2d_call-c4"),
    ),
    "unclosed C4 call must end at a fence",
  );
  // Existing grammar output must not be changed by the new diagram overlay.
  for (const source of [
    "flowchart LR\n  packet\n  A --> B",
    "sequenceDiagram\n participant Alice\n Alice->>Bob: packet",
    "classDiagram\n class Animal",
    "stateDiagram-v2\n [*] --> Still",
    "erDiagram\n CUSTOMER ||--o{ ORDER : places",
    "requirementDiagram\n requirement test {\n id: 1\n }",
    "mindmap\n root((Root))",
    "gantt\n dateFormat YYYY-MM-DD",
    "timeline\n 2023 : Event",
    "journey\n section Work",
    "gitGraph\n commit",
    'pie\n "A" : 4',
    "quadrantChart\n x-axis Low --> High",
    "sankey-beta\n A,B,10",
    "info",
    "packetExtra\n  0: value",
    "packet-betaExtra\n  0: value",
    "radar\n axis X",
    "swimlane\n subgraph X",
    "usecase\n actor X",
    "block diagrams are useful\n hello world",
    "packet delivery is delayed\n hello world",
  ]) {
    assert.equal(wasm.codeToHtml(source, opts), baseline.codeToHtml(source, opts), source);
    check(source);
  }
} finally {
  native.dispose();
  wasm.dispose();
  baseline.dispose();
}
console.log("Local Mermaid overlays verified against Ferrigura fixtures and WASM");
