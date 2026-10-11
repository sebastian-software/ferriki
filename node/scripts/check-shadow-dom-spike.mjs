#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createHighlighter } from "../ferriki/index.mjs";
import { ferriki } from "../vite/index.mjs";
import "./test-asset-env.mjs";

const nodeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(nodeRoot, "examples", "shadow-dom");
const depsRoot = resolve(
  process.env.FERRIKI_SHADOW_BENCH_DEPS_ROOT ?? "/private/tmp/ferriki-react-jsx-spike-deps",
);
const depsRequire = createRequire(join(depsRoot, "__ferriki-shadow-check__.cjs"));
let playwright;
try {
  playwright = depsRequire("playwright");
} catch (error) {
  throw new Error(
    "Install the temporary React, ReactDOM, and Playwright dependencies described in the example README and set FERRIKI_SHADOW_BENCH_DEPS_ROOT.",
    { cause: error },
  );
}
const browserTypes = {
  chromium: playwright.chromium,
  firefox: playwright.firefox,
  webkit: playwright.webkit,
};
const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-shadow-check-"));
const options = parseArguments(process.argv.slice(2));
const serveOnly = options.serve;
let browser;

function parseArguments(args) {
  const options = { serve: false, browsers: ["chromium"] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log(
        [
          "Usage: node scripts/check-shadow-dom-spike.mjs [options]",
          "",
          "Options:",
          "  --serve                    Start the demo server without launching a browser",
          "  --browsers <list>          Comma-separated browser engines (default: chromium)",
          "                             Supported: chromium, firefox, webkit",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (argument === "--serve") {
      options.serve = true;
      continue;
    }
    if (argument === "--browsers") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --browsers");
      options.browsers = value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  assert(options.browsers.length > 0, "--browsers requires at least one browser engine");
  assert.equal(
    new Set(options.browsers).size,
    options.browsers.length,
    "--browsers cannot contain duplicates",
  );
  for (const name of options.browsers)
    assert(Object.hasOwn(browserTypes, name), `Unsupported browser engine: ${name}`);
  return options;
}

function tokenStyles(host) {
  const root = host.shadowRoot ?? host;
  const pre = root.querySelector("pre");
  const token =
    root.querySelector(".tok-keyword") ??
    root.querySelector("code span[style]") ??
    root.querySelector("code span span");
  return {
    color: getComputedStyle(token).color,
    font: getComputedStyle(token).fontFamily,
    fontStyle: getComputedStyle(token).fontStyle,
    background: getComputedStyle(pre).backgroundColor,
    lineNumber: getComputedStyle(root.querySelector("[data-ln]"), "::before").content,
    selectedLineBackground: getComputedStyle(root.querySelector(".highlighted")).backgroundColor,
  };
}

// Set an actual document Selection consistently in light and shadow trees.
async function selectCodeText(locator) {
  return locator.evaluate((code) => {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let first;
    let last;
    let firstOffset = 0;
    let lastOffset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (!text) continue;
      const firstCharacter = text.search(/[^\r\n]/u);
      if (!first && firstCharacter !== -1) {
        last = node;
        first = node;
        firstOffset = firstCharacter;
      }
      let nodeEnd = text.length;
      while (nodeEnd > 0 && /[\r\n]/u.test(text[nodeEnd - 1])) nodeEnd--;
      if (nodeEnd > 0) {
        last = node;
        lastOffset = nodeEnd;
      }
    }
    if (!first || !last || lastOffset === 0 || (last === first && lastOffset <= firstOffset))
      throw new Error("Could not find the first and last rendered code characters");

    const selection = document.getSelection();
    if (!selection) throw new Error("The document does not expose a Selection");
    selection.removeAllRanges();
    selection.setBaseAndExtent(first, firstOffset, last, lastOffset);
    return selection.toString();
  });
}

async function writeFontFixture(project, styleMode) {
  const light = {
    name: "spike-light-font-flags",
    type: "light",
    fg: "#111111",
    bg: "#ffffff",
    settings: [
      { scope: "keyword", settings: { foreground: "#aa0000", fontStyle: "italic bold underline" } },
    ],
  };
  const dark = {
    name: "spike-dark-no-font-flags",
    type: "dark",
    fg: "#eeeeee",
    bg: "#111111",
    settings: [{ scope: "keyword", settings: { foreground: "#00aa00" } }],
  };
  const highlighter = await createHighlighter({ langs: ["javascript"], themes: [light, dark] });
  const blocks = [];
  try {
    for (const defaultColor of ["day", "night"]) {
      const options = {
        lang: "javascript",
        themes: { day: light.name, night: dark.name },
        defaultColor,
        styleMode,
      };
      const code = "const value = 1";
      const rendered =
        styleMode === "classes"
          ? highlighter.codeToHtmlWithCss(code, options)
          : { html: highlighter.codeToHtml(code, options), css: "" };
      blocks.push({
        defaultColor,
        code: {
          code,
          language: "javascript",
          ...rendered,
          metadata: { lineNumbers: false, highlightedLines: [] },
        },
      });
    }
  } finally {
    highlighter.dispose();
  }
  const css = [...new Set(blocks.map(({ code }) => code.css).filter(Boolean))].join("\n");
  await writeFile(
    join(project, "font-fixture.jsx"),
    `import React from "react";
import { renderToString } from "react-dom/server";
import { FERRIKI_CODE_TAG } from "@ferriki/core/web-component";
const blocks = ${JSON.stringify(blocks)};
export function render() {
  return renderToString(React.createElement("main", null, blocks.map(({ defaultColor, code }) => React.createElement("section", { key: defaultColor, "data-font-default": defaultColor }, React.createElement(FERRIKI_CODE_TAG, { className: "font-shadow-code", "data-ferriki-theme": defaultColor, highlightedCode: code.html }, React.createElement("pre", null, React.createElement("code", null, code.code)))))));
}
`,
  );
  await writeFile(
    join(project, "font-registration.js"),
    `import { defineCodeElement } from "@ferriki/core/web-component";
export const FerrikiCodeElement = defineCodeElement(${JSON.stringify({ css, themeAliases: ["day", "night"] })});
`,
  );
}

async function writeElementProbe(project) {
  await writeFile(
    join(project, "src", "element-probe.js"),
    `import { defineCodeElement, FERRIKI_CODE_TAG } from "@ferriki/core/web-component";
import { initialBlock } from "./snippets.jsx";
export const FerrikiCodeElement = defineCodeElement({ css: initialBlock.css, themeAliases: ["light", "dark"] });
if (import.meta.hot) import.meta.hot.accept("./snippets.jsx", (module) => {
  if (module) defineCodeElement({ css: module.initialBlock.css, themeAliases: ["light", "dark"] });
});
export { defineCodeElement, FERRIKI_CODE_TAG, initialBlock };
`,
  );
  await writeFile(
    join(project, "src", "csr-probe.js"),
    `import React from "react";
import { createRoot } from "react-dom/client";
import { defineCodeElement, FERRIKI_CODE_TAG } from "@ferriki/core/web-component";
import { initialBlock, updatedBlock } from "./snippets.jsx";
export const FerrikiCodeElement = defineCodeElement({ css: initialBlock.css, themeAliases: ["light", "dark"] });
if (import.meta.hot) import.meta.hot.accept("./snippets.jsx", (module) => {
  if (module) defineCodeElement({ css: module.initialBlock.css, themeAliases: ["light", "dark"] });
});
function view(block) {
  return React.createElement(FERRIKI_CODE_TAG, { "data-ferriki-theme": "light", highlightedCode: block.html }, React.createElement("pre", null, React.createElement("code", null, block.code)));
}
export function mount(target, block) {
  const root = createRoot(target);
  root.render(view(block));
  return root;
}
export function update(root, block) {
  root.render(view(block));
}
export { defineCodeElement, initialBlock, updatedBlock };
`,
  );
}

async function checkUpgradePaths(browser, baseUrl, initialBlock) {
  const context = await browser.newContext();
  try {
    const latePage = await context.newPage();
    await latePage.goto(`${baseUrl}/?manual=1`, { waitUntil: "networkidle" });
    const lateBefore = await latePage.evaluate((propertyHtml) => {
      const host = document.querySelector("[data-panel=macro] ferriki-code");
      window.__lateUpgradeHost = host;
      window.__lateUpgradeRoot = host.shadowRoot;
      window.__lateUpgradePre = host.shadowRoot?.querySelector("pre");
      window.__lateUpgradeToken = host.shadowRoot?.querySelector("code span");
      const preUpgrade = document.createElement("ferriki-code");
      preUpgrade.highlightedCode = propertyHtml;
      preUpgrade.setAttribute("data-ferriki-theme", "light");
      preUpgrade.innerHTML = "<pre><code>property fallback</code></pre>";
      document.body.append(preUpgrade);
      window.__preUpgradeHost = preUpgrade;
      return {
        defined: customElements.get("ferriki-code") !== undefined,
        hasDeclarativeRoot: Boolean(host.shadowRoot),
        codeRef: host.getAttribute("code-ref"),
        source: host.shadowRoot?.querySelector("pre code")?.textContent,
        marker: host.shadowRoot?.firstChild?.data,
        stylesheetLinkCount: host.shadowRoot?.querySelectorAll("link[data-ferriki-code-css]")
          .length,
        fallback: host.querySelector("pre code")?.textContent,
        preUpgradeOwnProperty: Object.hasOwn(preUpgrade, "highlightedCode"),
      };
    }, initialBlock.html);
    assert.equal(
      lateBefore.defined,
      false,
      "manual SSR unexpectedly registered the custom element",
    );
    assert.equal(
      lateBefore.hasDeclarativeRoot,
      true,
      "the HTML parser did not create declarative Shadow DOM before browser registration",
    );
    assert.match(lateBefore.codeRef ?? "", /^ferriki-/);
    assert.equal(
      lateBefore.source,
      'const island = "prepared at build time";\nconsole.log(island);\n',
    );
    assert.equal(
      lateBefore.marker,
      `ferriki-code:${encodeURIComponent(lateBefore.codeRef).replaceAll("-", "%2D")}`,
    );
    assert.equal(lateBefore.stylesheetLinkCount, 1);
    assert.equal(lateBefore.fallback, undefined);
    assert.equal(lateBefore.preUpgradeOwnProperty, true);
    await latePage.evaluate(async () => {
      await import("/src/element-probe.js");
    });
    assert.deepEqual(
      await latePage.evaluate(() => {
        const host = window.__lateUpgradeHost;
        const preUpgrade = window.__preUpgradeHost;
        const root = host.shadowRoot;
        const propertyDescriptor = Object.getOwnPropertyDescriptor(
          customElements.get("ferriki-code").prototype,
          "highlightedCode",
        );
        return {
          defined: customElements.get("ferriki-code") !== undefined,
          upgraded: host instanceof customElements.get("ferriki-code"),
          hasShadowRoot: Boolean(host.shadowRoot),
          source: host.shadowRoot?.querySelector("pre code")?.textContent,
          fallback: host.querySelector("pre code")?.textContent,
          rootPreserved: root === window.__lateUpgradeRoot,
          prePreserved: root?.querySelector("pre") === window.__lateUpgradePre,
          tokenPreserved: root?.querySelector("code span") === window.__lateUpgradeToken,
          styleTags: root?.querySelectorAll("style").length,
          stylesheetLinkCount: root?.querySelectorAll("link[data-ferriki-code-css]").length,
          preUpgradeUpgraded: preUpgrade instanceof customElements.get("ferriki-code"),
          preUpgradeOwnProperty: Object.hasOwn(preUpgrade, "highlightedCode"),
          preUpgradeSource: preUpgrade.shadowRoot?.querySelector("pre code")?.textContent,
          preUpgradeFallback: preUpgrade.querySelector("pre code")?.textContent,
          propertyGetter: typeof propertyDescriptor?.get,
          propertySetter: typeof propertyDescriptor?.set,
        };
      }),
      {
        defined: true,
        upgraded: true,
        hasShadowRoot: true,
        source: 'const island = "prepared at build time";\nconsole.log(island);\n',
        fallback: undefined,
        rootPreserved: true,
        prePreserved: true,
        tokenPreserved: true,
        styleTags: 0,
        stylesheetLinkCount: 1,
        preUpgradeUpgraded: true,
        preUpgradeOwnProperty: false,
        preUpgradeSource: initialBlock.code,
        preUpgradeFallback: "property fallback",
        propertyGetter: "function",
        propertySetter: "function",
      },
      "late custom-element upgrade did not preserve declarative Shadow DOM and its unresolved code-ref stylesheet",
    );

    const earlyPage = await context.newPage();
    await earlyPage.goto(`${baseUrl}/?manual=1`, { waitUntil: "networkidle" });
    assert.deepEqual(
      await earlyPage.evaluate(async () => {
        const { FERRIKI_CODE_TAG, initialBlock } = await import("/src/element-probe.js");
        const escapeAttribute = (value) =>
          value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
        const escapeText = (value) =>
          value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        document.open();
        document.write(
          `<!doctype html><html><body><${FERRIKI_CODE_TAG} data-ferriki-theme="light" highlightedCode="${escapeAttribute(initialBlock.html)}"><pre><code>${escapeText(initialBlock.code)}</code></pre></${FERRIKI_CODE_TAG}></body></html>`,
        );
        document.close();
        const host = document.querySelector(FERRIKI_CODE_TAG);
        return {
          defined: customElements.get(FERRIKI_CODE_TAG) !== undefined,
          upgraded: host instanceof customElements.get(FERRIKI_CODE_TAG),
          hasRoot: Boolean(host.shadowRoot),
          source: host.shadowRoot?.querySelector("pre code")?.textContent,
          fallback: host.querySelector("pre code")?.textContent,
        };
      }),
      {
        defined: true,
        upgraded: true,
        hasRoot: true,
        source: initialBlock.code,
        fallback: initialBlock.code,
      },
      "registration-before-parser did not adopt the highlightedCode attribute",
    );
  } finally {
    await context.close();
  }
}

async function checkReferencePaths(browser, baseUrl, styleMode, initialBlock, updatedBlock) {
  if (styleMode === "classes") {
    assert(initialBlock.css.length > 0, "classes mode did not generate initial block CSS");
    assert(updatedBlock.css.length > 0, "classes mode did not generate updated block CSS");
    assert.notEqual(initialBlock.css, updatedBlock.css, "reference blocks must have distinct CSS");
  }
  const noJsContext = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await noJsContext.newPage();
    await page.goto(`${baseUrl}/reference?manual=1`, { waitUntil: "load" });
    const noJsEvidence = await page.evaluate(() => ({
      defined: customElements.get("ferriki-code") !== undefined,
      hosts: [...document.querySelectorAll("[data-reference-host]")].map((host) => ({
        name: host.dataset.referenceHost,
        reference: host.getAttribute("code-ref"),
        text: host.shadowRoot?.querySelector("pre code")?.textContent,
        visible: Boolean(host.shadowRoot?.querySelector("pre")?.getClientRects().length),
        links: [...(host.shadowRoot?.querySelectorAll("link[data-ferriki-code-css]") ?? [])].map(
          (link) => link.href,
        ),
        styles: host.shadowRoot?.querySelectorAll("style").length,
      })),
    }));
    assert.equal(
      noJsEvidence.defined,
      false,
      `${styleMode}: DSD registered custom elements without JavaScript`,
    );
    assert.deepEqual(
      noJsEvidence.hosts.map(({ name, reference, text }) => ({ name, reference, text })),
      [
        { name: "changing", reference: "probe-initial", text: initialBlock.code },
        { name: "stable", reference: "probe-initial", text: initialBlock.code },
        { name: "repeated", reference: "probe-initial", text: initialBlock.code },
        { name: "late-style", reference: "probe-updated", text: updatedBlock.code },
      ],
      `${styleMode}: DSD did not expose exact highlighted text without JavaScript`,
    );
    assert(
      noJsEvidence.hosts.every(
        (host) =>
          host.visible &&
          host.styles === 0 &&
          host.links.length === 1 &&
          new URL(host.links[0]).pathname === "/reference.css",
      ),
      `${styleMode}: DSD did not use one external stylesheet URL without inline styles`,
    );
    const noJsStyles = await page
      .locator('[data-reference-host="late-style"]')
      .evaluate(tokenStyles);
    assert(noJsStyles.color, `${styleMode}: DSD external stylesheet did not style token text`);
    assert.notEqual(noJsStyles.background, "rgba(0, 0, 0, 0)");
  } finally {
    await noJsContext.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    const warnings = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") warnings.push(message.text());
    });
    page.on("pageerror", (error) => warnings.push(error.message));
    await page.goto(`${baseUrl}/reference?manual=1`, { waitUntil: "networkidle" });
    const unregistered = await page.evaluate(() => ({
      defined: customElements.get("ferriki-code") !== undefined,
      hosts: Object.fromEntries(
        [...document.querySelectorAll("[data-reference-host]")].map((host) => {
          const root = host.shadowRoot;
          const name = host.dataset.referenceHost;
          window.__referenceNodes ??= {};
          window.__referenceNodes[name] = {
            host,
            root,
            pre: root?.querySelector("pre"),
            token: root?.querySelector("code span"),
            marker: root?.firstChild,
          };
          return [
            name,
            {
              reference: host.getAttribute("code-ref"),
              text: root?.querySelector("pre code")?.textContent,
              marker: root?.firstChild?.data,
              links: root?.querySelectorAll("link[data-ferriki-code-css]").length,
            },
          ];
        }),
      ),
    }));
    assert.equal(unregistered.defined, false);
    assert.equal(Object.keys(unregistered.hosts).length, 4);
    assert(
      Object.values(unregistered.hosts).every(
        (host) => host.marker?.startsWith("ferriki-code:") && host.links === 1,
      ),
      `${styleMode}: unregistered DSD references were missing their markers or stylesheet links`,
    );

    await page.evaluate(async () => import("/src/reference-register-empty.js"));
    const emptyRegistration = await page.evaluate(() => ({
      defined: customElements.get("ferriki-code") !== undefined,
      hosts: [...document.querySelectorAll("[data-reference-host]")].map((host) => {
        const before = window.__referenceNodes[host.dataset.referenceHost];
        const root = host.shadowRoot;
        return {
          name: host.dataset.referenceHost,
          rootPreserved: root === before.root,
          prePreserved: root?.querySelector("pre") === before.pre,
          tokenPreserved: root?.querySelector("code span") === before.token,
          linkCount: root?.querySelectorAll("link[data-ferriki-code-css]").length,
          sheetCount: root?.adoptedStyleSheets.length,
        };
      }),
    }));
    assert.equal(emptyRegistration.defined, true);
    assert(
      emptyRegistration.hosts.every(
        (host) =>
          host.rootPreserved && host.prePreserved && host.tokenPreserved && host.linkCount === 1,
      ),
      `${styleMode}: empty registration replaced DSD content or removed an unresolved stylesheet link`,
    );

    const lateCssBefore = await page
      .locator('[data-reference-host="late-style"]')
      .evaluate(tokenStyles);
    await page.evaluate(async () => import("/src/reference-client.jsx"));
    await page.waitForFunction(() => window.__referenceHydrated === true);
    assert.equal(
      await page.evaluate(() => window.__referenceCodeDefinedBeforeHydration),
      true,
      `${styleMode}: reference code element was not registered before React hydration`,
    );
    assert.deepEqual(await page.evaluate(() => window.__referenceShadowErrors), []);

    const partiallyRegistered = await page.evaluate(() => {
      const hosts = [...document.querySelectorAll("[data-reference-host]")];
      const firstSheet = hosts[0].shadowRoot.adoptedStyleSheets[0];
      return {
        hosts: hosts.map((host) => {
          const before = window.__referenceNodes[host.dataset.referenceHost];
          const root = host.shadowRoot;
          return {
            name: host.dataset.referenceHost,
            text: root?.querySelector("pre code")?.textContent,
            rootPreserved: root === before.root,
            prePreserved: root?.querySelector("pre") === before.pre,
            tokenPreserved: root?.querySelector("code span") === before.token,
            linkCount: root?.querySelectorAll("link[data-ferriki-code-css]").length,
            sharedSheet:
              root?.adoptedStyleSheets.length === 1 && root.adoptedStyleSheets[0] === firstSheet,
          };
        }),
        firstSheet,
      };
    });
    assert.deepEqual(
      partiallyRegistered.hosts.map(({ name, text }) => ({ name, text })),
      [
        { name: "changing", text: initialBlock.code },
        { name: "stable", text: initialBlock.code },
        { name: "repeated", text: initialBlock.code },
        { name: "late-style", text: updatedBlock.code },
      ],
    );
    assert(
      partiallyRegistered.hosts.every(
        (host) =>
          host.rootPreserved && host.prePreserved && host.tokenPreserved && host.sharedSheet,
      ),
      `${styleMode}: first reference registration or hydration replaced matching DSD nodes or sheets`,
    );
    assert.deepEqual(
      partiallyRegistered.hosts.map((host) => host.linkCount),
      [0, 0, 0, 1],
      `${styleMode}: DSD stylesheet links did not track per-reference CSS registration`,
    );
    assert.deepEqual(
      await page.locator('[data-reference-host="late-style"]').evaluate(tokenStyles),
      lateCssBefore,
      `${styleMode}: the still-linked DSD block lost its styles before late registration`,
    );

    const beforeLateRegistration = await page.evaluate(() => {
      const host = document.querySelector('[data-reference-host="late-style"]');
      const root = host.shadowRoot;
      window.__lateStyleIdentity = {
        root,
        pre: root.querySelector("pre"),
        token: root.querySelector("code span"),
        sheet: root.adoptedStyleSheets[0],
      };
      return true;
    });
    assert.equal(beforeLateRegistration, true);
    await page.evaluate(() => window.__registerUpdatedReference());
    const afterLateRegistration = await page
      .locator('[data-reference-host="late-style"]')
      .evaluate((host) => {
        const before = window.__lateStyleIdentity;
        const root = host.shadowRoot;
        return {
          rootPreserved: root === before.root,
          prePreserved: root.querySelector("pre") === before.pre,
          tokenPreserved: root.querySelector("code span") === before.token,
          sameSheet:
            root.adoptedStyleSheets.length === 1 && root.adoptedStyleSheets[0] === before.sheet,
          linkCount: root.querySelectorAll("link[data-ferriki-code-css]").length,
          text: root.querySelector("pre code")?.textContent,
        };
      });
    assert.deepEqual(afterLateRegistration, {
      rootPreserved: true,
      prePreserved: true,
      tokenPreserved: true,
      sameSheet: true,
      linkCount: 0,
      text: updatedBlock.code,
    });

    await page.evaluate(() => window.__registerInitialReferenceAgain());
    const rootsAfterRepeat = await page.evaluate(() =>
      [...document.querySelectorAll("[data-reference-host]")].map((host) => {
        const before = window.__referenceNodes[host.dataset.referenceHost];
        return {
          name: host.dataset.referenceHost,
          root: host.shadowRoot === before.root,
          pre: host.shadowRoot.querySelector("pre") === before.pre,
          token: host.shadowRoot.querySelector("code span") === before.token,
          links: host.shadowRoot.querySelectorAll("link[data-ferriki-code-css]").length,
        };
      }),
    );
    assert(
      rootsAfterRepeat.every((host) => host.root && host.pre && host.token && host.links === 0),
      `${styleMode}: repeated registry calls replaced matching reference nodes or retained marked links`,
    );

    await page.locator("[data-reference-theme]").click();
    await page.locator("[data-reference-rerender]").click();
    const afterParentChanges = await page.evaluate(() =>
      [...document.querySelectorAll("[data-reference-host]")].map((host) => {
        const before = window.__referenceNodes[host.dataset.referenceHost];
        return {
          name: host.dataset.referenceHost,
          root: host.shadowRoot === before.root,
          pre: host.shadowRoot.querySelector("pre") === before.pre,
          token: host.shadowRoot.querySelector("code span") === before.token,
          theme: host.getAttribute("data-ferriki-theme"),
        };
      }),
    );
    assert(
      afterParentChanges.every(
        (host) => host.root && host.pre && host.token && host.theme === "dark",
      ),
      `${styleMode}: theme or parent updates replaced DSD nodes`,
    );

    await page.locator("[data-reference-source]").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-reference-host="changing"]')?.getAttribute("code-ref") ===
        "probe-updated",
    );
    const changedReference = await page
      .locator('[data-reference-host="changing"]')
      .evaluate((host) => {
        const before = window.__referenceNodes.changing;
        return {
          rootPreserved: host.shadowRoot === before.root,
          preReplaced: host.shadowRoot.querySelector("pre") !== before.pre,
          tokenReplaced: host.shadowRoot.querySelector("code span") !== before.token,
          reference: host.getAttribute("code-ref"),
          text: host.shadowRoot.querySelector("pre code")?.textContent,
        };
      });
    assert.deepEqual(changedReference, {
      rootPreserved: true,
      preReplaced: true,
      tokenReplaced: true,
      reference: "probe-updated",
      text: updatedBlock.code,
    });

    const collision = await page.evaluate(() => {
      try {
        window.__registerCodeBlocks({
          css: "",
          themeAliases: ["light", "dark"],
          blocks: { "probe-initial": "<pre><code>different block</code></pre>" },
        });
        return null;
      } catch (error) {
        return { name: error.name, message: error.message };
      }
    });
    assert.equal(collision?.name, "TypeError");
    assert.match(collision.message, /already registered with different HTML/u);

    const lateRegistration = await page.evaluate(() => {
      const host = document.createElement("ferriki-code");
      host.setAttribute("data-ferriki-theme", "light");
      host.setAttribute("code-ref", "probe-late");
      document.body.append(host);
      const before = {
        blank: !host.shadowRoot.querySelector("pre code"),
        slot: Boolean(host.shadowRoot.querySelector("slot")),
      };
      window.__registerCodeBlocks({
        css: "",
        themeAliases: ["light", "dark"],
        blocks: { "probe-late": "<pre><code>late registry block</code></pre>" },
      });
      return {
        before,
        text: host.shadowRoot.querySelector("pre code")?.textContent,
        slot: Boolean(host.shadowRoot.querySelector("slot")),
      };
    });
    assert.deepEqual(lateRegistration, {
      before: { blank: true, slot: true },
      text: "late registry block",
      slot: false,
    });

    await page.evaluate(() => {
      const target = document.createElement("section");
      target.id = "reference-csr-probe";
      document.body.append(target);
      window.__referenceCsrRoot = window.__mountReferenceProbe(target);
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('#reference-csr-probe [data-reference-host="csr"]')
          ?.shadowRoot?.querySelector("pre code")?.textContent,
    );
    const csrInitial = await page
      .locator('#reference-csr-probe [data-reference-host="csr"]')
      .evaluate((host) => {
        window.__referenceCsrNodes = {
          root: host.shadowRoot,
          pre: host.shadowRoot.querySelector("pre"),
          token: host.shadowRoot.querySelector("code span"),
        };
        return {
          reference: host.getAttribute("code-ref"),
          text: host.shadowRoot.querySelector("pre code")?.textContent,
          root: Boolean(host.shadowRoot),
        };
      });
    assert.deepEqual(csrInitial, {
      reference: "probe-initial",
      text: initialBlock.code,
      root: true,
    });
    await page.evaluate(() =>
      window.__updateReferenceProbe(window.__referenceCsrRoot, "probe-initial"),
    );
    const csrRepeated = await page
      .locator('#reference-csr-probe [data-reference-host="csr"]')
      .evaluate((host) => ({
        root: host.shadowRoot === window.__referenceCsrNodes.root,
        pre: host.shadowRoot.querySelector("pre") === window.__referenceCsrNodes.pre,
        token: host.shadowRoot.querySelector("code span") === window.__referenceCsrNodes.token,
      }));
    assert.deepEqual(csrRepeated, { root: true, pre: true, token: true });
    await page.evaluate(() =>
      window.__updateReferenceProbe(window.__referenceCsrRoot, "probe-updated"),
    );
    await page.waitForFunction(() =>
      document
        .querySelector('#reference-csr-probe [data-reference-host="csr"]')
        ?.shadowRoot?.querySelector("pre code")
        ?.textContent.includes("Updated without rebuilding the host"),
    );
    const csrUpdated = await page
      .locator('#reference-csr-probe [data-reference-host="csr"]')
      .evaluate((host) => ({
        root: host.shadowRoot === window.__referenceCsrNodes.root,
        preReplaced: host.shadowRoot.querySelector("pre") !== window.__referenceCsrNodes.pre,
        tokenReplaced:
          host.shadowRoot.querySelector("code span") !== window.__referenceCsrNodes.token,
        reference: host.getAttribute("code-ref"),
        text: host.shadowRoot.querySelector("pre code")?.textContent,
      }));
    assert.deepEqual(csrUpdated, {
      root: true,
      preReplaced: true,
      tokenReplaced: true,
      reference: "probe-updated",
      text: updatedBlock.code,
    });
    assert.deepEqual(await page.evaluate(() => window.__referenceShadowErrors), []);
    assert.deepEqual(warnings, [], `${styleMode}: reference hydration or updates warned or failed`);
    console.log(
      `Shadow DOM references ${styleMode}: empty React hosts, DSD no-JS styles, partial CSS registration, hydration identity, late registration, collisions, ref changes, themes, and parent updates passed`,
    );
  } finally {
    await context.close();
  }
}

async function checkReferenceSizing(browser, baseUrl, styleMode, initialBlock, updatedBlock) {
  const initialLineCount = initialBlock.code.split(/\r\n|\r|\n/u).length;
  const updatedLineCount = updatedBlock.code.split(/\r\n|\r|\n/u).length;
  assert.notEqual(
    initialLineCount,
    updatedLineCount,
    `${styleMode}: sizing fixture references must have different source line counts`,
  );

  async function readGeometry(page) {
    return page.evaluate(() =>
      [...document.querySelectorAll("[data-reference-host]")].map((host) => {
        const style = getComputedStyle(host);
        const rect = host.getBoundingClientRect();
        const next = host.nextElementSibling;
        const root = host.shadowRoot;
        const pre = root?.querySelector("pre");
        return {
          name: host.dataset.referenceHost,
          reference: host.getAttribute("code-ref"),
          hasShadowRoot: Boolean(root),
          sourceText: root?.querySelector("pre code")?.textContent,
          height: rect.height,
          bottom: rect.bottom,
          nextTop: next?.getBoundingClientRect().top,
          rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          display: style.display,
          boxSizing: style.boxSizing,
          minBlockSize: Number.parseFloat(style.minBlockSize),
          minBlockSizeText: style.minBlockSize,
          hostPaddingBlockStart: Number.parseFloat(style.paddingBlockStart),
          hostPaddingBlockEnd: Number.parseFloat(style.paddingBlockEnd),
          borderBlockStartWidth: Number.parseFloat(style.borderBlockStartWidth),
          borderBlockEndWidth: Number.parseFloat(style.borderBlockEndWidth),
          lineHeightVariable: style.getPropertyValue("--ferriki-code-line-height").trim(),
          codePaddingVariable: style.getPropertyValue("--ferriki-code-padding-block").trim(),
          preLineHeight: pre ? getComputedStyle(pre).lineHeight : undefined,
          prePaddingBlockStart: pre ? getComputedStyle(pre).paddingBlockStart : undefined,
        };
      }),
    );
  }

  function assertReservedGeometry(metrics, label) {
    for (const host of metrics) {
      const isCustom = host.name !== "stable";
      const lineCount = host.reference === "probe-initial" ? initialLineCount : updatedLineCount;
      const lineHeight = isCustom ? 28 : host.rootFontSize * 1.3125;
      const codePadding = isCustom ? 10 : 0;
      const hostPadding = isCustom ? 4 : 0;
      const hostBorder = isCustom ? 2 : 0;
      const expectedMinBlockSize = lineCount * lineHeight + 2 * codePadding;
      const expectedOuterHeight = expectedMinBlockSize + 2 * hostPadding + 2 * hostBorder;

      assert.equal(host.display, "block", `${label} ${host.name}: host is not block-level`);
      assert.equal(
        host.boxSizing,
        "content-box",
        `${label} ${host.name}: reservation must use content-box sizing`,
      );
      assert(
        host.hasShadowRoot === (label === "filled"),
        `${label} ${host.name}: unexpected root state`,
      );
      assert(host.height > 0, `${label} ${host.name}: host did not reserve positive space`);
      assert(
        Number.isFinite(host.minBlockSize),
        `${label} ${host.name}: min-block-size did not resolve`,
      );
      assert(
        Math.abs(host.minBlockSize - expectedMinBlockSize) < 1,
        `${label} ${host.name}: min-block-size ${host.minBlockSizeText} did not reserve ${expectedMinBlockSize}px`,
      );
      assert(
        Math.abs(host.height - expectedOuterHeight) < 1,
        `${label} ${host.name}: host height ${host.height}px did not match reserved outer height ${expectedOuterHeight}px`,
      );
      assert(
        Math.abs(host.nextTop - host.bottom) < 1,
        `${label} ${host.name}: following sibling moved away from the host boundary`,
      );

      if (label === "empty") {
        assert.equal(
          host.sourceText,
          undefined,
          `${host.name}: an empty reference rendered code before registration`,
        );
        assert.equal(host.lineHeightVariable, isCustom ? "28px" : "");
        assert.equal(host.codePaddingVariable, isCustom ? "10px" : "");
      } else {
        assert.equal(
          host.preLineHeight,
          isCustom ? "28px" : "21px",
          `${host.name}: registered pre did not use its expected line height`,
        );
        assert.equal(
          host.prePaddingBlockStart,
          isCustom ? "10px" : "0px",
          `${host.name}: registered pre did not use its expected code padding`,
        );
      }
    }
  }

  const noJsContext = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await noJsContext.newPage();
    await page.goto(`${baseUrl}/reference?plain=1&manual=1`, { waitUntil: "load" });
    const empty = await readGeometry(page);
    assert.deepEqual(
      empty.map(({ name, reference }) => ({ name, reference })),
      [
        { name: "changing", reference: "probe-initial" },
        { name: "stable", reference: "probe-initial" },
        { name: "repeated", reference: "probe-initial" },
        { name: "late-style", reference: "probe-updated" },
      ],
      `${styleMode}: empty reference geometry fixture did not render expected hosts`,
    );
    assertReservedGeometry(empty, "empty");
  } finally {
    await noJsContext.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/reference?plain=1&manual=1`, { waitUntil: "networkidle" });
    const beforeRegistration = await readGeometry(page);
    assertReservedGeometry(beforeRegistration, "empty");
    assert(
      beforeRegistration.every((host) => host.sourceText === undefined),
      `${styleMode}: reference hosts were not empty before registration`,
    );

    await page.evaluate(async () => {
      await import("/src/reference-client.jsx");
      window.__registerUpdatedReference();
    });
    await page.waitForFunction(() => window.__referenceHydrated === true);
    const afterRegistration = await readGeometry(page);
    assertReservedGeometry(afterRegistration, "filled");
    for (let index = 0; index < beforeRegistration.length; index++) {
      const before = beforeRegistration[index];
      const after = afterRegistration[index];
      const expectedSource =
        before.reference === "probe-initial" ? initialBlock.code : updatedBlock.code;
      assert.equal(
        after.sourceText,
        expectedSource,
        `${styleMode} ${after.name}: registry filled the wrong source`,
      );
      assert(
        Math.abs(after.height - before.height) < 1 && Math.abs(after.nextTop - before.nextTop) < 1,
        `${styleMode} ${after.name}: registration shifted the host or following sibling`,
      );
    }

    const changingBefore = afterRegistration.find(({ name }) => name === "changing");
    await page.locator("[data-reference-source]").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-reference-host="changing"]')?.getAttribute("code-ref") ===
          "probe-updated" &&
        document
          .querySelector('[data-reference-host="changing"]')
          ?.shadowRoot?.querySelector("pre code")
          ?.textContent.includes("Updated without rebuilding the host"),
    );
    const changed = (await readGeometry(page)).find(({ name }) => name === "changing");
    const expectedResize =
      (updatedLineCount - initialLineCount) * Number.parseFloat(changingBefore.lineHeightVariable);
    assert.equal(changed.reference, "probe-updated");
    assert(
      Math.abs(changed.height - changingBefore.height - expectedResize) < 1,
      `${styleMode}: changing reference height did not grow by ${expectedResize}px`,
    );
    assert(
      Math.abs(changed.nextTop - changingBefore.nextTop - expectedResize) < 1,
      `${styleMode}: changing reference did not move its following sibling by ${expectedResize}px`,
    );
    console.log(
      `Reference sizing ${styleMode}: no-JS reservation, default/custom CSS metrics, registration stability, and changed-reference resize passed`,
    );
  } finally {
    await context.close();
  }
}

async function readMaxLinesGeometry(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-max-lines-host], [data-raw-max-lines]")].map((host) => {
      const root = host.shadowRoot;
      const pre = root?.querySelector("pre");
      const hostStyle = getComputedStyle(host);
      const preStyle = pre ? getComputedStyle(pre) : undefined;
      const rect = host.getBoundingClientRect();
      const next = host.nextElementSibling;
      return {
        name: host.getAttribute("data-max-lines-host") ?? "raw",
        reference: host.getAttribute("code-ref"),
        maxLines: host.getAttribute("max-lines"),
        hasShadowRoot: Boolean(root),
        sourceText: root?.querySelector("pre code")?.textContent,
        height: rect.height,
        bottom: rect.bottom + window.scrollY,
        nextTop: next ? next.getBoundingClientRect().top + window.scrollY : undefined,
        rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        minBlockSize: Number.parseFloat(hostStyle.minBlockSize),
        minBlockSizeText: hostStyle.minBlockSize,
        hostPaddingBlockStart: Number.parseFloat(hostStyle.paddingBlockStart),
        hostPaddingBlockEnd: Number.parseFloat(hostStyle.paddingBlockEnd),
        borderBlockStartWidth: Number.parseFloat(hostStyle.borderBlockStartWidth),
        borderBlockEndWidth: Number.parseFloat(hostStyle.borderBlockEndWidth),
        preHeight: pre?.getBoundingClientRect().height,
        preClientHeight: pre?.clientHeight,
        preScrollHeight: pre?.scrollHeight,
        preScrollTop: pre?.scrollTop,
        preMaxBlockSize: preStyle?.maxBlockSize,
        preLineHeight: preStyle?.lineHeight,
        prePaddingBlockStart: preStyle?.paddingBlockStart,
        prePaddingBlockEnd: preStyle?.paddingBlockEnd,
        preOverflowY: preStyle?.overflowY,
        preTabIndex: pre?.tabIndex,
        markedLinkCount: root?.querySelectorAll("link[data-ferriki-code-css]").length,
        adoptedSheetCount: root?.adoptedStyleSheets?.length ?? 0,
      };
    }),
  );
}

function assertMaxLinesGeometry(
  metric,
  { label, source, maxLines, hasShadowRoot, checkKeyboard = true },
) {
  const lineCount = source.split(/\r\n|\r|\n/u).length;
  const visibleLineCount = maxLines == null ? lineCount : Math.min(lineCount, maxLines);
  const expectedLineHeight = metric.rootFontSize * 1.3125;
  const lineHeight = metric.preLineHeight
    ? Number.parseFloat(metric.preLineHeight)
    : expectedLineHeight;
  const codePadding = metric.prePaddingBlockStart
    ? Number.parseFloat(metric.prePaddingBlockStart) + Number.parseFloat(metric.prePaddingBlockEnd)
    : 0;
  const expectedMinBlockSize = visibleLineCount * lineHeight + codePadding;
  const expectedHostHeight =
    expectedMinBlockSize +
    metric.hostPaddingBlockStart +
    metric.hostPaddingBlockEnd +
    metric.borderBlockStartWidth +
    metric.borderBlockEndWidth;

  assert.equal(
    metric.maxLines,
    maxLines == null ? null : String(maxLines),
    `${label} ${metric.name}: max-lines attribute`,
  );
  assert.equal(metric.hasShadowRoot, hasShadowRoot, `${label} ${metric.name}: shadow root state`);
  assert(
    Math.abs(metric.minBlockSize - expectedMinBlockSize) < 1,
    `${label} ${metric.name}: min-block-size ${metric.minBlockSizeText} did not reserve ${expectedMinBlockSize}px`,
  );
  assert(
    Math.abs(metric.height - expectedHostHeight) < 1,
    `${label} ${metric.name}: host height ${metric.height}px did not match ${expectedHostHeight}px`,
  );
  assert(
    Math.abs(metric.nextTop - metric.bottom) < 1,
    `${label} ${metric.name}: following sibling did not stay at the host boundary`,
  );

  if (hasShadowRoot) {
    assert.equal(metric.sourceText, source, `${label} ${metric.name}: source text changed`);
    assert(
      Math.abs(metric.preHeight - expectedMinBlockSize) < 1,
      `${label} ${metric.name}: pre height ${metric.preHeight}px did not match the visible line cap`,
    );
    assert.equal(
      metric.preOverflowY,
      "auto",
      `${label} ${metric.name}: capped pre is not scrollable`,
    );
    if (lineCount > maxLines) {
      assert(
        metric.preScrollHeight > metric.preClientHeight,
        `${label} ${metric.name}: capped pre has no scrollable overflow`,
      );
      assert(
        Number.isFinite(Number.parseFloat(metric.preMaxBlockSize)),
        `${label} ${metric.name}: shared CSS did not constrain pre max-block-size`,
      );
      if (checkKeyboard)
        assert(
          metric.preTabIndex >= 0,
          `${label} ${metric.name}: capped pre is not keyboard-focusable`,
        );
    } else {
      assert(
        metric.preScrollHeight <= metric.preClientHeight + 1,
        `${label} ${metric.name}: a cap above the source length clipped the short block`,
      );
    }
  } else {
    assert.equal(metric.sourceText, undefined, `${label} ${metric.name}: empty host rendered code`);
  }
}

async function assertLastCodeCharacterVisible(page, selector, label) {
  const evidence = await page.locator(selector).evaluate((host) => {
    const pre = host.shadowRoot?.querySelector("pre");
    const code = pre?.querySelector("code");
    if (!pre || !code) throw new Error("The capped host has no rendered code");
    pre.scrollTop = pre.scrollHeight;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let textNode;
    let offset = -1;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const text = current.textContent ?? "";
      for (let index = text.length - 1; index >= 0; index--) {
        if (!/\s/u.test(text[index])) {
          textNode = current;
          offset = index;
          break;
        }
      }
    }
    if (!textNode) throw new Error("The rendered code has no final non-whitespace character");
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.setEnd(textNode, offset + 1);
    const character = range.getBoundingClientRect();
    const viewport = pre.getBoundingClientRect();
    return {
      scrollTop: pre.scrollTop,
      maxScrollTop: pre.scrollHeight - pre.clientHeight,
      scrollHeight: pre.scrollHeight,
      clientHeight: pre.clientHeight,
      characterTop: character.top,
      characterBottom: character.bottom,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      characterText: textNode.textContent.slice(offset, offset + 1),
      visible:
        character.width > 0 &&
        character.top >= viewport.top - 1 &&
        character.bottom <= viewport.bottom + 1,
    };
  });
  assert(
    evidence.scrollTop > 0 && Math.abs(evidence.scrollTop - evidence.maxScrollTop) < 1,
    `${label}: scrolling did not reach the end of the code block`,
  );
  assert(
    evidence.visible,
    `${label}: the final code character was not visible after scrolling (${JSON.stringify(evidence)})`,
  );
}

async function checkReferenceMaxLines(browser, baseUrl, styleMode, initialBlock, updatedBlock) {
  const initialLineCount = initialBlock.code.split(/\r\n|\r|\n/u).length;
  const updatedLineCount = updatedBlock.code.split(/\r\n|\r|\n/u).length;
  assert(updatedLineCount > 6, `${styleMode}: long max-lines fixture must exceed the cap`);
  assert(initialLineCount < 20, `${styleMode}: short max-lines fixture must fit under the cap`);

  const fixtures = {
    long: { source: updatedBlock.code, maxLines: 3 },
    short: { source: initialBlock.code, maxLines: 20 },
  };

  const noJsContext = await browser.newContext({ javaScriptEnabled: false });
  try {
    const plainPage = await noJsContext.newPage();
    await plainPage.goto(`${baseUrl}/reference?plain=1&manual=1`, { waitUntil: "load" });
    const emptyReference = await readMaxLinesGeometry(plainPage);
    assert.deepEqual(
      emptyReference.map(({ name, maxLines }) => ({ name, maxLines })),
      [
        { name: "long", maxLines: "3" },
        { name: "short", maxLines: "20" },
      ],
      `${styleMode}: no-JS reference cap fixture did not render expected hosts`,
    );
    for (const metric of emptyReference)
      assertMaxLinesGeometry(metric, {
        ...fixtures[metric.name],
        label: "empty reference",
        hasShadowRoot: false,
      });

    const dsdPage = await noJsContext.newPage();
    await dsdPage.goto(`${baseUrl}/reference?manual=1`, { waitUntil: "networkidle" });
    const dsdBeforeJavaScript = await readMaxLinesGeometry(dsdPage);
    assert.deepEqual(
      dsdBeforeJavaScript.map(({ name }) => name),
      ["long", "short"],
      `${styleMode}: DSD cap fixture did not render both hosts`,
    );
    for (const metric of dsdBeforeJavaScript) {
      const fixture = fixtures[metric.name];
      assertMaxLinesGeometry(metric, {
        ...fixture,
        label: "DSD before JavaScript",
        hasShadowRoot: true,
        checkKeyboard: false,
      });
      assert.equal(metric.markedLinkCount, 1, `DSD ${metric.name}: shared CSS URL is missing`);
    }
    await assertLastCodeCharacterVisible(
      dsdPage,
      '[data-max-lines-host="long"]',
      `${styleMode} DSD no-JS cap`,
    );
  } finally {
    await noJsContext.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    const warnings = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") warnings.push(message.text());
    });
    page.on("pageerror", (error) => warnings.push(error.message));

    await page.goto(`${baseUrl}/reference?plain=1&manual=1`, { waitUntil: "networkidle" });
    const beforeRegistration = await readMaxLinesGeometry(page);
    for (const metric of beforeRegistration)
      assertMaxLinesGeometry(metric, {
        ...fixtures[metric.name],
        label: "empty reference",
        hasShadowRoot: false,
      });

    const rawBefore = await page.evaluate(() => {
      const template = document.querySelector('[data-max-lines-host="long"]');
      const host = document.createElement("ferriki-code");
      const next = document.createElement("div");
      host.setAttribute("data-raw-max-lines", "");
      host.setAttribute("code-ref", "probe-updated");
      host.setAttribute("max-lines", "3");
      host.setAttribute("style", template.getAttribute("style") ?? "");
      next.setAttribute("data-raw-max-lines-next", "");
      next.style.blockSize = "1px";
      document.body.append(host, next);
      window.__rawMaxLinesHost = host;
      return {
        hasShadowRoot: Boolean(host.shadowRoot),
        height: host.getBoundingClientRect().height,
        bottom: host.getBoundingClientRect().bottom + window.scrollY,
        nextTop: next.getBoundingClientRect().top + window.scrollY,
      };
    });
    assert.equal(rawBefore.hasShadowRoot, false, `${styleMode}: raw cap host upgraded too early`);
    assert(Math.abs(rawBefore.nextTop - rawBefore.bottom) < 1);

    await page.evaluate(async () => {
      await import("/src/reference-client.jsx");
      window.__registerUpdatedReference();
    });
    await page.waitForFunction(() => window.__referenceHydrated === true);
    const afterRegistration = await readMaxLinesGeometry(page);
    for (const metric of afterRegistration)
      if (metric.name !== "raw")
        assertMaxLinesGeometry(metric, {
          ...fixtures[metric.name],
          label: "filled reference",
          hasShadowRoot: true,
        });

    for (const before of beforeRegistration) {
      const after = afterRegistration.find(({ name }) => name === before.name);
      assert(
        Math.abs(after.height - before.height) < 1 && Math.abs(after.nextTop - before.nextTop) < 1,
        `${styleMode} ${before.name}: reference registration shifted capped geometry`,
      );
    }

    const rawAfter = afterRegistration.find(({ name }) => name === "raw");
    assertMaxLinesGeometry(rawAfter, {
      ...fixtures.long,
      label: "raw manual host after upgrade",
      hasShadowRoot: true,
    });
    assert(
      Math.abs(rawAfter.height - rawBefore.height) < 1 &&
        Math.abs(rawAfter.nextTop - rawBefore.nextTop) < 1,
      `${styleMode}: upgrading a raw max-lines host shifted its following sibling`,
    );

    await page.evaluate(() => {
      const host = document.querySelector('[data-max-lines-host="long"]');
      window.__cappedHostIdentity = {
        host,
        root: host.shadowRoot,
        pre: host.shadowRoot.querySelector("pre"),
        code: host.shadowRoot.querySelector("pre code"),
      };
    });

    const longPre = page.locator('[data-max-lines-host="long"] pre');
    await longPre.scrollIntoViewIfNeeded();
    await longPre.evaluate((pre) => {
      pre.scrollTop = 0;
      pre.focus();
    });
    await page.keyboard.press("PageDown");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-max-lines-host="long"]')?.shadowRoot?.querySelector("pre")
          ?.scrollTop > 0,
      undefined,
      { timeout: 1000 },
    );
    const keyboardScrollTop = await longPre.evaluate((pre) => pre.scrollTop);
    assert(keyboardScrollTop > 0, `${styleMode}: keyboard PageDown did not scroll the capped pre`);
    await assertLastCodeCharacterVisible(
      page,
      '[data-max-lines-host="long"]',
      `${styleMode} reference cap`,
    );

    const beforeGrow = afterRegistration.find(({ name }) => name === "long");
    await page.locator("[data-max-lines-grow]").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-max-lines-host="long"]')?.getAttribute("max-lines") === "6",
    );
    const afterGrow = (await readMaxLinesGeometry(page)).find(({ name }) => name === "long");
    assertMaxLinesGeometry(afterGrow, {
      ...fixtures.long,
      maxLines: 6,
      label: "grown reference cap",
      hasShadowRoot: true,
    });
    assert(
      Math.abs(
        afterGrow.height - beforeGrow.height - 3 * Number.parseFloat(beforeGrow.preLineHeight),
      ) < 1,
      `${styleMode}: raising the line cap did not grow the viewport by three lines`,
    );
    assert(
      Math.abs(
        afterGrow.nextTop - beforeGrow.nextTop - 3 * Number.parseFloat(beforeGrow.preLineHeight),
      ) < 1,
      `${styleMode}: raising the line cap did not move the next sibling with the viewport`,
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const before = window.__cappedHostIdentity;
        const host = document.querySelector('[data-max-lines-host="long"]');
        return {
          host: host === before.host,
          root: host.shadowRoot === before.root,
          pre: host.shadowRoot.querySelector("pre") === before.pre,
          code: host.shadowRoot.querySelector("pre code") === before.code,
        };
      }),
      { host: true, root: true, pre: true, code: true },
      `${styleMode}: updating max-lines replaced the reference host or code nodes`,
    );

    await page.locator("[data-max-lines-remove]").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-max-lines-host="long"]')?.hasAttribute("max-lines") === false,
    );
    const afterRemove = (await readMaxLinesGeometry(page)).find(({ name }) => name === "long");
    assert.equal(afterRemove.maxLines, null, `${styleMode}: removing the cap retained max-lines`);
    assertMaxLinesGeometry(afterRemove, {
      ...fixtures.long,
      maxLines: undefined,
      label: "uncapped reference",
      hasShadowRoot: true,
    });
    assert(
      Math.abs(
        afterRemove.height -
          afterGrow.height -
          (updatedLineCount - 6) * Number.parseFloat(afterGrow.preLineHeight),
      ) < 1,
      `${styleMode}: removing the cap did not restore the full source height`,
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const before = window.__cappedHostIdentity;
        const host = document.querySelector('[data-max-lines-host="long"]');
        return {
          host: host === before.host,
          root: host.shadowRoot === before.root,
          pre: host.shadowRoot.querySelector("pre") === before.pre,
          code: host.shadowRoot.querySelector("pre code") === before.code,
        };
      }),
      { host: true, root: true, pre: true, code: true },
      `${styleMode}: removing max-lines replaced the reference host or code nodes`,
    );

    const short = (await readMaxLinesGeometry(page)).find(({ name }) => name === "short");
    assertMaxLinesGeometry(short, {
      ...fixtures.short,
      label: "short reference under cap",
      hasShadowRoot: true,
    });
    assert.deepEqual(warnings, [], `${styleMode}: max-lines hydration or updates warned or failed`);

    const dsdPage = await context.newPage();
    await dsdPage.goto(`${baseUrl}/reference?manual=1`, { waitUntil: "networkidle" });
    const dsdBeforeUpgrade = await readMaxLinesGeometry(dsdPage);
    for (const metric of dsdBeforeUpgrade) {
      assertMaxLinesGeometry(metric, {
        ...fixtures[metric.name],
        label: "DSD before upgrade",
        hasShadowRoot: true,
      });
      assert.equal(
        metric.markedLinkCount,
        1,
        `DSD ${metric.name}: expected its external stylesheet link`,
      );
      await dsdPage.locator(`[data-max-lines-host="${metric.name}"]`).evaluate((host) => {
        window[`__dsdIdentity_${host.dataset.maxLinesHost}`] = {
          root: host.shadowRoot,
          pre: host.shadowRoot.querySelector("pre"),
          code: host.shadowRoot.querySelector("pre code"),
        };
      });
    }
    await dsdPage.evaluate(async () => {
      await import("/src/reference-client.jsx");
      window.__registerUpdatedReference();
    });
    await dsdPage.waitForFunction(() => window.__referenceHydrated === true);
    const dsdAfterUpgrade = await readMaxLinesGeometry(dsdPage);
    for (const metric of dsdAfterUpgrade) {
      assertMaxLinesGeometry(metric, {
        ...fixtures[metric.name],
        label: "DSD after upgrade",
        hasShadowRoot: true,
      });
      assert.equal(
        metric.markedLinkCount,
        0,
        `DSD ${metric.name}: marked CSS link survived registration`,
      );
      assert.equal(
        metric.adoptedSheetCount,
        1,
        `DSD ${metric.name}: shared CSS sheet was not adopted`,
      );
      assert(
        Math.abs(metric.height - dsdBeforeUpgrade.find(({ name }) => name === metric.name).height) <
          1,
        `DSD ${metric.name}: upgrade changed its capped host height`,
      );
    }
    assert.deepEqual(
      await dsdPage.evaluate(() =>
        ["long", "short"].map((name) => {
          const host = document.querySelector(`[data-max-lines-host="${name}"]`);
          const before = window[`__dsdIdentity_${name}`];
          return {
            root: host.shadowRoot === before.root,
            pre: host.shadowRoot.querySelector("pre") === before.pre,
            code: host.shadowRoot.querySelector("pre code") === before.code,
          };
        }),
      ),
      [
        { root: true, pre: true, code: true },
        { root: true, pre: true, code: true },
      ],
      `${styleMode}: upgrading DSD cap hosts replaced the existing shadow nodes`,
    );
    console.log(
      `Reference maxLines ${styleMode}: no-JS sizing, DSD CSS cap, scrolling, keyboard access, raw upgrade, and cap changes passed`,
    );
  } finally {
    await context.close();
  }
}

async function checkFontAliases(context, baseUrl, styleMode) {
  const page = await context.newPage();
  const warnings = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") warnings.push(message.text());
  });
  page.on("pageerror", (error) => warnings.push(error.message));
  try {
    await page.goto(`${baseUrl}/fonts`, { waitUntil: "networkidle" });
    await page.evaluate(async () => import("/font-registration.js"));
    const expected = {
      day: { style: "italic", weight: "700", decoration: "underline" },
      night: { style: "normal", weight: "400", decoration: "none" },
    };
    const fontFlags = (element) => {
      const token = [...element.shadowRoot.querySelectorAll("span")]
        .filter((span) => span.textContent === "=")
        .at(-1);
      const computed = getComputedStyle(token);
      return {
        style: computed.fontStyle,
        weight: computed.fontWeight,
        decoration: computed.textDecorationLine,
      };
    };
    for (const defaultColor of ["day", "night"]) {
      const host = page.locator(`[data-font-default="${defaultColor}"] .font-shadow-code`);
      await page.waitForFunction(
        (color) =>
          Boolean(
            document.querySelector(`[data-font-default="${color}"] ferriki-code`)?.shadowRoot,
          ),
        defaultColor,
      );
      assert.deepEqual(
        await host.evaluate(fontFlags),
        expected[defaultColor],
        `${styleMode}/${defaultColor}: default theme font flags were lost`,
      );
      const otherColor = defaultColor === "day" ? "night" : "day";
      await host.evaluate(
        (element, theme) => element.setAttribute("data-ferriki-theme", theme),
        otherColor,
      );
      assert.deepEqual(
        await host.evaluate(fontFlags),
        expected[otherColor],
        `${styleMode}/${defaultColor}: changing theme aliases lost font flags`,
      );
    }
    assert.deepEqual(warnings, [], "font alias registration warned or failed");
  } finally {
    await page.close();
  }
}

async function checkClientPropertyContract(page, initialBlock, updatedBlock) {
  await page.evaluate(async () => {
    const module = await import("/src/csr-probe.js");
    const constructor = customElements.get("ferriki-code");
    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, "highlightedCode");
    window.__highlightedSetterCalls = 0;
    Object.defineProperty(constructor.prototype, "highlightedCode", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        window.__highlightedSetterCalls++;
        descriptor.set.call(this, value);
      },
    });
    const target = document.createElement("section");
    target.id = "client-property-probe";
    document.body.append(target);
    window.__csrProbeModule = module;
    window.__csrProbeRoot = module.mount(target, module.initialBlock);
  });
  await page.waitForFunction(() =>
    Boolean(document.querySelector("#client-property-probe ferriki-code")?.shadowRoot),
  );
  assert.deepEqual(
    await page.locator("#client-property-probe ferriki-code").evaluate((host) => ({
      shadowSource: host.shadowRoot.querySelector("pre code")?.textContent,
      fallbackSource: host.querySelector("pre code")?.textContent,
      setterCalls: window.__highlightedSetterCalls,
      hasProperty: "highlightedCode" in host,
    })),
    {
      shadowSource: initialBlock.code,
      fallbackSource: initialBlock.code,
      setterCalls: 1,
      hasProperty: true,
    },
    "React client mount did not assign highlightedCode while preserving fallback children",
  );

  assert.deepEqual(
    await page.locator("#client-property-probe ferriki-code").evaluate((host) => {
      const root = host.shadowRoot;
      host.highlightedCode = null;
      const slot = root.querySelector("slot");
      return {
        clearedMarkup: !root.querySelector("pre code"),
        fallbackSlot: Boolean(slot),
        assignedFallback: slot
          ?.assignedNodes({ flatten: true })
          .map((node) => node.textContent)
          .join(""),
      };
    }),
    {
      clearedMarkup: true,
      fallbackSlot: true,
      assignedFallback: initialBlock.code,
    },
    "clearing highlightedCode did not reveal the React-owned fallback through a slot",
  );

  await page.evaluate(() =>
    window.__csrProbeModule.update(window.__csrProbeRoot, window.__csrProbeModule.updatedBlock),
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#client-property-probe ferriki-code")
      ?.shadowRoot?.querySelector("pre code")
      ?.textContent.includes("Updated without rebuilding the host"),
  );
  assert.deepEqual(
    await page.locator("#client-property-probe ferriki-code").evaluate((host) => ({
      source: host.shadowRoot.querySelector("pre code")?.textContent,
      fallback: host.querySelector("pre code")?.textContent,
      setterCalls: window.__highlightedSetterCalls,
    })),
    {
      source: updatedBlock.code,
      fallback: updatedBlock.code,
      setterCalls: 3,
    },
    "React update did not set highlightedCode or update its source fallback",
  );

  const evidence = await page.evaluate(() => {
    const legacy = document.createElement("ferriki-code");
    legacy.setAttribute("highlighted-code", window.__csrProbeModule.updatedBlock.html);
    legacy.setAttribute("data-ferriki-theme", "light");
    legacy.innerHTML = "<pre><code>legacy fallback</code></pre>";
    document.body.append(legacy);
    const ssr = document.createElement("ferriki-code");
    ssr.setAttribute("highlightedcode", window.__csrProbeModule.initialBlock.html);
    ssr.setAttribute("data-ferriki-theme", "light");
    ssr.innerHTML = "<pre><code>SSR fallback</code></pre>";
    document.body.append(ssr);

    const latestWrite = document.createElement("ferriki-code");
    latestWrite.setAttribute("data-ferriki-theme", "light");
    latestWrite.setAttribute("highlightedcode", "<pre><code>camel old</code></pre>");
    latestWrite.innerHTML = "<pre><code>latest-write fallback</code></pre>";
    latestWrite.highlightedCode = "<pre><code>property new</code></pre>";
    const propertyDoesNotReflect =
      latestWrite.getAttribute("highlightedcode") === "<pre><code>camel old</code></pre>";
    document.body.append(latestWrite);
    const propertyWins =
      latestWrite.shadowRoot.querySelector("pre code")?.textContent === "property new";
    latestWrite.setAttribute("highlighted-code", "<pre><code>kebab third</code></pre>");
    const kebabAttributeWins =
      latestWrite.shadowRoot.querySelector("pre code")?.textContent === "kebab third";
    latestWrite.removeAttribute("highlighted-code");
    const camelAttributeReturns =
      latestWrite.shadowRoot.querySelector("pre code")?.textContent === "camel old";
    latestWrite.removeAttribute("highlightedcode");
    const clearedToFallback =
      !latestWrite.shadowRoot.querySelector("pre code") &&
      latestWrite.shadowRoot
        .querySelector("slot")
        ?.assignedNodes({ flatten: true })
        .map((node) => node.textContent)
        .join("") === "latest-write fallback";

    const hosts = [
      document.querySelector(".shadow-code"),
      document.querySelector("[data-panel=macro] ferriki-code"),
      document.querySelector("#client-property-probe ferriki-code"),
      legacy,
      ssr,
      latestWrite,
    ];
    const roots = hosts.map((host) => host.shadowRoot);
    const sheets = roots.map((root) => Array.from(root.adoptedStyleSheets));
    const firstSheet = sheets[0][0];
    const rules = Array.from(firstSheet.cssRules, (rule) => rule.cssText);
    const definition = customElements.get("ferriki-code");
    const repeatedDefinition = window.__csrProbeModule.defineCodeElement({
      css: window.__csrProbeModule.initialBlock.css,
      themeAliases: ["light", "dark"],
    });
    return {
      legacySource: legacy.shadowRoot.querySelector("pre code")?.textContent,
      ssrSource: ssr.shadowRoot.querySelector("pre code")?.textContent,
      latestWrite: {
        propertyDoesNotReflect,
        propertyWins,
        kebabAttributeWins,
        camelAttributeReturns,
        clearedToFallback,
      },
      sharedSheet: sheets.every((list) => list.length === 1 && list[0] === firstSheet),
      duplicateRules: rules.length - new Set(rules).size,
      shadowStyleTags: roots.map((root) => root.querySelectorAll("style").length),
      idempotentRegistration: definition === repeatedDefinition,
    };
  });
  assert.deepEqual(
    evidence,
    {
      legacySource: updatedBlock.code,
      ssrSource: initialBlock.code,
      latestWrite: {
        propertyDoesNotReflect: true,
        propertyWins: true,
        kebabAttributeWins: true,
        camelAttributeReturns: true,
        clearedToFallback: true,
      },
      sharedSheet: true,
      duplicateRules: 0,
      shadowStyleTags: [0, 0, 0, 0, 0, 0],
      idempotentRegistration: true,
    },
    "highlightedCode attributes, shared stylesheet reuse, or rule deduplication failed",
  );
}

async function check(styleMode, browserName) {
  const projectPath = join(tempRoot, browserName, styleMode);
  await cp(fixtureRoot, projectPath, { recursive: true });
  const project = await realpath(projectPath);
  await writeFile(join(project, "package.json"), '{"private":true,"type":"module"}\n');
  const projectModules = join(project, "node_modules");
  await mkdir(join(projectModules, "@ferriki"), { recursive: true });
  for (const dependency of ["react", "react-dom", "scheduler"])
    await symlink(
      join(depsRoot, "node_modules", dependency),
      join(projectModules, dependency),
      "dir",
    );
  await symlink(join(nodeRoot, "ferriki"), join(projectModules, "@ferriki", "core"), "dir");
  await writeElementProbe(project);
  if (!serveOnly) await writeFontFixture(project, styleMode);
  const template = await readFile(join(project, "index.html"), "utf8");
  let server;
  let ferrikiPlugin;
  const ssr = {
    name: "ferriki-shadow-demo-ssr",
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/ferriki-code.css" || url.pathname === "/reference.css") {
          try {
            response.setHeader("content-type", "text/css; charset=utf-8");
            if (url.pathname === "/reference.css") {
              const { referenceCss } = await vite.ssrLoadModule("/src/reference-server.jsx");
              response.end(referenceCss);
            } else response.end(ferrikiPlugin.api.codeElementCss());
          } catch (error) {
            response.statusCode = 500;
            response.end(error.stack ?? String(error));
          }
          return;
        }
        if (url.pathname !== "/" && url.pathname !== "/fonts" && url.pathname !== "/reference")
          return next();
        try {
          let rendered;
          if (url.pathname === "/fonts") {
            const { render } = await vite.ssrLoadModule("/font-fixture.jsx");
            rendered = render();
          } else if (url.pathname === "/reference") {
            const referenceServer = await vite.ssrLoadModule("/src/reference-server.jsx");
            rendered = url.searchParams.has("plain")
              ? referenceServer.renderReferenceApp()
              : referenceServer.renderReferenceShadows();
          } else {
            const { render } = await vite.ssrLoadModule("/src/server.jsx");
            rendered = ferrikiPlugin.api.renderCodeElements(render(), {
              stylesheetHref: "/ferriki-code.css",
            });
          }
          let html = template.replace("<!--ssr-outlet-->", rendered);
          if (url.pathname === "/reference")
            html = html.replace("/src/client.jsx", "/src/reference-client.jsx");
          if (url.searchParams.has("manual") || url.pathname === "/fonts")
            html = html.replace(
              /<script type="module" src="\/src\/(?:reference-)?client\.jsx"><\/script>/u,
              "",
            );
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(await vite.transformIndexHtml(request.url ?? "/", html));
        } catch (error) {
          response.statusCode = 500;
          response.end(error.stack ?? String(error));
        }
      });
    },
  };
  try {
    server = await createServer({
      root: project,
      configFile: false,
      plugins: [
        (ferrikiPlugin = ferriki({
          themes: { light: "github-light-default", dark: "github-dark-default" },
          styleMode,
          assets: { remote: false },
        })),
        ssr,
      ],
      oxc: { jsx: { runtime: "automatic" } },
      optimizeDeps: {
        include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
        noDiscovery: true,
      },
      appType: "custom",
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, fs: { allow: [project, nodeRoot] } },
    });
    await server.listen();
    const address = server.httpServer.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    if (serveOnly) {
      console.log(`Ferriki Shadow DOM demo: ${baseUrl}`);
      console.log("Press Ctrl+C to stop and remove the temporary consumer.");
      await new Promise((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
      return;
    }
    const { initialBlock, updatedBlock } = await server.ssrLoadModule("/src/snippets.jsx");
    const { render } = await server.ssrLoadModule("/src/server.jsx");
    const html = render();
    const macroMarkup = ferrikiPlugin.api.renderCodeElements(html, {
      stylesheetHref: "/ferriki-code.css",
    });
    assert.match(macroMarkup, /<template shadowrootmode="open">/);
    assert.match(macroMarkup, /<!--ferriki-code:ferriki%2D[0-9a-f]+-->/u);
    const rawMacroHost = html.match(
      /<ferriki-code[^>]+code-ref="ferriki-[a-f0-9]{64}"[^>]*><\/ferriki-code>/u,
    )?.[0];
    assert(rawMacroHost, "raw default Code output did not contain an empty code-ref host");
    assert.doesNotMatch(rawMacroHost, /highlightedCode=|<pre/iu);
    assert.match(macroMarkup, /<pre[^>]*>[\s\S]*?<code>/u);
    assert.match(
      macroMarkup,
      /<link rel="stylesheet" href="\/ferriki-code\.css" data-ferriki-code-css>/u,
    );
    await checkUpgradePaths(browser, baseUrl, initialBlock);
    const referenceServer = await server.ssrLoadModule("/src/reference-server.jsx");
    const referenceMarkup = referenceServer.renderReferenceApp();
    assert.match(referenceMarkup, /<ferriki-code[^>]+code-ref="probe-initial"><\/ferriki-code>/);
    assert.doesNotMatch(
      referenceMarkup,
      /<ferriki-code[^>]+code-ref="probe-initial">[^<\s]/,
      "the React reference adapter emitted prepared HTML as host content",
    );

    await checkReferenceSizing(browser, baseUrl, styleMode, initialBlock, updatedBlock);
    await checkReferenceMaxLines(browser, baseUrl, styleMode, initialBlock, updatedBlock);

    const noJsContext = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await noJsContext.newPage();
      await page.goto(baseUrl);
      assert.equal(
        await page.locator('[data-panel="shadow"] pre code').textContent(),
        initialBlock.code,
      );
      assert.equal(
        await page
          .locator('[data-panel="macro"] ferriki-code')
          .evaluate((host) => host.shadowRoot?.querySelector("pre code")?.textContent),
        'const island = "prepared at build time";\nconsole.log(island);\n',
        "default Code macro SSR did not preserve highlighted text in declarative Shadow DOM",
      );
      assert(
        await page.locator('[data-panel="shadow"] pre').isVisible(),
        "SSR source fallback was hidden without JavaScript",
      );
      assert.equal(
        await page.locator('[data-panel="shadow"] ferriki-code').getAttribute("highlightedcode"),
        initialBlock.html,
        "SSR did not preserve highlighted HTML in the custom property attribute",
      );
      const macroHostWithoutJs = page.locator('[data-panel="macro"] ferriki-code');
      assert.deepEqual(
        await macroHostWithoutJs.evaluate((host) => ({
          root: Boolean(host.shadowRoot),
          visible: Boolean(host.shadowRoot?.querySelector("pre")?.getClientRects().length),
          ref: host.getAttribute("code-ref"),
          links: [...(host.shadowRoot?.querySelectorAll("link[data-ferriki-code-css]") ?? [])].map(
            (link) => link.href,
          ),
          inlineStyles: host.shadowRoot?.querySelectorAll("style").length,
        })),
        {
          root: true,
          visible: true,
          ref: await macroHostWithoutJs.getAttribute("code-ref"),
          links: [`${baseUrl}/ferriki-code.css`],
          inlineStyles: 0,
        },
        "default Code macro SSR did not use declarative Shadow DOM and one external stylesheet URL",
      );
      await page.goto(`${baseUrl}/fonts`);
      assert.equal(
        await page.locator("[data-font-default=day] pre code").textContent(),
        "const value = 1",
        "the font fixture did not retain its source fallback without JavaScript",
      );
      assert.equal(
        await page
          .locator("[data-font-default=night] ferriki-code")
          .evaluate((host) => host.shadowRoot),
        null,
        "the font fixture unexpectedly required a shadow root without JavaScript",
      );
    } finally {
      await noJsContext.close();
    }
    await checkReferencePaths(browser, baseUrl, styleMode, initialBlock, updatedBlock);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      await checkFontAliases(context, baseUrl, styleMode);
      const page = await context.newPage();
      const warnings = [];
      page.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error")
          warnings.push(message.text());
      });
      page.on("pageerror", (error) => warnings.push(error.message));
      await page.goto(`${baseUrl}/?manual=1`, { waitUntil: "networkidle" });
      await page.evaluate(async () => import("/src/element-probe.js"));
      await page.evaluate(() => {
        const host = document.querySelector(".shadow-code");
        window.__initialShadowRoot = host.shadowRoot;
        window.__initialShadowPre = host.shadowRoot.querySelector("pre");
        window.__initialShadowToken = host.shadowRoot.querySelector("code span");
        window.__initialShadowFallback = host.querySelector("pre");
        const macroHost = document.querySelector("[data-panel=macro] ferriki-code");
        window.__initialMacroRoot = macroHost.shadowRoot;
        window.__initialMacroPre = macroHost.shadowRoot.querySelector("pre");
        window.__initialMacroToken = macroHost.shadowRoot.querySelector("code span");
        window.__initialMacroFallback = macroHost.querySelector("pre");
        const descriptor = Object.getOwnPropertyDescriptor(
          customElements.get("ferriki-code").prototype,
          "highlightedCode",
        );
        window.__hydrationSetterCalls = 0;
        Object.defineProperty(customElements.get("ferriki-code").prototype, "highlightedCode", {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {
            window.__hydrationSetterCalls++;
            descriptor.set.call(this, value);
          },
        });
        window.__copiedCode = undefined;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.__copiedCode = text;
            },
          },
        });
      });
      await page.evaluate(async () => {
        await import("/src/client.jsx");
      });
      await page.waitForFunction(() => window.__ferrikiShadowHydrated === true);
      assert.equal(
        await page.evaluate(() => window.__ferrikiCodeDefinedBeforeHydration),
        true,
        "the custom element was not defined before React hydration",
      );
      assert.deepEqual(await page.evaluate(() => window.__ferrikiShadowErrors), []);
      assert.deepEqual(warnings, [], "development hydration warned or failed");
      assert.equal(
        await page.evaluate(() => window.__hydrationSetterCalls),
        0,
        "React hydration unexpectedly reassigned highlightedCode instead of adopting SSR attributes",
      );
      assert.deepEqual(
        await page.locator("[data-panel=macro] ferriki-code").evaluate((host) => ({
          defined: customElements.get("ferriki-code") !== undefined,
          isCustomElement: host instanceof customElements.get("ferriki-code"),
          rootPreserved: host.shadowRoot === window.__initialMacroRoot,
          prePreserved: host.shadowRoot.querySelector("pre") === window.__initialMacroPre,
          tokenPreserved: host.shadowRoot.querySelector("code span") === window.__initialMacroToken,
          fallbackAbsent:
            host.querySelector("pre") === null && window.__initialMacroFallback === null,
          fallbackText: host.querySelector("pre code")?.textContent,
          codeRef: host.getAttribute("code-ref"),
          theme: host.getAttribute("data-ferriki-theme"),
          styleTags: host.shadowRoot.querySelectorAll("style").length,
          markedStylesheets: host.shadowRoot.querySelectorAll("link[data-ferriki-code-css]").length,
        })),
        {
          defined: true,
          isCustomElement: true,
          rootPreserved: true,
          prePreserved: true,
          tokenPreserved: true,
          fallbackAbsent: true,
          fallbackText: undefined,
          codeRef: await page.locator("[data-panel=macro] ferriki-code").getAttribute("code-ref"),
          theme: "light",
          styleTags: 0,
          markedStylesheets: 0,
        },
        "default Code macro did not hydrate its reference host in place",
      );
      await checkClientPropertyContract(page, initialBlock, updatedBlock);
      const sameNodes = () =>
        page.evaluate(() => {
          const host = document.querySelector(".shadow-code");
          return {
            root: host.shadowRoot === window.__initialShadowRoot,
            pre: host.shadowRoot.querySelector("pre") === window.__initialShadowPre,
            token: host.shadowRoot.querySelector("code span") === window.__initialShadowToken,
            fallback: host.querySelector("pre") === window.__initialShadowFallback,
          };
        });
      assert.deepEqual(
        await sameNodes(),
        { root: true, pre: true, token: true, fallback: true },
        "hydration replaced SSR token nodes",
      );

      const shadow = page.locator(".shadow-code");
      const light = page.locator("[data-light-code]");
      const lightStyles = await light.evaluate(tokenStyles);
      const shadowStyles = await shadow.evaluate(tokenStyles);
      assert.deepEqual(
        shadowStyles,
        lightStyles,
        "isolated theme, base, or annotation CSS differs from the baseline",
      );
      assert.equal(shadowStyles.lineNumber, '"1"');
      assert.notEqual(shadowStyles.selectedLineBackground, "rgba(0, 0, 0, 0)");
      assert.match(shadowStyles.font, /monospace/);

      await page.locator("[data-rerender]").click();
      assert.equal(await page.locator("main").getAttribute("data-parent-renders"), "1");
      assert.deepEqual(await sameNodes(), {
        root: true,
        pre: true,
        token: true,
        fallback: true,
      });

      await page.locator("[data-toggle-theme]").click();
      const dark = await shadow.evaluate(tokenStyles);
      assert.equal(
        await page.locator("[data-panel=macro] ferriki-code").getAttribute("data-ferriki-theme"),
        "dark",
        "default Code macro did not receive the runtime theme prop",
      );
      assert.notEqual(dark.color, shadowStyles.color, "dark theme did not change token color");
      assert.notEqual(
        dark.background,
        shadowStyles.background,
        "dark theme did not change code background",
      );
      assert.deepEqual(dark, await light.evaluate(tokenStyles));
      assert.deepEqual(
        await sameNodes(),
        { root: true, pre: true, token: true, fallback: true },
        "theme change rebuilt the shadow content",
      );

      await page.locator("[data-toggle-conflict]").check();
      await page.waitForFunction(() =>
        document.querySelector("main")?.classList.contains("conflict"),
      );
      assert.deepEqual(
        await shadow.evaluate(tokenStyles),
        dark,
        "page selectors leaked into shadow CSS",
      );
      assert.notEqual(
        (await light.evaluate(tokenStyles)).color,
        dark.color,
        "the conflict control did not affect regular HTML",
      );
      assert.notEqual((await light.evaluate(tokenStyles)).font, dark.font);
      assert.deepEqual(await sameNodes(), {
        root: true,
        pre: true,
        token: true,
        fallback: true,
      });

      assert.equal(await shadow.locator("pre code:visible").textContent(), initialBlock.code);
      const lightSelection = await selectCodeText(light.locator("pre code"));
      const shadowSelection = await selectCodeText(shadow.locator("pre code:visible"));
      assert.equal(
        shadowSelection,
        lightSelection,
        "selection differs between the shadow and regular HTML blocks",
      );
      assert.equal(
        shadowSelection,
        initialBlock.code.replace(/\n$/, ""),
        "selection changed visible source text or included annotation text",
      );
      await page.evaluate(() => {
        window.__nativeCopySelection = undefined;
        document.addEventListener(
          "copy",
          () => {
            window.__nativeCopySelection = window.getSelection()?.toString() ?? "";
          },
          { once: true },
        );
      });
      await page.keyboard.press("ControlOrMeta+C");
      assert.equal(
        await page.evaluate(() => window.__nativeCopySelection),
        initialBlock.code.replace(/\n$/, ""),
        "the browser's copy event did not expose the selected shadow source",
      );
      await page.locator('[data-copy-code="shadow"]').click();
      assert.equal(
        await page.evaluate(() => window.__copiedCode),
        initialBlock.code,
        "Copy included annotations or changed source",
      );

      await page.locator('[data-panel="light"]').evaluate((panel) => {
        panel.hidden = true;
      });
      if (browserName === "chromium") {
        const accessibility = await (
          await context.newCDPSession(page)
        ).send("Accessibility.getFullAXTree");
        assert(
          accessibility.nodes.some(
            (node) =>
              node.role?.value === "StaticText" &&
              node.name?.value.includes("Shadow DOM keeps real text"),
          ),
          "shadow source was missing from the accessibility tree",
        );
        assert.equal(
          await page.evaluate(() => {
            window.getSelection().removeAllRanges();
            return window.find("Shadow DOM keeps real text", false, false, true);
          }),
          true,
          "browser find could not locate shadow source",
        );
      } else {
        console.log(`${browserName}: skipped Chromium-only AX CDP and window.find checks`);
      }
      await page.locator('[data-panel="light"]').evaluate((panel) => {
        panel.hidden = false;
      });

      await page.locator("[data-update-code]").click();
      assert.equal(await shadow.locator("pre code:visible").textContent(), updatedBlock.code);
      const afterUpdate = await sameNodes();
      assert.equal(afterUpdate.root, true, "content update replaced the host's root");
      assert.equal(afterUpdate.pre, false, "content update kept stale source nodes");
      assert.equal(afterUpdate.fallback, true, "React replaced its reusable fallback container");
      assert.equal(
        await shadow.evaluate((host) => host.querySelector("pre code").textContent),
        updatedBlock.code,
        "React did not update the fallback source",
      );
      assert.equal(
        await shadow.locator("pre:visible").getAttribute("data-title"),
        updatedBlock.metadata.title,
      );
      await page.locator('[data-copy-code="shadow"]').click();
      assert.equal(await page.evaluate(() => window.__copiedCode), updatedBlock.code);

      const snippetPath = join(project, "src", "snippets.jsx");
      const original = await readFile(snippetPath, "utf8");
      const changed = original.replace(
        "Shadow DOM keeps real text",
        "HMR keeps the island current",
      );
      assert.notEqual(original, changed);
      const watcherChanges = [];
      const onWatcherChange = (changedPath) => watcherChanges.push(changedPath);
      server.watcher.on("change", onWatcherChange);
      await page.evaluate(() => {
        window.__ferrikiShadowHmrUpdates = [];
        window.addEventListener("ferriki:shadow-source-update", (event) => {
          window.__ferrikiShadowHmrUpdates.push(event.detail.initialBlock.code);
        });
      });
      await page.locator("[data-update-code]").click();
      await writeFile(snippetPath, changed);
      try {
        await page.waitForFunction(() =>
          document
            .querySelector(".shadow-code")
            ?.shadowRoot?.querySelector("code")
            ?.textContent.includes("HMR keeps the island current"),
        );
      } catch (error) {
        const source = await shadow.locator("pre code:visible").textContent();
        const browserHmrUpdates = await page.evaluate(() => window.__ferrikiShadowHmrUpdates);
        const transformed = await server.transformRequest("/src/snippets.jsx");
        const snippetModules = server.moduleGraph.getModulesByFile(snippetPath);
        const hmrImporters = [...(snippetModules ?? [])].flatMap((module) =>
          [...module.importers].map((importer) => ({
            url: importer.url,
            acceptsSnippet: [...importer.acceptedHmrDeps].includes(module),
          })),
        );
        server.watcher.off("change", onWatcherChange);
        throw new Error(
          `HMR did not update the shadow code. Current source: ${source}. Browser diagnostics: ${warnings.join("; ") || "none"}. ` +
            `HMR evidence: ${JSON.stringify({
              watcherChanges,
              browserHmrUpdates,
              transformedHasNewSource: transformed?.code.includes("HMR keeps the island current"),
              hmrImporters,
            })}`,
          { cause: error },
        );
      } finally {
        server.watcher.off("change", onWatcherChange);
      }
      assert.equal((await sameNodes()).root, true, "HMR replaced the shadow host's root");
      const transformed = await server.transformRequest("/src/snippets.jsx");
      assert(
        transformed.map?.sourcesContent?.some((source) =>
          source.includes("HMR keeps the island current"),
        ),
      );
      assert(transformed.map.mappings.length > 0);
      assert.deepEqual(await page.evaluate(() => window.__ferrikiShadowErrors), []);
      assert.deepEqual(warnings, [], "browser interactions or source reload warned or failed");

      const output = resolve(
        process.env.FERRIKI_SHADOW_SCREENSHOT ?? join(tempRoot, `${styleMode}.png`),
      );
      if (styleMode === "classes" && browserName === "chromium") {
        await page.locator("[data-toggle-conflict]").check();
        await page.screenshot({ path: output, fullPage: true });
        console.log(`Shadow DOM demo screenshot: ${output}`);
      }
    } finally {
      await context.close();
    }
    console.log(
      `Shadow DOM ${browserName}/${styleMode}: SSR fallback, highlightedCode property, hydration, shared stylesheet, CSS isolation, themes, selection, copy, updates, and source reload passed`,
    );
  } finally {
    await server?.close();
  }
}

try {
  if (serveOnly) {
    await check("classes", options.browsers[0]);
  } else {
    for (const browserName of options.browsers) {
      browser = await browserTypes[browserName].launch({ headless: true });
      try {
        for (const styleMode of ["inline", "classes"]) await check(styleMode, browserName);
      } finally {
        await browser.close();
      }
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
