/* eslint-disable no-template-curly-in-string -- Fixtures contain literal source-code interpolation. */
import assert from "node:assert/strict";
import { fromHtml } from "hast-util-from-html";
import { createHighlighter } from "../ferriki/index.mjs";
import { createEngine, theme, validateOutput } from "./tiobe-benchmark.mjs";
import "./test-asset-env.mjs";

const cssProperty = /(?:support-type|meta)-property_2d_name-(?:css|scss)/;
const htmlTag = /entity-name-tag(?:-[a-z]+)*-html/;
const variable = /(?:variable-other|support-variable)/;
const examples = [];
function example(name, lang, code, tokens) {
  examples.push({ name, lang, code, tokens });
}
for (const lang of ["javascript", "typescript", "jsx", "tsx"]) {
  example(
    `Styled Components in ${lang}`,
    lang,
    "const Button = styled.button`color: red; &:hover { color: blue; }`;\nconst after = 42;",
    [["color", cssProperty]],
  );
  example(
    `Emotion declarations in ${lang}`,
    lang,
    "const styles = css`color: red; padding: 8px;`;\nconst after = 42;",
    [["color", cssProperty]],
  );
  example(
    `Lit templates in ${lang}`,
    lang,
    'const styles = css`:host { color: red; }`;\nconst view = html`<button>${label}</button>`;\nconst icon = svg`<circle cx="10" />`;\nconst after = 42;',
    [
      ["color", cssProperty],
      ["button", htmlTag],
      ["circle", htmlTag],
      ["label", variable],
    ],
  );
  example(
    `Lit bindings and quoted attributes in ${lang}`,
    lang,
    'class Greeting extends LitElement {\n static styles = css`:host { color: red; }`;\n render() { return html`<button @click=${this.greet} .value=${this.name} ?disabled=${this.busy} class="${this.kind}">${this.name}</button>`; }\n}\nconst icon = svg`<circle cx="${size}" />`;\nconst after = 42;',
    [
      ["color", cssProperty],
      ["button", htmlTag],
      ["circle", htmlTag],
      ["greet", variable],
      ["name", variable],
      ["busy", variable],
      ["kind", variable],
      ["size", variable],
    ],
  );
}
example(
  "Styled Components types, attributes, and interpolation",
  "tsx",
  'const Button = styled.button.attrs({ type: "button" })<{ $active: boolean }>`color: ${props => props.$active ? "red" : "blue"};`;\nconst after = 42;',
  [
    ["color", cssProperty],
    ["props", variable],
  ],
);
example(
  "Styled Components wrapper and keyframes",
  "typescript",
  "const Button = styled(Component)`color: red;`;\nconst pulse = keyframes`from { opacity: 0; } to { opacity: 1; }`;\nconst after = 42;",
  [
    ["color", cssProperty],
    ["opacity", cssProperty],
  ],
);
for (const lang of ["jsx", "tsx"]) {
  example(
    `Emotion CSS prop in ${lang}`,
    lang,
    "const view = <div css={`color: red;`}>Hello</div>;\nconst after = 42;",
    [["color", cssProperty]],
  );
  example(
    `Styled JSX in ${lang}`,
    lang,
    "const view = <style jsx>{`div { color: red; }`}</style>;\nconst after = 42;",
    [["color", cssProperty]],
  );
  example(
    `Multiline global Styled JSX in ${lang}`,
    lang,
    "const view = <style jsx global>\n  {`\n    div { color: red; }\n  `}\n</style>;\nconst after = 42;",
    [["color", cssProperty]],
  );
}
example("Handlebars blocks and HTML", "hbs", "<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>", [
  ["li", htmlTag],
  ["each", /(?:keyword|support|entity)-/],
]);
example(
  "Liquid filters and dynamic attributes",
  "liquid",
  '{% assign greeting = "Hello" %}\n<a class="{{ theme }}">{{ greeting | escape }}</a>\n<style>.card { color: {{ color }}; }</style>',
  [
    ["assign", /(?:keyword|entity)-/],
    ["escape", /(?:support|entity)-/],
    ["theme", /liquid/],
    ["color", cssProperty],
  ],
);
for (const lang of ["gjs", "gts"]) {
  example(
    `Glimmer component in ${lang}`,
    lang,
    'import Component from "@glimmer/component";\nexport default class Greeting extends Component {\n  <template>\n    <button {{on "click" this.greet}}>{{@name}}</button>\n  </template>\n}\nconst after = 42;',
    [
      ["button", htmlTag],
      ["greet", /(?:variable|entity|support)-/],
    ],
  );
}

function scopedText(html) {
  const tokens = [];
  function visit(node, classes = []) {
    const scopes = [...classes, ...(node.properties?.className ?? [])];
    if (node.type === "text") tokens.push({ text: node.value, scopes: scopes.join(" ") });
    for (const child of node.children ?? []) visit(child, scopes);
  }
  visit(fromHtml(html, { fragment: true }));
  return tokens;
}

for (const { name, lang, code, tokens } of examples) {
  // Only load the host. Injections and their dependencies must be automatic.
  const native = await createHighlighter({ langs: [lang], themes: [theme] });
  let reference;
  try {
    reference = await createEngine("shiki-wasm", { textmate: lang });
    const actual = native.codeToHtml(code, { lang, theme });
    const validation = validateOutput("ferriki", code, actual, { html: reference.html(code) });
    assert.equal(validation.sourcePreserved, true, name);
    assert.equal(validation.highlighted, true, name);
    assert.deepEqual(validation.referenceParity, { html: true }, name);
    assert(actual.includes("color:"), `${name}: colored output`);
    const scoped = scopedText(native.codeToHtml(code, { lang, theme, styleMode: "classes" }));
    for (const [text, scope] of tokens) {
      const matches = scoped.filter((token) => token.text === text);
      assert(
        matches.some((token) => scope.test(token.scopes)),
        `${name}: ${text} must have ${scope}; got ${matches.map((token) => token.scopes).join(" | ")}`,
      );
    }
    const after = scoped.find((token) => token.text === "after");
    if (after) {
      assert.match(after.scopes, variable, `${name}: host resumes after the template`);
      assert.doesNotMatch(after.scopes, /(?:tok|exact)-source-css/, `${name}: CSS scope must end`);
    }
  } finally {
    native.dispose();
    reference?.dispose();
  }
}
console.log(`Frontend grammar coverage verified: ${examples.length} native/WASM examples`);
