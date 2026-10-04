import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parse as parseJs } from "@babel/parser";
import { createHighlighter, ShikiError } from "@ferriki/core";
import { findInlineCodeMacros } from "@ferriki/core/macro-transform";
import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import MagicString from "magic-string";

const VIRTUAL_CSS_PREFIX = "virtual:ferriki-vite/";
const MACRO_MODULES = new Set(["@ferriki/core/macro", "@ferriki/core/react/macro"]);
const LINE_CSS = [
  ".ferriki-highlight-line[data-ln]::before{content:attr(data-ln);display:inline-block;min-width:2.5em;margin-right:1.5em;padding-right:.75em;text-align:right;opacity:.55}",
  ".ferriki-highlight-line.highlighted{background:color-mix(in srgb,currentColor 10%,transparent)}",
].join("\n");

const DEFAULT_THEME = "github-dark-default";

/**
 * Highlight opted-in HTML and intrinsic JSX blocks before the framework lowers JSX.
 * @param {import("./index.d.mts").FerrikiViteOptions} options
 * @returns {import("vite").Plugin} A plugin that highlights explicitly marked HTML and JSX blocks.
 */
export function ferriki(options = {}) {
  if (options.theme && options.themes)
    throw new TypeError("Pass either `theme` or `themes`, not both");
  if (options.transformers !== undefined && !Array.isArray(options.transformers))
    throw new ShikiError("`transformers` option must be an array", "ERR_USAGE");

  const theme = options.theme ?? (options.themes ? undefined : DEFAULT_THEME);
  const themes = options.themes;
  if (themes && Object.keys(themes).length === 0)
    throw new ShikiError("`themes` option must not be empty", "ERR_USAGE");
  const styleMode = options.styleMode ?? "inline";
  const lineNumbers = options.lineNumbers ?? false;
  const transformers = [...(options.transformers ?? [])];
  const themeNames = themes ? [...new Set(Object.values(themes))] : [theme];
  let highlighterPromise;
  const languageLoads = new Map();
  const virtualCss = new Map();
  const warnedFiles = new Set();

  function getHighlighter() {
    highlighterPromise ??= createHighlighter({ themes: themeNames, assets: options.assets });
    return highlighterPromise;
  }

  function warnOnce(context, id, language, cause) {
    const key = id.split("?", 1)[0];
    if (warnedFiles.has(key)) return;
    warnedFiles.add(key);
    context.warn(
      `Ferriki could not highlight language "${language}" in ${id}; keeping the block as plain code (${cause?.message ?? "unknown language"}).`,
    );
  }

  async function highlight(context, id, code, language, rawMeta, settings = {}) {
    const highlighter = await getHighlighter();
    const meta = parseMeta(rawMeta);
    const effectiveLineNumbers = settings.lineNumbers ?? lineNumbers;
    let loading = languageLoads.get(language);
    if (!loading) {
      loading = Promise.resolve().then(() => highlighter.loadLanguage(language));
      languageLoads.set(language, loading);
    }
    try {
      await loading;
    } catch (error) {
      languageLoads.delete(language);
      if (error?.code === "ERR_UNSUPPORTED") {
        warnOnce(context, id, language, error);
        return settings.plainOnUnknown
          ? {
              root: plainCodeRoot(code, language, meta, effectiveLineNumbers),
              css: "",
              plain: true,
            }
          : undefined;
      }
      throw error;
    }

    const transformer = createMetaTransformer(meta, effectiveLineNumbers);
    const highlightOptions = {
      lang: language,
      ...(themes ? { themes, defaultColor: Object.keys(themes)[0] } : { theme }),
      styleMode,
      transformers: [...transformers, transformer],
    };
    try {
      if (styleMode === "classes") {
        const result = highlighter.codeToHtmlWithCss(code, highlightOptions);
        return { root: parseHighlightedHtml(result.html), css: result.css };
      }
      return {
        root: parseHighlightedHtml(highlighter.codeToHtml(code, highlightOptions)),
        css: "",
      };
    } catch (error) {
      if (error?.code === "ERR_UNSUPPORTED") {
        warnOnce(context, id, language, error);
        return settings.plainOnUnknown
          ? {
              root: plainCodeRoot(code, language, meta, effectiveLineNumbers),
              css: "",
              plain: true,
            }
          : undefined;
      }
      throw error;
    }
  }

  function makeCssModule(css) {
    const id = `${VIRTUAL_CSS_PREFIX}${createHash("sha256").update(css).digest("hex")}.css`;
    virtualCss.set(id, css);
    return id;
  }

  return {
    name: "@ferriki/vite",
    enforce: "pre",

    resolveId(id) {
      if (id.startsWith(VIRTUAL_CSS_PREFIX) && virtualCss.has(id)) return `\0${id}`;
      return null;
    },

    load(id) {
      if (id.startsWith("\0")) return virtualCss.get(id.slice(1)) ?? null;
      return null;
    },

    transformIndexHtml: {
      order: "pre",
      async handler(html, ctx) {
        const context = this;
        const filename = ctx?.filename ?? ctx?.path ?? "index.html";
        const result = await transformHtml(html, async (code, lang, meta) =>
          highlight(context, filename, code, lang, meta),
        );
        if (!result.changed) return null;
        const css = [result.css, result.needsLineCss ? LINE_CSS : ""].filter(Boolean).join("\n");
        return {
          html: result.html,
          tags: css
            ? [
                {
                  tag: "style",
                  attrs: { "data-ferriki-vite": "" },
                  children: css,
                  injectTo: "head",
                },
              ]
            : [],
        };
      },
    },

    async transform(source, id) {
      const path = id.split("?", 1)[0];
      const isJsx = /\.(?:jsx|tsx)$/.test(path);
      const isScript = /\.[cm]?[jt]sx?$/.test(path);
      const included = Boolean(options.include?.(id));
      if (!(isScript || included)) return null;
      const context = this;
      const result =
        isJsx || included
          ? await transformJsx(source, id, async (code, lang, meta) =>
              highlight(context, id, code, lang, meta),
            )
          : { changed: false, magic: new MagicString(source), css: "", needsLineCss: false };
      const macroPlan =
        (isScript || included) && hasMacroModuleReference(source)
          ? findInlineCodeMacros(source, path)
          : { calls: [], imports: [] };
      const macroCss = new Set();
      let macroChanged = false;
      if (macroPlan.calls.length) {
        const byteToIndex = makeByteOffsetMap(source);
        for (const call of macroPlan.calls) {
          const meta = parseMeta(call.meta ?? "");
          // A call-level setting replaces the Vite default, while an explicit
          // showLineNumbers annotation remains an opt-in in its own right.
          const effectiveLineNumbers = meta.lineNumbers || (call.lineNumbers ?? lineNumbers);
          const rendered = await highlight(context, id, call.code, call.language, call.meta ?? "", {
            lineNumbers: effectiveLineNumbers,
            plainOnUnknown: true,
          });
          const descriptorCss = [
            rendered.css,
            effectiveLineNumbers || meta.highlightedLines.size ? LINE_CSS : "",
          ]
            .filter(Boolean)
            .join("\n");
          const descriptor = createPreparedCodeBlock(
            call.code,
            call.language,
            rendered.root,
            descriptorCss,
            meta,
            effectiveLineNumbers,
          );
          result.magic.overwrite(
            byteToIndex(call.start),
            byteToIndex(call.end),
            lowerMacroCall(call, descriptor),
          );
          if (descriptorCss) macroCss.add(descriptorCss);
          macroChanged = true;
        }
        for (const item of macroPlan.imports) {
          result.magic.overwrite(byteToIndex(item.start), byteToIndex(item.end), item.replacement);
          macroChanged = true;
        }
      }
      if (!result.changed && !macroChanged) return null;

      const css = [
        ...new Set([result.css, ...macroCss, result.needsLineCss ? LINE_CSS : ""].filter(Boolean)),
      ].join("\n");
      if (css) {
        const cssId = makeCssModule(css);
        result.magic.append(`\nimport ${JSON.stringify(cssId)};\n`);
      }
      return {
        code: result.magic.toString(),
        map: result.magic.generateMap({ hires: true, includeContent: true, source: id }),
      };
    },
  };
}

function createMetaTransformer(meta, defaultLineNumbers) {
  const addClass = (node, name) => {
    const existing = node.properties.className;
    const classes = Array.isArray(existing)
      ? existing
      : typeof existing === "string"
        ? existing.split(/\s+/)
        : [];
    node.properties.className = [...new Set([...classes.filter(Boolean), name])];
  };
  return {
    name: "ferriki-vite-metadata",
    pre(node) {
      if (meta.title !== undefined) node.properties["data-title"] = meta.title;
      if (meta.label !== undefined) node.properties["data-label"] = meta.label;
    },
    line(node, line) {
      if (defaultLineNumbers || meta.lineNumbers) node.properties["data-ln"] = line;
      if (meta.highlightedLines.has(line)) addClass(node, "highlighted");
      if (defaultLineNumbers || meta.lineNumbers || meta.highlightedLines.size)
        addClass(node, "ferriki-highlight-line");
    },
  };
}

function parseMeta(raw = "") {
  const titleMatch = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)')/.exec(raw);
  const title = titleMatch?.[1] ?? titleMatch?.[2];
  const rest = titleMatch
    ? `${raw.slice(0, titleMatch.index)} ${raw.slice(titleMatch.index + titleMatch[0].length)}`
    : raw;
  const label = /\[([^\]]+)\]/.exec(rest)?.[1]?.trim();
  const selection = /(?:^|\s)\{([\d,-]+)\}(?=\s|$)/.exec(rest)?.[1];
  const highlightedLines = new Set();
  if (selection) {
    for (const part of selection.split(",")) {
      const [first, last = first] = part.split("-").map(Number);
      if (first < 1 || last < first || last > 10000) continue;
      for (let line = first; line <= last; line++) highlightedLines.add(line);
    }
  }
  return {
    title,
    label,
    highlightedLines,
    lineNumbers: /(?:^|\s)showLineNumbers(?:\s|$)/.test(rest),
  };
}

function plainCodeRoot(code, language, meta, lineNumbers) {
  const preProperties = { className: ["shiki"] };
  if (meta.title !== undefined) preProperties.dataTitle = meta.title;
  if (meta.label !== undefined) preProperties.dataLabel = meta.label;
  const codeProperties = { className: [`language-${language}`] };
  const annotated = lineNumbers || meta.highlightedLines.size > 0;
  const lines = code.split("\n");
  const children = annotated
    ? lines.flatMap((line, index) => {
        const number = index + 1;
        const classes = ["ferriki-highlight-line"];
        if (meta.highlightedLines.has(number)) classes.push("highlighted");
        const properties = { className: classes };
        if (lineNumbers) properties.dataLn = String(number);
        const nodes = [
          {
            type: "element",
            tagName: "span",
            properties,
            children: [{ type: "text", value: line }],
          },
        ];
        if (index < lines.length - 1) nodes.push({ type: "text", value: "\n" });
        return nodes;
      })
    : [{ type: "text", value: code }];
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: preProperties,
        children: [
          {
            type: "element",
            tagName: "code",
            properties: codeProperties,
            children,
          },
        ],
      },
    ],
  };
}

function createPreparedCodeBlock(code, language, root, css, meta, lineNumbers) {
  const highlightedLines = [...meta.highlightedLines];
  const metadata = {
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    lineNumbers,
    highlightedLines,
  };
  return { code, language, html: toHtml(root), css, metadata };
}

function safeJsLiteral(value) {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (character) => {
    if (character === "<") return "\\u003c";
    return character === "\u2028" ? "\\u2028" : "\\u2029";
  });
}

function makeByteOffsetMap(source) {
  const offsets = new Map([[0, 0]]);
  let byteOffset = 0;
  let sourceOffset = 0;
  while (sourceOffset < source.length) {
    const codePoint = source.codePointAt(sourceOffset);
    const character = String.fromCodePoint(codePoint);
    byteOffset += Buffer.byteLength(character, "utf8");
    sourceOffset += character.length;
    offsets.set(byteOffset, sourceOffset);
  }
  return (offset) => {
    const result = offsets.get(offset);
    if (result === undefined) {
      throw new RangeError(`Ferriki returned a non-boundary UTF-8 source offset: ${offset}`);
    }
    return result;
  };
}

function parseHighlightedHtml(html) {
  return fromHtml(html, { fragment: true });
}

function property(node, name) {
  const key = `data${name[0].toUpperCase()}${name.slice(1)}`;
  return node.properties?.[key] ?? node.properties?.[`data-${name}`];
}

function elementChildren(node, tagName) {
  return (node.children ?? []).filter(
    (child) => child.type === "element" && child.tagName === tagName,
  );
}

function directTextContent(node) {
  if (!Array.isArray(node.children) || node.children.some((child) => child.type !== "text"))
    return undefined;
  return node.children.map((child) => child.value).join("");
}

function mergeProperties(original = {}, rendered = {}) {
  const merged = { ...rendered, ...original };
  const classes = [original.className, rendered.className]
    .flatMap((value) =>
      Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [],
    )
    .filter(Boolean);
  if (classes.length) merged.className = [...new Set(classes)];
  if (original.style && rendered.style) merged.style = `${rendered.style};${original.style}`;
  else if (original.style || rendered.style) merged.style = original.style ?? rendered.style;
  return merged;
}

async function transformHtml(source, render) {
  let tree;
  try {
    tree = fromHtml(source, { fragment: true, verbose: true });
  } catch {
    return { html: source, css: "", changed: false, needsLineCss: false };
  }
  const magic = new MagicString(source);
  const css = new Set();
  let changed = false;
  let needsLineCss = false;
  const targets = [];
  visitHast(tree, (node) => {
    if (node.tagName === "pre" && property(node, "highlight") === "auto") targets.push(node);
  });
  for (const pre of targets) {
    const codes = elementChildren(pre, "code");
    if (codes.length !== 1) continue;
    const code = codes[0];
    const value = directTextContent(code);
    const language = property(pre, "language");
    if (value === undefined || typeof language !== "string" || !language) continue;
    const rawMeta = property(pre, "meta");
    const rendered = await render(value, language, typeof rawMeta === "string" ? rawMeta : "");
    if (!rendered) continue;
    const renderedPre = elementChildren(rendered.root, "pre")[0];
    const renderedCode = renderedPre && elementChildren(renderedPre, "code")[0];
    const position = pre.data?.position;
    const start = position?.opening?.start?.offset;
    const end = position?.closing?.end?.offset;
    if (!renderedPre || !renderedCode || !Number.isInteger(start) || !Number.isInteger(end))
      continue;
    const output = structuredClone(pre);
    const outputCode = elementChildren(output, "code")[0];
    output.properties = mergeProperties(output.properties, renderedPre.properties);
    outputCode.properties = mergeProperties(outputCode.properties, renderedCode.properties);
    outputCode.children = renderedCode.children;
    magic.overwrite(start, end, toHtml(output));
    if (rendered.css) css.add(rendered.css);
    needsLineCss ||= /data-ln|highlighted/.test(toHtml(renderedPre));
    changed = true;
  }
  return {
    html: changed ? magic.toString() : source,
    css: [...css].join("\n"),
    changed,
    needsLineCss,
  };
}

function visitHast(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type === "element") visit(node);
  for (const child of node.children ?? []) visitHast(child, visit);
}

async function transformJsx(source, id, render) {
  let ast;
  try {
    ast = parseJs(source, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
  } catch {
    return { changed: false, magic: new MagicString(source), css: "", needsLineCss: false };
  }
  const magic = new MagicString(source);
  const css = new Set();
  let changed = false;
  let needsLineCss = false;
  const candidates = [];
  visitAst(ast, (node) => {
    if (node.type !== "JSXElement" || jsxName(node.openingElement.name) !== "pre") return;
    candidates.push(node);
  });
  for (const pre of candidates) {
    const preProps = staticAttributes(pre.openingElement);
    if (!preProps || preProps.get("data-highlight") !== "auto") continue;
    if (
      !staticProtocolAttribute(pre.openingElement, "data-highlight") ||
      !staticProtocolAttribute(pre.openingElement, "data-language")
    )
      continue;
    if (!staticProtocolAttribute(pre.openingElement, "data-meta")) continue;
    const language = preProps.get("data-language");
    if (typeof language !== "string" || !language) continue;
    const codeNodes = pre.children.filter(
      (child) => child.type === "JSXElement" && jsxName(child.openingElement.name) === "code",
    );
    if (
      codeNodes.length !== 1 ||
      pre.children.some((child) => child !== codeNodes[0] && child.type !== "JSXText")
    )
      continue;
    const code = codeNodes[0];
    const codeProps = staticAttributes(code.openingElement);
    if (!codeProps) continue;
    if (
      !safeGeneratedAttributes(pre.openingElement) ||
      !safeGeneratedAttributes(code.openingElement)
    )
      continue;
    const codeText = staticJsxChildren(code.children);
    if (codeText === undefined) continue;
    const result = await render(codeText, language, preProps.get("data-meta") ?? "");
    if (!result) continue;
    const renderedPre = elementChildren(result.root, "pre")[0];
    const renderedCode = renderedPre && elementChildren(renderedPre, "code")[0];
    if (!renderedCode) continue;
    const generatedChildren = renderedCode.children.map(toJsx).join("");
    const codeOpenEnd = code.openingElement.end;
    const codeCloseStart = code.closingElement?.start;
    if (!Number.isInteger(codeCloseStart)) continue;
    magic.overwrite(codeOpenEnd, codeCloseStart, generatedChildren);
    addGeneratedJsxAttributes(magic, pre.openingElement, renderedPre.properties);
    addGeneratedJsxAttributes(magic, code.openingElement, renderedCode.properties);
    if (result.css) css.add(result.css);
    needsLineCss ||= /data-ln|highlighted/.test(toHtml(renderedPre));
    changed = true;
  }
  return { changed, magic, css: [...css].join("\n"), needsLineCss };
}

function visitAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "comments" || key === "tokens") continue;
    if (Array.isArray(value)) for (const child of value) visitAst(child, visit);
    else if (value && typeof value === "object" && typeof value.type === "string")
      visitAst(value, visit);
  }
}

function hasMacroModuleReference(source) {
  if (
    !source.includes("@ferriki/core/macro") &&
    !source.includes("@ferriki/core/react/macro") &&
    !source.includes("\\")
  )
    return false;

  let ast;
  try {
    ast = parseJs(source, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
  } catch {
    // Let the native scanner report syntax diagnostics when source text could
    // contain a macro module reference but Babel cannot build an AST.
    return true;
  }

  let found = false;
  visitAst(ast, (node) => {
    if (found) return;
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type") return;
      if (
        node.specifiers?.length &&
        node.specifiers.every((specifier) => specifier.importKind === "type")
      )
        return;
      found = isMacroModuleSpecifier(node.source);
      return;
    }
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      if (node.exportKind === "type") return;
      if (
        node.type === "ExportNamedDeclaration" &&
        node.specifiers.length > 0 &&
        node.specifiers.every((specifier) => specifier.exportKind === "type")
      )
        return;
      found = isMacroModuleSpecifier(node.source);
      return;
    }
    if (node.type === "ImportExpression" && isMacroModuleSpecifier(node.source)) {
      found = true;
      return;
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Import" &&
      node.arguments.length > 0 &&
      isMacroModuleSpecifier(node.arguments[0])
    ) {
      found = true;
      return;
    }
    if (
      (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments.length > 0 &&
      isMacroModuleSpecifier(node.arguments[0])
    ) {
      found = true;
      return;
    }
    if (
      node.type === "TSImportEqualsDeclaration" &&
      node.importKind !== "type" &&
      node.moduleReference?.type === "TSExternalModuleReference" &&
      isMacroModuleSpecifier(node.moduleReference.expression)
    ) {
      found = true;
    }
  });
  return found;
}

function isMacroModuleSpecifier(node) {
  if (node?.type === "StringLiteral") return MACRO_MODULES.has(node.value);
  return (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    MACRO_MODULES.has(node.quasis[0]?.value.cooked)
  );
}

function lowerMacroCall(call, descriptor) {
  if (call.kind !== "react") return safeJsLiteral(descriptor);
  return typeof call.component === "string"
    ? `<${call.component} code={${safeJsLiteral(descriptor)}} />`
    : `<div dangerouslySetInnerHTML={{ __html: ${safeJsLiteral(descriptor.html)} }} />`;
}

function jsxName(node) {
  return node?.type === "JSXIdentifier" ? node.name : undefined;
}

function staticAttributes(opening) {
  const values = new Map();
  for (const attr of opening.attributes) {
    if (attr.type !== "JSXAttribute" || attr.name.type !== "JSXIdentifier") return undefined;
    const name = attr.name.name;
    if (values.has(name)) return undefined;
    let value;
    if (attr.value?.type === "StringLiteral") value = attr.value.value;
    else if (attr.value?.type === "JSXExpressionContainer") {
      const expression = attr.value.expression;
      if (expression.type === "StringLiteral") value = expression.value;
      else if (expression.type === "TemplateLiteral" && expression.expressions.length === 0)
        value = expression.quasis[0]?.value.cooked;
      else value = undefined;
    } else value = undefined;
    if (value !== undefined) values.set(name, value);
  }
  return values;
}

function staticProtocolAttribute(opening, name) {
  const matches = opening.attributes.filter(
    (attr) =>
      attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name,
  );
  if (matches.length > 1) return false;
  if (matches.length === 0) return true;
  const value = matches[0].value;
  return (
    value?.type === "StringLiteral" ||
    (value?.type === "JSXExpressionContainer" &&
      (value.expression.type === "StringLiteral" ||
        (value.expression.type === "TemplateLiteral" && value.expression.expressions.length === 0)))
  );
}

function staticJsxChildren(children) {
  let result = "";
  for (const child of children) {
    if (child.type === "JSXText") {
      // Babel's JSXText value has already decoded HTML character references.
      result += normalizeJsxText(child.value);
    } else if (child.type === "JSXExpressionContainer") {
      const expression = child.expression;
      if (expression.type === "StringLiteral") result += expression.value;
      else if (expression.type === "TemplateLiteral" && expression.expressions.length === 0)
        result += expression.quasis[0]?.value.cooked ?? "";
      else if (expression.type === "JSXEmptyExpression") continue;
      else return undefined;
    } else return undefined;
  }
  return result;
}

function normalizeJsxText(value) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  let lastNonEmpty = -1;
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].replace(/\t/g, " ");
    if (index !== 0) line = line.replace(/^\s+/, "");
    if (index !== lines.length - 1) line = line.replace(/\s+$/, "");
    lines[index] = line;
    if (line) lastNonEmpty = index;
  }
  return lines.map((line, index) => (line && index < lastNonEmpty ? `${line} ` : line)).join("");
}

function styleObject(style) {
  if (!style) return {};
  if (typeof style === "object") return style;
  const result = {};
  for (const declaration of String(style).split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const rawName = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (!rawName || !value) continue;
    const name = rawName.startsWith("--")
      ? rawName
      : rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[name] = value;
  }
  return result;
}

function addGeneratedJsxAttributes(magic, opening, properties = {}) {
  const generated = [];
  const attrs = opening.attributes.filter((attr) => attr.type === "JSXAttribute");
  const classValue = Array.isArray(properties.className)
    ? properties.className.join(" ")
    : properties.className;
  if (classValue) {
    const existing = attrs.find((attr) => ["class", "className"].includes(attr.name?.name));
    const staticClass = existing && staticJsxAttributeValue(existing.value);
    if (existing && staticClass !== undefined) {
      const merged = `${staticClass} ${classValue}`.trim();
      magic.overwrite(existing.value.start, existing.value.end, `{${JSON.stringify(merged)}}`);
    } else if (!existing) generated.push(`className={${JSON.stringify(classValue)}}`);
  }
  const style = styleObject(properties.style);
  if (Object.keys(style).length) {
    const existing = attrs.find((attr) => attr.name?.name === "style");
    const staticStyle = existing && staticJsxAttributeValue(existing.value);
    if (existing && staticStyle !== undefined) {
      const merged = { ...style, ...styleObject(staticStyle) };
      magic.overwrite(existing.value.start, existing.value.end, `{${JSON.stringify(merged)}}`);
    } else if (!existing) generated.push(`style={${JSON.stringify(style)}}`);
  }
  for (const [propertyName, value] of Object.entries(properties)) {
    if (["className", "style"].includes(propertyName) || value === null || value === undefined)
      continue;
    const attrName = jsxAttributeName(propertyName);
    if (attrs.some((attr) => jsxAttributeName(attr.name?.name) === attrName)) continue;
    if (Array.isArray(value)) generated.push(`${attrName}={${JSON.stringify(value.join(" "))}}`);
    else if (typeof value === "boolean") generated.push(`${attrName}={${value}}`);
    else generated.push(`${attrName}={${JSON.stringify(String(value))}}`);
  }
  if (generated.length) magic.appendLeft(opening.end - 1, ` ${generated.join(" ")}`);
}

function jsxAttributeName(name) {
  if (typeof name !== "string") return name;
  if (name.startsWith("data") && /[A-Z]/.test(name.slice(4)))
    return `data-${name
      .slice(4)
      .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      .replace(/^-/, "")}`;
  return name;
}

function staticJsxAttributeValue(value) {
  if (value?.type === "StringLiteral") return value.value;
  if (value?.type === "JSXExpressionContainer") {
    const expression = value.expression;
    if (expression.type === "StringLiteral") return expression.value;
    if (expression.type === "TemplateLiteral" && expression.expressions.length === 0)
      return expression.quasis[0]?.value.cooked;
  }
  return undefined;
}

function safeGeneratedAttributes(opening) {
  const classAttrs = opening.attributes.filter(
    (attr) => attr.type === "JSXAttribute" && ["class", "className"].includes(attr.name?.name),
  );
  if (
    classAttrs.length > 1 ||
    classAttrs.some((attr) => staticJsxAttributeValue(attr.value) === undefined)
  )
    return false;
  const styleAttrs = opening.attributes.filter(
    (attr) => attr.type === "JSXAttribute" && attr.name?.name === "style",
  );
  return (
    styleAttrs.length <= 1 &&
    styleAttrs.every((attr) => staticJsxAttributeValue(attr.value) !== undefined)
  );
}

function toJsx(node) {
  if (node.type === "text") return `{${JSON.stringify(node.value)}}`;
  if (node.type !== "element") return "";
  const attrs = [];
  for (const [name, value] of Object.entries(node.properties ?? {})) {
    const attrName = jsxAttributeName(name === "className" ? "className" : name);
    if (attrName === "style") attrs.push(`style={${JSON.stringify(styleObject(value))}}`);
    else if (Array.isArray(value)) attrs.push(`${attrName}={${JSON.stringify(value.join(" "))}}`);
    else if (typeof value === "boolean") attrs.push(`${attrName}={${value}}`);
    else if (value !== null && value !== undefined)
      attrs.push(`${attrName}={${JSON.stringify(String(value))}}`);
  }
  const start = `<${node.tagName}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;
  const children = (node.children ?? []).map(toJsx).join("");
  return `${start}${children}</${node.tagName}>`;
}
