import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { build, createServer, parseAst, transformWithOxc } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { code } from "../../ferriki/macro.mjs";
import { ferriki } from "../index.mjs";
import "../../scripts/test-asset-env.mjs";

// Count the adapter's parses: it imports `parseAst` from Vite, and this
// pass-through wrapper records the module ID of every call.
const parsedIds = vi.hoisted(() => []);
vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseAst(source, options, filename) {
      parsedIds.push(filename);
      return actual.parseAst(source, options, filename);
    },
  };
});

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

const notationTransformers = [
  notationTransformerModules[0].transformerNotationDiff(),
  notationTransformerModules[1].transformerNotationFocus(),
  notationTransformerModules[2].transformerNotationHighlight(),
  notationTransformerModules[3].transformerNotationWordHighlight(),
];

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A minimal transform context: Vite's and Rolldown's `this.error` both throw. */
function context(warnings = []) {
  return {
    warn: (message) => warnings.push(message),
    error(error, pos) {
      if (pos !== undefined) error.pos = pos;
      throw error;
    },
  };
}

async function transformModule(plugin, source, id = "/src/example.tsx", warnings = [], meta) {
  return plugin.transform.handler.call(context(warnings), source, id, meta);
}

function plugin(options = {}) {
  return ferriki({ theme: "github-dark-default", ...options });
}

function withoutVirtualStyles(code) {
  return code.replace(/^import "virtual:ferriki-vite\/[^\n]+";\n/gm, "");
}

function cssImportId(code) {
  return /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(code)?.[1];
}

function parseOutput(code, lang = "tsx") {
  return parseAst(code, { lang }, `output.${lang}`);
}

function* nodes(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* nodes(child);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") yield node;
  for (const [key, value] of Object.entries(node))
    if (key !== "type" && value && typeof value === "object") yield* nodes(value);
}

function jsxElements(ast, name) {
  return [...nodes(ast)].filter(
    (node) =>
      node.type === "JSXElement" &&
      node.openingElement.name.type === "JSXIdentifier" &&
      node.openingElement.name.name === name,
  );
}

function jsxAttribute(element, name) {
  return element.openingElement.attributes.find(
    (attribute) => attribute.type === "JSXAttribute" && attribute.name.name === name,
  );
}

function attributeNames(element) {
  return element.openingElement.attributes.map((attribute) =>
    attribute.type === "JSXAttribute" ? attribute.name.name : attribute.type,
  );
}

function objectProperty(object, name) {
  return object.properties.find(
    (property) =>
      property.type === "Property" && (property.key.name ?? property.key.value) === name,
  );
}

/** Elements that receive a prepared descriptor as a `code={{ ... }}` object literal. */
function preparedComponents(ast) {
  return [...nodes(ast)].filter((node) => {
    if (node.type !== "JSXElement") return false;
    const expression = jsxAttribute(node, "code")?.value?.expression;
    return expression?.type === "ObjectExpression" && objectProperty(expression, "html");
  });
}

function preparedDescriptors(ast) {
  return preparedComponents(ast).map((element) => jsxAttribute(element, "code").value.expression);
}

/** Text content of rendered HTML, with the escapes Ferriki emits and HTML's newline normalization. */
function htmlText(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&#x3C;", "<")
    .replaceAll("&#x22;", '"')
    .replaceAll("&#x26;", "&")
    .replace(/\r\n?/g, "\n");
}

/** Turn transformed module output without imports into a script for `runInNewContext`. */
function asScript(code) {
  return code.replace(/^export \{\s*\};?$/gm, "").replace(/^export /gm, "");
}

function lineAndColumn(source, offset) {
  const before = source.slice(0, offset);
  return { line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) };
}

/** Run a transform that must fail with a positioned macro diagnostic. */
async function macroError(source, id, { message, at }, options) {
  const error = await transformModule(plugin(options), source, id).then(
    () => undefined,
    (thrown) => thrown,
  );
  expect(error, `${id} should be rejected:\n${source}`).toBeInstanceOf(Error);
  expect(error.name, error.message).toBe("FerrikiMacroError");
  expect(error.code).toBe("FERRIKI_MACRO");
  expect(error.id).toBe(id);
  if (message instanceof RegExp) expect(error.message).toMatch(message);
  else expect(error.message).toContain(message);
  if (at !== undefined) {
    const offset = typeof at === "number" ? at : source.indexOf(at);
    expect(offset, `marker ${String(at)} must occur in the source`).toBeGreaterThanOrEqual(0);
    expect(error.pos).toBe(offset);
    expect(error.loc).toEqual({ file: id, ...lineAndColumn(source, offset) });
  }
  return error;
}

async function evaluateJsx(code, filename, globals = {}) {
  const executable = await transformWithOxc(withoutVirtualStyles(code), filename, {
    lang: "tsx",
    jsx: { runtime: "classic", pragma: "jsx" },
  });
  return runInNewContext(executable.code, {
    jsx: (type, props) => ({ type, props }),
    ...globals,
  });
}

async function createProject(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ferriki-vite-test-")));
  tempRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function buildOutputText(result) {
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  return outputs.map((item) => ("source" in item ? String(item.source) : item.code)).join("\n");
}

describe("@ferriki/vite", () => {
  it("replaces macro aliases with prepared blocks and preserves source maps", async () => {
    const source = `const before = "🧪";
import { code as renderSnippet, type PreparedCodeBlock } from "@ferriki/core/macro";
const prepared: PreparedCodeBlock = renderSnippet('const tag = "</script>";\\r\\n// λ', { language: "ts", meta: 'title="Demo" [API] {1}', lineNumbers: false });
const numbered = renderSnippet("const value = 1;", { language: "ts", meta: "showLineNumbers", lineNumbers: false });`;
    const vitePlugin = plugin({ styleMode: "classes", lineNumbers: true });
    const result = await transformModule(vitePlugin, source, "/src/example.mts");

    expect(result.code).not.toContain("code as renderSnippet");
    expect(result.code).toContain('import type { PreparedCodeBlock } from "@ferriki/core/macro";');
    expect(() => parseOutput(result.code, "ts")).not.toThrow();
    expect(result.code).not.toContain("</script>");
    expect(result.map).toMatchObject({
      version: 3,
      sources: ["/src/example.mts"],
      sourcesContent: [source],
    });

    const executable = await transformWithOxc(withoutVirtualStyles(result.code), "/src/x.mts", {
      lang: "ts",
    });
    const { prepared, numbered } = runInNewContext(
      `${asScript(executable.code)}\n({ prepared, numbered });`,
    );
    expect(prepared.code).toBe('const tag = "</script>";\r\n// λ');
    expect(prepared.language).toBe("ts");
    expect(prepared.html).toMatch(/^<pre\b[^>]*><code>/);
    expect(prepared.html).toContain('data-title="Demo"');
    expect(prepared.html).toContain('data-label="API"');
    expect(prepared.html).toContain("&#x3C;/script>");
    expect(prepared.html).toContain('<span class="line highlighted ferriki-highlight-line">');
    expect(prepared.html).not.toMatch(/className|data-ln/);
    expect(htmlText(prepared.html)).toBe('const tag = "</script>";\n// λ');
    expect(prepared.css).toContain(".ferriki-style-");
    expect(prepared.css).toContain(".ferriki-highlight-line");
    expect(prepared.metadata).toEqual({
      title: "Demo",
      label: "API",
      lineNumbers: false,
      highlightedLines: [1],
    });
    expect(numbered.metadata.lineNumbers).toBe(true);
    expect(numbered.html).toContain('<span class="line ferriki-highlight-line" data-ln="1">');
    const cssId = cssImportId(result.code);
    expect(cssId).toBeTruthy();
    expect(vitePlugin.resolveId(cssId)).toBe(`\0${cssId}`);
    expect(vitePlugin.load(`\0${cssId}`)).toContain(".ferriki-style-");
  });

  it("updates the content-addressed CSS module when macro output changes", async () => {
    const vitePlugin = plugin({ styleMode: "classes" });
    const before = await transformModule(
      vitePlugin,
      `import { code } from "@ferriki/core/macro"; const value = code("const value = 42;", { language: "ts" });`,
      "/src/macro-hmr.ts",
    );
    const after = await transformModule(
      vitePlugin,
      `import { code } from "@ferriki/core/macro"; const value = code("function value() { return 42; }", { language: "ts" });`,
      "/src/macro-hmr.ts",
    );
    const beforeId = cssImportId(before.code);
    const afterId = cssImportId(after.code);
    expect(beforeId).not.toBe(afterId);
    expect(vitePlugin.load(`\0${beforeId}`)).not.toBe(vitePlugin.load(`\0${afterId}`));
  });

  it("lowers React Code macros to HTML or named and inline render callbacks", async () => {
    const source = `const before = "🧪";
import { Code as PrepareCode } from "@ferriki/core/react/macro";
export const defaultBlock = <PrepareCode source={'const tag = "</script>";\\r\\n// λ'} language="ts" meta='title="Demo" [API] {1}' lineNumbers={false} />;
function renderNamed({ code, className }) { return <section className={className} dangerouslySetInnerHTML={{ __html: code.html }} />; }
export const namedBlock = <PrepareCode source={\`console.log("named");\\n\`} language="js" render={renderNamed} />;
export const customBlock = <PrepareCode source={\`console.log("custom");\\n\`} language="js" meta="showLineNumbers" lineNumbers={false} className={currentClassName()} render={({ code, ...props }) => <section {...props} data-language={code.language} dangerouslySetInnerHTML={{ __html: code.html }} />} />;`;
    const vitePlugin = plugin({ styleMode: "classes", lineNumbers: true });
    const result = await transformModule(vitePlugin, source, "/src/react-code.tsx");

    expect(result.code).not.toContain("@ferriki/core/react/macro");
    expect(result.code).not.toContain("<PrepareCode");
    expect(result.code).not.toContain('from "react"');
    expect(result.moduleType).toBeUndefined();
    const ast = parseOutput(result.code);
    const [fallback] = jsxElements(ast, "div");
    expect(attributeNames(fallback)).toEqual(["dangerouslySetInnerHTML"]);
    const fallbackHtml = jsxAttribute(fallback, "dangerouslySetInnerHTML").value.expression
      .properties[0].value.value;
    expect(fallbackHtml).toMatch(/^<pre\b/);
    expect(fallbackHtml).toContain('data-title="Demo"');
    expect(fallbackHtml).toContain('data-label="API"');
    expect(htmlText(fallbackHtml)).toBe('const tag = "</script>";\n// λ');
    expect(fallbackHtml).not.toContain("data-ln");
    expect(result.code).not.toContain("</script>");

    const components = preparedComponents(ast);
    const [namedDescriptor, customDescriptor] = preparedDescriptors(ast);
    expect(components).toHaveLength(2);
    expect(objectProperty(namedDescriptor, "code").value.value).toBe('console.log("named");\n');
    expect(objectProperty(customDescriptor, "code").value.value).toBe('console.log("custom");\n');
    expect(objectProperty(customDescriptor, "language").value.value).toBe("js");
    expect(attributeNames(components[0])).toEqual(["code", "render"]);
    expect(attributeNames(components[1])).toEqual(["code", "className", "render"]);
    const sections = jsxElements(ast, "section");
    expect(sections).toHaveLength(2);
    expect(attributeNames(sections[1])).toContain("JSXSpreadAttribute");
    expect(attributeNames(sections[1])).toContain("data-language");

    const customMetadata = objectProperty(customDescriptor, "metadata").value;
    expect(objectProperty(customMetadata, "lineNumbers").value.value).toBe(true);
    expect(objectProperty(customDescriptor, "css").value.value).toContain(".ferriki-style-");
    expect(result.code).toContain("currentClassName()");
    const cssId = cssImportId(result.code);
    expect(cssId).toBeTruthy();
    expect(vitePlugin.resolveId(cssId)).toBe(`\0${cssId}`);
    expect(vitePlugin.load(`\0${cssId}`)).toContain(".ferriki-style-");
    expect(result.map).toMatchObject({
      version: 3,
      sources: ["/src/react-code.tsx"],
      sourcesContent: [source],
    });
  });

  it("reports unsupported React Code element forms", async () => {
    const cases = [
      ['<PrepareCode source={readSource()} language="ts" />', /source.*static string/i, "source="],
      ['<PrepareCode source="const value = 1;" language="ts" {...props} />', /spread/i, "{..."],
      [
        '<PrepareCode source="const value = 1;" language="ts" title="Demo" />',
        /unknown.*prop/i,
        "title=",
      ],
      [
        '<PrepareCode source="const value = 1;" language="ts">children</PrepareCode>',
        /self-closing.*children/i,
        "<PrepareCode",
      ],
      [
        '<PrepareCode source="const value = 1;" language="ts" render={<span />} />',
        /render.*callback/i,
        "<span",
      ],
    ];
    const prefix = 'import { Code as PrepareCode } from "@ferriki/core/react/macro";\n';
    for (const [element, message, marker] of cases)
      await macroError(`${prefix}${element}`, "/src/invalid.tsx", {
        message,
        at: prefix.length + element.indexOf(marker),
      });
  });

  it("decodes quoted JSX attributes like OXC and preserves expression literals", async () => {
    const elements = [
      ['<MacroCode source="x &amp; &#x1F680;" language="text" render={CodeBlock} />', "x & 🚀"],
      [
        "<MacroCode source={'x &amp; &#x1F680;'} language=\"text\" render={CodeBlock} />",
        "x &amp; &#x1F680;",
      ],
      ['<MacroCode source="&amp;lt;" language="text" render={CodeBlock} />', "&lt;"],
      [
        '<MacroCode source="x &unknownEntity; y" language="text" render={CodeBlock} />',
        "x &unknownEntity; y",
      ],
      [
        '<MacroCode source="  leading  and trailing  " language="text" render={CodeBlock} />',
        "  leading  and trailing  ",
      ],
      [
        '<MacroCode source="first\n  middle\nlast " language="text" render={CodeBlock} />',
        "first\n  middle\nlast ",
      ],
      [
        '<MacroCode source="first\r\n  second " language="text" render={CodeBlock} />',
        "first\r\n  second ",
      ],
    ];
    const vitePlugin = plugin();

    for (const [index, [element, expected]] of elements.entries()) {
      // OXC's own JSX transform is the oracle for the runtime value of the attribute.
      const oracle = await transformWithOxc(`(${element});`, "/oracle.jsx", {
        lang: "jsx",
        jsx: { runtime: "classic", pragma: "h" },
      });
      const props = runInNewContext(oracle.code, {
        h: (_type, props) => props,
        MacroCode: "MacroCode",
        CodeBlock() {},
      });
      expect(props.source).toBe(expected);

      const source = `import { Code as MacroCode } from "@ferriki/core/react/macro";\nfunction CodeBlock(props) { return props.code; }\n${element}`;
      const result = await transformModule(vitePlugin, source, `/src/entities-${index}.tsx`);
      const [descriptor] = preparedDescriptors(parseOutput(result.code));
      expect(objectProperty(descriptor, "code").value.value).toBe(expected);
    }

    const staticResult = await transformModule(
      vitePlugin,
      `import { Code as MacroCode } from "@ferriki/core/react/macro";\n<MacroCode source="x" language="text" className="syntax &amp; &#x1F680;" />`,
      "/src/class-entity.tsx",
    );
    const [wrapper] = jsxElements(parseOutput(staticResult.code), "div");
    // The quoted attribute is kept verbatim, so the JSX compiler decodes it once.
    expect(jsxAttribute(wrapper, "className").value.raw).toBe('"syntax &amp; &#x1F680;"');
    const evaluated = await evaluateJsx(staticResult.code, "/src/class-entity.tsx");
    expect(evaluated.props.className).toBe("syntax & 🚀");
  });

  it("evaluates render and className once in JSX attribute order and keeps lexical captures", async () => {
    const source = `const before = "🧪";
import { Code as PrepareCode } from "@ferriki/core/react/macro";
const FerrikiMacroRenderHelper = "user binding";
const Object = null;
function inspectNoClassName(props) { return { hasClassName: "className" in props }; }
const owner = {
  marker: "λ",
  events: [],
  className() { this.events.push("className"); return "syntax"; },
  renderer() { this.events.push("render"); const marker = this.marker; return (props) => { this.events.push("invoke"); return { marker, language: props.code.language, className: props.className, hasClassName: "className" in props }; }; },
  make() { return <PrepareCode source="const value = 1;" language="text" className={this.className()} render={this.renderer()} />; },
};
const result = owner.make();
const withoutClassName = <PrepareCode source="const noClass = true;" language="text" render={inspectNoClassName} />;
({ result, withoutClassName, events: owner.events });`;
    const result = await transformModule(plugin(), source, "/src/order.tsx");
    const evaluated = await evaluateJsx(result.code, "/src/order.tsx");

    expect(evaluated.events).toEqual(["className", "render"]);
    expect(evaluated.result.type.name).toBe("FerrikiMacroRenderHelper1");
    expect(evaluated.result.props.className).toBe("syntax");
    expect(evaluated.result.props.render).toBeTypeOf("function");
    expect(result.code.match(/this\.className\(\)/g)).toHaveLength(1);
    expect(result.code.match(/this\.renderer\(\)/g)).toHaveLength(1);

    const rendered = evaluated.result.type(evaluated.result.props);
    expect(evaluated.events).toEqual(["className", "render", "invoke"]);
    expect(rendered).toEqual({
      marker: "λ",
      language: "text",
      className: "syntax",
      hasClassName: true,
    });
    expect(evaluated.withoutClassName.type(evaluated.withoutClassName.props).hasClassName).toBe(
      false,
    );
  });

  it("names the render helper after every identifier of the module, types included", async () => {
    const source = `import { Code } from "@ferriki/core/react/macro";
type FerrikiMacroRenderHelper = string;
const label = { FerrikiMacroRenderHelper1: true };
<FerrikiMacroRenderHelper2 />;
export const block = <Code source="x" language="text" render={(props) => props} />;`;
    const result = await transformModule(plugin(), source, "/src/helper-name.tsx");
    expect(result.code).toContain("function FerrikiMacroRenderHelper3(props)");
    expect(result.code).toContain("<FerrikiMacroRenderHelper3 code={");
  });

  it("maps renderer expressions back to their original source locations", async () => {
    const source = `import { Code as PrepareCode } from "@ferriki/core/react/macro";
const marker = "🧪";
const block = <PrepareCode source="x" language="text" render={({ code }) => {
  return marker + code.language;
}} />;`;
    const id = "/src/render-map.tsx";
    const result = await transformModule(plugin(), source, id);
    const generatedStart = result.code.indexOf("return marker + code.language;");
    const originalStart = source.indexOf("return marker + code.language;");
    const position = (text, index) => {
      const before = text.slice(0, index).split("\n");
      return { line: before.length, column: before.at(-1).length };
    };

    expect(generatedStart).toBeGreaterThanOrEqual(0);
    expect(
      originalPositionFor(new TraceMap(result.map), position(result.code, generatedStart)),
    ).toMatchObject({
      source: id,
      ...position(source, originalStart),
    });
  });

  it("retains nested macro edits inside a renderer expression", async () => {
    const source = `import { code as prepare } from "@ferriki/core/macro";
import { Code as PrepareCode } from "@ferriki/core/react/macro";
const block = <PrepareCode source="outer" language="text" render={({ code }) => <section>
  <PrepareCode source="inner" language="text" render={({ code: inner }) => inner.code} />
  <pre>{prepare("const nestedλ = 1;", { language: "ts" }).code}</pre>
  {code.code}
</section>} />;`;
    const result = await transformModule(plugin(), source, "/src/nested.tsx");

    expect(() => parseOutput(result.code)).not.toThrow();
    expect(result.code).not.toContain("<PrepareCode");
    expect(result.code).not.toContain("prepare(");
    expect(result.code).toContain('"code":"const nestedλ = 1;"');
    expect(result.code).toContain('"code":"inner"');
    expect(result.code).toContain('"code":"outer"');
    expect(result.map.sourcesContent).toEqual([source]);
  });

  it("uses the default wrapper when a runtime renderer value is undefined", async () => {
    const source = `import { Code as PrepareCode } from "@ferriki/core/react/macro";
const value = <PrepareCode source="fallback" language="text" className={chooseClassName()} render={undefined} />;
value;`;
    const result = await transformModule(plugin(), source, "/src/undefined-render.tsx");
    let classNameReads = 0;
    const evaluated = await evaluateJsx(result.code, "/src/undefined-render.tsx", {
      chooseClassName: () => {
        classNameReads++;
        return "syntax";
      },
    });

    expect(classNameReads).toBe(1);
    expect(evaluated.type.name).toBe("FerrikiMacroRenderHelper");
    const fallback = evaluated.type(evaluated.props);
    expect(fallback.type).toBe("div");
    expect(fallback.props.className).toBe("syntax");
    expect(fallback.props.dangerouslySetInnerHTML.__html).toContain("fallback");
    expect(result.code.match(/"html":/g)).toHaveLength(1);
  });

  it("keeps a descriptor an expression at the start of a statement or concise arrow body", async () => {
    const source = `import { code } from "@ferriki/core/macro";
export const make = () => code("arrow", { language: "ts" });
export const parenthesized = () => (code("parenthesized", { language: "ts" }));
code("statement", { language: "ts" }).html;
export const value = code("value", { language: "ts" });`;
    const result = await transformModule(plugin(), source, "/src/positions.ts");
    expect(result.code).toMatch(/^export const make = \(\) => \(\{"code":"arrow",/m);
    expect(result.code).toMatch(
      /^export const parenthesized = \(\) => \(\{"code":"parenthesized",/m,
    );
    expect(result.code).toMatch(/^\(\{"code":"statement",.*\}\)\.html;$/m);
    expect(result.code).toMatch(/^export const value = \{"code":"value",/m);
    const executable = await transformWithOxc(result.code, "/src/positions.ts", { lang: "ts" });
    const evaluated = runInNewContext(
      `${asScript(executable.code)}\n({ make, parenthesized, value });`,
    );
    expect(evaluated.make().code).toBe("arrow");
    expect(evaluated.parenthesized().code).toBe("parenthesized");
    expect(evaluated.value.code).toBe("value");
  });

  it("warns once per module for unknown languages and emits escaped plain HTML", async () => {
    const source = `import { code } from "@ferriki/core/macro";
const prepared = code('const markup = "<script>" & 1;\\nnext', { language: "not-a-real-language", meta: 'title="A <b>" {2}', lineNumbers: true });
const other = code("plain", { language: "also-not-real" });`;
    const warnings = [];
    const result = await transformModule(plugin(), source, "/src/fallback.cts", warnings);
    const { prepared, other } = runInNewContext(
      `${withoutVirtualStyles(result.code)}\n({ prepared, other });`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /language "(?:not-a-real-language|also-not-real)" in \/src\/fallback\.cts/,
    );
    expect(prepared.code).toBe('const markup = "<script>" & 1;\nnext');
    expect(prepared.language).toBe("not-a-real-language");
    expect(prepared.html).toBe(
      '<pre class="shiki" data-title="A &#x3C;b>"><code class="language-not-a-real-language">' +
        '<span class="ferriki-highlight-line" data-ln="1">const markup = "&#x3C;script>" &#x26; 1;</span>\n' +
        '<span class="ferriki-highlight-line highlighted" data-ln="2">next</span></code></pre>',
    );
    expect(prepared.metadata).toEqual({
      title: "A <b>",
      lineNumbers: true,
      highlightedLines: [2],
    });
    expect(prepared.css).toContain(".ferriki-highlight-line");
    expect(other.html).toBe(
      '<pre class="shiki"><code class="language-also-not-real">plain</code></pre>',
    );
    expect(other.css).toBe("");
  });

  it("forwards transformer callbacks to every prepared block", async () => {
    const source = `import { code } from "@ferriki/core/macro";
import { Code } from "@ferriki/core/react/macro";
export const prepared = code("  const answer = 42; // [!code focus]\\n  return answer; // [!code ++]\\n  throw Error(\\"old\\"); // [!code --]\\nconst marker = \\"// [!code focus]\\";", { language: "ts", meta: "{2}" });
export const element = <Code language="ts" source={\`const word = 1; // [!code word:word]\`} />;`;
    const result = await transformModule(
      plugin({ transformers: notationTransformers }),
      source,
      "/src/notation.tsx",
    );
    const ast = parseOutput(result.code);
    const descriptor = [...nodes(ast)].find(
      (node) => node.type === "ObjectExpression" && objectProperty(node, "html"),
    );
    const html = objectProperty(descriptor, "html").value.value;
    const lines = [...html.matchAll(/<span class="(line[^"]*)"/g)].map((match) =>
      match[1].split(" "),
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual(expect.arrayContaining(["line", "focused"]));
    expect(lines[1]).toEqual(
      expect.arrayContaining(["highlighted", "diff", "add", "ferriki-highlight-line"]),
    );
    expect(lines[2]).toEqual(expect.arrayContaining(["diff", "remove"]));
    const text = htmlText(html);
    expect(text).toContain("  const answer = 42;");
    expect(text).not.toContain("[!code ++]");
    expect(text).not.toContain("[!code --]");
    expect(text).toContain('const marker = "// [!code focus]";');
    const [wrapper] = jsxElements(ast, "div");
    const elementHtml = jsxAttribute(wrapper, "dangerouslySetInnerHTML").value.expression
      .properties[0].value.value;
    expect(elementHtml).toContain("highlighted-word");
  });

  it("emits theme CSS for class output and concrete colors for inline multi-theme output", async () => {
    const themes = { light: "github-light-default", dark: "github-dark-default" };
    const source = `import { code } from "@ferriki/core/macro"; export const block = code("const value = 42;", { language: "ts" });`;
    const classPlugin = ferriki({ themes, styleMode: "classes" });
    const classes = await transformModule(classPlugin, source, "/src/themes.ts");
    const css = classPlugin.load(`\0${cssImportId(classes.code)}`);
    expect(css).toContain("--ferriki-color:var(--shiki-light)");
    expect(css).toContain('[data-ferriki-theme="dark"]');

    const inline = await transformModule(ferriki({ themes }), source, "/src/themes.ts");
    expect(cssImportId(inline.code)).toBeUndefined();
    expect(inline.code).toContain("color:#");
    expect(inline.code).toContain("--shiki-dark:");
  });

  it("keeps directive prologues first and appends the stylesheet import", async () => {
    const source = `"use client";\n"use strict";\nimport { code } from "@ferriki/core/macro";\nexport const block = code("const value = 42;", { language: "ts", meta: "{1}" });`;
    const result = await transformModule(plugin(), source, "/src/directives.ts");
    expect(result.code.startsWith('"use client";\n"use strict";\n')).toBe(true);
    const ast = parseOutput(result.code, "ts");
    expect(ast.body.slice(0, 2).map((statement) => statement.directive)).toEqual([
      "use client",
      "use strict",
    ]);
    expect(result.code.indexOf('import "virtual:ferriki-vite/')).toBeGreaterThan(
      result.code.indexOf("export const block"),
    );
  });

  it("throws when the browser macro entry is executed without a build transform", () => {
    expect(() => code("const value = 1;", { language: "ts" })).toThrow(
      /compile-time macro.*@ferriki\/vite/,
    );
  });

  it("rejects an empty theme map as invalid usage", () => {
    expect(() => ferriki({ themes: {} })).toThrow(expect.objectContaining({ code: "ERR_USAGE" }));
  });

  it("rejects non-array transformer options as invalid usage", () => {
    expect(() => ferriki({ transformers: {} })).toThrow(
      expect.objectContaining({ code: "ERR_USAGE" }),
    );
  });
});

describe("@ferriki/vite import gate", () => {
  it("declares a host filter for script IDs and the two macro specifiers", () => {
    expect(plugin().transform.filter).toEqual({
      id: expect.any(RegExp),
      code: ["@ferriki/core/macro", "@ferriki/core/react/macro"],
    });
    const { id } = plugin().transform.filter;
    for (const script of ["/a.js", "/a.mjs", "/a.cjs", "/a.jsx", "/a.ts", "/a.mts", "/a.tsx"])
      expect(id.test(script), script).toBe(true);
    expect(id.test("/a.tsx?v=1")).toBe(true);
    for (const other of ["/a.vue", "/a.css", "/a.mdx", "/a.vue?vue&type=script&lang.ts", "/ts"])
      expect(id.test(other), other).toBe(false);
    // A function predicate cannot be a host filter; it is checked in the handler.
    expect(plugin({ include: () => true }).transform.filter).toEqual({
      code: ["@ferriki/core/macro", "@ferriki/core/react/macro"],
    });
  });

  it("leaves modules without a macro import untouched and never starts the highlighter", async () => {
    const vitePlugin = ferriki({
      theme: "not-a-real-theme",
      assets: { remote: false, cacheDir: join(tmpdir(), "ferriki-no-macro-assets") },
    });
    parsedIds.length = 0;
    await expect(
      transformModule(vitePlugin, 'const untouched = "🧪";', "/src/no-macro.cts"),
    ).resolves.toBeNull();
    // A mention passes the substring filter; the parse finds no import.
    await expect(
      transformModule(
        vitePlugin,
        'import type { PreparedCodeBlock } from "@ferriki/core/macro";\n// "@ferriki/core/react/macro"\nexport type Block = PreparedCodeBlock;',
        "/src/types-only.ts",
      ),
    ).resolves.toBeNull();
    expect(parsedIds).toEqual(["/src/types-only.ts"]);
  });

  it("does not load the native addon when macro text appears only in comments and strings", () => {
    const viteUrl = new URL("../index.mjs", import.meta.url).href;
    const source = String.raw`// Documentation mentions @ferriki/core/macro.
const example = "@ferriki/core/macro";
const pattern = /\d+\\w+/;`;
    const script = `
      // Vite's own parser loads first; only Ferriki's addon must stay unloaded.
      await import("vite");
      Object.defineProperty(process, "arch", { value: "unsupported" });
      const { ferriki } = await import(${JSON.stringify(viteUrl)});
      const result = await ferriki().transform.handler.call({ warn() {}, error(error) { throw error } }, ${JSON.stringify(source)}, "/src/ordinary.ts");
      if (result !== null) throw new Error("the ordinary module should remain unchanged");
      process.stdout.write("null");
    `;

    const result = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    expect(result).toBe("null");
  });

  it("does not transform a macro specifier spelled with escapes", async () => {
    for (const specifier of [
      String.raw`"@ferriki/core/\u006dacro"`,
      String.raw`"\u0040ferriki/core/macro"`,
      String.raw`"\x40ferriki\/core\/\macro"`,
    ]) {
      const source = `import { code } from ${specifier};\nconst prepared = code("const value = 1;", { language: "ts" });`;
      await expect(transformModule(plugin(), source, "/src/escaped.ts")).resolves.toBeNull();
    }
  });

  it("transforms included compiler-emitted modules and declares their JSX module type", async () => {
    const includedPlugin = plugin({ include: (id) => id.includes("virtual:markdown") });
    await expect(
      transformModule(
        includedPlugin,
        `import { code } from "@ferriki/core/macro"; code("x", { language: "ts" });`,
        "\0virtual:other/page.mdx",
      ),
    ).resolves.toBeNull();

    const source = `import { code as prepare } from "@ferriki/core/macro";
const snippet = prepare("const mdx = 1;", { language: "ts" });`;
    const result = await transformModule(includedPlugin, source, "\0virtual:markdown/page.mdx");
    expect(result.code).not.toContain("@ferriki/core/macro");
    expect(result.code).toContain("const mdx = 1;");
    expect(result.map.sources).toEqual(["\0virtual:markdown/page.mdx"]);
    expect(result.moduleType).toBeUndefined();

    const react = `import { Code } from "@ferriki/core/react/macro";
export const block = <Code source="const mdx = 2;" language="ts" />;`;
    const reactResult = await transformModule(includedPlugin, react, "\0virtual:markdown/page.mdx");
    expect(reactResult.code).toContain("<div dangerouslySetInnerHTML");
    expect(reactResult.moduleType).toBe("tsx");
    const declared = await transformModule(
      includedPlugin,
      react,
      "\0virtual:markdown/page.mdx",
      [],
      { moduleType: "jsx" },
    );
    expect(declared.moduleType).toBeUndefined();
    const jsxFile = await transformModule(plugin(), react, "/src/page.jsx");
    expect(jsxFile.moduleType).toBeUndefined();
    const jsFile = await transformModule(plugin(), react, "/src/page.js");
    expect(jsFile.moduleType).toBe("jsx");
  });

  it("lets Rolldown lower the JSX it emits into an included virtual module", async () => {
    const root = await createProject({
      "index.html":
        '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
      "src/main.js": 'import { block } from "virtual:demo.mdx";\nconsole.log(block);\n',
    });
    // Stands in for an MDX compiler that exposes its JSX output under a virtual ID.
    const compiler = {
      name: "virtual-mdx-output",
      enforce: "pre",
      resolveId: (id) => (id === "virtual:demo.mdx" ? "\0virtual:demo.mdx" : null),
      load: (id) =>
        id === "\0virtual:demo.mdx"
          ? 'import { Code } from "@ferriki/core/react/macro";\nexport const block = <Code source="const virtualValue = 1;" language="ts" className="virtual" />;\n'
          : null,
    };
    const output = buildOutputText(
      await build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [compiler, plugin({ include: (id) => id.includes("virtual:demo") })],
        build: {
          write: false,
          minify: false,
          rolldownOptions: { external: [/^react(?:\/|$)/] },
        },
      }),
    );
    expect(output).toContain('from "react/jsx-runtime"');
    expect(output).toMatch(/jsx\("div", \{\s*className: "virtual",\s*dangerouslySetInnerHTML/);
    expect(output).toContain("virtualValue");
  });

  it("parses only modules that import a macro, in Vite build and dev", async () => {
    const root = await createProject({
      "index.html":
        '<!doctype html><html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>',
      "src/main.ts":
        'import { plain } from "./plain.ts";\nimport { block } from "./block.ts";\nconsole.log(plain, block);\n',
      "src/plain.ts": 'export const plain = "no macro here";\n',
      "src/block.ts":
        'import { code } from "@ferriki/core/macro";\nexport const block = code("const builtValue = 42;", { language: "ts", meta: "{1}" });\n',
    });
    const handled = [];
    const countingPlugin = () => {
      const vitePlugin = plugin({ styleMode: "classes" });
      const { handler } = vitePlugin.transform;
      vitePlugin.transform.handler = function (source, id, meta) {
        handled.push(id);
        return handler.call(this, source, id, meta);
      };
      return vitePlugin;
    };
    const projectIds = (ids) =>
      ids.filter((id) => id.startsWith(root)).map((id) => id.slice(root.length));

    parsedIds.length = 0;
    const output = buildOutputText(
      await build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [countingPlugin()],
        build: { write: false, minify: false },
      }),
    );
    expect(output).toContain("builtValue");
    expect(output).toContain("ferriki-highlight-line");
    expect(output).not.toContain("@ferriki/core/macro");
    expect(projectIds(handled)).toEqual(["/src/block.ts"]);
    expect(projectIds(parsedIds)).toEqual(["/src/block.ts"]);

    handled.length = 0;
    parsedIds.length = 0;
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [countingPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, fs: { allow: [root] } },
      appType: "custom",
    });
    try {
      const plain = await server.transformRequest("/src/plain.ts");
      const block = await server.transformRequest("/src/block.ts");
      expect(plain.code).toContain("no macro here");
      expect(block.code).toContain("virtual:ferriki-vite/");
      expect(block.code).toContain("builtValue");
    } finally {
      await server.close();
    }
    expect(projectIds(handled)).toEqual(["/src/block.ts"]);
    expect(projectIds(parsedIds)).toEqual(["/src/block.ts"]);
  });

  it("lowers React macros in Vite dev and build, including class CSS", async () => {
    const root = await createProject({
      "index.html":
        '<!doctype html><html><head></head><body><script type="module" src="/src/example.tsx"></script></body></html>',
      "src/example.tsx": `import { Code } from "@ferriki/core/react/macro";
const h = (type: unknown, props: unknown) => ({ type, props });
const block = <Code source="const jsxValue = 42;" language="ts" meta="{1}" className="example" />;
console.log(block);
`,
    });
    const oxc = { jsx: { runtime: "classic", pragma: "h" } };
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [plugin({ styleMode: "classes" })],
      oxc,
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, fs: { allow: [root] } },
      appType: "custom",
    });
    try {
      const module = await server.transformRequest("/src/example.tsx");
      expect(module.code).toContain("virtual:ferriki-vite/");
      expect(module.code).toContain("jsxValue");
      expect(module.code).toMatch(/h\("div", \{\s*className: "example"/);
    } finally {
      await server.close();
    }

    const output = buildOutputText(
      await build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [plugin({ styleMode: "classes", lineNumbers: true })],
        oxc,
        build: { write: false, minify: false },
      }),
    );
    expect(output).toContain("jsxValue");
    expect(output).toContain("ferriki-highlight-line");
    expect(output).not.toContain("@ferriki/core/react/macro");
  });
});

describe("@ferriki/vite diagnostics", () => {
  it("reserves the macro name against declarations in the same scope and nested scopes", async () => {
    const forms = [
      ["function code() {}", "code() {}"],
      ["const code = 1;", "code = 1"],
      ["class code {}", "code {}"],
      ['import { code } from "./other.js";', 'code } from "./other'],
      ["function render(code) { return code; }", "code) {"],
      ["const render = (code) => code;", "code) =>"],
      ["function render({ code }) { return code; }", "code }"],
      ["const render = ({ code: { code } }) => code;", "code } }"],
      ["function render([code = 1]) {}", "code = 1"],
      ["{ let code = 1; }", "code = 1"],
      ["try {} catch (code) {}", "code) {}"],
      ["for (const code of []) {}", "code of"],
      ["const value = function code() {};", "code() {}"],
      ["const value = class code {};", "code {}"],
      ["namespace code {}", "code {}"],
      ["enum code {}", "code {}"],
      ["enum Values { code = 1 }", "code = 1"],
      ["type code = string;", "code = string"],
      ["interface code {}", "code {}"],
      ["class Item { constructor(private code: string) {} }", "code: string"],
    ];
    for (const [declaration, marker] of forms) {
      const source = `import { code } from "@ferriki/core/macro";\n${declaration}\nexport const block = code("x", { language: "ts" });`;
      const offset = source.indexOf(marker, source.indexOf("\n"));
      await macroError(source, "/src/reserved.ts", {
        message: "`code` is reserved in this module because it binds the `code` macro",
        at: offset,
      });
    }

    const react = `import { Code as Example } from "@ferriki/core/react/macro";
function Wrapper({ Example }) { return <Example source="x" language="ts" />; }`;
    await macroError(react, "/src/reserved.tsx", {
      message: "`Example` is reserved in this module because it binds the React `Code` macro",
      at: react.indexOf("Example }", react.indexOf("\n")),
    });

    // Duplicate imports of the macro and unrelated uses of the name are covered too.
    await macroError(
      'import { code, code as code } from "@ferriki/core/macro";',
      "/src/duplicate.ts",
      { message: "`code` is reserved", at: 'code } from "' },
    );
    const unrelated = `import { code } from "@ferriki/core/macro";
const record = { code: 1, get code() { return 2; } };
label: for (;;) { break label; }
record.code;
type Shape = { code: string };
type Renderer = (code: string) => void;
function typed<code>(value: typeof code): code { return value as code; }
export const block = code("x", { language: "ts" });`;
    await expect(transformModule(plugin(), unrelated, "/src/unrelated.ts")).resolves.toMatchObject({
      code: expect.stringContaining('"code":"x"'),
    });
  });

  it("reports macro errors with id, location and code frame through Vite dev and build", async () => {
    const file = `import { code } from "@ferriki/core/macro";
export const block = (code) => code("x", { language: "ts" });
`;
    const root = await createProject({
      "index.html":
        '<!doctype html><html><head></head><body><script type="module" src="/src/invalid.ts"></script></body></html>',
      "src/invalid.ts": file,
    });
    const id = join(root, "src/invalid.ts");
    const expectedLoc = { file: id, line: 2, column: 22 };

    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [plugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, fs: { allow: [root] } },
      appType: "custom",
    });
    let devError;
    try {
      devError = await server.transformRequest("/src/invalid.ts").catch((error) => error);
    } finally {
      await server.close();
    }
    expect(devError).toBeInstanceOf(Error);
    expect(devError).toMatchObject({
      name: "FerrikiMacroError",
      code: "FERRIKI_MACRO",
      plugin: "@ferriki/vite",
      id,
      loc: expectedLoc,
    });
    expect(devError.message).toContain("`code` is reserved in this module");
    expect(devError.frame).toContain("export const block = (code) =>");

    const buildError = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [plugin()],
      build: { write: false },
    }).catch((error) => error);
    expect(buildError).toBeInstanceOf(Error);
    const reported = buildError.errors?.[0] ?? buildError;
    expect(reported).toMatchObject({
      plugin: "@ferriki/vite",
      pluginCode: "FERRIKI_MACRO",
      id,
      loc: expectedLoc,
    });
    expect(reported.message).toContain("`code` is reserved in this module");
    expect(reported.frame).toContain("export const block = (code) =>");
  });

  it("reports syntax errors of a macro module with the parser's position", async () => {
    const source = `import { code } from "@ferriki/core/macro";\nconst café = code("x", { language: "ts" ;`;
    const error = await transformModule(plugin(), source, "/src/broken.ts").catch(
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toMatch(/expected/i);
    expect(error.loc).toMatchObject({ file: "/src/broken.ts", line: 2 });
  });
});

describe("ported native scanner contract", () => {
  it("recognizes aliases and inline calls inside loops", async () => {
    const source =
      "import { code as snippet } from '@ferriki/core/macro';\nwhile (ready) snippet(`a\\nb`, { language: 'ts', meta: 'demo', lineNumbers: false });";
    const result = await transformModule(plugin(), source, "/src/example.js");
    expect(result.code.startsWith('\nwhile (ready) ({"code":"a\\nb",')).toBe(true);
    expect(result.code).toContain('"code":"a\\nb","language":"ts"');
    expect(result.code).toContain('"metadata":{"lineNumbers":false,"highlightedLines":[]}');
    expect(result.code).not.toContain("snippet");
  });

  it("recognizes cooked literals and keeps type imports", async () => {
    const source =
      "import { code as snippet, type CodeOptions as Options } from '@ferriki/core/macro';\nsnippet(`const x = \\u{1F680};`, { language: 'js' });";
    const result = await transformModule(plugin(), source, "/src/sample.ts");
    const replacement = "import type { CodeOptions as Options } from '@ferriki/core/macro';";
    expect(result.code.startsWith(`${replacement}\n({"code":"const x = 🚀;",`)).toBe(true);
    expect(() => parseOutput(replacement, "ts")).not.toThrow();

    const attributes = await transformModule(
      plugin(),
      "import { code, type FerrikiCodeOptions } from '@ferriki/core/macro' with { type: 'js' };\nexport const block = code('x', { language: 'ts' });",
      "/src/attributes.ts",
    );
    expect(attributes.code).toContain(
      "import type { FerrikiCodeOptions } from '@ferriki/core/macro' with { type: 'js' };",
    );
  });

  it("supports string and template literals with optional metadata", async () => {
    const source = `import { code } from '@ferriki/core/macro';
export const first = code('π\\n', { 'language': 'text', meta: '' });
export const second = code(\`const rocket = '🚀';\`, { language: 'js', lineNumbers: true });`;
    const result = await transformModule(plugin(), source, "/src/literals.mjs");
    const { first, second } = runInNewContext(
      `${asScript(withoutVirtualStyles(result.code))}\n({ first, second });`,
    );
    expect(first.code).toBe("π\n");
    expect(first.metadata).toEqual({ lineNumbers: false, highlightedLines: [] });
    expect(second.code).toBe("const rocket = '🚀';");
    expect(second.metadata.lineNumbers).toBe(true);
  });

  it("rejects lone surrogates in consumed literals and preserves valid Unicode", async () => {
    const cases = [
      [
        String.raw`const prefix = '🧪';
import { code } from '@ferriki/core/macro';
code('\uD800', { language: 'text' });`,
        String.raw`'\uD800'`,
        "/src/surrogate.js",
        "code string",
      ],
      [
        `import { code } from '@ferriki/core/macro';
code(\`before \\uD800 after\`, { language: 'text' });`,
        "`before",
        "/src/surrogate.mjs",
        "code template",
      ],
      [
        String.raw`import { code } from '@ferriki/core/macro';
code('code', { language: '\uD800' });`,
        String.raw`'\uD800'`,
        "/src/surrogate-language.ts",
        "`language` option",
      ],
      [
        String.raw`import { code } from '@ferriki/core/macro';
code('code', { language: 'text', meta: '\uD800' });`,
        String.raw`'\uD800'`,
        "/src/surrogate-meta.ts",
        "`meta` option",
      ],
    ];
    for (const [source, marker, id, kind] of cases)
      await macroError(source, id, {
        message: `the ${kind} contains an unpaired UTF-16 surrogate and cannot be represented as UTF-8`,
        at: marker,
      });

    const valid = `const ignored = '\\uD800';
import { code } from '@ferriki/core/macro';
export const first = code('\\uD83D\\uDE80', { language: 'ts' });
export const second = code(\`\\uD83D\\uDE80\`, { language: 'ts' });
export const third = code('\\uFFFD', { language: 'ts' });`;
    const result = await transformModule(plugin(), valid, "/src/valid-unicode.ts");
    expect(result.code).toContain('"code":"🚀"');
    expect(result.code.match(/"code":"🚀"/g)).toHaveLength(2);
    expect(result.code).toContain('"code":"\uFFFD"');
  });

  it("resolves cooked module specifiers and reports UTF-16 positions", async () => {
    // The escaped import is recognized once the module passes the textual filter.
    const source =
      "const café = 1;\n// uses @ferriki/core/macro\nimport { code } from '@ferriki/core/\\u006dacro';\nconst result = code('x', { language: 'text', extra: true });";
    await macroError(source, "/src/unicode.tsx", {
      message: "unknown `extra` option in `code` call",
      at: "extra",
    });

    const astral =
      "const note = '🦀';\nimport { code } from '@ferriki/core/macro';\ncode('ok', { language: 'ts' });";
    const result = await transformModule(plugin(), astral, "/src/offset.ts");
    expect(result.code.startsWith('const note = \'🦀\';\n\n({"code":"ok",')).toBe(true);
    expect(result.code).toMatch(/"highlightedLines":\[\]\}\}\);$/);
  });

  it("rejects escaped macro bindings and unsupported imports", async () => {
    await macroError(
      "import { code as snippet } from '@ferriki/core/macro';\nconst saved = snippet;",
      "/src/escape.ts",
      {
        message: "the imported code binding must be used as a direct function call",
        at: "snippet;",
      },
    );
    await macroError(
      "import { code as Code } from '@ferriki/core/macro';\nexport const view = <Code />;",
      "/src/escape.tsx",
      {
        message: "the imported code binding must be used as a direct function call",
        at: "Code />",
      },
    );
    for (const [source, message] of [
      ["export default code;", "direct function call"],
      ["export { code };", "direct function call"],
      ["code.call(null, 'x', { language: 'ts' });", "direct function call"],
      ["new code('x', { language: 'ts' });", "direct function call"],
      ["code`x`;", "direct function call"],
      ["typeof code;", "direct function call"],
      ["code = null;", "direct function call"],
      ["[code] = [];", "direct function call"],
      ["(code)('x', { language: 'ts' });", "direct function call"],
      ["<code.Item />;", "direct function call"],
    ])
      await macroError(
        `import { code } from '@ferriki/core/macro';\n${source}`,
        "/src/escape.tsx",
        {
          message,
          at: source.indexOf("code") + "import { code } from '@ferriki/core/macro';\n".length,
        },
      );

    await macroError("import * as macros from '@ferriki/core/macro';", "/src/namespace.js", {
      message: "namespace imports",
      at: "* as",
    });
    await macroError("import { anotherThing } from '@ferriki/core/macro';", "/src/other.js", {
      message: "value imports from `@ferriki/core/macro` are limited to the named `code` export",
      at: "anotherThing",
    });
  });

  it("accepts only named ESM value imports from the macro subpath", async () => {
    const cases = [
      ["import macro from '@ferriki/core/macro';", "/imports/macro.js", "default imports", "macro"],
      [
        "import * as macro from '@ferriki/core/macro';",
        "/imports/namespace.js",
        "namespace imports",
        "*",
      ],
      ["import '@ferriki/core/macro';", "/imports/side-effect.js", "side-effect imports", 0],
      ["import {} from '@ferriki/core/macro';", "/imports/empty.js", "empty value imports", 0],
      ["export * from '@ferriki/core/macro';", "/imports/reexport-all.js", "re-exports", 0],
      [
        "export { code } from '@ferriki/core/macro';",
        "/imports/reexport-named.js",
        "re-exports",
        0,
      ],
      ["void import('@ferriki/core/macro');", "/imports/dynamic.js", "dynamic imports", "import("],
      [
        "void import('@ferriki/core/macro', { with: { type: 'json' } });",
        "/imports/dynamic-options.js",
        "dynamic imports",
        "import(",
      ],
      [
        "void import(`@ferriki/core/macro`, { with: { type: 'json' } });",
        "/imports/dynamic-template.ts",
        "dynamic imports",
        "import(",
      ],
      ["require('@ferriki/core/macro');", "/imports/require.js", "CommonJS `require()`", 0],
      [
        "require('@ferriki/core/macro', 'extra');",
        "/imports/require-extra.js",
        "CommonJS `require()`",
        0,
      ],
      [
        "require(`@ferriki/core/macro`, 'extra');",
        "/imports/require-template-extra.js",
        "CommonJS `require()`",
        0,
      ],
      [
        "require?.('@ferriki/core/macro');",
        "/imports/require-optional.ts",
        "CommonJS `require()`",
        0,
      ],
      [
        "import macros = require('@ferriki/core/macro');",
        "/imports/equals.ts",
        "`import = require(...)` from `@ferriki/core/macro` is unsupported; use the named ESM `code` import",
        0,
      ],
    ];
    for (const [source, id, message, at] of cases) await macroError(source, id, { message, at });

    await expect(
      transformModule(
        plugin(),
        "import type { CodeOptions as Options } from '@ferriki/core/macro';\nexport type { PreparedCodeBlock } from '@ferriki/core/macro';\nexport { type FerrikiCodeOptions } from '@ferriki/core/macro';\nimport type Macro = require('@ferriki/core/macro');",
        "/imports/types.ts",
      ),
    ).resolves.toBeNull();
    // A module-local `require` is not CommonJS loading.
    await expect(
      transformModule(
        plugin(),
        "function load(require) { return require('@ferriki/core/macro'); }",
        "/imports/shadowed-require.js",
      ),
    ).resolves.toBeNull();
  });

  it("rejects dynamic arguments, duplicates and spreads", async () => {
    const cases = [
      ["code(getCode(), { language: 'ts' });", "first `code` argument must be a string literal"],
      // eslint-disable-next-line no-template-curly-in-string -- the macro input contains an interpolation.
      ["code(`x ${name}`, { language: 'ts' });", "cannot contain interpolations"],
      ["code('x', { language: 'ts', language: 'js' });", "duplicate `language` key"],
      ["code('x', { ...opts, language: 'ts' });", "spread properties"],
      ["code(...args, { language: 'ts' });", "spread arguments"],
      ["code('x', { [key]: 'ts' });", "computed keys"],
      ["code('x', { language: '   ' });", "nonempty string literal `language` option"],
      ["code('x', { language: language });", "nonempty string literal `language` option"],
      ["code('x', { language });", "nonempty string literal `language` option"],
      ["code('x', { language: `ts` });", "nonempty string literal `language` option"],
      ["code('x', { language: 'ts', meta: value });", "`meta` option must be a string literal"],
      ["code('x', { language: 'ts', lineNumbers: 1 });", "`lineNumbers` option must be a boolean"],
      ["code('x', { language: 'ts', title: 'demo' });", "unknown `title` option"],
      ["code('x', {});", "options require a nonempty string literal `language`"],
      ["code('x', { language: 'ts', get meta() { return 'demo'; } });", "getters"],
      ["code('x', { language: 'ts', set meta(value) {} });", "setters"],
      ["code('x', { language: 'ts', meta() { return 'demo'; } });", "methods"],
      ["code('x', { language: 'ts', 1: true });", "computed keys"],
      ["code('x', options);", "second `code` argument must be an object literal"],
      ["code('x');", "exactly two non-spread arguments"],
      ["code('x', { language: 'ts' }, {});", "exactly two non-spread arguments"],
      ["code(...code, { language: 'ts' });", "direct function call"],
      ["code?.('x', { language: 'ts' });", "optional calls to `code` are unsupported"],
      ["(code as any)('x', { language: 'ts' });", "direct function call"],
      ["code('x', { language: 'ts', meta: 2 });", "`meta` option must be a string literal"],
    ];
    for (const [call, message] of cases)
      await macroError(`import { code } from '@ferriki/core/macro'; ${call}`, "/src/invalid.ts", {
        message,
      });
  });

  it("supports virtual MDX module IDs as TSX", async () => {
    const source =
      "import { code } from '@ferriki/core/macro';\nexport const view = <div>{code('x', { language: 'ts' })}</div>;";
    const result = await transformModule(
      plugin({ include: (id) => id.startsWith("Component.mdx") }),
      source,
      "Component.mdx?virtual=1",
    );
    expect(result.code).toContain('<div>{{"code":"x",');
    expect(() => parseOutput(withoutVirtualStyles(result.code))).not.toThrow();
  });

  it("recognizes React Code aliases next to inline calls and keeps type imports", async () => {
    const source = `import { code as inline } from '@ferriki/core/macro';
import { Code as PrepareBlock, type CodeProps as Props } from '@ferriki/core/react/macro';
const options: Props = { source: 'typed source', language: 'text' };
const block = <PrepareBlock
  source={\`const rocket = '\\u{1F680}';\\n\`}
  language={'tsx'}
  meta={\`title="React"\`}
  lineNumbers={false}
  render={ui /* keep the bound member */ . CodeBlock}
/>;
const plain = inline('plain', { language: 'text' });`;
    const result = await transformModule(plugin(), source, "/src/react-macro.tsx");
    expect(result.code).toContain(
      "import type { CodeProps as Props } from '@ferriki/core/react/macro';",
    );
    expect(result.code).not.toMatch(/^import \{/m);
    expect(result.code).toContain("render={ui /* keep the bound member */ . CodeBlock} />");
    const [descriptor, plain] = [...nodes(parseOutput(result.code))].filter(
      (node) => node.type === "ObjectExpression" && objectProperty(node, "html"),
    );
    expect(objectProperty(descriptor, "code").value.value).toBe("const rocket = '🚀';\n");
    expect(objectProperty(descriptor, "language").value.value).toBe("tsx");
    const metadata = objectProperty(descriptor, "metadata").value;
    expect(objectProperty(metadata, "title").value.value).toBe("React");
    expect(objectProperty(metadata, "lineNumbers").value.value).toBe(false);
    expect(objectProperty(plain, "code").value.value).toBe("plain");
  });

  it("keeps JSX string semantics and forwards runtime presentation expressions", async () => {
    const source = `import { Code } from '@ferriki/core/react/macro';
const first = <Code source="x &amp; y" language="text" className="syntax &amp; color" />;
const second = <Code source={'const π = 1;'} language={\`ts\`} render={$Block} />;
const third = <Code source={\`default\`} language="js" lineNumbers render={(source) => <pre>{source}</pre>} />;
const fourth = <Code source="escaped" language="js" render={function Renderer() { return null; }} />;`;
    const result = await transformModule(plugin(), source, "/src/react-attributes.jsx");
    const ast = parseOutput(result.code, "jsx");
    const [wrapper] = jsxElements(ast, "div").filter((element) =>
      jsxAttribute(element, "className"),
    );
    expect(jsxAttribute(wrapper, "className").value.raw).toBe('"syntax &amp; color"');
    expect(
      htmlText(
        jsxAttribute(wrapper, "dangerouslySetInnerHTML").value.expression.properties[0].value.value,
      ),
    ).toBe("x & y");
    const descriptors = preparedDescriptors(ast);
    expect(descriptors.map((descriptor) => objectProperty(descriptor, "code").value.value)).toEqual(
      ["const π = 1;", "default", "escaped"],
    );
    expect(
      objectProperty(objectProperty(descriptors[1], "metadata").value, "lineNumbers").value.value,
    ).toBe(true);
    expect(result.code).toContain("render={$Block} />");
    expect(result.code).toContain("render={(source) => <pre>{source}</pre>} />");
    expect(result.code).toContain("render={function Renderer() { return null; }} />");
    expect(result.moduleType).toBeUndefined();
  });

  it("omits empty React presentation", async () => {
    const result = await transformModule(
      plugin(),
      'import { Code } from \'@ferriki/core/react/macro\'; const block = <Code source="x" language="ts" />;',
      "/src/empty-presentation.tsx",
    );
    expect(result.code).toMatch(/^ const block = <div dangerouslySetInnerHTML=\{\{ __html: "/);
    expect(result.code).not.toContain("FerrikiMacroRenderHelper");
  });

  it("keeps presentation order around non-ASCII source", async () => {
    const source =
      'const π = 1; import { Code } from \'@ferriki/core/react/macro\';\nconst block = <Code render={renderExample} source="x" language="ts" className="例 &amp; code" />;';
    const result = await transformModule(plugin(), source, "/src/presentation-spans.tsx");
    expect(result.code).toMatch(
      /<FerrikiMacroRenderHelper code=\{\{.*\}\} render=\{renderExample\} className="例 &amp; code" \/>;/,
    );
    const [helper] = preparedComponents(parseOutput(result.code));
    expect(attributeNames(helper)).toEqual(["code", "render", "className"]);
  });

  it("lowers nested macros inside render callbacks and checks marker escapes", async () => {
    const source = `import { Code } from '@ferriki/core/react/macro';
const outer = <Code source="outer" language="ts" render={(text) => <Code source="inner" language="ts" className={classFor(text)} />} />;`;
    const result = await transformModule(plugin(), source, "/src/nested-render.tsx");
    expect(result.code).toMatch(
      /render=\{\(text\) => <div className=\{classFor\(text\)\} dangerouslySetInnerHTML=/,
    );
    expect(result.code).toContain('"code":"outer"');

    await macroError(
      'import { Code } from \'@ferriki/core/react/macro\'; <Code source="x" language="ts" render={Code} />',
      "/src/presentation-escape.tsx",
      { message: "the imported React Code binding must be used", at: "Code} />" },
    );
    await macroError(
      "import { code } from '@ferriki/core/macro'; import { Code } from '@ferriki/core/react/macro'; <Code source=\"x\" language=\"ts\" className={code} />",
      "/src/presentation-escape.tsx",
      { message: "code binding must be used as a direct function call", at: "code} />" },
    );
  });

  it("decodes JSX entities once and preserves quoted attribute whitespace", async () => {
    const source = [
      "import { Code } from '@ferriki/core/react/macro';",
      'export const entities = <Code source="&copy; &#128640; &#x1F680; &#xD83D;&#xDE80; &unknown; &#X1F680; &amp;lt; &amp;&copy; &&amp; &; &#; &#x; &am p;" language="ts" render={(props) => props} />;',
      'export const whitespace = <Code source="first\n  second\tthird\r\nfourth" language="ts" render={(props) => props} />;',
    ].join("\n");
    const result = await transformModule(plugin(), source, "/src/jsx-entities.tsx");
    const descriptors = preparedDescriptors(parseOutput(result.code));
    expect(descriptors.map((descriptor) => objectProperty(descriptor, "code").value.value)).toEqual(
      [
        "© 🚀 🚀 🚀 &unknown; &#X1F680; &lt; &© && &; &#; &#x; &am p;",
        "first\n  second\tthird\r\nfourth",
      ],
    );
  });

  it("rejects invalid JSX numeric entities and unpaired surrogates", async () => {
    for (const value of ["&#xD800;", "&#xD83D;x&#xDE80;", "&#56320;"]) {
      const source = `import { Code } from '@ferriki/core/react/macro';\nconst block = <Code source="${value}" language="ts" />;`;
      await macroError(source, "/src/invalid-jsx-entity.tsx", {
        message:
          "the `source` contains an unpaired UTF-16 surrogate and cannot be represented as UTF-8",
        at: '"',
      });
    }
    await macroError(
      'import { Code } from \'@ferriki/core/react/macro\';\nconst block = <Code source="&#x110000;" language="ts" />;',
      "/src/invalid-jsx-entity.tsx",
      {
        message: "React `Code` `source` contains an invalid numeric JSX character reference",
        at: '"&#x110000',
      },
    );
    await macroError(
      'import { Code } from \'@ferriki/core/react/macro\';\nconst block = <Code source="x" language="ts" className="&#99999999999;" />;',
      "/src/invalid-jsx-entity.tsx",
      {
        message: "React `Code` `className` contains an invalid numeric JSX character reference",
        at: '"&#9999',
      },
    );
    await macroError(
      'import { Code } from \'@ferriki/core/react/macro\';\nconst block = <Code source="x" language="ts" className="&#xDC00;" />;',
      "/src/invalid-jsx-entity.tsx",
      {
        message: "the React `Code` `className` contains an unpaired UTF-16 surrogate",
        at: '"&#xDC00',
      },
    );
  });

  it("rejects dynamic or unsupported React Code elements", async () => {
    const cases = [
      ['<Code source={source} language="ts" />', "`source` must be a static string", "source="],
      [
        // eslint-disable-next-line no-template-curly-in-string -- the macro input contains an interpolation.
        '<Code source={`x ${value}`} language="ts" />',
        "cannot contain template interpolations",
        "source=",
      ],
      [
        '<Code source="x" language={language} />',
        "`language` must be a static string",
        "language=",
      ],
      ['<Code source="x" language="ts" meta={title} />', "`meta` must be a static string", "meta="],
      [
        '<Code source="x" language="ts" lineNumbers={enabled} />',
        "`lineNumbers` to be a static boolean",
        "lineNumbers=",
      ],
      [
        '<Code source="x" language="ts" lineNumbers="true" />',
        "`lineNumbers` to be a static boolean",
        "lineNumbers=",
      ],
      ['<Code language="ts" />', "requires a static string `source`", "<Code"],
      ['<Code source="x" />', "requires a nonempty static string `language`", "<Code"],
      [
        '<Code source="x" language="  " />',
        "requires a nonempty static string `language`",
        "language=",
      ],
      ['<Code source="x" source="y" language="ts" />', "duplicate `source` attribute", 'source="y'],
      ['<Code {...props} source="x" language="ts" />', "spread attributes", "{...props}"],
      ['<Code source="x" language="ts" xlink:href="y" />', "namespaced attributes", "xlink"],
      ['<Code source="x" language="ts" key="key" />', "unknown React `Code` prop `key`", "key="],
      [
        '<Code source="x" language="ts" ref={reference} />',
        "unknown React `Code` prop `ref`",
        "ref=",
      ],
      [
        '<Code source="x" language="ts" children="child" />',
        "unknown React `Code` prop `children`",
        "children=",
      ],
      [
        '<Code source="x" language="ts">child</Code>',
        "must be self-closing and cannot have children",
        "<Code",
      ],
      [
        '<Code source="x" language="ts"></Code>',
        "must be self-closing and cannot have children",
        "<Code",
      ],
      ['<Code source="x" language="ts" render />', "`render` must have a nonempty value", "render"],
      [
        '<Code source="x" language="ts" className />',
        "`className` must have a nonempty value",
        "className",
      ],
      [
        '<Code source="x" language="ts" render={<pre />} />',
        "statically obvious nonfunction value",
        "<pre",
      ],
      [
        '<Code source="x" language="ts" render={<>content</>} />',
        "statically obvious nonfunction value",
        "<>",
      ],
      [
        '<Code source="x" language="ts" render={42} />',
        "statically obvious nonfunction value",
        "42",
      ],
      [
        '<Code source="x" language="ts" render="callback" />',
        "`render` must be a nonempty JSX expression",
        "render=",
      ],
      [
        '<Code source="x" language="ts" render={null} />',
        "statically obvious nonfunction value",
        "null",
      ],
      [
        '<Code source="x" language="ts" render={{}} />',
        "statically obvious nonfunction value",
        "{}",
      ],
      [
        '<Code source="x" language="ts" render={[]} />',
        "statically obvious nonfunction value",
        "[]",
      ],
      [
        '<Code source="x" language="ts" render={(`x`)} />',
        "statically obvious nonfunction value",
        "(`x`)",
      ],
      [
        '<Code source="x" language="ts" component={widget} />',
        "unknown React `Code` prop `component`",
        "component=",
      ],
    ];
    const prefix = "import { Code } from '@ferriki/core/react/macro'; ";
    for (const [jsx, message, marker] of cases) {
      const source = `${prefix}${jsx}`;
      await macroError(source, "/src/invalid-react.tsx", {
        message,
        at: prefix.length + jsx.indexOf(marker),
      });
    }

    const emptyExpression = await transformModule(
      plugin(),
      `${prefix}<Code source="x" language="ts" lineNumbers={} />`,
      "/src/invalid-react.tsx",
    ).catch((error) => error);
    expect(emptyExpression.message).toContain(
      "JSX attributes must only be assigned a non-empty 'expression'",
    );

    await macroError(
      `${prefix}<Code source="x" language="ts" render={Code} />`,
      "/src/react-binding.tsx",
      { message: "React Code binding" },
    );
    await macroError(
      "import { code as InlineCode } from '@ferriki/core/macro'; import { Code } from '@ferriki/core/react/macro'; <Code source=\"x\" language=\"ts\" className={InlineCode} />",
      "/src/react-other-binding.tsx",
      { message: "code binding must be used as a direct function call", at: "InlineCode} />" },
    );
    await macroError(`${prefix}Code({ source: "x", language: "ts" });`, "/src/react-call.tsx", {
      message: "React Code binding must be used as a direct self-closing JSX element",
      at: prefix.length,
    });
  });

  it("leaves lowercase JSX intrinsics outside React macro analysis", async () => {
    const source =
      'import { Code as code } from \'@ferriki/core/react/macro\'; const view = <code source="x" language="text">ordinary intrinsic</code>;';
    const result = await transformModule(plugin(), source, "/src/intrinsic.jsx");
    expect(result.code).toBe(
      ' const view = <code source="x" language="text">ordinary intrinsic</code>;',
    );
  });

  it("enforces React macro import constraints and keeps type-only forms", async () => {
    const cases = [
      ["import Code from '@ferriki/core/react/macro';", "default imports"],
      ["import * as macros from '@ferriki/core/react/macro';", "namespace imports"],
      ["import '@ferriki/core/react/macro';", "side-effect imports"],
      ["import { code } from '@ferriki/core/react/macro';", "limited to the named `Code` export"],
      [
        "export { Code } from '@ferriki/core/react/macro';",
        "re-exports from Ferriki macro subpaths",
      ],
      ["void import('@ferriki/core/react/macro');", "dynamic imports from Ferriki macro subpaths"],
      [
        "require('@ferriki/core/react/macro');",
        "CommonJS `require()` from a Ferriki macro subpath",
      ],
      [
        "import reactMacro = require('@ferriki/core/react/macro');",
        "`import = require(...)` from `@ferriki/core/react/macro`",
      ],
    ];
    for (const [source, message] of cases)
      await macroError(source, "/src/react-imports.tsx", { message });

    await expect(
      transformModule(
        plugin(),
        "import type { CodeProps } from '@ferriki/core/react/macro'; export type { CodeProps as Props } from '@ferriki/core/react/macro';",
        "/src/react-types.tsx",
      ),
    ).resolves.toBeNull();
  });
});
