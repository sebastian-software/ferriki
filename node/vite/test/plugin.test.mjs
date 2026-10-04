import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "@babel/parser";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { fromHtml } from "hast-util-from-html";
import { build, createServer, transformWithEsbuild } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { finalCodeText, scrollCodeBlockFromKey } from "../../examples/code-authoring/copy.mjs";
import { code } from "../../ferriki/macro.mjs";
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
  if (node.type === "JSXElement" && jsxTagName(node.openingElement.name) === name) return node;
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

function findJsxNodes(node, name, found = []) {
  if (!node || typeof node !== "object") return found;
  if (node.type === "JSXElement" && jsxTagName(node.openingElement.name) === name) found.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => findJsxNodes(child, name, found));
    else if (value && typeof value === "object") findJsxNodes(value, name, found);
  }
  return found;
}

function jsxTagName(node) {
  if (node?.type === "JSXIdentifier") return node.name;
  if (node?.type === "JSXMemberExpression")
    return `${jsxTagName(node.object)}.${jsxTagName(node.property)}`;
  return undefined;
}

function jsxProp(node, name) {
  return node.openingElement.attributes.find(
    (attribute) => attribute.type === "JSXAttribute" && attribute.name.name === name,
  );
}

function objectProperty(node, name) {
  return node.properties.find(
    (property) =>
      property.type === "ObjectProperty" && (property.key.name ?? property.key.value) === name,
  );
}

function findPreparedComponents(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (node.type === "JSXElement") {
    const value = jsxProp(node, "code")?.value;
    const code = value?.type === "JSXExpressionContainer" ? value.expression : undefined;
    if (code?.type === "ObjectExpression" && objectProperty(code, "html")) found.push(node);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) findPreparedComponents(child, found);
    } else if (value && typeof value === "object") {
      findPreparedComponents(value, found);
    }
  }
  return found;
}

function findPreparedBlocks(node) {
  return findPreparedComponents(node).map(
    (component) => jsxProp(component, "code").value.expression,
  );
}

function findPreparedBlock(node) {
  return findPreparedBlocks(node)[0];
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

function hastProperty(node, name) {
  const key = `data${name[0].toUpperCase()}${name.slice(1)}`;
  return node.properties?.[key] ?? node.properties?.[`data-${name}`];
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

function withoutVirtualStyles(code) {
  return code.replace(/^import "virtual:ferriki-vite\/[^\n]+";\n/gm, "");
}

describe("@ferriki/vite", () => {
  it("replaces scoped macro aliases with prepared blocks and preserves source maps", async () => {
    const source = `const before = "🧪";
import { code as renderSnippet, type PreparedCodeBlock } from "@ferriki/core/macro";
const prepared: PreparedCodeBlock = renderSnippet('const tag = "</script>";\\r\\n// λ', { language: "ts", meta: 'title="Demo" [API] {1}', lineNumbers: false });
const numbered = renderSnippet("const value = 1;", { language: "ts", meta: "showLineNumbers", lineNumbers: false });
function shadow(renderSnippet) { return renderSnippet("leave me alone", { language: "ts" }); }`;
    const plugin = ferriki({
      theme: "github-dark-default",
      styleMode: "classes",
      lineNumbers: true,
    });
    const result = await transformJsx(plugin, source, "/src/example.mts");

    expect(result.code).not.toContain("code as renderSnippet");
    expect(result.code).toMatch(
      /import type \{[^}]*PreparedCodeBlock[^}]*\} from ["']@ferriki\/core\/macro["'];/,
    );
    expect(() =>
      parse(result.code, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
    expect(result.code).toContain(
      'function shadow(renderSnippet) { return renderSnippet("leave me alone"',
    );
    expect(result.code).not.toContain("</script>");
    expect(result.map).toMatchObject({
      version: 3,
      sources: ["/src/example.mts"],
      sourcesContent: [source],
    });

    const executable = withoutVirtualStyles(result.code)
      .replace(/^import type .*;\s*$/gm, "")
      .replace("const prepared: PreparedCodeBlock =", "const prepared =");
    const { prepared, numbered } = runInNewContext(`${executable}\n({ prepared, numbered });`);
    expect(prepared.code).toBe('const tag = "</script>";\r\n// λ');
    expect(prepared.language).toBe("ts");
    expect(prepared.html).toContain("<pre");
    expect(prepared.html).toContain("<code");
    expect(prepared.html).toContain('data-title="Demo"');
    expect(prepared.html).toContain('data-label="API"');
    expect(prepared.html).toContain("&#x3C;/script>");
    expect(prepared.css).toContain(".ferriki-style-");
    expect(prepared.css).toContain(".ferriki-highlight-line");
    expect(prepared.metadata).toEqual({
      title: "Demo",
      label: "API",
      lineNumbers: false,
      highlightedLines: [1],
    });
    expect(numbered.metadata.lineNumbers).toBe(true);
    const cssId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];
    expect(cssId).toBeTruthy();
    expect(plugin.resolveId(cssId)).toBe(`\0${cssId}`);
    expect(plugin.load(`\0${cssId}`)).toContain(".ferriki-style-");
  });

  it("updates the content-addressed CSS module when macro output changes", async () => {
    const plugin = ferriki({ theme: "github-dark-default", styleMode: "classes" });
    const before = await transformJsx(
      plugin,
      `import { code } from "@ferriki/core/macro"; const value = code("const value = 42;", { language: "ts" });`,
      "/src/macro-hmr.ts",
    );
    const after = await transformJsx(
      plugin,
      `import { code } from "@ferriki/core/macro"; const value = code("function value() { return 42; }", { language: "ts" });`,
      "/src/macro-hmr.ts",
    );
    const beforeId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(before.code)?.[1];
    const afterId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(after.code)?.[1];
    expect(beforeId).not.toBe(afterId);
    expect(plugin.load(`\0${beforeId}`)).not.toBe(plugin.load(`\0${afterId}`));
  });

  it("lowers React Code macros to HTML or named and inline render callbacks", async () => {
    const source = `const before = "🧪";
import { Code as PrepareCode } from "@ferriki/core/react/macro";
export const defaultBlock = <PrepareCode source={'const tag = "</script>";\\r\\n// λ'} language="ts" meta='title="Demo" [API] {1}' lineNumbers={false} />;
function renderNamed({ code, className }) { return <section className={className} dangerouslySetInnerHTML={{ __html: code.html }} />; }
export const namedBlock = <PrepareCode source={\`console.log("named");\\n\`} language="js" render={renderNamed} />;
export const customBlock = <PrepareCode source={\`console.log("custom");\\n\`} language="js" meta="showLineNumbers" lineNumbers={false} className={currentClassName()} render={({ code, ...props }) => <section {...props} data-language={code.language} dangerouslySetInnerHTML={{ __html: code.html }} />} />;
export function shadow(PrepareCode) { return <PrepareCode source={getSource()} language="ts" />; }`;
    const plugin = ferriki({
      theme: "github-dark-default",
      styleMode: "classes",
      lineNumbers: true,
    });
    const result = await transformJsx(plugin, source, "/src/react-code.tsx");

    expect(result.code).not.toContain("@ferriki/core/react/macro");
    expect(result.code).not.toContain('from "react"');
    expect(result.code).toContain(
      'export function shadow(PrepareCode) { return <PrepareCode source={getSource()} language="ts" />; }',
    );
    const ast = parse(result.code, { sourceType: "module", plugins: ["jsx", "typescript"] });
    const fallback = findJsx(ast, "div");
    expect(fallback.openingElement.attributes.map((attribute) => attribute.name.name)).toEqual([
      "dangerouslySetInnerHTML",
    ]);
    const fallbackHtml = jsxProp(fallback, "dangerouslySetInnerHTML").value.expression.properties[0]
      .value.value;
    const fallbackTree = fromHtml(fallbackHtml, { fragment: true });
    const fallbackPre = findHast(
      fallbackTree,
      (node) => node.type === "element" && node.tagName === "pre",
    );
    const fallbackCode = findHast(
      fallbackTree,
      (node) => node.type === "element" && node.tagName === "code",
    );
    expect(fallbackHtml).toContain("<pre");
    expect(hastProperty(fallbackPre, "title")).toBe("Demo");
    expect(hastProperty(fallbackPre, "label")).toBe("API");
    expect(hastText(fallbackCode)).toBe('const tag = "</script>";\n// λ');
    expect(
      findHast(
        fallbackTree,
        (node) => node.type === "element" && hastProperty(node, "ln") !== undefined,
      ),
    ).toBeUndefined();
    expect(result.code).not.toContain("</script>");

    const preparedComponents = findPreparedComponents(ast);
    const preparedDescriptors = preparedComponents.map(
      (component) => jsxProp(component, "code").value.expression,
    );
    expect(preparedDescriptors).toHaveLength(2);
    const [namedDescriptor, customDescriptor] = preparedDescriptors;
    expect(objectProperty(namedDescriptor, "code").value.value).toBe('console.log("named");\n');
    expect(objectProperty(customDescriptor, "code").value.value).toBe('console.log("custom");\n');
    expect(objectProperty(customDescriptor, "language").value.value).toBe("js");
    expect(
      preparedComponents[0].openingElement.attributes.map((attribute) => attribute.name.name),
    ).toEqual(["code", "render"]);
    expect(
      preparedComponents[1].openingElement.attributes.map((attribute) => attribute.name.name),
    ).toEqual(["code", "className", "render"]);
    const sections = findJsxNodes(ast, "section");
    expect(sections).toHaveLength(2);
    expect(
      sections[1].openingElement.attributes.some(
        (attribute) => attribute.type === "JSXSpreadAttribute",
      ),
    ).toBe(true);
    expect(
      sections[1].openingElement.attributes.some(
        (attribute) => attribute.name?.name === "data-language",
      ),
    ).toBe(true);

    const customMetadata = objectProperty(customDescriptor, "metadata").value;
    expect(objectProperty(customMetadata, "lineNumbers").value.value).toBe(true);
    expect(objectProperty(customDescriptor, "css").value.value).toContain(".ferriki-style-");
    expect(result.code).toContain("currentClassName()");
    const cssId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];
    expect(cssId).toBeTruthy();
    expect(plugin.resolveId(cssId)).toBe(`\0${cssId}`);
    expect(plugin.load(`\0${cssId}`)).toContain(".ferriki-style-");
    expect(result.map).toMatchObject({
      version: 3,
      sources: ["/src/react-code.tsx"],
      sourcesContent: [source],
    });
  });

  it("reports unsupported React Code element forms", async () => {
    const cases = [
      ['<PrepareCode source={readSource()} language="ts" />', /source.*literal|static source/i],
      ['<PrepareCode source="const value = 1;" language="ts" {...props} />', /spread/i],
      [
        '<PrepareCode source="const value = 1;" language="ts" title="Demo" />',
        /unknown.*prop|unsupported.*prop/i,
      ],
      [
        '<PrepareCode source="const value = 1;" language="ts">children</PrepareCode>',
        /self-closing|children/i,
      ],
      [
        '<PrepareCode source="const value = 1;" language="ts" render={<span />} />',
        /render.*function|render.*JSX|JSX.*render/i,
      ],
    ];

    for (const [element, diagnostic] of cases) {
      const source = `import { Code as PrepareCode } from "@ferriki/core/react/macro";\n${element}`;
      await expect(
        transformJsx(ferriki({ theme: "github-dark-default" }), source, "/src/invalid.tsx"),
      ).rejects.toThrow(diagnostic);
    }
  });

  it("preserves React callback descriptors and JSX literal className entity decoding", async () => {
    const classNameLiteral = 'className="syntax &amp; &#x1F680;"';
    const elements = [
      {
        element: '<MacroCode source="x &amp; &#x1F680;" language="text" render={CodeBlock} />',
        expected: "x & 🚀",
      },
      {
        element: "<MacroCode source={'x &amp; &#x1F680;'} language=\"text\" render={CodeBlock} />",
        expected: "x &amp; &#x1F680;",
      },
      {
        element: '<MacroCode source="&amp;lt;" language="text" render={CodeBlock} />',
        expected: "&lt;",
      },
      {
        element: '<MacroCode source="x &unknownEntity; y" language="text" render={CodeBlock} />',
        expected: "x &unknownEntity; y",
      },
      {
        element:
          '<MacroCode source="  leading  and trailing  " language="text" render={CodeBlock} />',
      },
      {
        element: '<MacroCode source="first\n  middle\nlast " language="text" render={CodeBlock} />',
      },
      {
        element: '<MacroCode source="first\r\n  second " language="text" render={CodeBlock} />',
      },
    ];
    const plugin = ferriki({ theme: "github-dark-default" });

    for (const [index, { element, expected }] of elements.entries()) {
      const parsedInput = parse(element, { sourceType: "module", plugins: ["jsx"] });
      const inputProp = jsxProp(findJsx(parsedInput, "MacroCode"), "source").value;
      const parsedValue =
        inputProp.type === "StringLiteral" ? inputProp.value : inputProp.expression.value;
      expect(parsedValue).toBe(expected ?? parsedValue);

      const source = `import { Code as MacroCode } from "@ferriki/core/react/macro";\nfunction CodeBlock(props) { return props.code; }\n${element}`;
      const result = await transformJsx(plugin, source, `/src/entities-${index}.tsx`);
      const ast = parse(result.code, { sourceType: "module", plugins: ["jsx", "typescript"] });
      const descriptor = findPreparedBlock(ast);
      expect(objectProperty(descriptor, "code").value.value).toBe(parsedValue);
    }

    const staticClass = `<MacroCode source="x" language="text" ${classNameLiteral} />`;
    const staticResult = await transformJsx(
      plugin,
      `import { Code as MacroCode } from "@ferriki/core/react/macro";\n${staticClass}`,
      "/src/class-entity.tsx",
    );
    const staticAst = parse(staticResult.code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
    const wrapper = findJsx(staticAst, "div");
    expect(jsxProp(wrapper, "className").value.value).toBe("syntax & 🚀");
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
    const result = await transformJsx(
      ferriki({ theme: "github-dark-default" }),
      source,
      "/src/order.tsx",
    );
    const executable = await transformWithEsbuild(
      withoutVirtualStyles(result.code),
      "/src/order.tsx",
      {
        loader: "tsx",
        jsx: "transform",
        jsxFactory: "jsx",
      },
    );
    const evaluated = runInNewContext(executable.code, {
      jsx: (type, props) => ({ type, props }),
    });

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

  it("maps renderer expressions back to their original source locations", async () => {
    const source = `import { Code as PrepareCode } from "@ferriki/core/react/macro";
const marker = "🧪";
const block = <PrepareCode source="x" language="text" render={({ code }) => {
  return marker + code.language;
}} />;`;
    const id = "/src/render-map.tsx";
    const result = await transformJsx(ferriki({ theme: "github-dark-default" }), source, id);
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

  it("retains nested macro and static JSX edits inside a renderer expression", async () => {
    const source = `import { Code as PrepareCode } from "@ferriki/core/react/macro";
const block = <PrepareCode source="outer" language="text" render={({ code }) => <section>
  <pre data-highlight="auto" data-language="ts"><code>const staticλ = 1;</code></pre>
  <PrepareCode source="inner" language="text" render={({ code: inner }) => inner.code} />
  {code.code}
</section>} />;`;
    const result = await transformJsx(
      ferriki({ theme: "github-dark-default" }),
      source,
      "/src/nested.tsx",
    );

    expect(() =>
      parse(result.code, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
    expect(result.code).not.toContain("<PrepareCode");
    expect(result.code).toContain('className={"shiki github-dark-default"}');
    expect(result.code).toContain('className={"line"}');
    expect(result.code).toContain("staticλ");
    expect(result.code).toContain('"language":"text"');
    expect(result.map.sourcesContent).toEqual([source]);
  });

  it("uses the default wrapper when a runtime renderer value is undefined", async () => {
    const source = `import { Code as PrepareCode } from "@ferriki/core/react/macro";
const value = <PrepareCode source="fallback" language="text" className={chooseClassName()} render={undefined} />;
value;`;
    const result = await transformJsx(
      ferriki({ theme: "github-dark-default" }),
      source,
      "/src/undefined-render.tsx",
    );
    const executable = await transformWithEsbuild(
      withoutVirtualStyles(result.code),
      "/src/undefined-render.tsx",
      {
        loader: "tsx",
        jsx: "transform",
        jsxFactory: "jsx",
      },
    );
    let classNameReads = 0;
    const evaluated = runInNewContext(executable.code, {
      chooseClassName: () => {
        classNameReads++;
        return "syntax";
      },
      jsx: (type, props) => ({ type, props }),
    });

    expect(classNameReads).toBe(1);
    expect(evaluated.type.name).toBe("FerrikiMacroRenderHelper");
    const fallback = evaluated.type(evaluated.props);
    expect(fallback.type).toBe("div");
    expect(fallback.props.className).toBe("syntax");
    expect(fallback.props.dangerouslySetInnerHTML.__html).toContain("fallback");
    expect(result.code.match(/"html":/g)).toHaveLength(1);
  });

  it("recognizes escaped macro specifiers and reports dynamic macro uses", async () => {
    const escaped = String.raw`import { code as prepare } from "@ferriki/core/\u006dacro";
const prepared = prepare("const value = 1;", { language: "ts" });`;
    const result = await transformJsx(ferriki({ theme: "github-dark-default" }), escaped);
    expect(result.code).not.toContain("@ferriki/core/");
    expect(result.code).toContain('language":"ts"');

    const escapedPrefix = String.raw`import { code as prepare } from "\u0040ferriki/core/macro";
const prepared = prepare("const value = 2;", { language: "ts" });`;
    const prefixResult = await transformJsx(
      ferriki({ theme: "github-dark-default" }),
      escapedPrefix,
    );
    expect(prefixResult.code).not.toContain("\\u0040ferriki");
    expect(prefixResult.code).toContain('language":"ts"');

    const escapedVariants = [
      String.raw`"\x40ferriki\/core\/\macro"`,
      String.raw`"\u{00000040}ferriki/core/macro"`,
      `"@ferriki/core/ma\\${String.fromCharCode(10)}cro"`,
    ];
    for (const [index, specifier] of escapedVariants.entries()) {
      const variant = `import { code } from ${specifier};\nconst prepared = code("const value = ${index + 3};", { language: "ts" });`;
      const variantResult = await transformJsx(
        ferriki({ theme: "github-dark-default" }),
        variant,
        `/src/escaped-${index}.ts`,
      );
      expect(variantResult.code).not.toContain("@ferriki/core/macro");
      expect(variantResult.code).toContain('language":"ts"');
    }

    const invalid = `import { code } from "@ferriki/core/macro";
const source = "const value = 1;";
const prepared = code(source, { language: "ts" });`;
    await expect(
      transformJsx(ferriki({ theme: "github-dark-default" }), invalid, "/src/invalid.cts"),
    ).rejects.toThrow(/macro|static|code/i);

    const dynamicWithOptions = 'void import(`@ferriki/core/macro`, { with: { type: "json" } });';
    await expect(
      transformJsx(
        ferriki({ theme: "github-dark-default" }),
        dynamicWithOptions,
        "/src/dynamic-import.ts",
      ),
    ).rejects.toThrow(/dynamic imports/);

    for (const dynamicRequire of [
      "require(`@ferriki/core/macro`);",
      "require('@ferriki/core/macro', 'extra');",
      "require?.('@ferriki/core/macro');",
    ]) {
      await expect(
        transformJsx(ferriki({ theme: "github-dark-default" }), dynamicRequire, "/src/require.ts"),
      ).rejects.toThrow(/CommonJS `require\(\)`/);
    }
  });

  it("does not load the native addon for macro-free escaped source", () => {
    const bridgeUrl = new URL("../../ferriki/macro-transform.mjs", import.meta.url).href;
    const source = String.raw`const pattern = /\d+/; const value = "line\n";`;
    const script = `
      Object.defineProperty(process, "arch", { value: "unsupported" });
      const { findInlineCodeMacros } = await import(${JSON.stringify(bridgeUrl)});
      const plan = findInlineCodeMacros(${JSON.stringify(source)});
      process.stdout.write(JSON.stringify(plan));
    `;

    const result = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    });
    expect(result).toBe('{"calls":[],"imports":[]}');
  });

  it("does not load the native addon when macro text appears only in comments and strings", () => {
    const viteUrl = new URL("../index.mjs", import.meta.url).href;
    const source = String.raw`// Documentation mentions @ferriki/core/macro.
const example = "@ferriki/core/macro";
const pattern = /\d+\\w+/;`;
    const script = `
      Object.defineProperty(process, "arch", { value: "unsupported" });
      const { ferriki } = await import(${JSON.stringify(viteUrl)});
      const result = await ferriki().transform.call({ warn() {} }, ${JSON.stringify(source)}, "/src/ordinary.ts");
      if (result !== null) throw new Error("the ordinary module should remain unchanged");
      process.stdout.write("null");
    `;

    const result = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    });
    expect(result).toBe("null");
  });

  it("transforms macros in included compiler-emitted modules and skips macro-free scripts", async () => {
    const macroFreePlugin = ferriki({
      theme: "not-a-real-theme",
      assets: { remote: false, cacheDir: join(tmpdir(), "ferriki-no-macro-assets") },
    });
    await expect(
      transformJsx(macroFreePlugin, 'const untouched = "🧪";', "/src/no-macro.cts"),
    ).resolves.toBeNull();

    const includedPlugin = ferriki({
      theme: "github-dark-default",
      include: (id) => id.includes("virtual:markdown"),
    });
    const source = `import { code as prepare } from "@ferriki/core/macro";
const snippet = prepare("const mdx = 1;", { language: "ts" });`;
    const result = await transformJsx(includedPlugin, source, "\0virtual:markdown/page.mdx");
    expect(result).toBeTruthy();
    expect(result.code).not.toContain("@ferriki/core/macro");
    expect(result.code).toContain("const mdx = 1;");
    expect(result.map.sources).toEqual(["\0virtual:markdown/page.mdx"]);
  });

  it("warns for unknown macro languages and emits explicitly escaped plain HTML", async () => {
    const source = `import { code } from "@ferriki/core/macro";
const prepared = code('const markup = "<script>";', { language: "not-a-real-language" });`;
    const warnings = [];
    const result = await transformJsx(
      ferriki({ theme: "github-dark-default" }),
      source,
      "/src/fallback.cts",
      warnings,
    );
    const prepared = runInNewContext(`${withoutVirtualStyles(result.code)}\nprepared;`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not-a-real-language");
    expect(prepared.code).toBe('const markup = "<script>";');
    expect(prepared.language).toBe("not-a-real-language");
    expect(prepared.html).toContain("&#x3C;script>");
  });

  it("throws when the browser macro entry is executed without a build transform", () => {
    expect(() => code("const value = 1;", { language: "ts" })).toThrow(
      /compile-time macro.*@ferriki\/vite/,
    );
  });

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
