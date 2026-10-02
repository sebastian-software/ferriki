import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { build, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { ferriki } from "../index.mjs";
import "../../scripts/test-asset-env.mjs";

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

async function transformJsx(plugin, source, id = "/src/example.tsx", warnings = []) {
  return plugin.transform.call(context(warnings), source, id);
}

describe("@ferriki/vite", () => {
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
