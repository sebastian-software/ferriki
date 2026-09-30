/* eslint-disable antfu/no-top-level-await -- The browser harness loads its fixed corpus before enabling controls. */
const dataText = await fetch("/production.json").then((response) => response.text());
const data = JSON.parse(dataText);
const dataSha256 = [
  ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataText))),
]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");
const style = document.createElement("style");
style.textContent = data.css;
document.head.append(style);
const fixtures = document.querySelector("#fixtures");
fixtures.innerHTML = data.cases.map((item) => `<section>${item.html}</section>`).join("");
const roots = [...fixtures.children].map((node) => node.firstElementChild);
const tokens = roots.map((root) => [...root.querySelectorAll(".token")]);
const original = tokens.flat();
const probe = document.createElement("span");
fixtures.append(probe);
const theme = document.querySelector("#theme");
const example = document.querySelector("#case");
for (const value of data.themes) theme.add(new Option(value, value));
for (const item of data.cases) example.add(new Option(item.id, item.id));
theme.value = "monokai";
example.value = "json-object";
function show() {
  const item = data.cases.find((candidate) => candidate.id === example.value);
  const gallery = document.querySelector("#gallery");
  if (gallery.dataset.case !== item.id) {
    gallery.innerHTML = item.html;
    gallery.dataset.case = item.id;
  }
  gallery.dataset.ferrikiTheme = theme.value;
}
example.addEventListener("change", show);
theme.addEventListener("change", show);
show();
const status = document.querySelector("#status");
status.textContent = `${data.cases.length} cases · ${data.themes.length} themes · ready`;
const fontStyle = (font) => [
  font & 1 ? "italic" : "normal",
  font & 2 ? "700" : "400",
  [font & 4 ? "underline" : "", font & 8 ? "line-through" : ""].filter(Boolean).join(" ") || "none",
];
const snapshot = (node) => {
  const s = getComputedStyle(node);
  return [s.color, s.fontStyle, s.fontWeight, s.textDecorationLine];
};
function expectedTarget(task, token) {
  const has = (prefix) =>
    token.scopes.some((scope) => scope === prefix || scope.startsWith(`${prefix}.`));
  const context = (prefix) =>
    token.scopes.slice(0, -1).some((scope) => scope === prefix || scope.startsWith(`${prefix}.`));
  const leaf = (prefix) =>
    token.scopes.at(-1) === prefix || token.scopes.at(-1).startsWith(`${prefix}.`);
  const targets = {
    strings: () => has("string"),
    comments: () => has("comment"),
    keywords: () => has("keyword"),
    numbers: () => has("constant.numeric"),
    functions: () => has("entity.name.function"),
    types: () => has("entity.name.type"),
    parameters: () => has("variable.parameter"),
    escapes: () => has("string") && has("constant.character.escape"),
    "json-keys": () => has("support.type.property-name.json"),
    "json-values": () =>
      context("meta.structure.dictionary.json") && leaf("string.quoted.double.json"),
    "template-variables": () => context("string.template") && has("variable"),
    "html-tags": () => has("entity.name.tag.html"),
    "html-attributes": () => has("entity.other.attribute-name.html"),
    "embedded-js": () => context("text.html") && context("source.js") && has("keyword"),
    "css-classes": () => has("entity.other.attribute-name.class"),
    "markdown-heading": () => has("markup.heading"),
    "python-docstring": () => has("string.quoted.docstring"),
    "regex-escapes": () => context("string.regexp") && has("constant.character.escape"),
    "scope-order": () =>
      token.scopes.join(" ") === "source.class-probe meta.a meta.b entity.name.probe",
    "scope-repetition": () =>
      token.scopes.join(" ") === "source.class-probe meta.a meta.a entity.name.probe",
  };
  return targets[task.id]();
}

const stylingTasks = [
  ["strings", ".tok-string"],
  ["comments", ".tok-comment"],
  ["keywords", ".tok-keyword"],
  ["numbers", ".tok-constant-numeric"],
  ["functions", ".tok-entity-name-function"],
  ["types", ".tok-entity-name-type"],
  ["parameters", ".tok-variable-parameter"],
  ["escapes", ".tok-string.tok-constant-character-escape"],
  ["json-keys", ".tok-support-type-property_2d_name-json"],
  ["json-values", ".scope-meta-structure-dictionary-json .leaf-string-quoted-double-json"],
  ["template-variables", ".scope-string-template .tok-variable"],
  ["html-tags", ".tok-entity-name-tag-html"],
  ["html-attributes", ".tok-entity-other-attribute_2d_name-html"],
  ["embedded-js", ".scope-text-html .scope-source-js .tok-keyword"],
  ["css-classes", ".tok-entity-other-attribute_2d_name-class"],
  ["markdown-heading", ".tok-markup-heading"],
  ["python-docstring", ".tok-string-quoted-docstring"],
  ["regex-escapes", ".scope-string-regexp .tok-constant-character-escape"],
  ["scope-order", ".scope-meta-a > .scope-meta-b > .scope-entity-name-probe > .token"],
  ["scope-repetition", ".scope-meta-a > .scope-meta-a > .scope-entity-name-probe > .token"],
];

document.querySelector("#run").addEventListener("click", async () => {
  let checked = 0;
  const mismatches = [];
  const sourcePreserved = roots.every((root, index) => root.textContent === data.cases[index].code);
  for (const name of data.themes) {
    fixtures.dataset.ferrikiTheme = name;
    for (const [caseIndex, item] of data.cases.entries()) {
      if (tokens[caseIndex].length !== item.expected.length)
        throw new Error(`Token count: ${item.id}`);
      for (const [index, token] of item.expected.entries()) {
        const expected = data.styles[name][token.id];
        probe.style.color = expected.color;
        const wanted = [getComputedStyle(probe).color, ...fontStyle(expected.fontStyle || 0)];
        const actual = snapshot(tokens[caseIndex][index]);
        checked++;
        if (JSON.stringify(actual) !== JSON.stringify(wanted) && mismatches.length < 25)
          mismatches.push({
            theme: name,
            case: item.id,
            token: index,
            content: token.content,
            actual,
            wanted,
          });
      }
    }
    status.textContent = `Checking ${name}: ${checked} styles, ${mismatches.length} mismatches`;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const own = document.createElement("style");
  own.textContent = ".tok-string{color:rgb(18,52,86)}";
  document.head.append(own);
  const customOverride = original
    .filter((node) => node.classList.contains("tok-string"))
    .every((node) => getComputedStyle(node).color === "rgb(18, 52, 86)");
  own.remove();
  const tasks = [];
  for (const [id, selector] of stylingTasks) {
    const baseline = tokens.map((line) => line.map((node) => getComputedStyle(node).color));
    own.textContent = `#fixtures ${selector}{color:rgb(18,52,86)}`;
    document.head.append(own);
    let targets = 0;
    let errors = 0;
    for (const [caseIndex, item] of data.cases.entries()) {
      for (const [index, token] of item.expected.entries()) {
        const wanted = expectedTarget({ id }, token);
        targets += Number(wanted);
        const actual = getComputedStyle(tokens[caseIndex][index]).color;
        if (actual !== (wanted ? "rgb(18, 52, 86)" : baseline[caseIndex][index])) errors++;
      }
    }
    tasks.push({ id, targets, errors, passed: targets > 0 && errors === 0 });
    own.remove();
  }
  const result = {
    checked,
    dataSha256,
    tasks,
    mismatches,
    sourcePreserved,
    customOverride,
    domPreserved: original.every((node) => node.isConnected),
    metrics: data.metrics,
    browser: navigator.userAgent,
  };
  await fetch("/results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  });
  status.textContent = JSON.stringify(result, null, 2);
});
