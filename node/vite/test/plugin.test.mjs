import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { fromHtml } from "hast-util-from-html";
import { build, createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { finalCodeText, scrollCodeBlockFromKey } from "../../examples/code-authoring/copy.mjs";
import { ferriki } from "../index.mjs";
import "../../scripts/test-asset-env.mjs";

const notationTransformerModules = await Promise.all(
  [
    "notation-diff.ts",
    "notation-focus.ts",
    "notation-highlight.ts",
    "notation-highlight-word.ts",
  ].map(
    (filename) =>
      import(
        new URL(
          `../../compat/upstream/shiki/packages/transformers/src/transformers/${filename}`,
          import.meta.url,
        ).href
      ),
  ),
);

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(warnings = []) {
  return { warn: (message) => warnings.push(message) };
}

function findJsx(node, name) {
  if (!node || typeof node !== "object") return undefined;
  if (node.type === "JSXElement" && node.openingElement.name.name === name) return node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findJsx(child, name);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findJsx(value, name);
      if (found) return found;
    }
  }
}

function jsxText(node) {
  if (node.type === "JSXText") return node.value;
  if (node.type === "JSXExpressionContainer" && node.expression.type === "StringLiteral")
    return node.expression.value;
  if (node.type !== "JSXElement") return "";
  return node.children.map(jsxText).join("");
}

function findHast(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findHast(child, predicate);
    if (found) return found;
  }
}

function classes(node) {
  const value = node?.properties?.className;
  return Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
}

function hastText(node) {
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(hastText).join("");
}

const notationTransformers = [
  notationTransformerModules[0].transformerNotationDiff(),
  notationTransformerModules[1].transformerNotationFocus(),
  notationTransformerModules[2].transformerNotationHighlight(),
  notationTransformerModules[3].transformerNotationWordHighlight(),
];

async function transformJsx(plugin, source, id = "/src/example.tsx", warnings = []) {
  return plugin.transform.call(context(warnings), source, id);
}

describe("@ferriki/vite", () => {
  it("uses Shiki notation callbacks on the documented HTML and JSX authoring example", async () => {
    const examplePath = new URL("../../examples/code-authoring/index.html", import.meta.url);
    const source = await readFile(examplePath, "utf8");
    const plugin = ferriki({
      themes: { light: "github-light-default", dark: "github-dark-default" },
      styleMode: "classes",
      lineNumbers: true,
      transformers: notationTransformers,
    });
    const result = await plugin.transformIndexHtml.handler.call(context(), source, {
      filename: examplePath.pathname,
    });

    expect(result.html).toContain("<details>");
    expect(result.html).toContain("<summary>Show the response type</summary>");
    expect(result.html).toContain('data-ln="1"');
    expect(result.html).toContain('data-ln="2"');
    expect(result.html).toContain("<title>Focused code example</title>");
    expect(result.html).toContain('<link rel="stylesheet" href="./style.css" />');

    const tree = fromHtml(result.html, { fragment: true });
    const scriptElements = [];
    findHast(tree, (node) => {
      if (node.type === "element" && node.tagName === "script") scriptElements.push(node);
      return false;
    });
    expect(scriptElements).toHaveLength(1);
    const copyButton = findHast(
      tree,
      (node) =>
        node.type === "element" && node.tagName === "button" && "dataCopyCode" in node.properties,
    );
    const copyStatus = findHast(
      tree,
      (node) => node.type === "element" && node.properties.id === "copy-status",
    );
    expect(copyButton.properties.ariaControls).toEqual(["response-code"]);
    expect(copyButton.properties.ariaDescribedBy).toEqual(["copy-status"]);
    expect(copyStatus.properties).toMatchObject({ role: "status", ariaLive: "polite" });
    const primaryPre = findHast(
      tree,
      (node) =>
        node.type === "element" && node.tagName === "pre" && node.properties.id === "response-code",
    );
    const code = findHast(primaryPre, (node) => node.type === "element" && node.tagName === "code");
    const lines = code.children.filter((node) => node.type === "element");
    const lineClasses = lines.map(classes);
    expect(lineClasses[1]).toEqual(expect.arrayContaining(["highlighted", "focused"]));
    expect(lineClasses[1]).not.toContain("remove");
    expect(lineClasses[3]).toEqual(expect.arrayContaining(["focused", "diff", "remove"]));
    expect(lineClasses[4]).toEqual(
      expect.arrayContaining(["highlighted", "focused", "diff", "add"]),
    );
    expect(lineClasses[1]).toContain("line");
    expect(lines.map((line) => line.properties.dataLn)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    expect(
      findHast(
        code,
        (node) => node.type === "element" && classes(node).includes("highlighted-word"),
      ),
    ).toBeTruthy();
    const renderedText = lines.map(hastText).join("\n");
    expect(renderedText).toContain('throw new TypeError("Expected a string");');
    expect(renderedText).toContain('const marker = "// [!code focus]";');
    expect(renderedText).toContain('const tag = "<script>";');
    expect(renderedText).not.toContain("[!code --]");
    expect(renderedText).not.toContain("[!code ++]");

    const style = await readFile(
      new URL("../../examples/code-authoring/style.css", import.meta.url),
      "utf8",
    );
    expect(style).toContain(".line.focused");
    expect(style).toContain(".line.highlighted");
    expect(style).toContain(".line.diff.add");
    expect(style).toContain(".line.diff.remove");
    expect(style).toContain(":focus-visible");
    expect(style).toContain('[data-ferriki-theme="dark"]');

    const sourceLines = [
      { classList: { contains: (name) => name === "line" }, textContent: "  const kept = 1;" },
      {
        classList: { contains: (name) => name === "line" || name === "remove" },
        textContent: "  const old = 1;",
      },
      { classList: { contains: (name) => name === "line" }, textContent: "  const next = 2;  " },
    ];
    expect(finalCodeText({ querySelector: () => ({ children: sourceLines }) })).toBe(
      "  const kept = 1;\n  const next = 2;  ",
    );

    const scrollBlock = { clientWidth: 326, scrollLeft: 0, scrollWidth: 534 };
    const rightArrow = { key: "ArrowRight", preventDefault: vi.fn() };
    expect(scrollCodeBlockFromKey(scrollBlock, rightArrow)).toBe(true);
    expect(scrollBlock.scrollLeft).toBe(48);
    expect(rightArrow.preventDefault).toHaveBeenCalledOnce();
    expect(scrollCodeBlockFromKey(scrollBlock, { key: "ArrowLeft", preventDefault: vi.fn() })).toBe(
      true,
    );
    expect(scrollBlock.scrollLeft).toBe(0);
    expect(scrollCodeBlockFromKey(scrollBlock, { key: "ArrowLeft", preventDefault: vi.fn() })).toBe(
      false,
    );
    expect(
      scrollCodeBlockFromKey(scrollBlock, {
        key: "ArrowRight",
        metaKey: true,
        preventDefault: vi.fn(),
      }),
    ).toBe(false);
  });

  it("forwards notation callbacks through JSX while preserving unrelated source", async () => {
    const source = [
      'const heading = "leave this line";',
      'export const view = <section><pre id="sample" data-highlight="auto" data-language="ts" data-meta="{2}"><code>{"  const answer = 42; // [!code focus]\\n  return answer; // [!code ++]\\n  throw Error(\\"old\\"); // [!code --]"}</code></pre><p>untouched</p></section>;',
    ].join("\n");
    const result = await transformJsx(
      ferriki({ theme: "github-dark-default", transformers: notationTransformers }),
      source,
    );
    const ast = parse(result.code, { sourceType: "module", plugins: ["jsx", "typescript"] });
    const pre = findJsx(ast, "pre");
    const code = findJsx(ast, "code");
    const renderedLines = code.children.filter((node) => node.type === "JSXElement");
    const jsxClasses = (node) => {
      const attr = node.openingElement.attributes.find((item) => item.name?.name === "className");
      const value = attr?.value?.expression?.value;
      return value?.split(/\s+/) ?? [];
    };

    expect(result.code.startsWith('const heading = "leave this line";\n')).toBe(true);
    expect(result.code).toContain("<p>untouched</p>");
    expect(
      pre.openingElement.attributes.some(
        (item) => item.name?.name === "id" && item.value.value === "sample",
      ),
    ).toBe(true);
    expect(renderedLines).toHaveLength(3);
    expect(jsxClasses(renderedLines[0])).toEqual(expect.arrayContaining(["focused"]));
    expect(jsxClasses(renderedLines[1])).toEqual(
      expect.arrayContaining(["highlighted", "diff", "add"]),
    );
    expect(jsxClasses(renderedLines[2])).toEqual(expect.arrayContaining(["diff", "remove"]));
    expect(jsxText(code)).toContain("const answer = 42;");
    expect(jsxText(code)).toContain("  const answer = 42;");
    expect(jsxText(code)).not.toContain("[!code ++]");
    expect(jsxText(code)).not.toContain("[!code --]");
  });

  it("transforms opted-in HTML, preserves surrounding markup, and applies metadata CSS", async () => {
    const plugin = ferriki({ theme: "github-dark-default", lineNumbers: true });
    const source = `<main><pre id="sample" data-highlight="auto" data-language="ts" data-meta='title="API" [Node] {2} showLineNumbers'><code>const first = 1;\nconst second = 2;</code></pre><button>copy</button></main>`;
    const result = await plugin.transformIndexHtml.handler.call(context(), source, {
      filename: "/tmp/example.html",
      path: "/example.html",
    });

    expect(result.html).toContain('id="sample"');
    expect(result.html).toContain('data-title="API"');
    expect(result.html).toContain('data-label="Node"');
    expect(result.html).toContain('data-ln="1"');
    expect(result.html).toContain('data-ln="2"');
    expect(result.html).toMatch(/class="[^"]*highlighted/);
    expect(result.html).toContain("<button>copy</button>");
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0].children).toContain("content:attr(data-ln)");
  });

  it("uses decoded JSXText once and preserves string-expression boundaries and source maps", async () => {
    const plugin = ferriki({ theme: "github-dark-default", lineNumbers: true });
    const source = `export const example = <pre id="code" data-highlight="auto" data-language="ts" data-meta={'title="Example" [API] {1} showLineNumbers'} data-owner="docs"><code>\n  const value = &gt;;\n  {" + "}\n  value\n</code></pre>`;
    const result = await transformJsx(plugin, source);

    expect(result.code).toContain('data-title={"Example"}');
    expect(result.code).toContain('data-label={"API"}');
    expect(result.code).toContain('data-ln={"1"}');
    expect(result.code).toContain('data-owner="docs"');
    expect(result.code).toContain('{" >"}');
    expect(result.code).toContain('{"; "}');
    expect(result.code).toContain('{"+"}');
    expect(result.map).toMatchObject({
      version: 3,
      sources: ["/src/example.tsx"],
      sourcesContent: [source],
    });

    const encoded = await transformJsx(
      ferriki({ theme: "github-dark-default" }),
      `<pre data-highlight="auto" data-language="ts"><code>&amp;gt;</code></pre>`,
    );
    const encodedAst = parse(encoded.code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
    expect(jsxText(findJsx(encodedAst, "code"))).toBe("&gt;");
  });

  it("keeps directive prologues and authored inline styles intact", async () => {
    const plugin = ferriki({ theme: "github-dark-default", lineNumbers: true });
    const source = `"use client";\n"use strict";\nconst block = <pre data-highlight="auto" data-language="ts" data-meta="{1}" style="color: red"><code>const value = 42;</code></pre>;`;
    const result = await transformJsx(plugin, source);
    expect(result.code.startsWith('"use client";\n"use strict";')).toBe(true);
    const ast = parse(result.code, { sourceType: "module", plugins: ["jsx", "typescript"] });
    expect(ast.program.directives.map((directive) => directive.value.value)).toEqual([
      "use client",
      "use strict",
    ]);
    expect(result.code).toContain('"color":"red"');
    expect(result.code).toContain('"backgroundColor":"#0d1117"');
    expect(result.code.indexOf('import "virtual:ferriki-vite/')).toBeGreaterThan(
      result.code.indexOf("const block"),
    );
  });

  it("leaves dynamic, spread, styled, and nested-markup blocks unchanged", async () => {
    const plugin = ferriki({ theme: "github-dark-default" });
    const cases = [
      `<pre data-highlight="auto" data-language="ts"><code>{value}</code></pre>`,
      `<pre {...props} data-highlight="auto" data-language="ts"><code>const x = 1</code></pre>`,
      `<pre data-highlight="auto" data-language="ts" className={className}><code>const x = 1</code></pre>`,
      `<pre data-highlight="auto" data-language="ts" style={style}><code>const x = 1</code></pre>`,
      `<pre data-highlight="auto" data-language="ts"><code><a href="/">link</a></code></pre>`,
    ];
    for (const source of cases) expect(await transformJsx(plugin, source)).toBeNull();

    const html = `<pre data-highlight="auto" data-language="html"><code><a href="/">link</a></code></pre>`;
    const result = await plugin.transformIndexHtml.handler.call(context(), html, {
      filename: "/tmp/index.html",
    });
    expect(result).toBeNull();
  });

  it("includes compiler-emitted JSX IDs only when explicitly configured", async () => {
    const plugin = ferriki({
      theme: "github-dark-default",
      include: (id) => id.includes("virtual:markdown"),
    });
    const source = `export const snippet = <pre data-highlight="auto" data-language="ts"><code>const x = 1</code></pre>`;
    const result = await transformJsx(plugin, source, "\0virtual:markdown/page.mdx");
    expect(result.code).toContain("className");
  });

  it("loads generated class CSS through a content-addressed virtual module", async () => {
    const plugin = ferriki({
      themes: { light: "github-light-default", dark: "github-dark-default" },
      styleMode: "classes",
      lineNumbers: true,
    });
    const source = `<pre data-highlight="auto" data-language="ts" data-meta="{1}"><code>const value = 42;</code></pre>`;
    const result = await transformJsx(plugin, source);
    const id = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];
    expect(id).toBeTruthy();
    expect(plugin.resolveId(id)).toBe(`\0${id}`);
    const css = plugin.load(`\0${id}`);
    expect(css).toContain(".highlighted");
    expect(css).toContain(".ferriki-style-");
    expect(result.code).toContain('data-ln={"1"}');
  });

  it("keeps a default theme and emits an explicit dark-theme selector", async () => {
    const plugin = ferriki({
      themes: { light: "github-light-default", dark: "github-dark-default" },
      styleMode: "classes",
    });
    const source =
      '<pre data-highlight="auto" data-language="ts"><code>const value = 42;</code></pre>';
    const result = await transformJsx(plugin, source);
    const id = /import "([^"]+\.css)";/.exec(result.code)?.[1];
    const css = plugin.load(`\0${id}`);
    expect(css).toContain("--ferriki-color:var(--shiki-light)");
    expect(css).toContain('[data-ferriki-theme="dark"]');
  });

  it("uses a concrete default color with inline multi-theme output", async () => {
    const plugin = ferriki({
      themes: { light: "github-light-default", dark: "github-dark-default" },
    });
    const source =
      '<pre data-highlight="auto" data-language="ts"><code>const value = 42;</code></pre>';
    const result = await plugin.transformIndexHtml.handler.call(context(), source, {
      filename: "/tmp/themes.html",
    });
    expect(result.html).toContain("color:#");
    expect(result.html).toContain("--shiki-dark:");
  });

  it("rejects an empty theme map as invalid usage", () => {
    expect(() => ferriki({ themes: {} })).toThrow(expect.objectContaining({ code: "ERR_USAGE" }));
  });

  it("rejects non-array transformer options as invalid usage", () => {
    expect(() => ferriki({ transformers: {} })).toThrow(
      expect.objectContaining({ code: "ERR_USAGE" }),
    );
  });

  it("changes the CSS module ID when a transformed block changes for HMR", async () => {
    const plugin = ferriki({ theme: "github-dark-default", styleMode: "classes" });
    const before = await transformJsx(
      plugin,
      `<pre data-highlight="auto" data-language="ts"><code>const value = 42;</code></pre>`,
    );
    const after = await transformJsx(
      plugin,
      `<pre data-highlight="auto" data-language="ts"><code>function value() {"{ return 42; }"}</code></pre>`,
    );
    const beforeId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(before.code)?.[1];
    const afterId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(after.code)?.[1];
    expect(beforeId).not.toBe(afterId);
    expect(plugin.load(`\0${beforeId}`)).not.toBe(plugin.load(`\0${afterId}`));
  });

  it("warns once per HTML file for unknown languages and leaves the code plain", async () => {
    const warnings = [];
    const plugin = ferriki({ theme: "github-dark-default" });
    const source = `<pre data-highlight="auto" data-language="not-a-real-language"><code>const x = 1;</code></pre><pre data-highlight="auto" data-language="also-not-real"><code>const y = 2;</code></pre>`;
    const result = await plugin.transformIndexHtml.handler.call(context(warnings), source, {
      filename: "/tmp/page.html",
    });
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/tmp/page.html");
  });

  it("does not initialize themes for a project with no marked blocks", async () => {
    const plugin = ferriki({
      theme: "not-a-real-theme",
      assets: { remote: false, cacheDir: join(tmpdir(), "no-ferriki-assets") },
    });
    await expect(
      plugin.transformIndexHtml.handler.call(context(), "<html><body>plain</body></html>", {
        filename: "/tmp/plain.html",
      }),
    ).resolves.toBeNull();
  });

  it("works in Vite dev and build transforms, including class CSS", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ferriki-vite-test-")));
    tempRoots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><head></head><body><pre data-highlight="auto" data-language="ts"><code>const htmlValue = 42;</code></pre><script type="module" src="/src/example.tsx"></script></body></html>',
    );
    await writeFile(
      join(root, "src/example.tsx"),
      'const block = <pre data-highlight="auto" data-language="ts" data-meta="{1}"><code>const jsxValue = 42;</code></pre>; console.log(block);',
    );
    const plugin = ferriki({ theme: "github-dark-default", styleMode: "classes" });
    const server = await createServer({
      configFile: false,
      root,
      plugins: [plugin],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, fs: { allow: [root] } },
      appType: "custom",
    });
    try {
      const html = await server.transformIndexHtml(
        "/",
        await readFile(join(root, "index.html"), "utf8"),
      );
      const module = await server.transformRequest("/src/example.tsx");
      expect(html).toContain("github-dark-default");
      expect(html).toContain("data-ferriki-vite");
      expect(module.code).toContain("virtual:ferriki-vite/");
      expect(module.code).toContain("jsxValue");
    } finally {
      await server.close();
    }

    const buildPlugin = ferriki({
      theme: "github-dark-default",
      styleMode: "classes",
      lineNumbers: true,
    });
    const result = await build({
      configFile: false,
      root,
      plugins: [buildPlugin],
      build: { write: false, outDir: "dist", minify: false },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const outputText = outputs
      .map((item) => ("source" in item ? String(item.source) : item.code))
      .join("\n");
    expect(outputText).toContain("jsxValue");
    expect(outputText).toContain("htmlValue");
    expect(outputText).toContain("ferriki-highlight-line");
  });
});
