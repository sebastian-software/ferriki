import { ShikiError } from "./index.mjs";

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

export function renderTransformedHast(result, options, transformers, commonContext, source) {
  const properties = {
    class: result.themeName,
  };
  if (options.rootStyle !== false)
    properties.style =
      options.rootStyle || result.rootStyle || `background-color:${result.bg};color:${result.fg}`;
  if (options.tabindex !== false && options.tabindex !== null)
    properties.tabindex = String(options.tabindex ?? 0);
  for (const [key, value] of Object.entries(options.meta || {})) {
    if (!key.startsWith("_")) properties[key] = value;
  }

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
          ...(token.htmlStyle ? { style: stringifyStyle(token.htmlStyle) } : {}),
        },
        children: [{ type: "text", value: token.content }],
      };
      for (const transformer of transformers)
        span =
          transformer?.span?.call(context, span, lineIndex + 1, column, lineNode, token) || span;
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

export function splitTokensAtDecorations(tokens, decorations, source) {
  const resolved = resolveDecorations(decorations, source);
  const breakpoints = resolved.flatMap((item) => [item.start.offset, item.end.offset]);
  return tokens.map((line) =>
    line.flatMap((token) => {
      const start = token.offset;
      const end = start + token.content.length;
      const points = [
        ...new Set([start, ...breakpoints.filter((point) => point > start && point < end), end]),
      ].sort((left, right) => left - right);
      return points.slice(0, -1).map((point, index) => ({
        ...token,
        offset: point,
        content: token.content.slice(point - start, points[index + 1] - start),
      }));
    }),
  );
}

function resolveDecorations(decorations, source) {
  const sourceLines = source.split("\n");
  const lineStarts = [];
  let offset = 0;
  for (const line of sourceLines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineLength = (line) => (line.endsWith("\r") ? line.length - 1 : line.length);
  const toPosition = (value) => {
    if (typeof value === "number") {
      if (value < 0 || value > source.length)
        throw new ShikiError(
          `Invalid decoration offset: ${value}. Code length: ${source.length}`,
          "ERR_USAGE",
        );
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= value) line++;
      return { line, character: value - lineStarts[line], offset: value };
    }
    const line = sourceLines[value?.line] === undefined ? -1 : value.line;
    if (line < 0)
      throw new ShikiError(
        `Invalid decoration position ${JSON.stringify(value)}. Lines length: ${sourceLines.length}`,
        "ERR_USAGE",
      );
    let character = value.character;
    if (character < 0) character = lineLength(sourceLines[line]) + character;
    if (character < 0 || character > lineLength(sourceLines[line]))
      throw new ShikiError(
        `Invalid decoration position ${JSON.stringify(value)}. Line ${line} length: ${lineLength(sourceLines[line])}`,
        "ERR_USAGE",
      );
    return { line, character, offset: lineStarts[line] + character };
  };
  const items = decorations.map((decoration) => ({
    ...decoration,
    start: toPosition(decoration.start),
    end: toPosition(decoration.end),
  }));
  for (let index = 0; index < items.length; index++) {
    const current = items[index];
    if (current.start.offset > current.end.offset)
      throw new ShikiError(
        `Invalid decoration range: ${JSON.stringify(current.start)} - ${JSON.stringify(current.end)}`,
        "ERR_USAGE",
      );
    for (const other of items.slice(index + 1)) {
      const nested =
        (current.start.offset <= other.start.offset && other.end.offset <= current.end.offset) ||
        (other.start.offset <= current.start.offset && current.end.offset <= other.end.offset);
      const intersects =
        current.start.offset < other.end.offset && other.start.offset < current.end.offset;
      if (intersects && !nested)
        throw new ShikiError(
          `Decorations ${JSON.stringify(current.start)} and ${JSON.stringify(other.start)} intersect.`,
          "ERR_USAGE",
        );
    }
  }
  return items;
}

function applyDecorations(codeNode, decorations, source) {
  const items = resolveDecorations(decorations, source);
  const lines = (codeNode.children || []).filter(
    (node) => node.type === "element" && node.tagName === "span",
  );
  const applyProperties = (node, decoration, type) => {
    node.tagName = decoration.tagName || "span";
    node.properties = { ...(node.properties || {}), ...(decoration.properties || {}) };
    if (decoration.properties?.class) addClassToHast(node, decoration.properties.class);
    return decoration.transform?.(node, type) || node;
  };
  const decorateSection = (line, start, end, decoration) => {
    const lineNode = lines[line];
    if (!lineNode) return;
    let cursor = 0;
    let startIndex = start === 0 ? 0 : -1;
    let endIndex = end === Number.POSITIVE_INFINITY ? lineNode.children.length : -1;
    for (let index = 0; index < lineNode.children.length; index++) {
      const length = textContentLength(lineNode.children[index]);
      if (startIndex < 0 && cursor + length >= start)
        startIndex = cursor + length === start ? index + 1 : index;
      if (endIndex < 0 && cursor + length >= end)
        endIndex = cursor + length === end ? index + 1 : index;
      cursor += length;
    }
    if (startIndex < 0 || endIndex < 0)
      throw new ShikiError(`Failed to find decoration boundary on line ${line}`, "ERR_USAGE");
    const children = lineNode.children.slice(startIndex, endIndex);
    if (!decoration.alwaysWrap && children.length === lineNode.children.length) {
      lines[line] = applyProperties(lineNode, decoration, "line");
    } else if (!decoration.alwaysWrap && children.length === 1 && children[0].type === "element") {
      lineNode.children[startIndex] = applyProperties(children[0], decoration, "token");
    } else {
      const wrapper = applyProperties(
        {
          type: "element",
          tagName: decoration.tagName || "span",
          properties: {},
          children,
        },
        decoration,
        "wrapper",
      );
      lineNode.children.splice(startIndex, children.length, wrapper);
    }
  };
  for (const decoration of [...items].sort(
    (left, right) => right.start.offset - left.start.offset,
  )) {
    if (decoration.start.line === decoration.end.line) {
      decorateSection(
        decoration.start.line,
        decoration.start.character,
        decoration.end.character,
        decoration,
      );
    } else {
      decorateSection(
        decoration.start.line,
        decoration.start.character,
        Number.POSITIVE_INFINITY,
        decoration,
      );
      for (let line = decoration.start.line + 1; line < decoration.end.line; line++)
        lines[line] = applyProperties(lines[line], decoration, "line");
      decorateSection(decoration.end.line, 0, decoration.end.character, decoration);
    }
  }
}

function textContentLength(node) {
  if (node.type === "text") return node.value.length;
  return (node.children || []).reduce((total, child) => total + textContentLength(child), 0);
}
