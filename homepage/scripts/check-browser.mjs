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
    "Migrating from Shiki",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname.startsWith("/guide/migrating-from-shiki"));
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
    "Keyboard focus did not bring Compatibility fully into the visible landscape menu",
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

  const navDisplay = await page
    .locator(selectors.nav)
    .evaluate((element) => getComputedStyle(element).display);
  const menuDisplay = await page
    .locator(selectors.menu)
    .evaluate((element) => getComputedStyle(element).display);
  const searchVisible = await page.locator(selectors.search).isVisible();
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
  assert(searchVisible, `${pageFile} hides search at ${viewport.name} width`);
  await verifyAccessibility(page, pageFile, viewport);
  console.log(`Verified ${pageFile} at ${viewport.name} (${viewport.width}px).`);
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
