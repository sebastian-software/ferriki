/* eslint-disable antfu/no-top-level-await -- This standalone experiment loads its local corpus before enabling the controls. */
const dataText = await fetch("/data.json").then((response) => response.text());
const data = JSON.parse(dataText);
const customCss = await fetch("/custom-theme.css").then((response) => response.text());
const dataSha256 = [
  ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataText))),
]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");
const models = ["flat", "nested", "hybrid"];
const status = document.querySelector("#status");
const testRoot = document.querySelector("#test-fixtures");
const themeStyle = document.querySelector("#theme-css");
const taskStyle = document.querySelector("#task-css");
const colorMarker = "rgb(18, 52, 86)";

function declaration(style) {
  const font = style.fontStyle || 0;
  return `color:${style.color};font-style:${font & 1 ? "italic" : "normal"};font-weight:${font & 2 ? "700" : "400"};text-decoration-line:${[font & 4 ? "underline" : "", font & 8 ? "line-through" : ""].filter(Boolean).join(" ") || "none"}`;
}

function cssForTheme(theme) {
  const styles = data.styles[theme];
  const css = [];
  for (const model of models) {
    const seen = new Set();
    for (const path of data.paths) {
      const selector = path.selectors[model];
      // A flat class collision cannot receive two different declarations.
      // Keep the first declaration so the browser exposes the lost distinction.
      if (seen.has(selector)) continue;
      seen.add(selector);
      css.push(`.model-${model} :where(${selector}){${declaration(styles[path.id])}}`);
    }
  }
  css.push(
    `.fixture{color:${data.defaults[theme].color};background:${data.defaults[theme].background}}`,
  );
  return css.join("\n");
}

function snapshotStyle(element) {
  const style = getComputedStyle(element);
  return [style.color, style.fontStyle, style.fontWeight, style.textDecorationLine].join("|");
}

const mount = document.createElement("div");
mount.innerHTML = data.cases
  .map(
    (item) =>
      `<section data-case="${item.id}">${models.map((model) => `<pre class="fixture model-${model}">${item.html[model]}</pre>`).join("")}</section>`,
  )
  .join("");
testRoot.append(mount);
const nodes = models.map((model) =>
  data.cases.map((item) => [
    ...mount.querySelector(`[data-case="${item.id}"] .model-${model}`).querySelectorAll(".token"),
  ]),
);
const originalNodes = nodes.flat(2);
const expectedProbe = document.createElement("span");
testRoot.append(expectedProbe);

document.querySelector("#inventory").textContent =
  `${data.cases.length} cases · ${new Set(data.cases.map((item) => item.lang)).size} languages · ${Object.keys(data.styles).length} themes · ${data.paths.length} distinct scope paths`;
document.querySelector("#metrics").innerHTML = data.modelResults
  .map(
    (result) =>
      `<tr><td>${result.model}</td><td>${(result.gzipHtmlBytes / 1024).toFixed(1)} KiB</td><td>${result.spans}</td><td>${result.lostPathGroups.length}</td><td>${result.themeConflicts.length}</td></tr>`,
  )
  .join("");
const themeSelect = document.querySelector("#theme");
const caseSelect = document.querySelector("#case");
const modelSelect = document.querySelector("#model");
for (const theme of Object.keys(data.styles)) themeSelect.add(new Option(theme, theme));
themeSelect.add(new Option("Custom CSS palette", "custom-css"));
for (const item of data.cases) caseSelect.add(new Option(`${item.id} (${item.split})`, item.id));
themeSelect.value = "github-dark";

function showGallery() {
  const custom = themeSelect.value === "custom-css";
  themeStyle.textContent = custom ? customCss : cssForTheme(themeSelect.value);
  const item = data.cases.find((value) => value.id === caseSelect.value);
  const model = modelSelect.value;
  document.querySelector("#gallery").innerHTML =
    `<pre class="fixture model-${model}">${item.html[model]}</pre>`;
  document.querySelector("#gallery").classList.toggle("demo", custom);
}
document.querySelector("#palette").addEventListener("click", () => {
  themeSelect.value = "custom-css";
  const gallery = document.querySelector("#gallery");
  gallery.dataset.theme = gallery.dataset.theme === "dark" ? "light" : "dark";
  showGallery();
});
for (const control of [themeSelect, caseSelect, modelSelect])
  control.addEventListener("change", showGallery);
showGallery();
status.textContent = "Corpus ready. Browser verification has not run yet.";

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

function taskSelector(task, model, fallback = false) {
  if (task.flatSelector) return task.flatSelector;
  if (model === "nested") {
    return task.id === "scope-order"
      ? ".scope-meta-a > .scope-meta-b > .scope-entity-name-probe > .token"
      : ".scope-meta-a > .scope-meta-a > .scope-entity-name-probe > .token";
  }
  if (model === "hybrid" && fallback) {
    return data.paths
      .filter((path) => expectedTarget(task, path))
      .map((path) => `.${path.id}`)
      .join(",");
  }
  return task.id === "scope-order"
    ? ".ctx-meta-a.ctx-meta-b.leaf-entity-name-probe"
    : ".ctx-meta-a.leaf-entity-name-probe";
}

async function verifyTasks() {
  themeStyle.textContent = cssForTheme("github-dark");
  const baseline = nodes.map((cases) =>
    cases.map((tokens) => tokens.map((token) => getComputedStyle(token).color)),
  );
  const results = [];
  for (const task of data.tasks) {
    const perModel = [];
    for (const [modelIndex, model] of models.entries()) {
      for (const fallback of model === "hybrid" && !task.flatSelector ? [false, true] : [false]) {
        const selector = taskSelector(task, model, fallback);
        taskStyle.textContent = selector
          .split(",")
          .map((part) => `#test-fixtures .model-${model} ${part}{color:#123456}`)
          .join("\n");
        let targets = 0;
        let missed = 0;
        let unintended = 0;
        for (const [caseIndex, item] of data.cases.entries()) {
          for (const [tokenIndex, token] of item.tokens.entries()) {
            const expected = expectedTarget(task, token);
            const actual = getComputedStyle(nodes[modelIndex][caseIndex][tokenIndex]).color;
            if (expected) {
              targets++;
              if (actual !== colorMarker) missed++;
            } else if (actual !== baseline[modelIndex][caseIndex][tokenIndex]) unintended++;
          }
        }
        perModel.push({
          model,
          fallback,
          selector,
          targets,
          missed,
          unintended,
          passed: targets > 0 && missed === 0 && unintended === 0,
        });
      }
    }
    taskStyle.textContent = "";
    results.push({ ...task, results: perModel });
    await new Promise(requestAnimationFrame);
  }
  return results;
}

document.querySelector("#run").addEventListener("click", async () => {
  document.querySelector("#run").disabled = true;
  try {
    const fidelity = models.map((model) => ({
      model,
      tokenChecks: 0,
      mismatches: 0,
      byTheme: {},
      examples: [],
    }));
    for (const [themeIndex, theme] of Object.keys(data.styles).entries()) {
      status.textContent = `Checking theme ${themeIndex + 1}/${Object.keys(data.styles).length}: ${theme}`;
      themeStyle.textContent = cssForTheme(theme);
      const expected = new Map();
      for (const path of data.paths) {
        expectedProbe.style.cssText = declaration(data.styles[theme][path.id]);
        expected.set(path.id, snapshotStyle(expectedProbe));
      }
      for (const [modelIndex, model] of models.entries()) {
        const result = fidelity[modelIndex];
        let themeMismatches = 0;
        for (const [caseIndex, item] of data.cases.entries()) {
          for (const [tokenIndex, token] of item.tokens.entries()) {
            const element = nodes[modelIndex][caseIndex][tokenIndex];
            if (element.textContent !== token.content)
              throw new Error(`Source changed: ${model}/${item.id}/${tokenIndex}`);
            result.tokenChecks++;
            const actual = snapshotStyle(element);
            if (actual !== expected.get(token.id)) {
              result.mismatches++;
              themeMismatches++;
              if (result.examples.length < 12)
                result.examples.push({
                  theme,
                  case: item.id,
                  text: token.content,
                  scopes: token.scopes,
                  expected: expected.get(token.id),
                  actual,
                });
            }
          }
        }
        if (themeMismatches) result.byTheme[theme] = themeMismatches;
      }
      await new Promise(requestAnimationFrame);
    }
    status.textContent = "Checking handwritten CSS tasks…";
    const taskResults = await verifyTasks();
    themeStyle.textContent = customCss;
    testRoot.classList.add("demo");
    const stringCaseIndex = data.cases.findIndex((item) => item.id === "json-root");
    const customPalette = [];
    for (const [palette, expectedColor] of [
      ["light", "rgb(17, 99, 41)"],
      ["dark", "rgb(165, 214, 255)"],
    ]) {
      testRoot.dataset.theme = palette;
      customPalette.push({
        palette,
        passed: nodes.every((cases) =>
          cases[stringCaseIndex].every((token) => getComputedStyle(token).color === expectedColor),
        ),
      });
    }
    testRoot.classList.remove("demo");
    const taskSummary = models.map((model) => {
      const simple = taskResults.filter((task) =>
        task.results.some((result) => result.model === model && !result.fallback && result.passed),
      );
      return {
        model,
        simplePassed: simple.length,
        total: taskResults.length,
        developmentPassed: simple.filter((task) => task.split === "development").length,
        holdoutPassed: simple.filter((task) => task.split === "holdout").length,
        withFallbackPassed: taskResults.filter((task) =>
          task.results.some((result) => result.model === model && result.passed),
        ).length,
      };
    });
    const result = {
      dataSha256,
      userAgent: navigator.userAgent,
      fidelity,
      taskSummary,
      tasks: taskResults,
      customPalette,
      themeSwitchPreservedNodes: originalNodes.every((node) => node.isConnected),
      sourcePreserved: data.cases.every((item) =>
        models.every(
          (model) =>
            mount.querySelector(`[data-case="${item.id}"] .model-${model}`).textContent ===
            item.code,
        ),
      ),
    };
    document.querySelector("#result").textContent = JSON.stringify(
      { ...result, tasks: undefined },
      null,
      2,
    );
    document.querySelector("#task-results").innerHTML = taskResults
      .map(
        (task) =>
          `<li><strong>${task.title}</strong> (${task.split}) — ${task.results.map((value) => `${value.model}${value.fallback ? " fallback" : ""}: ${value.passed ? "PASS" : "FAIL"}`).join(" · ")}</li>`,
      )
      .join("");
    const response = await fetch("/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    if (!response.ok) throw new Error("Could not save browser evidence");
    status.textContent = "Browser verification complete. Results saved locally.";
    showGallery();
  } catch (error) {
    status.textContent = `Verification failed: ${error.message}`;
    document.querySelector("#result").textContent = error.stack;
  } finally {
    document.querySelector("#run").disabled = false;
  }
});
