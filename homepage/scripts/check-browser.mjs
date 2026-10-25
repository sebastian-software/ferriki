/* eslint-disable security/detect-non-literal-fs-filename -- Vite and axe paths are package-owned; pages come from the site route list. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";

import { expectedPages, pagePath } from "./site-pages.mjs";

const homepageRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
const requestedPort = Number(process.env.FERRIKI_PREVIEW_PORT ?? 0);
assert(
  Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535,
  "FERRIKI_PREVIEW_PORT must be a valid TCP port",
);
const selectors = {
  nav: ".site-links, .ferriki-nav",
  menu: ".site-menu, .ferriki-menu",
  summary: ".site-menu > summary, .ferriki-menu > summary",
  flyout: ".site-menu-flyout, .ferriki-menu-flyout",
  search: ".site-search input, .ferriki-search input",
};

let browser;
let previewServer;
try {
  previewServer = await preview({
    configFile: false,
    root: homepageRoot,
    logLevel: "silent",
    base: "/",
    build: { outDir: "build/client" },
    preview: {
      host: "127.0.0.1",
      port: requestedPort,
      strictPort: requestedPort !== 0,
    },
  });
  const address = previewServer.httpServer.address();
  assert(
    address && typeof address !== "string",
    "Vite preview did not expose a listening TCP address",
  );
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ colorScheme: "light" });
  for (const pageFile of expectedPages) {
    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "phone", width: 390, height: 844 },
      { name: "landscape", width: 844, height: 390 },
    ]) {
      await verifyViewport({ page, pageFile, viewport, origin });
    }
  }

  await page.goto(new URL("/evidence/benchmarks/", origin).href, { waitUntil: "load" });
  const benchmarkReport = JSON.parse(
    await readFile(new URL("../../docs/benchmarks/shiki-comparison.json", import.meta.url), "utf8"),
  );
  const yaml = benchmarkReport.warm.codeToHtml.find((row) => row.lang === "yaml");
  assert(yaml?.unsupported?.["shiki-js"], "Expected the documented YAML converter limitation");
  await page.getByLabel("Compare", { exact: true }).selectOption(yaml.path);
  assert.match(await page.locator(".ferriki-benchmark-chart").textContent(), /YAML grammar/);
  const yamlRow = page.getByRole("row").filter({ hasText: yaml.path });
  assert.match(await yamlRow.textContent(), /Unsupported/);
  assert.doesNotMatch(await page.locator("main").textContent(), /NaN|Infinity/);
  await page.getByLabel("Compare", { exact: true }).selectOption("");
  assert.doesNotMatch(await page.locator(".ferriki-benchmark-chart").textContent(), /NaN|Infinity/);
  console.log("Verified YAML's unsupported Shiki/JS state and full-corpus chart selection.");

  const memoryReport = JSON.parse(
    await readFile(
      new URL("../../docs/benchmarks/blacksmith-memory.json", import.meta.url),
      "utf8",
    ),
  );
  const memoryTable = page.getByRole("region", { name: /^RSS after repeated rendering/ });
  assert.equal(
    await memoryTable.getByRole("row").count(),
    5,
    "Expected both memory workloads on both hosts",
  );
  for (const profile of memoryReport.profiles) {
    const scenario = profile.scenarios.find((entry) => entry.id === "repository");
    const row = memoryTable.getByRole("row").filter({ hasText: `${profile.label} · 12 files` });
    const rowText = await row.textContent();
    for (const engine of ["ferriki", "shiki-wasm", "shiki-js"]) {
      const value = scenario.engines[engine].finalRss;
      const text = `${(value.median / 2 ** 20).toFixed(1)} [${(value.min / 2 ** 20).toFixed(1)}–${(value.max / 2 ** 20).toFixed(1)}]`;
      assert(
        rowText.includes(text),
        `${profile.id}/${engine}: memory value differs from verified evidence`,
      );
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await memoryTable.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
  await page.setViewportSize({ width: 844, height: 390 });
  console.log(
    "Verified process-memory medians, full ranges and keyboard scrolling on narrow screens.",
  );

  await verifyLanguageTables(page);
  await verifyRegexPolicyTables(page);

  const prismSamples = JSON.parse(
    await readFile(new URL("../app/data/prism-comparison.json", import.meta.url), "utf8"),
  );
  await page.goto(new URL("/guide/ferriki-vs-prism/", origin).href, { waitUntil: "load" });
  for (const entry of prismSamples.samples) {
    await page.getByLabel("Choose an example").selectOption(entry.id);
    const outputs = page.locator(".prism-comparison-grid pre");
    assert.equal(await outputs.count(), 2, `${entry.id}: missing comparison panel`);
    assert.equal(
      await outputs.nth(0).textContent(),
      entry.source,
      `${entry.id}: Ferriki source changed`,
    );
    assert.equal(
      await outputs.nth(1).textContent(),
      entry.source,
      `${entry.id}: Prism source changed`,
    );
    if (entry.id === "go-handler") {
      assert.match(
        await page.locator(".prism-classifications").textContent(),
        /entity\.name\.type\.go/,
      );
    }
    await verifyAccessibility(page, "guide/ferriki-vs-prism/index.html", { name: entry.id });
    if (entry.prismHtml === null) {
      assert.match(
        await page.locator(".prism-rendered figcaption").textContent(),
        /grammar unavailable/,
      );
    }
  }
  await page.getByLabel("Choose an example").selectOption("typescript-parameters");
  assert.match(
    await page.locator(".prism-classifications").textContent(),
    /variable\.parameter\.ts/,
  );
  assert.match(
    await page.locator(".prism-classifications").textContent(),
    /no token classification/,
  );
  console.log(
    `Verified all ${prismSamples.samples.length} comparison choices, unchanged source, scope evidence, and explicit unsupported state.`,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL("/guide/getting-started/", origin).href, { waitUntil: "load" });
  const summary = page.locator(selectors.summary);
  let reachedMenu = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.keyboard.press("Tab");
    if (await summary.evaluate((element) => element === document.activeElement)) {
      reachedMenu = true;
      break;
    }
  }
  assert(reachedMenu, "Tab navigation does not reach the mobile Docs menu");
  const focusStyle = await summary.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
    };
  });
  const hasOutline =
    focusStyle.outlineStyle !== "none" &&
    Number.parseFloat(focusStyle.outlineWidth) > 0 &&
    hasVisibleCssColor(focusStyle.outlineColor);
  const shadowColorStart = focusStyle.boxShadow.indexOf("(");
  const shadowColorEnd = focusStyle.boxShadow.indexOf(")", shadowColorStart);
  const shadowColor =
    shadowColorStart !== -1 && shadowColorEnd > shadowColorStart
      ? focusStyle.boxShadow.slice(
          focusStyle.boxShadow.lastIndexOf(" ", shadowColorStart) + 1,
          shadowColorEnd + 1,
        )
      : focusStyle.boxShadow.includes("transparent")
        ? "transparent"
        : "currentColor";
  const hasShadow =
    focusStyle.boxShadow !== "none" &&
    hasVisibleCssColor(shadowColor) &&
    focusStyle.boxShadow
      .replaceAll(/(?:rgba?|hsla?)\([^)]*\)/g, "")
      .split(/\s+/)
      .some((value) => {
        const metric = value.replaceAll(",", "");
        return (
          (metric.endsWith("px") || metric.endsWith("em") || metric.endsWith("rem")) &&
          Number.parseFloat(metric) !== 0
        );
      });
  const hasVisibleFocus = hasOutline || hasShadow;
  assert(hasVisibleFocus, "The mobile Docs menu has no visible keyboard focus indicator");

  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator(selectors.menu).getAttribute("open"),
    "",
    "Enter did not open the Docs menu",
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator(selectors.menu).getAttribute("open"),
    null,
    "Escape did not close the Docs menu",
  );
  assert(
    await summary.evaluate((element) => element === document.activeElement),
    "Escape did not return focus to Docs",
  );

  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent.trim()),
    "Ferriki home",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent.trim()),
    "Getting started",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent.trim()),
    "Build-time macros",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname.startsWith("/guide/build-time-macros"));
  assert.equal(
    await page.locator(selectors.menu).getAttribute("open"),
    null,
    "Selecting a page did not close the Docs menu",
  );
  console.log(
    "Verified mobile menu keyboard order, Enter navigation, Escape close, and focus return.",
  );

  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(new URL("/guide/getting-started/", origin).href, { waitUntil: "load" });
  await page.evaluate(() => globalThis.document.fonts.ready);
  const landscapeSummary = page.locator(selectors.summary);
  const flyout = page.locator(selectors.flyout);
  const compatibility = flyout.getByRole("link", { name: "Compatibility", exact: true });
  await landscapeSummary.focus();
  await page.keyboard.press("Enter");
  const linkCount = await flyout.getByRole("link").count();
  let reachedCompatibility = false;
  for (let attempt = 0; attempt < linkCount + 1; attempt++) {
    await page.keyboard.press("Tab");
    if (await compatibility.evaluate((element) => element === document.activeElement)) {
      reachedCompatibility = true;
      break;
    }
  }
  assert(reachedCompatibility, "Tab navigation does not reach Compatibility in the landscape menu");
  const [flyoutBounds, compatibilityBounds] = await Promise.all([
    flyout.boundingBox(),
    compatibility.boundingBox(),
  ]);
  assert(
    flyoutBounds && compatibilityBounds,
    "The landscape menu or Compatibility link has no visible bounds",
  );
  assert(
    flyoutBounds.y >= 0 && flyoutBounds.y + flyoutBounds.height <= 390,
    "The landscape menu exceeds the viewport height",
  );
  assert(
    compatibilityBounds.y >= flyoutBounds.y &&
      compatibilityBounds.y + compatibilityBounds.height <= flyoutBounds.y + flyoutBounds.height &&
      compatibilityBounds.y >= 0 &&
      compatibilityBounds.y + compatibilityBounds.height <= 390,
    `Keyboard focus did not bring Compatibility fully into the visible landscape menu: ${JSON.stringify({ flyoutBounds, compatibilityBounds })}`,
  );
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname.startsWith("/evidence/compatibility"));
  assert.equal(
    await page.locator(selectors.menu).getAttribute("open"),
    null,
    "Selecting Compatibility did not close the landscape menu",
  );
  console.log(
    "Verified landscape menu fits the viewport and keyboard navigation reaches Compatibility.",
  );
} finally {
  await browser?.close();
  await previewServer?.close();
}

async function verifyLanguageRow(
  details,
  entry,
  engines = ["ferriki", "shiki-wasm", "shiki-js", "prism"],
) {
  const row = details
    .getByRole("rowheader", { name: `${entry.language} · ${entry.size}`, exact: true })
    .locator("..");
  const text = await row.textContent();
  for (const id of engines) {
    const value = entry.timings[id];
    const expected =
      value === undefined
        ? "Unsupported"
        : `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
    assert(text.includes(expected), `${entry.language}/${entry.size}/${id}: stale language table`);
  }
}

async function verifyLanguageTable(page, profile, corpus) {
  const title = `${profile.label} · ${corpus === "curated" ? "Curated: 20 formats" : "TIOBE: 19 supported ranks"}`;
  const details = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: title }) });
  await details.locator("summary").click();
  const entries = profile.workloads.filter((entry) => entry.corpus === corpus);
  assert.equal(await details.getByRole("row").count(), entries.length + 1);
  for (const entry of entries) await verifyLanguageRow(details, entry);
  const table = details.getByRole("region");
  await page.setViewportSize({ width: 390, height: 844 });
  await table.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
  await details.locator("summary").click();
}

async function verifyLanguageTables(page) {
  const { profiles } = JSON.parse(
    await readFile(
      new URL("../../docs/benchmarks/blacksmith-comparison.json", import.meta.url),
      "utf8",
    ),
  );
  for (const profile of profiles) {
    for (const corpus of ["curated", "tiobe"]) await verifyLanguageTable(page, profile, corpus);
  }
  console.log(
    "Verified all 156 curated/TIOBE rows, unsupported states and narrow-screen table scrolling.",
  );
}

async function verifyRegexPolicyTables(page) {
  const report = JSON.parse(
    await readFile(
      new URL("../../docs/benchmarks/regex-modes-comparison.json", import.meta.url),
      "utf8",
    ),
  );
  const engines = report.engines.map(({ id }) => id);
  const overview = page.getByRole("region", { name: /^Regex policies on the same/ });
  assert.equal(await overview.getByRole("row").count(), 5);
  for (const profile of report.profiles) {
    for (const corpus of ["curated", "tiobe"])
      await verifyRegexPolicyLanguage({ page, profile, corpus, engines });
    await verifyRegexPolicyMemory(page, profile, engines);
  }
  console.log(
    "Verified all 156 regex-mode rows, seven contenders, memory ranges and keyboard scrolling.",
  );
}
async function verifyRegexPolicyColumns(details, entries, engines) {
  assert.equal(await details.getByRole("row").count(), entries.length + 1);
  assert.equal(await details.getByRole("columnheader").count(), engines.length + 1);
  for (const entry of entries) await verifyLanguageRow(details, entry, engines);
}
async function verifyRegexPolicyLanguage({ page, profile, corpus, engines }) {
  const title = `Regex modes · ${profile.label} · ${corpus === "curated" ? "20 formats" : "TIOBE"}`;
  const details = page.locator("details").filter({ has: page.getByText(title, { exact: true }) });
  await details.locator("summary").click();
  await verifyRegexPolicyColumns(
    details,
    profile.workloads.filter((entry) => entry.corpus === corpus),
    engines,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await details.getByRole("region").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
  await details.locator("summary").click();
}
async function verifyRegexPolicyMemory(page, profile, engines) {
  const title = `Regex modes · ${profile.label} · process memory`;
  const details = page.locator("details").filter({ has: page.getByText(title, { exact: true }) });
  await details.locator("summary").click();
  assert.equal(await details.getByRole("row").count(), 7);
  for (const scenario of profile.memory.scenarios) {
    const row = details
      .getByRole("rowheader", { name: `${scenario.id} · after reuse`, exact: true })
      .locator("..");
    const text = await row.textContent();
    for (const id of engines.filter((id) => id !== "prism")) {
      const value = scenario.engines[id].finalRss;
      assert(
        text.includes(
          `${(value.median / 2 ** 20).toFixed(1)} [${(value.min / 2 ** 20).toFixed(1)}–${(value.max / 2 ** 20).toFixed(1)}]`,
        ),
        `${profile.id}/${id}: wrong mode RSS`,
      );
    }
  }
  await details.locator("summary").click();
}

async function verifyViewport({ page, pageFile, viewport, origin }) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(new URL(pagePath(pageFile), origin).href, { waitUntil: "load" });
  const layout = await page.evaluate(() => ({
    width: globalThis.document.documentElement.clientWidth,
    pageWidth: Math.max(
      globalThis.document.documentElement.scrollWidth,
      globalThis.document.body.scrollWidth,
    ),
  }));
  assert(
    layout.pageWidth <= layout.width + 1,
    `${pageFile} has horizontal page overflow at ${viewport.name} width ${viewport.width}px: ${layout.pageWidth}px`,
  );

  if (pageFile === "index.html") await verifyMacroSample(page, viewport);

  const navDisplay = await page
    .locator(selectors.nav)
    .evaluate((element) => getComputedStyle(element).display);
  const menuDisplay = await page
    .locator(selectors.menu)
    .evaluate((element) => getComputedStyle(element).display);
  assert(
    await page.locator(selectors.search).isVisible(),
    "The site should keep search visible at each checked viewport",
  );
  if (viewport.name === "desktop") {
    assert.notEqual(navDisplay, "none", `${pageFile} hides desktop section navigation`);
    assert.equal(menuDisplay, "none", `${pageFile} shows the phone navigation on desktop`);
  } else {
    assert.equal(
      navDisplay,
      "none",
      `${pageFile} shows desktop navigation at ${viewport.name} width`,
    );
    assert.notEqual(
      menuDisplay,
      "none",
      `${pageFile} hides the phone navigation at ${viewport.name} width`,
    );
  }
  await verifyAccessibility(page, pageFile, viewport);
  console.log(`Verified ${pageFile} at ${viewport.name} (${viewport.width}px).`);
}
async function verifyMacroSample(page, viewport) {
  const sample = page.locator(".ferriki-macro-sample");
  assert.equal(await sample.count(), 1, "Homepage must show the Vite macro example");
  const figures = sample.locator("figure");
  assert.equal(await figures.count(), 2, "Expected source and prepared-result panels");
  await verifyMacroContent(sample, figures);
  await verifyMacroLayout(figures, viewport);
  await verifyMacroKeyboard(page, figures);
}

async function verifyMacroContent(sample, figures) {
  const input = figures.nth(0).locator("pre");
  const output = figures.nth(1).locator("pre");
  assert.match(await input.textContent(), /@ferriki\/core\/react\/macro/);
  const outputText = await output.textContent();
  assert.equal(outputText, "export const answer = 42;");
  assert(outputText.length < 128, "The visible prepared result should stay compact");
  assert.doesNotMatch(
    await sample.textContent(),
    /FerrikiMacroRenderHelper|FerrikiCodeBlocks|FerrikiDefineCodeElement/,
    "The full transform should remain a separate inspection artifact",
  );
  assert.equal(await input.getAttribute("tabindex"), "0");
  assert.equal(await output.getAttribute("tabindex"), "0");
}

async function verifyMacroLayout(figures, viewport) {
  const input = figures.nth(0).locator("pre");
  const output = figures.nth(1).locator("pre");
  const [inputBounds, outputBounds] = await Promise.all([
    input.boundingBox(),
    output.boundingBox(),
  ]);
  assert(inputBounds && outputBounds, "Both macro panels need visible bounds");
  if (viewport.width <= 700) {
    assert(outputBounds.y > inputBounds.y, "The macro panels should stack on a phone");
    return;
  }
  assert(outputBounds.x > inputBounds.x, "The macro panels should read from left to right");
  assert(
    Math.abs(outputBounds.y - inputBounds.y) < 2,
    "The macro panels should align at the top on wider screens",
  );
}

async function verifyMacroKeyboard(page, figures) {
  const input = figures.nth(0).locator("pre");
  const output = figures.nth(1).locator("pre");
  await input.focus();
  await page.keyboard.press("Tab");
  assert(
    await output.evaluate((element) => element === document.activeElement),
    "Keyboard focus should move from the Vite input to the prepared output",
  );
  const outline = await output.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  assert(
    outline.style !== "none" && outline.width >= 2,
    "The focused prepared output should have a visible focus indicator",
  );
}

async function verifyAccessibility(page, pageFile, viewport) {
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(async () =>
    globalThis.axe.run(globalThis.document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    }),
  );
  if (results.violations.length === 0) return;
  const details = results.violations
    .map((violation) => {
      const targets = violation.nodes
        .map((node) => `  ${node.target.join(", ")}: ${node.failureSummary}`)
        .join("\n");
      return `${violation.id} (${violation.impact}): ${violation.help}\n${targets}`;
    })
    .join("\n");
  throw new Error(`Accessibility violations on ${pageFile} at ${viewport.name} width:\n${details}`);
}

function hasVisibleCssColor(color) {
  const normalized = color.toLowerCase();
  if (normalized === "transparent") return false;
  const functionStart = normalized.indexOf("(");
  const functionEnd = normalized.lastIndexOf(")");
  if (functionStart === -1 || functionEnd < functionStart) return true;
  const functionName = normalized.slice(0, functionStart);
  const channels = normalized.slice(functionStart + 1, functionEnd).split("/");
  if (channels.length === 1) {
    if (functionName !== "rgba" && functionName !== "hsla") return true;
    const commaValues = channels[0].split(",");
    if (commaValues.length !== 4) return true;
    return Number.parseFloat(commaValues.at(-1).trim()) > 0;
  }
  const alpha = channels.at(-1).trim();
  return Number.parseFloat(alpha) > 0;
}
