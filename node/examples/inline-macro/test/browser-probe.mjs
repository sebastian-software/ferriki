import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { ferriki } from "@ferriki/vite";
import { fromHtml } from "hast-util-from-html";
import { chromium } from "playwright";
import React from "react";
import { renderToString } from "react-dom/server";
import { build, createServer } from "vite";

function hastText(node) {
  return node.type === "text"
    ? node.value
    : (node.children ?? []).map((child) => hastText(child)).join("");
}

async function main() {
  const project = process.env.FERRIKI_CONSUMER_PROJECT;
  assert(project, "FERRIKI_CONSUMER_PROJECT is required");
  const secondRoutePath = join(project, "src", "routes", "second.jsx");
  const options = {
    themes: { light: "github-light-default", dark: "github-dark-default" },
    styleMode: "classes",
    lineNumbers: true,
    assets: { remote: false },
  };

  const indexTemplate = await readFile(join(project, "index.html"), "utf8");
  let serverMarkup;
  const ssrPlugin = {
    name: "inline-macro-browser-fixture-ssr",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if ((request.url ?? "/").split("?", 1)[0] !== "/") return next();
        try {
          const { App } = await server.ssrLoadModule("/src/app.jsx");
          serverMarkup = renderToString(React.createElement(App, { initialRoute: "first" }));
          const html = indexTemplate.replace("<!--ssr-outlet-->", serverMarkup);
          const transformed = await server.transformIndexHtml(request.url ?? "/", html);
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(transformed);
        } catch (error) {
          server.ssrFixStacktrace(error);
          response.statusCode = 500;
          response.end(error.stack ?? String(error));
        }
      });
    },
  };

  const server = await createServer({
    configFile: false,
    root: project,
    plugins: [ferriki(options), ssrPlugin],
    esbuild: { jsx: "automatic" },
    optimizeDeps: {
      include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
      noDiscovery: true,
    },
    appType: "custom",
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      fs: { allow: [project] },
      hmr: { overlay: false },
    },
  });
  let browser;

  function cssImportId(code) {
    return code.match(/virtual:ferriki-vite\/[a-f0-9]+\.css/)?.[0];
  }

  function sourceMap(result) {
    const map = result?.map?.toJSON?.() ?? result?.map;
    assert(map, "Vite did not return a source map for the macro source");
    assert(
      map.sources.some((source) => {
        const normalized = source.replaceAll("\\", "/");
        return normalized === "second.jsx" || normalized.endsWith("src/routes/second.jsx");
      }),
      `the source map omitted the second route: ${map.sources.join(", ")}`,
    );
    assert(map.sourcesContent?.some((content) => content.includes("@ferriki/core/macro")));
    assert(map.mappings.length > 0, "Vite returned an empty source map for the macro source");
    return map;
  }

  try {
    await server.listen();
    const firstModule = await server.ssrLoadModule("/src/routes/first.jsx");
    const initialMarkup = renderToString(React.createElement(firstModule.default));
    assert.equal(firstModule.block.code, "const route = 'first';\nconsole.log(route);");
    assert.equal(firstModule.block.language, "ts");
    assert.deepEqual(firstModule.block.metadata, {
      title: "First route",
      label: "SSR",
      lineNumbers: true,
      highlightedLines: [2],
    });
    assert(initialMarkup.includes(firstModule.block.html));
    assert.match(initialMarkup, /data-title="First React macro"/);
    assert(
      hastText(fromHtml(initialMarkup, { fragment: true })).includes("const macroRoute = 'first';"),
    );
    assert.match(firstModule.block.css, /ferriki-style-[a-f0-9]{64}/);
    assert.match(firstModule.block.html, /<pre\b/);
    assert.match(firstModule.block.html, /<code\b/);

    const secondModule = await server.ssrLoadModule("/src/routes/second.jsx");
    const secondMarkup = renderToString(React.createElement(secondModule.default));
    assert.match(secondMarkup, /data-code-route="second-react-macro"/);
    assert.match(secondMarkup, /<h2>Second React macro<\/h2>/);
    assert(
      hastText(fromHtml(secondMarkup, { fragment: true })).includes("const macroRoute = 'second';"),
    );

    const secondSourceBefore = await readFile(secondRoutePath, "utf8");
    const before = await server.transformRequest("/src/routes/second.jsx");
    const beforeMap = sourceMap(before);
    assert.equal(
      beforeMap.sourcesContent.find((content) => content.includes("@ferriki/core/macro")),
      secondSourceBefore,
    );
    const cssIdBefore = cssImportId(before.code);
    assert(cssIdBefore, "the macro transform did not import its generated stylesheet");

    const address = server.httpServer.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new Error(
        "Chromium is not installed for Playwright 1.63.0. Run `pnpm dlx playwright@1.63.0 install --with-deps chromium` before this check.",
        { cause: error },
      );
    }

    const page = await browser.newPage();
    const clientWarnings = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error")
        clientWarnings.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => clientWarnings.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) =>
      clientWarnings.push(`requestfailed: ${request.url()} (${request.failure()?.errorText})`),
    );
    page.on("response", (response) => {
      if (response.status() >= 400)
        clientWarnings.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    try {
      await page.waitForFunction(() => window.__ferrikiHydrated === true, undefined, {
        timeout: 10_000,
      });
    } catch (error) {
      throw new Error(
        `React did not hydrate. Browser diagnostics: ${clientWarnings.join("\n") || "none"}`,
        {
          cause: error,
        },
      );
    }
    const hydratedMarkup = await page.locator("#root").innerHTML();
    const normalizedServerMarkup = await page.evaluate((markup) => {
      const template = document.createElement("template");
      template.innerHTML = markup;
      return template.innerHTML;
    }, serverMarkup);
    assert.equal(
      hydratedMarkup,
      normalizedServerMarkup,
      "client hydration changed the parsed server-rendered HTML",
    );
    assert.deepEqual(clientWarnings, [], "SSR hydration emitted a browser warning or error");

    const firstBlock = page.locator('[data-code-route="first"]');
    assert.equal(await firstBlock.locator("h2").textContent(), "First route");
    const initialCode = (await firstBlock.locator(".rendered-code").textContent()) ?? "";
    assert(initialCode.includes("const route = 'first';"));
    assert(initialCode.includes("console.log(route);"));
    assert.equal(await firstBlock.locator("pre[class*='ferriki-themes-']").count(), 1);
    assert(await firstBlock.locator(".token").count());
    const defaultMacroBlock = page.locator('pre[data-title="First React macro"]');
    assert.equal(await defaultMacroBlock.count(), 1);
    assert(((await defaultMacroBlock.textContent()) ?? "").includes("const macroRoute = 'first';"));
    assert(await defaultMacroBlock.locator(".token").count());

    const annotations = await firstBlock.evaluate((section) => {
      const lines = [...section.querySelectorAll(".ferriki-highlight-line[data-ln]")];
      const selected = lines.find((line) => line.classList.contains("highlighted"));
      return {
        lineNumbers: lines.map((line) => line.getAttribute("data-ln")),
        firstNumber: getComputedStyle(lines[0], "::before").content,
        numberDisplay: getComputedStyle(lines[0], "::before").display,
        selectedLine: selected?.getAttribute("data-ln"),
        selectedBackground: selected ? getComputedStyle(selected).backgroundColor : "",
      };
    });
    assert.deepEqual(annotations.lineNumbers, ["1", "2"]);
    assert.equal(annotations.firstNumber, '"1"');
    assert.equal(annotations.numberDisplay, "inline-block");
    assert.equal(annotations.selectedLine, "2");
    assert.notEqual(annotations.selectedBackground, "rgba(0, 0, 0, 0)");

    const computedStyles = await firstBlock.evaluate((section) => {
      const pre = section.querySelector("pre");
      const keyword = section.querySelector(".tok-keyword");
      const stringToken = section.querySelector(".tok-string");
      const lightKeywordColor = keyword ? getComputedStyle(keyword).color : "";
      section.setAttribute("data-ferriki-theme", "dark");
      return {
        fontFamily: getComputedStyle(pre).fontFamily,
        color: getComputedStyle(pre).color,
        lightKeywordColor,
        darkKeywordColor: keyword ? getComputedStyle(keyword).color : "",
        stringColor: stringToken ? getComputedStyle(stringToken).color : "",
        darkVariable: keyword
          ? getComputedStyle(keyword).getPropertyValue("--shiki-dark").trim()
          : "",
        styleText: [...document.querySelectorAll("style")]
          .map((style) => style.textContent)
          .join("\n"),
      };
    });
    assert.equal(computedStyles.fontFamily, '"Ferriki Fixture Mono", ui-monospace, monospace');
    assert.notEqual(computedStyles.color, "rgba(0, 0, 0, 0)");
    assert(
      computedStyles.styleText.includes("ferriki-style-"),
      "generated theme CSS was not loaded",
    );
    assert(computedStyles.styleText.includes('[data-ferriki-theme="dark"]'));
    assert(computedStyles.darkVariable, "dark theme token variables were not loaded");
    assert.notEqual(computedStyles.lightKeywordColor, computedStyles.darkKeywordColor);
    assert.notEqual(computedStyles.darkKeywordColor, computedStyles.stringColor);

    await page.evaluate(() => {
      window.__copiedCode = undefined;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => (window.__copiedCode = text) },
      });
    });
    await firstBlock.locator("[data-copy-code]").click();
    assert.equal(await page.evaluate(() => window.__copiedCode), firstModule.block.code);

    await page.locator('[data-route="second"]').click();
    const secondBlock = page.locator('[data-code-route="second"]');
    await secondBlock.waitFor();
    await page.waitForFunction(() => window.location.pathname === "/second");
    assert.equal(await page.locator("main").getAttribute("data-current-route"), "second");
    assert.equal(await secondBlock.locator("h2").textContent(), "Second route");
    assert(
      ((await secondBlock.locator(".rendered-code").textContent()) ?? "").includes(
        "const route = 'second';",
      ),
    );
    const customMacroBlock = page.locator('[data-code-route="second-react-macro"]');
    assert.equal(await customMacroBlock.locator("h2").textContent(), "Second React macro");
    const customMacroSource =
      (await customMacroBlock.locator(".rendered-code").textContent()) ?? "";
    assert(customMacroSource.includes("const macroRoute = 'second';"));
    assert.equal(await customMacroBlock.locator("pre[class*='ferriki-themes-']").count(), 1);
    const stylesBeforeHmr = (await page.locator("style").allTextContents()).join("\n");

    const oldLiteral = "\"const route = 'second';\\nconsole.log(route);\"";
    const newLiteral =
      "\"throw new TypeError('updated route'); // HMR adds a comment\\nconsole.log(503);\"";
    const oldReactSource = "source={`const macroRoute = 'second';\\nconsole.log(macroRoute);`}";
    const newReactSource =
      "source={`throw new TypeError('updated macro route'); // HMR adds a comment\\nconsole.log(504);`}";
    assert(
      secondSourceBefore.includes(oldLiteral),
      "the fixture source no longer has its expected HMR input",
    );
    assert(
      secondSourceBefore.includes(oldReactSource),
      "the React Code macro source changed unexpectedly",
    );
    const secondSourceAfter = secondSourceBefore
      .replace(oldLiteral, newLiteral)
      .replace(oldReactSource, newReactSource);
    assert.notEqual(secondSourceAfter, secondSourceBefore);
    await writeFile(secondRoutePath, secondSourceAfter);
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-code-route="second-react-macro"]')
          ?.textContent.includes("updated macro route"),
      undefined,
      { timeout: 15_000 },
    );

    const after = await server.transformRequest("/src/routes/second.jsx");
    const afterMap = sourceMap(after);
    assert.equal(
      afterMap.sourcesContent.find((content) => content.includes("@ferriki/core/macro")),
      secondSourceAfter,
    );
    const cssIdAfter = cssImportId(after.code);
    assert(cssIdAfter, "the updated macro transform lost its generated stylesheet import");
    assert.notEqual(cssIdAfter, cssIdBefore, "changing the code did not update its CSS module");
    const changedStyleClasses = [
      ...new Set(
        (after.code.match(/ferriki-style-[a-f0-9]{64}/g) ?? []).filter(
          (name) => !before.code.includes(name),
        ),
      ),
    ];
    assert(
      changedStyleClasses.length > 0,
      "the updated macro did not produce new native token classes",
    );
    assert(
      changedStyleClasses.every((name) => !stylesBeforeHmr.includes(name)),
      "the updated token CSS was already present before the HMR edit",
    );
    await page.waitForFunction((classes) => {
      const css = [...document.querySelectorAll("style")]
        .map((style) => style.textContent)
        .join("\n");
      return classes.some((name) => css.includes(name));
    }, changedStyleClasses);
    await secondBlock.locator("[data-copy-code]").click();
    assert.equal(
      await page.evaluate(() => window.__copiedCode),
      "throw new TypeError('updated route'); // HMR adds a comment\nconsole.log(503);",
    );
    await customMacroBlock.locator("[data-copy-code]").click();
    assert.equal(
      await page.evaluate(() => window.__copiedCode),
      "throw new TypeError('updated macro route'); // HMR adds a comment\nconsole.log(504);",
    );
    assert.deepEqual(clientWarnings, [], "navigation or HMR emitted a browser warning or error");

    const output = await build({
      configFile: false,
      root: project,
      plugins: [ferriki(options)],
      esbuild: { jsx: "automatic" },
      logLevel: "silent",
      build: { write: false, minify: false },
    });
    const outputs = Array.isArray(output) ? output.flatMap((item) => item.output) : output.output;
    const chunks = outputs.filter((item) => item.type === "chunk");
    assert(chunks.length > 0, "Vite produced no browser chunks");
    const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules ?? {}));
    const secondRouteChunks = chunks.filter((chunk) =>
      Object.keys(chunk.modules ?? {}).some((id) => id.includes("/src/routes/second.jsx")),
    );
    assert(
      secondRouteChunks.some((chunk) => chunk.isDynamicEntry),
      "the second client route was not included as a precompiled browser module",
    );
    const forbidden = moduleIds.filter((id) =>
      /@ferriki\/(?:core|engine)(?:[\\/]|$)|ferriki-core|@?oxc(?:[-/]|$)|(?:^|[\\/])(?:native|engine|downloader)\.mjs(?:[?#]|$)|asset-downloader|remote-asset/i.test(
        id,
      ),
    );
    assert.deepEqual(
      forbidden,
      [],
      `browser bundle reached Ferriki runtime modules: ${forbidden.join(", ")}`,
    );
    const browserSource = outputs
      .map((item) => ("source" in item ? String(item.source) : (item.code ?? "")))
      .join("\n");
    assert(
      !browserSource.includes("@ferriki/core"),
      "the browser bundle retained an unresolved macro import",
    );
    assert(!browserSource.includes("code() is a compile-time macro"));
    assert(
      browserSource.includes("updated route"),
      "browser build did not include the compiled macro output",
    );
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
