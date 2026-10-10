import { addScopeClasses, extractClassStyles, nestScopes, themeSwitchStyles } from "./classes.mjs";
import { ShikiError } from "./index.mjs";
import { loadFerrikiNativeBinding } from "./native.mjs";

export function sortTransformers(transformers) {
  if (transformers === undefined) return [];
  if (!Array.isArray(transformers))
    throw new ShikiError("Highlight option transformers must be an array", "ERR_USAGE");
  return [...transformers].sort((left, right) => rank(left) - rank(right));
}

function rank(transformer) {
  return transformer?.enforce === "pre" ? -1 : transformer?.enforce === "post" ? 1 : 0;
}

export function applyTokenTransformers(tokens, transformers, context) {
  let result = tokens;
  for (const transformer of transformers)
    result = transformer?.tokens?.call(context, result) || result;
  return result;
}

export const classStylesByTree = new WeakMap();

export function renderTransformedHast(result, options, transformers, commonContext, source) {
  const properties = {
    class:
      result.hastClass ||
      (result.themeName.startsWith("shiki-themes ")
        ? `shiki ${result.themeName}`
        : result.themeName),
  };
  if (options.styleMode === "classes")
    properties.class = `ferriki ${result.themeName.replace(/^shiki-themes /u, "")}`;
  if (options.rootStyle !== false)
    properties.style =
      options.rootStyle || result.rootStyle || `background-color:${result.bg};color:${result.fg}`;
  if (options.styleMode === "classes" && options.themes && options.rootStyle === undefined) {
    const variables = (result.rootStyle || `background-color:${result.bg};color:${result.fg}`)
      .split(";")
      .filter((part) => !part.startsWith("color:") && !part.startsWith("background-color:"))
      .join(";");
    properties.style = `background-color:var(--ferriki-background);color:var(--ferriki-color);${variables}`;
  }
  if (options.tabindex !== false && options.tabindex !== null)
    properties.tabindex = String(options.tabindex ?? 0);
  for (const [key, value] of Object.entries(options.meta || {})) {
    if (!key.startsWith("_")) properties[key] = value;
  }

  const themeStyles =
    options.styleMode === "classes" ? themeSwitchStyles(options) : { className: "", css: "" };
  if (themeStyles.className) properties.class += ` ${themeStyles.className}`;
  const scopePaths = new WeakMap();
  const root = { type: "root", children: [] };
  const lines = [];
  let preNode;
  let codeNode;
  const context = {
    ...commonContext,
    source,
    options,
    structure: options.structure || "classic",
    root,
    get tokens() {
      return result.tokens;
    },
    get pre() {
      return preNode;
    },
    get code() {
      return codeNode;
    },
    get lines() {
      return lines;
    },
    addClassToHast,
  };

  for (let lineIndex = 0; lineIndex < result.tokens.length; lineIndex++) {
    const lineNode = {
      type: "element",
      tagName: "span",
      properties: { class: "line" },
      children: [],
    };
    for (let column = 0; column < result.tokens[lineIndex].length; column++) {
      const token = result.tokens[lineIndex][column];
      let span = {
        type: "element",
        tagName: "span",
        properties: {
          ...(token.htmlAttrs || {}),
          ...(token.htmlStyle
            ? { style: stringifyStyle(token.htmlStyle) }
            : options.styleMode === "classes"
              ? { style: tokenCss(token) }
              : {}),
        },
        children: [{ type: "text", value: token.content }],
      };
      for (const transformer of transformers)
        span =
          transformer?.span?.call(context, span, lineIndex + 1, column, lineNode, token) || span;
      if (options.styleMode === "classes") {
        const scopes =
          token.scopeNames || token.explanation?.[0]?.scopes.map((item) => item.scopeName) || [];
        addScopeClasses(span, scopes);
        scopePaths.set(span, scopes);
      }
      lineNode.children.push(span);
    }
    let transformedLine = lineNode;
    for (const transformer of transformers)
      transformedLine =
        transformer?.line?.call(context, transformedLine, lineIndex + 1) || transformedLine;
    lines.push(transformedLine);
  }

  if (context.structure === "inline") {
    for (let index = 0; index < lines.length; index++) {
      if (index > 0)
        root.children.push({ type: "element", tagName: "br", properties: {}, children: [] });
      root.children.push(...lines[index].children);
    }
    codeNode = {
      type: "element",
      tagName: "code",
      properties: {},
      children: lines,
    };
  } else {
    const children = [];
    for (let index = 0; index < lines.length; index++) {
      if (index > 0) children.push({ type: "text", value: "\n" });
      children.push(lines[index]);
    }
    codeNode = {
      type: "element",
      tagName: "code",
      properties: {},
      children,
    };
    preNode = {
      type: "element",
      tagName: "pre",
      properties,
      children: [codeNode],
      data: options.data,
    };
  }

  if (context.structure === "classic") {
    for (const transformer of transformers)
      codeNode = transformer?.code?.call(context, codeNode) || codeNode;
    preNode.children = [codeNode];
    for (const transformer of transformers)
      preNode = transformer?.pre?.call(context, preNode) || preNode;
    root.children.push(preNode);
  } else {
    for (const transformer of transformers)
      codeNode = transformer?.code?.call(context, codeNode) || codeNode;
  }

  if (options.decorations?.length) applyDecorations(codeNode, options.decorations, source);
  if (context.structure === "inline" && options.decorations?.length) {
    root.children = [];
    for (let index = 0; index < lines.length; index++) {
      if (index > 0)
        root.children.push({ type: "element", tagName: "br", properties: {}, children: [] });
      root.children.push(...lines[index].children);
    }
  }

  let output = root;
  for (const transformer of transformers)
    output = transformer?.root?.call(context, output) || output;
  if (options.styleMode === "classes") {
    if (context.structure === "inline") {
      output.children = [
        { type: "element", tagName: "code", properties, children: output.children },
      ];
    }
    nestScopes(output, scopePaths);
    classStylesByTree.set(
      output,
      [extractClassStyles(output), themeStyles.css].filter(Boolean).join("\n"),
    );
  }
  return output;
}

function addClassToHast(node, className) {
  const current = node.properties?.class;
  const currentClasses = Array.isArray(current)
    ? current
    : typeof current === "string"
      ? current.split(/\s+/).filter(Boolean)
      : [];
  const addedClasses = Array.isArray(className) ? className : [className];
  node.properties = {
    ...(node.properties || {}),
    class: [...new Set([...currentClasses, ...addedClasses])].join(" "),
  };
  return node;
}

function stringifyStyle(style) {
  if (typeof style === "string") return style;
  if (!style || typeof style !== "object") return String(style || "");
  return Object.entries(style)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

// Range policy and tree edits are planned in Rust. This adapter retains opaque
// JS properties, callback data, original node identities, and exact UTF-16 slices.
function decorationRanges(decorations) {
  return decorations.map((item) => ({
    ...(typeof item.start === "number"
      ? { startOffset: item.start }
      : { startLine: item.start?.line, startCharacter: item.start?.character }),
    ...(typeof item.end === "number"
      ? { endOffset: item.end }
      : { endLine: item.end?.line, endCharacter: item.end?.character }),
    alwaysWrap: !!item.alwaysWrap,
  }));
}

let decorationBinding;
function decorationNative(call) {
  try {
    return call((decorationBinding ??= loadFerrikiNativeBinding()));
  } catch (error) {
    if (["ERR_USAGE", "InvalidArg", "NumberExpected"].includes(error?.code))
      throw new ShikiError(error.message, "ERR_USAGE", { cause: error });
    throw error;
  }
}

export function splitTokensAtDecorations(tokens, decorations, source) {
  const slices = decorationNative((native) =>
    native.splitDecorationTokens(
      source,
      decorationRanges(decorations),
      tokens.map((line) => {
        const metadata = new Float64Array(line.length * 2);
        for (let index = 0; index < line.length; index++) {
          metadata[index * 2] = line[index].offset;
          metadata[index * 2 + 1] = line[index].content.length;
        }
        return metadata;
      }),
    ),
  );
  return slices.map((line, index) => {
    const result = [];
    for (let position = 0; position < line.length; position += 4) {
      const token = tokens[index][line[position]];
      result.push({
        ...token,
        offset: line[position + 3],
        content: token.content.slice(line[position + 1], line[position + 2]),
      });
    }
    return result;
  });
}

function applyDecorations(codeNode, decorations, source) {
  const prepared = decorationNative((native) =>
    native.decorationSections(source, decorationRanges(decorations)),
  );
  const sections = prepared.sections;
  const items = decorations.map((item, index) => ({ ...item, ...prepared.ranges[index] }));
  const lines = (codeNode.children || []).filter(
    (node) => node.type === "element" && node.tagName === "span",
  );
  const execute = (batch) => {
    const objects = [];
    const metadata = [];
    const ids = new Map();
    const childArrays = new Set();
    let sharedChildren = false;
    const flatten = (node) => {
      if (ids.has(node)) return ids.get(node);
      const id = objects.length;
      ids.set(node, id);
      objects.push(node);
      const children = node.type === "text" ? [] : node.children || [];
      if (node.type !== "text" && node.children) {
        sharedChildren ||= childArrays.has(node.children);
        childArrays.add(node.children);
      }
      const record = metadata.length;
      metadata.push(
        Number(node.type === "element"),
        node.type === "text" ? node.value.length : 0,
        children.length,
      );
      for (let index = 0; index < children.length; index++) metadata.push(0);
      for (let index = 0; index < children.length; index++)
        metadata[record + 3 + index] = flatten(children[index]);
      return id;
    };
    // Transport only the lines this batch can touch. Callbacks with many
    // sections must not copy the entire block across N-API for every edit.
    const sourceLines = [...new Set(batch.map((section) => section.line))].filter(
      (index) => lines[index],
    );
    const localLines = new Map(sourceLines.map((index, local) => [index, local]));
    const lineIds = sourceLines.map((index) => flatten(lines[index]));
    // Mutating one aliased child array also changes its other owners. Re-read
    // that graph between sections, just as after a user callback.
    if (sharedChildren && batch.length > 1) {
      for (const section of batch) execute([section]);
      return;
    }
    const plan = decorationNative((native) =>
      native.planDecorationMutations(
        Float64Array.from(metadata),
        lineIds,
        batch.map((section) => ({
          ...section,
          line: localLines.get(section.line) ?? lineIds.length,
        })),
      ),
    );
    for (const edit of plan.mutations) {
      const decoration = items[edit.decoration];
      const line = objects[edit.line];
      let node = objects[edit.node];
      if (edit.target === "wrapper") {
        node = {
          type: "element",
          tagName: decoration.tagName || "span",
          properties: {},
          children: line.children.slice(edit.start, edit.start + edit.count),
        };
        objects[edit.node] = node;
      }
      node.tagName = decoration.tagName || "span";
      node.properties = { ...(node.properties || {}), ...(decoration.properties || {}) };
      if (decoration.properties?.class) addClassToHast(node, decoration.properties.class);
      const transformed = decoration.transform?.(node, edit.target) || node;
      if (edit.target === "line") lines[sourceLines[lineIds.indexOf(edit.line)]] = transformed;
      else line.children.splice(edit.start, edit.count, transformed);
      objects[edit.node] = transformed;
    }
    if (plan.error) throw new ShikiError(plan.error, "ERR_USAGE");
  };
  // Batch sections between callbacks. Callback traversal stays in Rust, and
  // reads the resolved decoration again after each callback (including edits
  // to this.start/end or alwaysWrap).
  let pending = [];
  const flush = () => {
    if (pending.length) execute(pending);
    pending = [];
  };
  // Rust emits each decoration's sections together. Walk those groups once
  // instead of rescanning the whole section list for every decoration.
  for (let sectionIndex = 0; sectionIndex < sections.length;) {
    const index = sections[sectionIndex].decoration;
    let end = sectionIndex + 1;
    while (end < sections.length && sections[end].decoration === index) end++;
    const item = items[index];
    if (!item.transform) {
      for (; sectionIndex < end; sectionIndex++) pending.push(sections[sectionIndex]);
      continue;
    }
    sectionIndex = end;
    flush();
    let cursor = { phase: 0, line: 0 };
    while (cursor.phase !== 3) {
      const next = decorationNative((native) =>
        native.nextDecorationSection(
          { start: item.start, end: item.end },
          index,
          !!item.alwaysWrap,
          cursor,
        ),
      );
      if (!next) break;
      execute([next.section]);
      cursor = next.cursor;
    }
  }
  flush();
}

function tokenCss(token) {
  const font = token.fontStyle || 0;
  const decorations =
    [font & 4 ? "underline" : "", font & 8 ? "line-through" : ""].filter(Boolean).join(" ") ||
    "none";
  return `${token.color ? `color:${token.color};` : ""}font-style:${font & 1 ? "italic" : "normal"};font-weight:${font & 2 ? "bold" : "normal"};text-decoration:${decorations}`;
}
