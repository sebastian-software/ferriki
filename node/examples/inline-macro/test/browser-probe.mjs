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
    : [...(node.children ?? []), ...(node.content ? [node.content] : [])]
        .map((child) => hastText(child))
        .join("");
}

const explicitMacroRouteColor = "rgb(77, 88, 99)";

function setSpanColor(node, color) {
  const style = node.properties?.style;
  const declarations =
    typeof style === "string"
      ? style.split(";").filter((declaration) => {
          const separator = declaration.indexOf(":");
          return separator < 0 || declaration.slice(0, separator).trim().toLowerCase() !== "color";
        })
      : style && typeof style === "object"
        ? Object.entries(style)
            .filter(
              ([name]) =>
                name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`) !== "color",
            )
            .map(
              ([name, value]) =>
                `${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}:${value}`,
            )
        : [];
  node.properties = {
    ...(node.properties || {}),
    style: [...declarations, `color:${color}`].join(";"),
  };
}

const explicitMacroRouteColorTransformer = {
  name: "inline-macro-authored-color-fixture",
  span(node, _line, _column, _lineNode, token) {
    if (token?.content === "macroRoute") setSpanColor(node, explicitMacroRouteColor);
    return node;
  },
};

function createSsrPlugin(indexTemplate, headStyle = "") {
  return {
    name: "inline-macro-browser-fixture-ssr",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if ((request.url ?? "/").split("?", 1)[0] !== "/") return next();
        try {
          const { App } = await server.ssrLoadModule("/src/app.jsx");
          const markup = renderToString(React.createElement(App, { initialRoute: "first" }));
          const styledTemplate = headStyle
            ? indexTemplate.replace("</head>", `${headStyle}</head>`)
            : indexTemplate;
          const html = styledTemplate.replace("<!--ssr-outlet-->", markup);
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
}

async function checkInlinePresentation(browser, project, indexTemplate, options) {
  const rootOverrides =
    "<style data-ferriki-test-root-colors>:root{--ferriki-keyword-color:rgb(51,62,73);--ferriki-background-color:rgb(241,242,243)}</style>";
  const inlineServer = await createServer({
    configFile: false,
    root: project,
    plugins: [
      ferriki({ ...options, styleMode: "inline" }),
      createSsrPlugin(indexTemplate, rootOverrides),
    ],
    oxc: { jsx: { runtime: "automatic" } },
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
  let noJsContext;
  try {
    await inlineServer.listen();
    const address = inlineServer.httpServer.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const paletteRequests = [];
    noJsContext = await browser.newContext({ javaScriptEnabled: false });
    const noJsPage = await noJsContext.newPage();
    noJsPage.on("request", (request) => {
      if (/@ferriki\/code-elements\.css|ferriki-code[^/]*\.css/u.test(request.url()))
        paletteRequests.push(request.url());
    });
    await noJsPage.goto(baseUrl, { waitUntil: "load" });
    const serverPresentation = await noJsPage
      .locator(".first-react-macro-class")
      .evaluate((host) => {
        const root = host.shadowRoot;
        const pre = root?.querySelector('pre[data-title="First React macro"]');
        const token = [...(root?.querySelectorAll(".ferriki-color-token") ?? [])].find(
          (span) => span.textContent?.trim() === "const",
        );
        const authoredToken = [...(root?.querySelectorAll(".ferriki-color-authored") ?? [])].find(
          (span) => span.textContent?.trim() === "macroRoute",
        );
        host.setAttribute("data-ferriki-theme", "light");
        const authoredLightColor = authoredToken ? getComputedStyle(authoredToken).color : "";
        host.setAttribute("data-ferriki-theme", "dark");
        const authoredDarkColor = authoredToken ? getComputedStyle(authoredToken).color : "";
        return {
          hasShadow: Boolean(root),
          baseStyleCount: root?.querySelectorAll("style[data-ferriki-code-base]").length ?? 0,
          paletteLinkCount: root?.querySelectorAll("link[data-ferriki-code-css]").length ?? 0,
          rootKeywordColor: getComputedStyle(document.documentElement)
            .getPropertyValue("--ferriki-keyword-color")
            .trim(),
          rootBackgroundColor: getComputedStyle(document.documentElement)
            .getPropertyValue("--ferriki-background-color")
            .trim(),
          tokenColor: token ? getComputedStyle(token).color : "",
          backgroundColor: pre ? getComputedStyle(pre).backgroundColor : "",
          authoredLightColor,
          authoredDarkColor,
        };
      });
    assert.equal(serverPresentation.hasShadow, true);
    assert.equal(serverPresentation.baseStyleCount, 1);
    assert.equal(serverPresentation.paletteLinkCount, 0);
    assert.equal(serverPresentation.rootKeywordColor, "rgb(51,62,73)");
    assert.equal(serverPresentation.rootBackgroundColor, "rgb(241,242,243)");
    assert.equal(serverPresentation.tokenColor, "rgb(51, 62, 73)");
    assert.equal(serverPresentation.backgroundColor, "rgb(241, 242, 243)");
    assert.equal(serverPresentation.authoredLightColor, "rgb(77, 88, 99)");
    assert.equal(serverPresentation.authoredDarkColor, "rgb(77, 88, 99)");
    assert.match(await noJsPage.locator("head").innerHTML(), /data-ferriki-test-root-colors/);
    const serverHtml = await noJsPage.content();
    assert(!serverHtml.includes("@ferriki/code-elements.css"));
    assert(!serverHtml.includes("ferriki-code.css"));

    const hydratedPage = await browser.newPage();
    hydratedPage.on("request", (request) => {
      if (/@ferriki\/code-elements\.css|ferriki-code[^/]*\.css/u.test(request.url()))
        paletteRequests.push(request.url());
    });
    await hydratedPage.goto(baseUrl, { waitUntil: "load" });
    await hydratedPage.waitForFunction(() => window.__ferrikiHydrated === true);
    const hydratedPresentation = await hydratedPage
      .locator(".first-react-macro-class")
      .evaluate((host) => {
        const root = host.shadowRoot;
        const pre = root?.querySelector('pre[data-title="First React macro"]');
        const token = [...(root?.querySelectorAll(".ferriki-color-token") ?? [])].find(
          (span) => span.textContent?.trim() === "const",
        );
        const authoredToken = [...(root?.querySelectorAll(".ferriki-color-authored") ?? [])].find(
          (span) => span.textContent?.trim() === "macroRoute",
        );
        host.setAttribute("data-ferriki-theme", "light");
        const authoredLightColor = authoredToken ? getComputedStyle(authoredToken).color : "";
        host.setAttribute("data-ferriki-theme", "dark");
        const authoredDarkColor = authoredToken ? getComputedStyle(authoredToken).color : "";
        return {
          baseStyleCount: root?.querySelectorAll("style[data-ferriki-code-base]").length ?? 0,
          paletteLinkCount: root?.querySelectorAll("link[data-ferriki-code-css]").length ?? 0,
          tokenColor: token ? getComputedStyle(token).color : "",
          backgroundColor: pre ? getComputedStyle(pre).backgroundColor : "",
          authoredLightColor,
          authoredDarkColor,
        };
      });
    assert.equal(hydratedPresentation.baseStyleCount, 1);
    assert.equal(hydratedPresentation.paletteLinkCount, 0);
    assert.equal(hydratedPresentation.tokenColor, serverPresentation.tokenColor);
    assert.equal(hydratedPresentation.backgroundColor, serverPresentation.backgroundColor);
    assert.equal(hydratedPresentation.authoredLightColor, "rgb(77, 88, 99)");
    assert.equal(hydratedPresentation.authoredDarkColor, "rgb(77, 88, 99)");
    assert.deepEqual(
      paletteRequests,
      [],
      "inline mode requested an external Ferriki palette stylesheet",
    );
    await hydratedPage.close();
  } finally {
    await noJsContext?.close();
    await inlineServer.close();
  }
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
    transformers: [explicitMacroRouteColorTransformer],
  };
  const macroPlugin = ferriki(options);

  const indexTemplate = await readFile(join(project, "index.html"), "utf8");

  const server = await createServer({
    configFile: false,
    root: project,
    plugins: [macroPlugin, createSsrPlugin(indexTemplate)],
    oxc: { jsx: { runtime: "automatic" } },
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
    assert.match(initialMarkup, /code-ref="ferriki-[a-f0-9]{64}"/);
    assert.match(initialMarkup, /min-block-size:min\(calc\(/);
    assert(!initialMarkup.includes("highlightedCode="));
    assert.match(initialMarkup, /<template shadowrootmode="open">/);
    assert.match(initialMarkup, /<!--ferriki-code:ferriki%2D[a-f0-9]{64}-->/);
    assert.match(initialMarkup, /<style data-ferriki-code-base>[\s\S]*?<\/style>/);
    assert.match(
      initialMarkup,
      /<link rel="stylesheet" href="\/@ferriki\/code-elements\.css" data-ferriki-code-css>/,
    );
    assert.match(initialMarkup, /data-title="First React macro"/);
    assert(
      initialMarkup.includes(firstModule.block.html),
      "ordinary descriptor output lost its prepared HTML",
    );
    assert.match(initialMarkup, /class="first-react-macro-class"/);
    assert(
      hastText(fromHtml(initialMarkup, { fragment: true })).includes("const macroRoute = 'first';"),
    );
    assert.match(firstModule.block.css, /ferriki-style-[a-f0-9]{64}/);
    assert.match(firstModule.block.html, /<pre\b/);
    assert.match(firstModule.block.html, /<code\b/);

    const secondModule = await server.ssrLoadModule("/src/routes/second.jsx");
    assert.equal(
      secondModule.getRenderCalls(),
      0,
      "the render callback ran during module transformation",
    );
    const secondMarkup = renderToString(React.createElement(secondModule.default));
    assert.equal(
      secondModule.getRenderCalls(),
      1,
      "the render callback did not run during React SSR",
    );
    assert.match(secondMarkup, /data-code-route="second-react-macro"/);
    assert.match(secondMarkup, /data-render-class="second-react-macro-class"/);
    assert.match(secondMarkup, /data-render-title="Second React macro"/);
    assert.match(secondMarkup, /class="second-react-macro-class"/);
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
    const noJsContext = await browser.newContext({ javaScriptEnabled: false });
    try {
      const noJsPage = await noJsContext.newPage();
      await noJsPage.goto(`${baseUrl}/?reference`, { waitUntil: "load" });
      const serverRenderedHost = await noJsPage
        .locator(".first-react-macro-class")
        .evaluate((host) => {
          const root = host.shadowRoot;
          const baseStyle = root?.querySelector("style[data-ferriki-code-base]");
          const paletteLink = root?.querySelector("link[data-ferriki-code-css]");
          const pre = root?.querySelector("pre[data-title='First React macro']");
          const token = root?.querySelector(".token");
          return {
            height: host.getBoundingClientRect().height,
            childCount: host.childNodes.length,
            shadow: Boolean(root),
            marker: root?.firstChild?.nodeType === Node.COMMENT_NODE ? root.firstChild.data : "",
            text: pre?.textContent,
            baseStyleCount: root?.querySelectorAll("style[data-ferriki-code-base]").length ?? 0,
            baseCss: baseStyle?.textContent ?? "",
            paletteHref: paletteLink?.getAttribute("href"),
            paletteRuleCount: paletteLink?.sheet?.cssRules.length ?? 0,
            tokenColor: token ? getComputedStyle(token).color : "",
            preHeight: pre?.getBoundingClientRect().height ?? 0,
          };
        });
      assert.equal(
        serverRenderedHost.childCount,
        0,
        "the SSR macro leaked template children into light DOM",
      );
      assert.equal(serverRenderedHost.shadow, true, "the HTML parser did not consume the SSR DSD");
      assert.match(
        serverRenderedHost.marker,
        /^ferriki-code:ferriki%2D[a-f0-9]{64}$/,
        "the parser did not preserve the SSR registry marker",
      );
      assert(
        serverRenderedHost.text?.includes("const macroRoute = 'first';"),
        "the prepared code was missing before JavaScript",
      );
      assert.equal(serverRenderedHost.baseStyleCount, 1);
      assert(serverRenderedHost.baseCss.includes(":host"), "the local base stylesheet was empty");
      assert.equal(
        serverRenderedHost.paletteHref,
        "/@ferriki/code-elements.css",
        "the SSR shadow root did not link the persistent class palette stylesheet",
      );
      assert(
        serverRenderedHost.paletteRuleCount > 0,
        "the persistent class palette stylesheet did not load",
      );
      assert.notEqual(serverRenderedHost.tokenColor, "", "the SSR token had no computed style");
      assert(
        serverRenderedHost.height > 0,
        "the SSR macro did not reserve space before JavaScript",
      );
      assert(serverRenderedHost.preHeight > 0, "the prepared SSR code had no visible height");
    } finally {
      await noJsContext.close();
    }
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
    let releaseClientRequest;
    let notifyClientRequest;
    const clientRequestStarted = new Promise((resolve) => {
      notifyClientRequest = resolve;
    });
    const clientRequestGate = new Promise((resolve) => {
      releaseClientRequest = resolve;
    });
    let parsedMarkup;
    await page.route("**/src/client.jsx**", async (route) => {
      notifyClientRequest();
      await clientRequestGate;
      await route.continue();
    });
    try {
      await page.goto(baseUrl, { waitUntil: "commit" });
      await clientRequestStarted;
      await page.waitForFunction(
        () =>
          document.readyState === "interactive" &&
          Boolean(document.querySelector("#root .first-react-macro-class")?.shadowRoot),
      );
      parsedMarkup = await page.locator("#root").evaluate((root) => {
        const host = root.querySelector(".first-react-macro-class");
        const shadowRoot = host?.shadowRoot;
        const pre = shadowRoot?.querySelector("pre[data-title='First React macro']");
        const code = pre?.querySelector("code");
        const token = shadowRoot?.querySelector(".token");
        const baseStyle = shadowRoot?.querySelector("style[data-ferriki-code-base]");
        const paletteLink = shadowRoot?.querySelector("link[data-ferriki-code-css]");
        window.__ferrikiBeforeHydrate = {
          root,
          host,
          shadowRoot,
          pre,
          code,
          token,
          baseStyle,
          paletteLink,
        };
        return root.innerHTML;
      });
      releaseClientRequest();
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
    } finally {
      releaseClientRequest();
      await page.unroute("**/src/client.jsx**");
    }
    const hydratedMarkup = await page.locator("#root").innerHTML();
    assert.equal(
      hydratedMarkup,
      parsedMarkup,
      "client hydration changed the parsed server-rendered HTML",
    );
    const preservedNodes = await page.evaluate(() => {
      const before = window.__ferrikiBeforeHydrate;
      const host = document.querySelector("#root .first-react-macro-class");
      return {
        host: host === before.host,
        shadowRoot: host?.shadowRoot === before.shadowRoot,
        pre: host?.shadowRoot?.querySelector("pre[data-title='First React macro']") === before.pre,
        code: host?.shadowRoot?.querySelector("pre code") === before.code,
        token: host?.shadowRoot?.querySelector(".token") === before.token,
        baseStyle:
          host?.shadowRoot?.querySelector("style[data-ferriki-code-base]") === before.baseStyle,
        paletteLink:
          host?.shadowRoot?.querySelector("link[data-ferriki-code-css]") === before.paletteLink,
      };
    });
    assert.deepEqual(
      preservedNodes,
      {
        host: true,
        shadowRoot: true,
        pre: true,
        code: true,
        token: true,
        baseStyle: true,
        paletteLink: true,
      },
      "hydration replaced parser-created DSD nodes",
    );
    assert.deepEqual(clientWarnings, [], "SSR hydration emitted a browser warning or error");

    const firstBlock = page.locator('[data-code-route="first"]');
    assert.equal(await firstBlock.locator("h2").textContent(), "First route");
    const initialCode = (await firstBlock.locator(".rendered-code").textContent()) ?? "";
    assert(initialCode.includes("const route = 'first';"));
    assert(initialCode.includes("console.log(route);"));
    assert.equal(
      await firstBlock.locator(".rendered-code pre[class*='ferriki-themes-']").count(),
      1,
    );
    assert(await firstBlock.locator(".token").count());
    const defaultMacroHost = page.locator(".first-react-macro-class");
    assert.equal(await defaultMacroHost.count(), 1);
    assert.equal(await defaultMacroHost.evaluate((host) => host.localName), "ferriki-code");
    const defaultMacroEvidence = await defaultMacroHost.evaluate((host) => ({
      source: host.shadowRoot?.querySelector('pre[data-title="First React macro"]')?.textContent,
      lightChildren: host.childNodes.length,
      tokenCount: host.shadowRoot?.querySelectorAll(".token").length,
      codeRef: host.getAttribute("code-ref"),
      highlightedCode: host.hasAttribute("highlightedcode"),
    }));
    assert.equal(
      defaultMacroEvidence.source,
      "const macroRoute = 'first';\nconsole.log(macroRoute);",
    );
    assert.equal(defaultMacroEvidence.lightChildren, 0);
    assert(defaultMacroEvidence.tokenCount > 0, "the default macro did not render syntax tokens");
    assert.match(defaultMacroEvidence.codeRef, /^ferriki-[a-f0-9]{64}$/);
    assert.equal(defaultMacroEvidence.highlightedCode, false);

    const semanticOverrides = await defaultMacroHost.evaluate((host) => {
      const root = host.shadowRoot;
      const pre = root?.querySelector('pre[data-title="First React macro"]');
      const token = [...(root?.querySelectorAll(".ferriki-color-token") ?? [])].find(
        (span) => span.textContent?.trim() === "const",
      );
      const authoredToken = [...(root?.querySelectorAll(".ferriki-color-authored") ?? [])].find(
        (span) => span.textContent?.trim() === "macroRoute",
      );
      const subtree = host.parentElement;
      const tokenColor = () => (token ? getComputedStyle(token).color : "");
      const authoredColor = () => (authoredToken ? getComputedStyle(authoredToken).color : "");
      const backgroundColor = () => (pre ? getComputedStyle(pre).backgroundColor : "");

      document.documentElement.style.setProperty("--ferriki-keyword-color", "rgb(1, 2, 3)");
      document.documentElement.style.setProperty("--ferriki-background-color", "rgb(10, 11, 12)");
      const globalKeyword = tokenColor();
      const globalBackground = backgroundColor();

      subtree?.style.setProperty("--ferriki-keyword-color", "rgb(20, 21, 22)");
      const subtreeKeyword = tokenColor();
      host.style.setProperty("--ferriki-keyword-color", "rgb(30, 31, 32)");
      const hostKeyword = tokenColor();
      host.style.removeProperty("--ferriki-keyword-color");
      const restoredSubtreeKeyword = tokenColor();
      subtree?.style.removeProperty("--ferriki-keyword-color");
      const restoredGlobalKeyword = tokenColor();
      document.documentElement.style.removeProperty("--ferriki-keyword-color");

      host.setAttribute("data-ferriki-theme", "light");
      const lightThemeFallback = tokenColor();
      const lightAuthoredColor = authoredColor();
      host.style.setProperty("--ferriki-keyword-color", "rgb(40, 41, 42)");
      const lightOverride = tokenColor();
      const beforeThemeChange = { root, pre, token };
      host.setAttribute("data-ferriki-theme", "dark");
      const darkOverride = tokenColor();
      const darkBackground = backgroundColor();
      const darkAuthoredColor = authoredColor();
      const sameElements =
        host.shadowRoot === beforeThemeChange.root &&
        host.shadowRoot?.querySelector('pre[data-title="First React macro"]') ===
          beforeThemeChange.pre &&
        [...(host.shadowRoot?.querySelectorAll(".ferriki-color-token") ?? [])].find(
          (span) => span.textContent?.trim() === "const",
        ) === beforeThemeChange.token;
      host.style.removeProperty("--ferriki-keyword-color");
      const darkThemeFallback = tokenColor();

      document.documentElement.style.removeProperty("--ferriki-background-color");
      host.removeAttribute("data-ferriki-theme");
      return {
        globalKeyword,
        globalBackground,
        subtreeKeyword,
        hostKeyword,
        restoredSubtreeKeyword,
        restoredGlobalKeyword,
        lightThemeFallback,
        lightAuthoredColor,
        lightOverride,
        darkOverride,
        darkAuthoredColor,
        darkBackground,
        darkThemeFallback,
        sameElements,
      };
    });
    assert.equal(semanticOverrides.globalKeyword, "rgb(1, 2, 3)");
    assert.equal(semanticOverrides.globalBackground, "rgb(10, 11, 12)");
    assert.equal(semanticOverrides.subtreeKeyword, "rgb(20, 21, 22)");
    assert.equal(semanticOverrides.hostKeyword, "rgb(30, 31, 32)");
    assert.equal(semanticOverrides.restoredSubtreeKeyword, "rgb(20, 21, 22)");
    assert.equal(semanticOverrides.restoredGlobalKeyword, "rgb(1, 2, 3)");
    assert.equal(semanticOverrides.lightAuthoredColor, explicitMacroRouteColor);
    assert.equal(semanticOverrides.lightOverride, "rgb(40, 41, 42)");
    assert.equal(semanticOverrides.darkOverride, semanticOverrides.lightOverride);
    assert.equal(semanticOverrides.darkAuthoredColor, explicitMacroRouteColor);
    assert.equal(semanticOverrides.darkBackground, semanticOverrides.globalBackground);
    assert.notEqual(semanticOverrides.darkThemeFallback, semanticOverrides.lightThemeFallback);
    assert.equal(semanticOverrides.sameElements, true);

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
    assert.equal(await customMacroBlock.getAttribute("class"), "second-react-macro-class");
    assert.equal(
      await customMacroBlock.getAttribute("data-render-class"),
      "second-react-macro-class",
    );
    assert.equal(await customMacroBlock.getAttribute("data-render-title"), "Second React macro");
    const rendererCounter = customMacroBlock.locator("[data-render-counter]");
    assert.equal(await rendererCounter.textContent(), "0");
    await rendererCounter.click();
    assert.equal(await rendererCounter.textContent(), "1");
    await page.locator("[data-render-class-toggle]").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-code-route="second-react-macro"]')
          ?.getAttribute("data-render-class") === "second-react-macro-class-alternate",
    );
    assert.equal(
      await customMacroBlock.getAttribute("class"),
      "second-react-macro-class-alternate",
    );
    assert.equal(
      await rendererCounter.textContent(),
      "1",
      "the renderer child remounted on parent rerender",
    );
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
    assert.equal(await customMacroBlock.getAttribute("class"), "second-react-macro-class");
    assert.equal(
      await customMacroBlock.getAttribute("data-render-class"),
      "second-react-macro-class",
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

    await checkInlinePresentation(browser, project, indexTemplate, options);

    const output = await build({
      configFile: false,
      root: project,
      plugins: [ferriki(options)],
      oxc: { jsx: { runtime: "automatic" } },
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
    const forbidden = moduleIds.filter((id) => {
      if (/(?:@ferriki[\\/]core|ferriki)[\\/]web-component\.mjs(?:[?#]|$)/.test(id)) return false;
      return /@ferriki\/(?:core|engine)(?:[\\/]|$)|ferriki-core|@?oxc(?:[-/]|$)|(?:^|[\\/])(?:native|engine|downloader)\.mjs(?:[?#]|$)|asset-downloader|remote-asset/i.test(
        id,
      );
    });
    assert.deepEqual(
      forbidden,
      [],
      `browser bundle reached Ferriki runtime modules: ${forbidden.join(", ")}`,
    );
    const browserSource = outputs
      .map((item) => ("source" in item ? String(item.source) : (item.code ?? "")))
      .join("\n");
    assert(
      !chunks
        .flatMap((chunk) => [...chunk.imports, ...chunk.dynamicImports])
        .some((specifier) => specifier.startsWith("@ferriki/core")),
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
