import { createHash } from "node:crypto";
import {
  addScopeClasses,
  createScopeClassCache,
  extractClassStylesFromTree,
  formatSafeTokenStyleEntry,
  isSafeDecorationAttributeName,
  isSafeDecorationAttributeValue,
  isSafeDecorationTagName,
  isUrlDecorationAttributeName,
  isValidHtmlAttributeName,
  nestScopes,
  normalizeSafeCssColor,
  sanitizeCssDeclarations,
  splitCssDeclarations,
  themeSwitchStyles,
  trimAsciiCssWhitespace,
} from "./classes.mjs";
import { ShikiError } from "./index.mjs";
import { loadFerrikiNativeBinding } from "./native.mjs";

const FORBIDDEN_ATTRIBUTE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SANITIZED_CLONE_ORIGIN = Symbol.for("ferriki.sanitizedCloneOrigin");

function assignOwnProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function setNormalizedStyleProperty(target, value) {
  const sanitized = sanitizeCssDeclarations(
    typeof value === "string" || (value && typeof value === "object" && !Array.isArray(value))
      ? value
      : Array.isArray(value)
        ? value.join(" ")
        : String(value ?? ""),
  );
  for (const existingKey of Object.keys(target)) {
    if (existingKey.toLowerCase() === "style" && existingKey !== "style") {
      delete target[existingKey];
    }
  }
  if (sanitized) assignOwnProperty(target, "style", sanitized);
  else delete target.style;
}

function isSafeMetaAttributeName(key) {
  if (typeof key !== "string" || key.startsWith("_")) return false;
  if (FORBIDDEN_ATTRIBUTE_KEYS.has(key)) return false;
  return isSafeDecorationAttributeName(key);
}

function defaultRootStyle(result) {
  if (result.isMultiTheme === true) return `background-color:${result.bg};color:${result.fg}`;
  const parts = [];
  const bg = normalizeSafeCssColor(result.bg);
  const fg = normalizeSafeCssColor(result.fg);
  if (bg) parts.push(`background-color:${bg}`);
  if (fg) parts.push(`color:${fg}`);
  return parts.join(";");
}

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
  const scopeClasses = options.styleMode === "classes" ? createScopeClassCache() : undefined;
  const properties = {
    class:
      result.hastClass ||
      (result.isMultiTheme === true ? `shiki ${result.themeName}` : result.themeName),
  };
  if (options.styleMode === "classes")
    properties.class = `ferriki ${result.isMultiTheme === true ? result.themeName.replace(/^shiki-themes /u, "") : result.themeName}`;
  if (options.rootStyle !== false) {
    const rootStyle = options.rootStyle || result.rootStyle || defaultRootStyle(result);
    if (rootStyle) properties.style = rootStyle;
  }
  if (options.styleMode === "classes" && options.themes && options.rootStyle === undefined) {
    const variables = (result.rootStyle || defaultRootStyle(result))
      .split(";")
      .filter((part) => !part.startsWith("color:") && !part.startsWith("background-color:"))
      .join(";");
    properties.style = `background-color:var(--ferriki-background);color:var(--ferriki-color);${variables}`;
  }
  if (options.tabindex !== false && options.tabindex !== null)
    properties.tabindex = String(options.tabindex ?? 0);
  for (const [key, value] of Object.entries(options.meta || {})) {
    if (!isSafeMetaAttributeName(key)) continue;
    if (key.toLowerCase() === "style") {
      setNormalizedStyleProperty(properties, value);
      continue;
    }
    if (!isSafeDecorationAttributeValue(key, value)) continue;
    assignOwnProperty(properties, key, value);
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
      const spanProperties = {};
      if (token.htmlAttrs && typeof token.htmlAttrs === "object") {
        for (const [key, value] of Object.entries(token.htmlAttrs)) {
          if (key !== "__proto__" && isValidHtmlAttributeName(key))
            assignOwnProperty(spanProperties, key, value);
        }
        for (const symbol of Object.getOwnPropertySymbols(token.htmlAttrs)) {
          if (Object.prototype.propertyIsEnumerable.call(token.htmlAttrs, symbol))
            assignOwnProperty(spanProperties, symbol, token.htmlAttrs[symbol]);
        }
      }
      if (token.htmlStyle) {
        let style;
        if (typeof token.htmlStyle === "object" && !Array.isArray(token.htmlStyle)) {
          const entries = [];
          for (const [key, value] of Object.entries(token.htmlStyle)) {
            const formatted = formatSafeTokenStyleEntry(key, value);
            if (formatted) entries.push(formatted);
          }
          style = entries.join(";");
        } else {
          style = stringifyStyle(token.htmlStyle);
        }
        if (style) spanProperties.style = style;
      } else if (options.styleMode === "classes") {
        spanProperties.style = tokenCss(token);
      }
      let span = {
        type: "element",
        tagName: "span",
        properties: spanProperties,
        children: [{ type: "text", value: token.content }],
      };
      for (const transformer of transformers)
        span =
          transformer?.span?.call(context, span, lineIndex + 1, column, lineNode, token) || span;
      if (options.styleMode === "classes") {
        const scopes =
          token.scopeNames || token.explanation?.[0]?.scopes.map((item) => item.scopeName) || [];
        addScopeClasses(span, scopes, scopeClasses);
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

  let pendingSanitizations;
  let inlineLines;
  let inlineLineSlots;
  let beforeApplyInlineLines;
  let beforeDecorationState;
  if (options.decorations?.length) {
    if (context.structure === "inline") {
      inlineLines = [];
      inlineLineSlots = [];
      for (let index = 0; index < lines.length; index++) {
        const entry = lines[index];
        if (entry && typeof entry === "object" && entry.type === "element") {
          inlineLines.push(entry);
          inlineLineSlots.push(index);
        }
      }
      beforeApplyInlineLines = inlineLines.slice();
    }
    if (options.decorations.some((decoration) => typeof decoration?.transform === "function")) {
      beforeDecorationState = captureSubtreeElementStyles(
        context.structure === "inline" ? { type: "root", children: inlineLines } : root,
      );
    }
    pendingSanitizations = applyDecorations(codeNode, options.decorations, source, inlineLines);
  }
  if (context.structure === "inline" && options.decorations?.length) {
    for (let index = 0; index < inlineLines.length; index++) {
      if (inlineLines[index] !== beforeApplyInlineLines[index]) {
        const originalSlot = inlineLineSlots[index];
        if (lines[originalSlot] === beforeApplyInlineLines[index]) {
          lines[originalSlot] = inlineLines[index];
        } else {
          const liveIndex = lines.indexOf(beforeApplyInlineLines[index]);
          if (liveIndex !== -1) lines[liveIndex] = inlineLines[index];
        }
      }
    }
    const liveInlineLines = lines.filter(
      (entry) => entry && typeof entry === "object" && entry.type === "element",
    );
    root.children = [];
    for (let index = 0; index < liveInlineLines.length; index++) {
      if (index > 0)
        root.children.push({ type: "element", tagName: "br", properties: {}, children: [] });
      root.children.push(...(liveInlineLines[index].children || []));
    }
  }
  let output = root;
  if (pendingSanitizations?.length) {
    const clonedNodes = new Map();
    const extraRoots =
      context.structure === "inline" ? [...lines, ...(codeNode ? [codeNode] : [])] : undefined;
    output = sanitizePendingDecorations(
      pendingSanitizations,
      output,
      scopePaths,
      clonedNodes,
      beforeDecorationState,
      extraRoots,
    );
    if (preNode && clonedNodes.has(preNode)) preNode = clonedNodes.get(preNode);
    if (codeNode && clonedNodes.has(codeNode)) codeNode = clonedNodes.get(codeNode);
    for (let index = 0; index < lines.length; index++) {
      if (clonedNodes.has(lines[index])) lines[index] = clonedNodes.get(lines[index]);
    }
    if (context.structure === "inline" && clonedNodes.size > 0) {
      const changedNodes = new Map();
      for (const [original, replacement] of clonedNodes) {
        if (replacement !== original) changedNodes.set(original, replacement);
      }
      if (changedNodes.size > 0) {
        const syncMemo = new Map(changedNodes);
        for (let index = 0; index < lines.length; index++) {
          lines[index] = replaceTreeNodes(lines[index], changedNodes, scopePaths, syncMemo);
        }
        if (codeNode) {
          codeNode = replaceTreeNodes(codeNode, changedNodes, scopePaths, syncMemo);
        }
      }
    }
  }
  for (const transformer of transformers)
    output = transformer?.root?.call(context, output) || output;
  if (options.styleMode === "classes") {
    if (context.structure === "inline") {
      const wrappedChildren = [
        { type: "element", tagName: "code", properties, children: output.children },
      ];
      if (canAssignOwnDataProperty(output, "children")) {
        output.children = wrappedChildren;
      } else {
        output = { ...output, children: wrappedChildren };
      }
    }
    output = nestScopes(output, scopePaths, scopeClasses);
    const extracted = extractClassStylesFromTree(output);
    output = extracted.tree;
    classStylesByTree.set(output, [extracted.css, themeStyles.css].filter(Boolean).join("\n"));
  }
  return output;
}

export function addClassToHast(node, className) {
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
export function decorationNative(call) {
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

function validateDecorationDescriptor(decoration) {
  const tagName = decoration?.tagName || "span";
  if (!isSafeDecorationTagName(tagName))
    throw new ShikiError(`Invalid HTML tag name ${JSON.stringify(tagName)}`, "ERR_USAGE");
  const properties = decoration?.properties;
  if (properties && typeof properties === "object") {
    for (const key of Object.keys(properties)) {
      if (!isSafeDecorationAttributeName(key))
        throw new ShikiError(`Invalid HTML attribute name ${JSON.stringify(key)}`, "ERR_USAGE");
      const descriptor = Object.getOwnPropertyDescriptor(properties, key);
      if (descriptor && Object.hasOwn(descriptor, "value")) {
        if (!isSafeDecorationAttributeValue(key, descriptor.value))
          throw new ShikiError(
            `Invalid HTML attribute value for ${JSON.stringify(key)}`,
            "ERR_USAGE",
          );
      }
    }
  }
}

const DECORATION_DESCRIPTOR_KEYS = new Set([
  "start",
  "end",
  "tagName",
  "properties",
  "alwaysWrap",
  "transform",
]);

function captureDecoration(item) {
  const copy = {
    start: item.start,
    end: item.end,
    tagName: item.tagName,
    properties: item.properties,
    alwaysWrap: item.alwaysWrap,
    transform: item.transform,
  };
  for (const key of Reflect.ownKeys(item)) {
    if (DECORATION_DESCRIPTOR_KEYS.has(key)) continue;
    if (!Object.prototype.propertyIsEnumerable.call(item, key)) continue;
    assignOwnProperty(copy, key, item[key]);
  }
  return copy;
}

function hasOwnEnumerableAccessor(style) {
  for (const key of Object.keys(style)) {
    const descriptor = Object.getOwnPropertyDescriptor(style, key);
    if (descriptor && !Object.hasOwn(descriptor, "value")) return true;
  }
  return false;
}

const opaqueStyleValueIds = new WeakMap();
let nextOpaqueStyleValueId = 1;

function isOpaqueStyleValue(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function styleValueSnapshotToken(value) {
  if (isOpaqueStyleValue(value)) {
    let id = opaqueStyleValueIds.get(value);
    if (id === undefined) {
      id = nextOpaqueStyleValueId++;
      opaqueStyleValueIds.set(value, id);
    }
    return `obj:${id}`;
  }
  if (typeof value === "symbol") return `sym:${value.description ?? ""}`;
  return `prim:${typeof value}:${String(value)}`;
}

function styleObjectSnapshotKey(style) {
  return JSON.stringify(
    Object.entries(style).map(([key, value]) => [key, styleValueSnapshotToken(value)]),
  );
}

function styleArraySnapshotKey(style) {
  return JSON.stringify(style.map((item) => styleValueSnapshotToken(item)));
}

function stringifySafeSummary(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `arr:${value.length}`;
  return typeof value;
}

function computeSubtreeHashes(root, structureHashes = new Map(), childrenHashes = new Map()) {
  const onStack = new Set();
  const stack = [[root, false]];
  while (stack.length > 0) {
    const [current, expanded] = stack.pop();
    if (!current || typeof current !== "object" || structureHashes.has(current)) continue;
    if (current.type === "text") {
      const digest = createHash("sha256")
        .update("t\0")
        .update(String(current.value ?? ""))
        .digest("hex");
      structureHashes.set(current, digest);
      continue;
    }
    if (!expanded) {
      if (onStack.has(current)) continue;
      onStack.add(current);
      stack.push([current, true]);
      if (Array.isArray(current.children)) {
        for (let index = current.children.length - 1; index >= 0; index--) {
          const child = current.children[index];
          if (
            child &&
            typeof child === "object" &&
            !structureHashes.has(child) &&
            !onStack.has(child)
          ) {
            stack.push([child, false]);
          }
        }
      }
      continue;
    }
    onStack.delete(current);
    const childHasher = createHash("sha256");
    if (Array.isArray(current.children)) {
      for (const child of current.children) {
        childHasher.update("\0");
        if (!child || typeof child !== "object") childHasher.update("null");
        else childHasher.update(structureHashes.get(child) ?? "cycle");
      }
    }
    const childrenDigest = childHasher.digest("hex");
    childrenHashes.set(current, childrenDigest);

    const elemHasher = createHash("sha256");
    elemHasher.update("e\0");
    elemHasher.update(String(current.tagName || ""));
    elemHasher.update("\0");
    if (current.properties && typeof current.properties === "object") {
      for (const key of Object.keys(current.properties)) {
        if (key.toLowerCase() === "style") continue;
        elemHasher.update(key);
        elemHasher.update("=");
        const descriptor = Object.getOwnPropertyDescriptor(current.properties, key);
        if (descriptor && Object.hasOwn(descriptor, "value")) {
          elemHasher.update(stringifySafeSummary(descriptor.value));
        } else {
          elemHasher.update("<accessor>");
        }
        elemHasher.update("\0");
      }
    }
    elemHasher.update("\u0001");
    elemHasher.update(childrenDigest);
    structureHashes.set(current, elemHasher.digest("hex"));
  }
  return { structureHashes, childrenHashes };
}

function captureSubtreeElementStyles(root) {
  const elements = new Set();
  const styles = new Map();
  for (const el of collectSubtreeElements(root)) {
    elements.add(el);
    styles.set(el, captureStyleReferenceSnapshot(el));
  }
  return { elements, styles };
}

function collectSubtreeElements(root) {
  const result = [];
  const visited = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (current.type === "element") result.push(current);
    if (Array.isArray(current.children)) {
      for (let index = current.children.length - 1; index >= 0; index--) {
        stack.push(current.children[index]);
      }
    }
  }
  return result;
}

function captureStyleReferenceSnapshot(node) {
  if (!node || typeof node !== "object" || !node.properties || typeof node.properties !== "object")
    return undefined;
  let snapshot;
  for (const key of Object.keys(node.properties)) {
    if (key.toLowerCase() !== "style") continue;
    const descriptor = Object.getOwnPropertyDescriptor(node.properties, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const value = descriptor.value;
    snapshot ??= new Map();
    if (value && typeof value === "object") {
      snapshot.set(
        key,
        hasOwnEnumerableAccessor(value)
          ? value
          : Array.isArray(value)
            ? `a:${styleArraySnapshotKey(value)}`
            : `o:${styleObjectSnapshotKey(value)}`,
      );
    } else {
      snapshot.set(key, `v:${styleValueSnapshotToken(value)}`);
    }
  }
  return snapshot;
}

function styleSnapshotEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function collectTrackedInSubtree(root, recordsByNode) {
  const tracked = [];
  const beforeElements = new Set();
  const beforeStyles = new Map();
  const untrackedStyled = [];
  const parentInfo = new Map();
  const visited = new Set();
  const stack = [[root, undefined, -1]];
  while (stack.length > 0) {
    const [current, parent, childIndex] = stack.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (parent !== undefined) parentInfo.set(current, { parent, index: childIndex });
    if (current.type === "element") {
      beforeElements.add(current);
      const styleSnapshot = captureStyleReferenceSnapshot(current);
      beforeStyles.set(current, styleSnapshot);
      const records = recordsByNode.get(current);
      if (records && records.size > 0) {
        tracked.push({ node: current, records: [...records] });
      } else if (styleSnapshot) {
        untrackedStyled.push({ node: current, styleSnapshot });
      }
    }
    if (Array.isArray(current.children)) {
      for (let index = current.children.length - 1; index >= 0; index--) {
        stack.push([current.children[index], current, index]);
      }
    }
  }
  return { tracked, beforeElements, beforeStyles, untrackedStyled, parentInfo };
}

function getElementByPath(root, path) {
  let current = root;
  for (const index of path) {
    if (!current || typeof current !== "object" || !Array.isArray(current.children))
      return undefined;
    current = current.children[index];
  }
  return current && typeof current === "object" && current.type === "element" ? current : undefined;
}

function collectSingleElementWrapperChain(root) {
  const chain = [];
  const visited = new Set();
  let current = root;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    if (!Array.isArray(current.children)) break;
    let onlyElementChild;
    let elementCount = 0;
    for (const child of current.children) {
      if (child && typeof child === "object" && child.type === "element") {
        elementCount++;
        onlyElementChild = child;
        if (elementCount > 1) break;
      }
    }
    if (elementCount !== 1) break;
    current = onlyElementChild;
  }
  return chain;
}

function sameDirectStructure(candidate, original) {
  if (!candidate || candidate.type !== "element" || candidate.tagName !== original.tagName)
    return false;
  const origProps =
    original.properties && typeof original.properties === "object"
      ? Object.keys(original.properties).filter((key) => key.toLowerCase() !== "style")
      : [];
  const candProps =
    candidate.properties && typeof candidate.properties === "object"
      ? Object.keys(candidate.properties).filter((key) => key.toLowerCase() !== "style")
      : [];
  if (origProps.length !== candProps.length) return false;
  for (let index = 0; index < origProps.length; index++) {
    if (origProps[index] !== candProps[index]) return false;
  }
  const origChildren = Array.isArray(original.children) ? original.children : [];
  const candChildren = Array.isArray(candidate.children) ? candidate.children : [];
  if (origChildren.length !== candChildren.length) return false;
  for (let index = 0; index < origChildren.length; index++) {
    const origChild = origChildren[index];
    const candChild = candChildren[index];
    if (!origChild || !candChild || origChild.type !== candChild.type) return false;
    if (origChild.type === "text" && origChild.value !== candChild.value) return false;
    if (origChild.type === "element" && origChild.tagName !== candChild.tagName) return false;
  }
  return true;
}

function normalizeCanonicalCssQuotedString(raw, startIndex) {
  const quote = raw[startIndex];
  let inner = "";
  let index = startIndex + 1;
  while (index < raw.length) {
    const ch = raw[index];
    if (ch === "\\") {
      if (index + 1 < raw.length) {
        const next = raw[index + 1];
        if (next === quote || next === '"' || next === "'" || next === "\\") {
          inner += next;
        } else {
          inner += `\\${next}`;
        }
        index += 2;
        continue;
      }
      inner += "\\";
      index++;
      continue;
    }
    if (ch === quote) {
      return {
        text: `"${inner.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`,
        endIndex: index,
      };
    }
    inner += ch;
    index++;
  }
  return undefined;
}

function normalizeCanonicalUrlCalls(value) {
  let output = "";
  let quote;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (quote) {
      if (ch === "\\") {
        output += ch;
        if (index + 1 < value.length) output += value[++index];
        continue;
      }
      if (ch === quote) quote = undefined;
      output += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      output += ch;
      continue;
    }
    if (
      (ch === "u" || ch === "U") &&
      value.slice(index, index + 4).toLowerCase() === "url(" &&
      (index === 0 || !/[\w-]/u.test(value[index - 1]))
    ) {
      let cursor = index + 4;
      let innerQuote;
      let close = -1;
      while (cursor < value.length) {
        const innerCh = value[cursor];
        if (innerQuote) {
          if (innerCh === "\\") {
            cursor += 2;
            continue;
          }
          if (innerCh === innerQuote) innerQuote = undefined;
          cursor++;
          continue;
        }
        if (innerCh === '"' || innerCh === "'") {
          innerQuote = innerCh;
          cursor++;
          continue;
        }
        if (innerCh === ")") {
          close = cursor;
          break;
        }
        cursor++;
      }
      if (close !== -1) {
        const rawArg = trimAsciiCssWhitespace(value.slice(index + 4, close));
        if (
          rawArg.length >= 2 &&
          ((rawArg[0] === '"' && rawArg.at(-1) === '"') ||
            (rawArg[0] === "'" && rawArg.at(-1) === "'"))
        ) {
          const parsed = normalizeCanonicalCssQuotedString(rawArg, 0);
          if (parsed && parsed.endIndex === rawArg.length - 1) {
            output += `url(${parsed.text})`;
            index = close;
            continue;
          }
        }
        const escaped = rawArg.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
        output += `url("${escaped}")`;
        index = close;
        continue;
      }
    }
    output += ch;
  }
  return output;
}

function canonicalizeCssDeclaration(segment) {
  let stripped = "";
  let quote;
  let inComment = false;
  for (let index = 0; index < segment.length; index++) {
    const ch = segment[index];
    if (inComment) {
      if (ch === "*" && segment[index + 1] === "/") {
        inComment = false;
        index++;
      }
      continue;
    }
    if (ch === "\\") {
      stripped += ch;
      if (index + 1 < segment.length) stripped += segment[++index];
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      stripped += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      stripped += ch;
      continue;
    }
    if (ch === "/" && segment[index + 1] === "*") {
      inComment = true;
      index++;
      continue;
    }
    stripped += ch;
  }
  if (inComment) return undefined;
  let colon = -1;
  let depth = 0;
  quote = undefined;
  for (let index = 0; index < stripped.length; index++) {
    const ch = stripped[index];
    if (ch === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) {
      colon = index;
      break;
    }
  }
  if (colon === -1) return undefined;
  const rawProp = trimAsciiCssWhitespace(stripped.slice(0, colon));
  if (!rawProp) return undefined;
  const prop = rawProp.startsWith("--") ? rawProp : rawProp.toLowerCase();
  const rawVal = trimAsciiCssWhitespace(stripped.slice(colon + 1));
  if (!rawVal) return undefined;
  let normVal = "";
  let pendingSpace = false;
  for (let index = 0; index < rawVal.length; index++) {
    const ch = rawVal[index];
    const code = rawVal.charCodeAt(index);
    if (ch === '"' || ch === "'") {
      if (pendingSpace && normVal.length > 0 && normVal.at(-1) !== "(") normVal += " ";
      pendingSpace = false;
      const normalizedQuote = normalizeCanonicalCssQuotedString(rawVal, index);
      if (normalizedQuote) {
        normVal += normalizedQuote.text;
        index = normalizedQuote.endIndex;
        continue;
      }
      normVal += rawVal.slice(index);
      break;
    }
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      pendingSpace = true;
      continue;
    }
    if (ch === "(") {
      let fnStart = normVal.length;
      while (fnStart > 0 && /[\w-]/u.test(normVal[fnStart - 1])) fnStart--;
      if (fnStart < normVal.length && !pendingSpace) {
        normVal = `${normVal.slice(0, fnStart)}${normVal.slice(fnStart).toLowerCase()}`;
      } else if (
        pendingSpace &&
        normVal.length > 0 &&
        normVal.at(-1) !== "(" &&
        normVal.at(-1) !== ","
      ) {
        normVal += " ";
      }
      pendingSpace = false;
      normVal += "(";
      continue;
    }
    if (ch === ")" || ch === ",") {
      pendingSpace = false;
      normVal += ch;
      continue;
    }
    if (pendingSpace && normVal.length > 0 && normVal.at(-1) !== "(" && normVal.at(-1) !== ",") {
      normVal += " ";
    }
    pendingSpace = false;
    normVal += ch;
  }
  return `${prop}:${normalizeCanonicalUrlCalls(normVal)}`;
}

function stripTrailingImportant(canonical) {
  return canonical.replace(/\s*!\s*important$/iu, "");
}

function addDeclarativeSegments(record, cssText) {
  if (typeof cssText !== "string" || !cssText) return;
  for (const segment of splitCssDeclarations(cssText)) {
    const trimmed = trimAsciiCssWhitespace(segment);
    if (!trimmed) continue;
    record.declarativeSegments.add(trimmed);
    const canonical = canonicalizeCssDeclaration(trimmed);
    const isUnsafe = !sanitizeCssDeclarations(trimmed);
    if (canonical) {
      record.declarativeCanonicalDecls.add(canonical);
      if (isUnsafe) record.declarativeCanonicalDecls.add(stripTrailingImportant(canonical));
    }
    if (isUnsafe) record.unsafeDeclarativeSegments.add(trimmed);
  }
}

function normalizeStylePropertyKey(key) {
  if (typeof key !== "string" || key.startsWith("--")) return key;
  if (/^[A-Z-]+$/u.test(key)) return key.toLowerCase();
  return key
    .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
    .replace(/^(Webkit|Moz|Ms|O)-/u, "-$1-")
    .toLowerCase();
}

function recordPlainObjectDeclarative(record, obj) {
  record.objectSnapshots.add(styleObjectSnapshotKey(obj));
  const addOpaqueEntry = (entryKey, opaqueVal) => {
    let set = record.declarativeOpaqueEntries.get(entryKey);
    if (!set) {
      set = new Set();
      record.declarativeOpaqueEntries.set(entryKey, set);
    }
    set.add(opaqueVal);
  };
  const addRejectedFragments = (formattedText) => {
    for (const fragment of splitCssDeclarations(formattedText)) {
      const trimmed = trimAsciiCssWhitespace(fragment);
      if (!trimmed) continue;
      record.declarativeSegments.add(trimmed);
      record.unsafeDeclarativeSegments.add(trimmed);
      record.rejectedDeclarativeFragments.add(trimmed);
      const canonical = canonicalizeCssDeclaration(trimmed);
      if (canonical) {
        record.declarativeCanonicalDecls.add(canonical);
        record.rejectedCanonicalFragments.add(canonical);
      }
    }
  };
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    const normKey = normalizeStylePropertyKey(key);
    if (isOpaqueStyleValue(value)) {
      addOpaqueEntry(key, value);
      if (normKey !== key) addOpaqueEntry(normKey, value);
      continue;
    }
    const strVal = String(value);
    record.declarativeEntries.add(JSON.stringify([key, strVal]));
    if (normKey !== key) record.declarativeEntries.add(JSON.stringify([normKey, strVal]));
    const formatted = `${key}:${strVal}`;
    const cleanEntry = sanitizeCssDeclarations({ [key]: strVal });
    if (cleanEntry) {
      addDeclarativeSegments(record, formatted);
      if (normKey !== key) addDeclarativeSegments(record, `${normKey}:${strVal}`);
    } else {
      addRejectedFragments(formatted);
      if (normKey !== key) addRejectedFragments(`${normKey}:${strVal}`);
    }
  }
}

function recordPlainArrayDeclarative(record, arr) {
  record.arraySnapshots.add(styleArraySnapshotKey(arr));
  if (arr.some(isOpaqueStyleValue)) {
    for (const item of arr) {
      if (item == null) continue;
      if (isOpaqueStyleValue(item)) {
        record.declarativeOpaqueArrayItems.add(item);
      } else {
        addDeclarativeSegments(record, String(item));
      }
    }
    return;
  }
  addDeclarativeSegments(record, arr.join(" "));
}

function snapshotPlainStyles(record) {
  for (const obj of record.plainStyleObjects) {
    if (!hasOwnEnumerableAccessor(obj)) record.objectSnapshots.add(styleObjectSnapshotKey(obj));
  }
  for (const arr of record.plainStyleArrays) {
    if (!hasOwnEnumerableAccessor(arr)) record.arraySnapshots.add(styleArraySnapshotKey(arr));
  }
}

function hasStyleProperty(node) {
  if (!node || typeof node !== "object" || !node.properties || typeof node.properties !== "object")
    return false;
  for (const key of Object.keys(node.properties)) {
    if (key.toLowerCase() === "style") return true;
  }
  return false;
}

function segmentMatchesRecord(trimmed, record) {
  if (!trimmed) return false;
  if (record.declarativeSegments.has(trimmed)) return true;
  if (record.declarativeCanonicalDecls.size > 0) {
    const canonical = canonicalizeCssDeclaration(trimmed);
    if (
      canonical &&
      (record.declarativeCanonicalDecls.has(canonical) ||
        record.declarativeCanonicalDecls.has(stripTrailingImportant(canonical)))
    )
      return true;
  }
  return false;
}

function isRejectedFragment(trimmed, record) {
  if (!trimmed) return false;
  if (record.rejectedDeclarativeFragments.has(trimmed)) return true;
  if (record.rejectedCanonicalFragments.size > 0) {
    const canonical = canonicalizeCssDeclaration(trimmed);
    if (canonical && record.rejectedCanonicalFragments.has(canonical)) return true;
  }
  return false;
}

function sanitizeStringForRecord(rawString, record) {
  if (
    record.declarativeSegments.size === 0 &&
    record.unsafeDeclarativeSegments.size === 0 &&
    record.rejectedDeclarativeFragments.size === 0
  )
    return { matched: false, value: undefined };
  const segments = splitCssDeclarations(rawString);
  let matchedAny = false;
  const kept = [];
  for (const segment of segments) {
    const trimmed = trimAsciiCssWhitespace(segment);
    if (!trimmed) continue;
    if (isRejectedFragment(trimmed, record)) {
      matchedAny = true;
      continue;
    }
    if (segmentMatchesRecord(trimmed, record)) {
      matchedAny = true;
      const clean = sanitizeCssDeclarations(segment);
      if (clean) kept.push(clean);
    } else {
      kept.push(trimmed);
    }
  }
  if (!matchedAny) return { matched: false, value: undefined };
  return { matched: true, value: kept.join(";") };
}

function sanitizePlainObjectForRecord(raw, record, forceMatch, coerceOpaqueValue) {
  let matchedAny = forceMatch;
  const kept = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue;
    const normKey = normalizeStylePropertyKey(key);
    if (isOpaqueStyleValue(value)) {
      if (
        record.declarativeOpaqueEntries.get(key)?.has(value) ||
        (normKey !== key && record.declarativeOpaqueEntries.get(normKey)?.has(value))
      ) {
        matchedAny = true;
        const clean = sanitizeCssDeclarations({ [key]: coerceOpaqueValue(value) });
        if (clean) kept.push(clean);
      } else {
        kept.push(`${key}:${coerceOpaqueValue(value)}`);
      }
      continue;
    }
    const strVal = String(value);
    const trimmedDecl = trimAsciiCssWhitespace(`${key}:${strVal}`);
    const normDecl = normKey !== key ? trimAsciiCssWhitespace(`${normKey}:${strVal}`) : undefined;
    if (
      record.declarativeEntries.has(JSON.stringify([key, strVal])) ||
      (normKey !== key && record.declarativeEntries.has(JSON.stringify([normKey, strVal]))) ||
      segmentMatchesRecord(trimmedDecl, record) ||
      (normDecl !== undefined && segmentMatchesRecord(normDecl, record))
    ) {
      matchedAny = true;
      const clean = sanitizeCssDeclarations({ [key]: strVal });
      if (clean) kept.push(clean);
    } else {
      kept.push(`${key}:${strVal}`);
    }
  }
  if (!matchedAny) return { matched: false, value: undefined };
  return { matched: true, value: kept.join(";") };
}

function sanitizePlainArrayForRecord(raw, record, forceMatch, coerceOpaqueValue) {
  if (!raw.some(isOpaqueStyleValue)) {
    const joined = raw.join(" ");
    const res = sanitizeStringForRecord(joined, record);
    if (res.matched) return res;
    return forceMatch
      ? { matched: true, value: trimAsciiCssWhitespace(joined) }
      : { matched: false, value: undefined };
  }
  const allDeclarative = raw.every((item) => {
    if (item == null) return true;
    if (isOpaqueStyleValue(item)) return record.declarativeOpaqueArrayItems.has(item);
    return segmentMatchesRecord(trimAsciiCssWhitespace(String(item)), record);
  });
  if (allDeclarative && raw.some((item) => item != null)) {
    const joined = raw
      .map((item) =>
        item == null ? "" : isOpaqueStyleValue(item) ? coerceOpaqueValue(item) : String(item),
      )
      .join(" ");
    return { matched: true, value: sanitizeCssDeclarations(joined) };
  }
  let matchedAny = forceMatch;
  const kept = [];
  for (const item of raw) {
    if (item == null) continue;
    if (isOpaqueStyleValue(item)) {
      if (record.declarativeOpaqueArrayItems.has(item)) {
        matchedAny = true;
        const clean = sanitizeCssDeclarations(coerceOpaqueValue(item));
        if (clean) kept.push(clean);
      } else {
        const trimmed = trimAsciiCssWhitespace(coerceOpaqueValue(item));
        if (trimmed) kept.push(trimmed);
      }
      continue;
    }
    const str = String(item);
    const res = sanitizeStringForRecord(str, record);
    if (res.matched) {
      matchedAny = true;
      if (res.value) kept.push(res.value);
    } else {
      const trimmed = trimAsciiCssWhitespace(str);
      if (trimmed) kept.push(trimmed);
    }
  }
  if (!matchedAny) return { matched: false, value: undefined };
  return { matched: true, value: kept.join(";") };
}

function sanitizeStyleValueForRecord(
  raw,
  record,
  allowAccessorCloneMatch,
  sanitizeRawStyle,
  coerceOpaqueValue,
) {
  if (record.values.has(raw)) {
    if (Array.isArray(raw) && !hasOwnEnumerableAccessor(raw)) {
      return sanitizePlainArrayForRecord(raw, record, true, coerceOpaqueValue);
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && !hasOwnEnumerableAccessor(raw)) {
      return sanitizePlainObjectForRecord(raw, record, true, coerceOpaqueValue);
    }
    return { matched: true, value: sanitizeRawStyle(raw) };
  }
  if (typeof raw === "string") {
    return sanitizeStringForRecord(raw, record);
  }
  if (Array.isArray(raw)) {
    if (hasOwnEnumerableAccessor(raw)) return { matched: false, value: undefined };
    if (record.arraySnapshots.size > 0 && record.arraySnapshots.has(styleArraySnapshotKey(raw))) {
      return sanitizePlainArrayForRecord(raw, record, true, coerceOpaqueValue);
    }
    if (allowAccessorCloneMatch && record.accessorArrayLengths.has(raw.length)) {
      return { matched: true, value: sanitizeRawStyle(raw) };
    }
    return sanitizePlainArrayForRecord(raw, record, false, coerceOpaqueValue);
  }
  if (!raw || typeof raw !== "object") return { matched: false, value: undefined };
  if (hasOwnEnumerableAccessor(raw)) return { matched: false, value: undefined };
  if (record.objectSnapshots.size > 0 && record.objectSnapshots.has(styleObjectSnapshotKey(raw))) {
    return sanitizePlainObjectForRecord(raw, record, true, coerceOpaqueValue);
  }
  if (
    allowAccessorCloneMatch &&
    record.accessorKeySignatures.has(JSON.stringify(Object.keys(raw)))
  ) {
    return { matched: true, value: sanitizeRawStyle(raw) };
  }
  if (
    record.declarativeEntries.size === 0 &&
    record.declarativeOpaqueEntries.size === 0 &&
    record.declarativeSegments.size === 0
  ) {
    return { matched: false, value: undefined };
  }
  return sanitizePlainObjectForRecord(raw, record, false, coerceOpaqueValue);
}

function candidateStyleMatchesRecord(node, record, allowAccessorCloneMatch = true) {
  if (!node || typeof node !== "object" || !node.properties || typeof node.properties !== "object")
    return false;
  for (const key of Object.keys(node.properties)) {
    if (key.toLowerCase() !== "style") continue;
    const raw = node.properties[key];
    if (record.values.has(raw)) return true;
    if (typeof raw === "string") {
      if (record.declarativeSegments.size === 0 && record.unsafeDeclarativeSegments.size === 0)
        continue;
      for (const segment of splitCssDeclarations(raw)) {
        if (segmentMatchesRecord(trimAsciiCssWhitespace(segment), record)) return true;
      }
      continue;
    }
    if (Array.isArray(raw)) {
      if (hasOwnEnumerableAccessor(raw)) continue;
      if (record.arraySnapshots.has(styleArraySnapshotKey(raw))) return true;
      if (allowAccessorCloneMatch && record.accessorArrayLengths.has(raw.length)) return true;
      if (raw.some(isOpaqueStyleValue)) {
        for (const item of raw) {
          if (item == null) continue;
          if (isOpaqueStyleValue(item)) {
            if (record.declarativeOpaqueArrayItems.has(item)) return true;
          } else {
            for (const segment of splitCssDeclarations(String(item))) {
              if (segmentMatchesRecord(trimAsciiCssWhitespace(segment), record)) return true;
            }
          }
        }
        continue;
      }
      for (const segment of splitCssDeclarations(raw.join(" "))) {
        if (segmentMatchesRecord(trimAsciiCssWhitespace(segment), record)) return true;
      }
      continue;
    }
    if (raw && typeof raw === "object") {
      if (hasOwnEnumerableAccessor(raw)) continue;
      if (record.objectSnapshots.has(styleObjectSnapshotKey(raw))) return true;
      if (
        allowAccessorCloneMatch &&
        record.accessorKeySignatures.has(JSON.stringify(Object.keys(raw)))
      )
        return true;
      if (
        record.declarativeEntries.size > 0 ||
        record.declarativeOpaqueEntries.size > 0 ||
        record.declarativeSegments.size > 0
      ) {
        for (const [entryKey, entryVal] of Object.entries(raw)) {
          if (entryVal == null) continue;
          const normKey = normalizeStylePropertyKey(entryKey);
          if (isOpaqueStyleValue(entryVal)) {
            if (
              record.declarativeOpaqueEntries.get(entryKey)?.has(entryVal) ||
              (normKey !== entryKey && record.declarativeOpaqueEntries.get(normKey)?.has(entryVal))
            )
              return true;
            continue;
          }
          const strVal = String(entryVal);
          if (
            record.declarativeEntries.has(JSON.stringify([entryKey, strVal])) ||
            (normKey !== entryKey &&
              record.declarativeEntries.has(JSON.stringify([normKey, strVal]))) ||
            segmentMatchesRecord(trimAsciiCssWhitespace(`${entryKey}:${strVal}`), record) ||
            (normKey !== entryKey &&
              segmentMatchesRecord(trimAsciiCssWhitespace(`${normKey}:${strVal}`), record))
          )
            return true;
        }
      }
    }
  }
  return false;
}

function addIndexBucket(map, key, record, bucketsByRecord) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { record, records: new Set([record]), recordByHash: undefined };
    map.set(key, bucket);
  } else {
    bucket.records.add(record);
  }
  let recordBuckets = bucketsByRecord.get(record);
  if (!recordBuckets) {
    recordBuckets = new Set();
    bucketsByRecord.set(record, recordBuckets);
  }
  recordBuckets.add(bucket);
}

function buildRecordStyleIndex(uniqueRecords, { unsafeOnly = false } = {}) {
  const byExactValue = new Map();
  const byObjectSnapshot = new Map();
  const byArraySnapshot = new Map();
  const byDeclarativeSegment = new Map();
  const byCanonicalDecl = new Map();
  const byDeclarativeEntry = new Map();
  const byDeclarativeOpaqueEntry = new Map();
  const byDeclarativeOpaqueArrayItem = new Map();
  const byUnsafeSegment = new Map();
  const byAccessorKeySignature = new Map();
  const byAccessorArrayLength = new Map();
  const bucketsByRecord = new Map();

  for (const record of uniqueRecords) {
    for (const value of record.values) addIndexBucket(byExactValue, value, record, bucketsByRecord);
    for (const snap of record.objectSnapshots)
      addIndexBucket(byObjectSnapshot, snap, record, bucketsByRecord);
    for (const snap of record.arraySnapshots)
      addIndexBucket(byArraySnapshot, snap, record, bucketsByRecord);
    if (!unsafeOnly) {
      for (const seg of record.declarativeSegments)
        addIndexBucket(byDeclarativeSegment, seg, record, bucketsByRecord);
      for (const canon of record.declarativeCanonicalDecls)
        addIndexBucket(byCanonicalDecl, canon, record, bucketsByRecord);
      for (const entry of record.declarativeEntries)
        addIndexBucket(byDeclarativeEntry, entry, record, bucketsByRecord);
    } else {
      for (const unsafeSeg of record.unsafeDeclarativeSegments) {
        const canonical = canonicalizeCssDeclaration(unsafeSeg);
        if (canonical) {
          addIndexBucket(byCanonicalDecl, canonical, record, bucketsByRecord);
          addIndexBucket(
            byCanonicalDecl,
            stripTrailingImportant(canonical),
            record,
            bucketsByRecord,
          );
        }
      }
      for (const canon of record.rejectedCanonicalFragments) {
        addIndexBucket(byCanonicalDecl, canon, record, bucketsByRecord);
      }
    }
    for (const [entryKey, opaqueSet] of record.declarativeOpaqueEntries) {
      for (const opaqueVal of opaqueSet) {
        addIndexBucket(
          byDeclarativeOpaqueEntry,
          JSON.stringify([entryKey, styleValueSnapshotToken(opaqueVal)]),
          record,
          bucketsByRecord,
        );
      }
    }
    for (const opaqueItem of record.declarativeOpaqueArrayItems) {
      addIndexBucket(byDeclarativeOpaqueArrayItem, opaqueItem, record, bucketsByRecord);
    }
    for (const unsafeSeg of record.unsafeDeclarativeSegments)
      addIndexBucket(byUnsafeSegment, unsafeSeg, record, bucketsByRecord);
    for (const sig of record.accessorKeySignatures)
      addIndexBucket(byAccessorKeySignature, sig, record, bucketsByRecord);
    for (const len of record.accessorArrayLengths)
      addIndexBucket(byAccessorArrayLength, len, record, bucketsByRecord);
  }

  return {
    byExactValue,
    byObjectSnapshot,
    byArraySnapshot,
    byDeclarativeSegment,
    byCanonicalDecl,
    byDeclarativeEntry,
    byDeclarativeOpaqueEntry,
    byDeclarativeOpaqueArrayItem,
    byUnsafeSegment,
    byAccessorKeySignature,
    byAccessorArrayLength,
    bucketsByRecord,
  };
}

function matchCandidateBucketsIndexed(candidate, styleIndex, includeAccessorClones = false) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !candidate.properties ||
    typeof candidate.properties !== "object"
  )
    return undefined;
  let matched;
  const addMatch = (bucket) => {
    if (!bucket) return;
    matched ??= new Set();
    matched.add(bucket);
  };
  const matchStringSegments = (cssText) => {
    if (
      styleIndex.byDeclarativeSegment.size === 0 &&
      styleIndex.byCanonicalDecl.size === 0 &&
      styleIndex.byUnsafeSegment.size === 0
    )
      return;
    for (const segment of splitCssDeclarations(cssText)) {
      const trimmed = trimAsciiCssWhitespace(segment);
      if (!trimmed) continue;
      const direct =
        styleIndex.byDeclarativeSegment.get(trimmed) ?? styleIndex.byUnsafeSegment.get(trimmed);
      if (direct) {
        addMatch(direct);
        continue;
      }
      if (styleIndex.byCanonicalDecl.size > 0) {
        const canonical = canonicalizeCssDeclaration(trimmed);
        const canonBucket = canonical
          ? (styleIndex.byCanonicalDecl.get(canonical) ??
            styleIndex.byCanonicalDecl.get(stripTrailingImportant(canonical)))
          : undefined;
        if (canonBucket) {
          addMatch(canonBucket);
        }
      }
    }
  };

  for (const key of Object.keys(candidate.properties)) {
    if (key.toLowerCase() !== "style") continue;
    const descriptor = Object.getOwnPropertyDescriptor(candidate.properties, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const raw = descriptor.value;
    const exactBucket = styleIndex.byExactValue.get(raw);
    if (exactBucket) {
      addMatch(exactBucket);
      continue;
    }
    if (typeof raw === "string") {
      matchStringSegments(raw);
      continue;
    }
    if (Array.isArray(raw)) {
      if (hasOwnEnumerableAccessor(raw)) continue;
      if (includeAccessorClones && styleIndex.byAccessorArrayLength.size > 0) {
        addMatch(styleIndex.byAccessorArrayLength.get(raw.length));
      }
      const arrBucket = styleIndex.byArraySnapshot.get(styleArraySnapshotKey(raw));
      if (arrBucket) {
        addMatch(arrBucket);
        continue;
      }
      if (raw.some(isOpaqueStyleValue)) {
        for (const item of raw) {
          if (item == null) continue;
          if (isOpaqueStyleValue(item)) {
            addMatch(styleIndex.byDeclarativeOpaqueArrayItem.get(item));
          } else {
            matchStringSegments(String(item));
          }
        }
        continue;
      }
      matchStringSegments(raw.join(" "));
      continue;
    }
    if (raw && typeof raw === "object") {
      if (hasOwnEnumerableAccessor(raw)) continue;
      if (includeAccessorClones && styleIndex.byAccessorKeySignature.size > 0) {
        addMatch(styleIndex.byAccessorKeySignature.get(JSON.stringify(Object.keys(raw))));
      }
      const objBucket = styleIndex.byObjectSnapshot.get(styleObjectSnapshotKey(raw));
      if (objBucket) {
        addMatch(objBucket);
        continue;
      }
      if (
        styleIndex.byDeclarativeEntry.size > 0 ||
        styleIndex.byDeclarativeOpaqueEntry.size > 0 ||
        styleIndex.byDeclarativeSegment.size > 0 ||
        styleIndex.byCanonicalDecl.size > 0 ||
        styleIndex.byUnsafeSegment.size > 0
      ) {
        for (const [entryKey, entryVal] of Object.entries(raw)) {
          if (entryVal == null) continue;
          const normKey = normalizeStylePropertyKey(entryKey);
          if (isOpaqueStyleValue(entryVal)) {
            const token = styleValueSnapshotToken(entryVal);
            addMatch(styleIndex.byDeclarativeOpaqueEntry.get(JSON.stringify([entryKey, token])));
            if (normKey !== entryKey) {
              addMatch(styleIndex.byDeclarativeOpaqueEntry.get(JSON.stringify([normKey, token])));
            }
            continue;
          }
          const strVal = String(entryVal);
          const entryBucket =
            styleIndex.byDeclarativeEntry.get(JSON.stringify([entryKey, strVal])) ??
            (normKey !== entryKey
              ? styleIndex.byDeclarativeEntry.get(JSON.stringify([normKey, strVal]))
              : undefined);
          if (entryBucket) {
            addMatch(entryBucket);
            continue;
          }
          matchStringSegments(`${entryKey}:${strVal}`);
          if (normKey !== entryKey) matchStringSegments(`${normKey}:${strVal}`);
        }
      }
    }
  }
  return matched;
}

function reconcileDetachedTrackedNodes(
  trackedInNode,
  beforeElements,
  beforeStyles,
  untrackedStyled,
  parentInfo,
  transformed,
  node,
  recordsByNode,
  trackNodeForRecord,
  sharedPreservedUntrackedClones,
) {
  const afterElements = collectSubtreeElements(transformed);
  const afterElementSet = new Set(afterElements);
  const detached = trackedInNode.filter((entry) => !afterElementSet.has(entry.node));
  const candidatesToInspect = [];
  for (const el of afterElements) {
    if (
      !beforeElements.has(el) ||
      !styleSnapshotEqual(captureStyleReferenceSnapshot(el), beforeStyles.get(el))
    ) {
      candidatesToInspect.push(el);
    }
  }
  if (detached.length === 0 && candidatesToInspect.length === 0) return;

  const pathCache = new Map();
  const getNodePath = (target) => {
    let cached = pathCache.get(target);
    if (cached) return cached;
    const reversed = [];
    let cursor = target;
    while (cursor && cursor !== node) {
      const link = parentInfo.get(cursor);
      if (!link) break;
      reversed.push(link.index);
      cursor = link.parent;
    }
    cached = reversed.reverse();
    pathCache.set(target, cached);
    return cached;
  };

  const uniqueRecords = new Set();
  for (const entry of trackedInNode) {
    for (const record of entry.records) {
      if (!uniqueRecords.has(record)) {
        uniqueRecords.add(record);
        snapshotPlainStyles(record);
      }
    }
  }

  let afterHashes;
  const ensureAfterHashIndex = () => {
    if (!afterHashes) afterHashes = computeSubtreeHashes(transformed);
  };
  const origStructureHashes = new Map();
  const origChildrenHashes = new Map();
  const wrapperChain =
    transformed === node ? [transformed] : collectSingleElementWrapperChain(transformed);
  const pathReconciledElements = new Set();

  if (detached.length > 0) {
    const claimedByRecord = new Map();
    const getClaimed = (record) => {
      let set = claimedByRecord.get(record);
      if (!set) {
        set = new Set();
        claimedByRecord.set(record, set);
      }
      return set;
    };

    // Phase 1: O(depth) path-first matching (checking deepest single-element wrapper base first
    // so outer same-tag wrappers never shadow cloned inner targets).
    const unmatched = [];
    for (const entry of detached) {
      for (const record of entry.records) {
        const claimed = getClaimed(record);
        let matched;
        for (let index = wrapperChain.length - 1; index >= 0; index--) {
          const candidate = getElementByPath(wrapperChain[index], getNodePath(entry.node));
          if (
            candidate &&
            !claimed.has(candidate) &&
            sameDirectStructure(candidate, entry.node) &&
            candidateStyleMatchesRecord(candidate, record)
          ) {
            matched = candidate;
            break;
          }
        }
        if (matched) {
          claimed.add(matched);
          pathReconciledElements.add(matched);
          record.clonedTargets.add(matched);
          trackNodeForRecord(record, matched);
        } else {
          unmatched.push({ entry, record });
        }
      }
    }

    // Phase 2: single O(|transformed|) combined structure+style index pass for moved/reshaped
    // clones so reordered repeated tokens with distinct styles stay linear.
    if (unmatched.length > 0) {
      ensureAfterHashIndex();
      const unmatchedRecords = new Set(unmatched.map((item) => item.record));
      const phase2Index = buildRecordStyleIndex(unmatchedRecords);
      const byStructAndKey = new Map();
      const byChildAndKey = new Map();
      const matchingByKey = new Map();
      const pushIndexed = (outerMap, hash, key, el) => {
        if (!hash) return;
        let inner = outerMap.get(hash);
        if (!inner) {
          inner = new Map();
          outerMap.set(hash, inner);
        }
        let slot = inner.get(key);
        if (!slot) {
          slot = { list: [], cursor: 0 };
          inner.set(key, slot);
        }
        slot.list.push(el);
      };
      const addMatchingKey = (key, el) => {
        let set = matchingByKey.get(key);
        if (!set) {
          set = new Set();
          matchingByKey.set(key, set);
        }
        set.add(el);
      };
      for (const el of afterElements) {
        if (!hasStyleProperty(el)) continue;
        const structHash = afterHashes.structureHashes.get(el);
        const childHash = afterHashes.childrenHashes.get(el);
        const matchedBuckets = matchCandidateBucketsIndexed(el, phase2Index, true);
        if (matchedBuckets) {
          for (const bucket of matchedBuckets) {
            pushIndexed(byStructAndKey, structHash, bucket, el);
            pushIndexed(byChildAndKey, childHash, bucket, el);
            addMatchingKey(bucket, el);
          }
        }
      }

      const phase2Used = new Set();
      const claimedNodeByEntry = new Map();
      const keysForRecord = (record) => phase2Index.bucketsByRecord.get(record);
      const claimFromMap = (outerMap, hash, keys, claimed) => {
        if (!hash || !keys) return undefined;
        const inner = outerMap.get(hash);
        if (!inner) return undefined;
        for (const key of keys) {
          const slot = inner.get(key);
          if (!slot) continue;
          while (slot.cursor < slot.list.length && phase2Used.has(slot.list[slot.cursor])) {
            slot.cursor++;
          }
          for (let index = slot.cursor; index < slot.list.length; index++) {
            const candidate = slot.list[index];
            if (!claimed.has(candidate) && !phase2Used.has(candidate)) {
              if (index === slot.cursor) slot.cursor++;
              return candidate;
            }
          }
        }
        return undefined;
      };

      const stillUnmatched = [];
      for (const item of unmatched) {
        const { entry, record } = item;
        if (!origStructureHashes.has(entry.node)) {
          computeSubtreeHashes(entry.node, origStructureHashes, origChildrenHashes);
        }
        const claimed = getClaimed(record);
        let matched;
        const sharedMatch = claimedNodeByEntry.get(entry);
        if (
          sharedMatch &&
          !claimed.has(sharedMatch) &&
          candidateStyleMatchesRecord(sharedMatch, record)
        ) {
          matched = sharedMatch;
        }
        if (!matched) {
          const keys = keysForRecord(record);
          matched =
            claimFromMap(byStructAndKey, origStructureHashes.get(entry.node), keys, claimed) ??
            claimFromMap(byChildAndKey, origChildrenHashes.get(entry.node), keys, claimed);
        }
        if (matched) {
          claimed.add(matched);
          phase2Used.add(matched);
          if (!claimedNodeByEntry.has(entry)) claimedNodeByEntry.set(entry, matched);
          pathReconciledElements.add(matched);
          record.clonedTargets.add(matched);
          trackNodeForRecord(record, matched);
        } else {
          stillUnmatched.push(item);
        }
      }

      if (stillUnmatched.length > 0 && matchingByKey.size > 0) {
        const leafCandidatesByKey = new Map();
        const getLeafSlot = (key) => {
          let slot = leafCandidatesByKey.get(key);
          if (slot !== undefined) return slot;
          const matchingSet = matchingByKey.get(key);
          if (!matchingSet || matchingSet.size === 0) {
            slot = null;
            leafCandidatesByKey.set(key, slot);
            return slot;
          }
          if (matchingSet.size === 1) {
            slot = { list: [...matchingSet], cursor: 0 };
            leafCandidatesByKey.set(key, slot);
            return slot;
          }
          const hasMatchingInSubtree = new Set();
          const leafMatching = [];
          for (let index = afterElements.length - 1; index >= 0; index--) {
            const el = afterElements[index];
            let descendantMatches = false;
            if (Array.isArray(el.children)) {
              for (const child of el.children) {
                if (hasMatchingInSubtree.has(child)) {
                  descendantMatches = true;
                  break;
                }
              }
            }
            const selfMatches = matchingSet.has(el);
            if (selfMatches && !descendantMatches) leafMatching.push(el);
            if (selfMatches || descendantMatches) hasMatchingInSubtree.add(el);
          }
          slot = { list: leafMatching.reverse(), cursor: 0 };
          leafCandidatesByKey.set(key, slot);
          return slot;
        };
        const fallbackClaimed = new Set();
        for (const { record } of stillUnmatched) {
          const keys = keysForRecord(record);
          if (!keys) continue;
          const claimed = getClaimed(record);
          let matched;
          for (const key of keys) {
            const slot = getLeafSlot(key);
            if (!slot) continue;
            while (
              slot.cursor < slot.list.length &&
              (fallbackClaimed.has(slot.list[slot.cursor]) ||
                phase2Used.has(slot.list[slot.cursor]))
            ) {
              slot.cursor++;
            }
            for (let index = slot.cursor; index < slot.list.length; index++) {
              const candidate = slot.list[index];
              if (
                !claimed.has(candidate) &&
                !fallbackClaimed.has(candidate) &&
                !phase2Used.has(candidate)
              ) {
                if (index === slot.cursor) slot.cursor++;
                matched = candidate;
                break;
              }
            }
            if (matched) break;
          }
          if (matched) {
            claimed.add(matched);
            fallbackClaimed.add(matched);
            pathReconciledElements.add(matched);
            record.clonedTargets.add(matched);
            trackNodeForRecord(record, matched);
          }
        }
      }
    }
  }

  // Reconcile any newly introduced elements (not already path-reconciled) and any surviving
  // elements whose styles changed using O(1) indexed lookups across active records.
  if (candidatesToInspect.length > 0) {
    const preservedUntrackedClones = new Set();
    for (const info of untrackedStyled) {
      if (afterElementSet.has(info.node)) continue;
      for (let index = wrapperChain.length - 1; index >= 0; index--) {
        const candidate = getElementByPath(wrapperChain[index], getNodePath(info.node));
        if (
          candidate &&
          !beforeElements.has(candidate) &&
          sameDirectStructure(candidate, info.node) &&
          styleSnapshotEqual(captureStyleReferenceSnapshot(candidate), info.styleSnapshot)
        ) {
          preservedUntrackedClones.add(candidate);
          sharedPreservedUntrackedClones?.add(candidate);
          break;
        }
      }
    }

    const remainingCandidates = candidatesToInspect.filter(
      (el) => !pathReconciledElements.has(el) && !preservedUntrackedClones.has(el),
    );
    if (remainingCandidates.length === 0) return;

    const trackedInAfter = new Set();
    for (const el of afterElements) {
      const recs = recordsByNode.get(el);
      if (!recs) continue;
      for (const rec of recs) {
        if (uniqueRecords.has(rec)) {
          trackedInAfter.add(el);
          break;
        }
      }
    }
    const hasTrackedInSubtree = new Set();
    const trackedAncestors = new Set();
    for (let index = afterElements.length - 1; index >= 0; index--) {
      const el = afterElements[index];
      let descendantTracked = false;
      if (Array.isArray(el.children)) {
        for (const child of el.children) {
          if (hasTrackedInSubtree.has(child)) {
            descendantTracked = true;
            break;
          }
        }
      }
      if (descendantTracked) trackedAncestors.add(el);
      if (descendantTracked || trackedInAfter.has(el)) hasTrackedInSubtree.add(el);
    }

    const styleIndex = buildRecordStyleIndex(uniqueRecords);
    let trackedHashesByRecord;
    const ensureTrackedHashesByRecord = () => {
      if (trackedHashesByRecord) return;
      ensureAfterHashIndex();
      trackedHashesByRecord = new Map();
      for (const entry of trackedInNode) {
        if (!origStructureHashes.has(entry.node)) {
          computeSubtreeHashes(entry.node, origStructureHashes, origChildrenHashes);
        }
        const hash = origStructureHashes.get(entry.node);
        if (!hash) continue;
        for (const record of entry.records) {
          let set = trackedHashesByRecord.get(record);
          if (!set) {
            set = new Set();
            trackedHashesByRecord.set(record, set);
          }
          set.add(hash);
        }
      }
    };

    const detachedRecords = new Set();
    for (const entry of detached) {
      for (const record of entry.records) detachedRecords.add(record);
    }
    const resolveBucketDetachedRecord = (bucket) => {
      if (detachedRecords.size === 0) return undefined;
      if (!Object.hasOwn(bucket, "detachedRecord")) {
        let found;
        for (const rec of bucket.records) {
          if (detachedRecords.has(rec)) {
            found = rec;
            break;
          }
        }
        bucket.detachedRecord = found;
      }
      return bucket.detachedRecord;
    };

    const resolveBucketRecordByHash = (bucket, candidateHash) => {
      if (!candidateHash) return undefined;
      if (!bucket.recordByHash) {
        ensureTrackedHashesByRecord();
        bucket.recordByHash = new Map();
        for (const rec of bucket.records) {
          const hashes = trackedHashesByRecord.get(rec);
          if (!hashes) continue;
          for (const hash of hashes) {
            if (!bucket.recordByHash.has(hash)) bucket.recordByHash.set(hash, rec);
          }
        }
      }
      return bucket.recordByHash.get(candidateHash);
    };

    for (const candidate of remainingCandidates) {
      const isNewElement = !beforeElements.has(candidate);
      if (isNewElement && trackedAncestors.has(candidate)) continue;
      const matchedBuckets = matchCandidateBucketsIndexed(candidate, styleIndex, isNewElement);
      if (matchedBuckets) {
        for (const bucket of matchedBuckets) {
          let targetRecord;
          if (isNewElement) {
            ensureTrackedHashesByRecord();
            const candidateHash = afterHashes.structureHashes.get(candidate);
            targetRecord =
              resolveBucketRecordByHash(bucket, candidateHash) ??
              resolveBucketDetachedRecord(bucket);
          } else {
            targetRecord = bucket.record;
          }
          if (!targetRecord || targetRecord.trackedNodes.has(candidate)) continue;
          targetRecord.clonedTargets.add(candidate);
          trackNodeForRecord(targetRecord, candidate);
        }
      }
    }
  }
}

function canAssignOwnDataProperty(obj, key) {
  const own = Object.getOwnPropertyDescriptor(obj, key);
  if (own) return Object.hasOwn(own, "value") && own.writable === true;
  if (!Object.isExtensible(obj)) return false;
  let proto = Object.getPrototypeOf(obj);
  while (proto) {
    const inherited = Object.getOwnPropertyDescriptor(proto, key);
    if (inherited) return Object.hasOwn(inherited, "value") && inherited.writable === true;
    proto = Object.getPrototypeOf(proto);
  }
  return true;
}

function replaceTreeNodes(root, replacements, scopePaths, clonedNodes) {
  if (replacements.size === 0) return root;
  const memo = clonedNodes ?? new Map();
  const cloneIfNeeded = (current) => {
    if (!current || typeof current !== "object") return current;
    if (memo.has(current)) return memo.get(current);
    let next = replacements.get(current) ?? current;
    if (Array.isArray(next.children)) {
      let childrenChanged = false;
      const nextChildren = next.children.map((child) => {
        const updated = cloneIfNeeded(child);
        if (updated !== child) childrenChanged = true;
        return updated;
      });
      if (childrenChanged) {
        let canMutateInPlace = next === current && !Object.isFrozen(next.children);
        if (canMutateInPlace) {
          for (let index = 0; index < nextChildren.length; index++) {
            if (nextChildren[index] === next.children[index]) continue;
            if (!canAssignOwnDataProperty(next.children, index)) {
              canMutateInPlace = false;
              break;
            }
          }
        }
        if (canMutateInPlace) {
          for (let index = 0; index < nextChildren.length; index++) {
            if (nextChildren[index] !== next.children[index]) {
              next.children[index] = nextChildren[index];
            }
          }
        } else if (next === current && !canAssignOwnDataProperty(next, "children")) {
          next = { ...next, children: nextChildren };
        } else if (next !== current) {
          next = { ...next, children: nextChildren };
        } else {
          next.children = nextChildren;
        }
      }
    }
    if (next !== current) {
      if (scopePaths && scopePaths.has(current)) {
        scopePaths.set(next, scopePaths.get(current));
      }
      Object.defineProperty(next, SANITIZED_CLONE_ORIGIN, {
        value: current[SANITIZED_CLONE_ORIGIN] ?? current,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    memo.set(current, next);
    return next;
  };
  return cloneIfNeeded(root);
}

function clonePropertiesWithUpdates(source, updates) {
  const next = {};
  for (const key of Object.keys(source)) {
    if (updates.has(key)) {
      const updated = updates.get(key);
      if (updated) assignOwnProperty(next, key, updated);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) Object.defineProperty(next, key, descriptor);
  }
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    if (Object.prototype.propertyIsEnumerable.call(source, symbol)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, symbol);
      if (descriptor) Object.defineProperty(next, symbol, descriptor);
    }
  }
  return next;
}

function recordNeedsExternalSanitization(record) {
  if (
    record.unsafeDeclarativeSegments.size > 0 ||
    record.rejectedDeclarativeFragments.size > 0 ||
    record.declarativeOpaqueEntries.size > 0 ||
    record.declarativeOpaqueArrayItems.size > 0 ||
    record.accessorKeySignatures.size > 0 ||
    record.accessorArrayLengths.size > 0
  )
    return true;
  for (const value of record.values) {
    if (typeof value !== "string" && value != null && typeof value !== "object") return true;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0 &&
      typeof value.toString === "function" &&
      value.toString !== Object.prototype.toString
    )
      return true;
  }
  return false;
}

function sanitizePendingDecorations(
  pendingSanitizations,
  emittedRoot,
  scopePaths,
  clonedNodes,
  beforeDecorationState,
  extraRoots,
) {
  const liveElementsList = collectSubtreeElements(emittedRoot);
  const liveElements = new Set(liveElementsList);
  if (extraRoots) {
    for (const extraRoot of extraRoots) {
      for (const el of collectSubtreeElements(extraRoot)) {
        liveElements.add(el);
      }
    }
  }
  const trackedElements = new Set();
  const sanitizedObjects = new Map();
  const coercedOpaqueValues = new Map();
  const frozenReplacements = new Map();
  const coerceOpaqueValue = (value) => {
    let cached = coercedOpaqueValues.get(value);
    if (cached === undefined) {
      cached = String(value);
      coercedOpaqueValues.set(value, cached);
    }
    return cached;
  };
  const sanitizeRawStyle = (raw) => {
    if (raw && typeof raw === "object") {
      let cached = sanitizedObjects.get(raw);
      if (cached === undefined) {
        cached = sanitizeCssDeclarations(Array.isArray(raw) ? raw.join(" ") : raw);
        sanitizedObjects.set(raw, cached);
      }
      return cached;
    }
    return sanitizeCssDeclarations(typeof raw === "string" ? raw : String(raw ?? ""));
  };
  const sanitizeTargetForRecord = (target, record, allowAccessorCloneMatch) => {
    const effectiveTarget = frozenReplacements.get(target) ?? target;
    if (!effectiveTarget.properties || typeof effectiveTarget.properties !== "object") return false;
    const styleKeys = Object.keys(effectiveTarget.properties).filter(
      (key) => key.toLowerCase() === "style",
    );
    if (styleKeys.length === 0) return false;
    const updates = new Map();
    for (const key of styleKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(effectiveTarget.properties, key);
      const isAccessor = Boolean(descriptor && !Object.hasOwn(descriptor, "value"));
      const raw = effectiveTarget.properties[key];
      const result = sanitizeStyleValueForRecord(
        raw,
        record,
        allowAccessorCloneMatch,
        sanitizeRawStyle,
        coerceOpaqueValue,
      );
      if (result.matched) {
        if (isAccessor || !result.value || result.value !== raw) updates.set(key, result.value);
      }
    }
    if (updates.size === 0) return false;
    const nextProperties = clonePropertiesWithUpdates(effectiveTarget.properties, updates);
    if (canAssignOwnDataProperty(effectiveTarget, "properties")) {
      effectiveTarget.properties = nextProperties;
    } else {
      frozenReplacements.set(target, { ...effectiveTarget, properties: nextProperties });
    }
    return true;
  };
  for (const record of pendingSanitizations) {
    snapshotPlainStyles(record);
    for (const target of record.trackedNodes) {
      if (!liveElements.has(target)) continue;
      trackedElements.add(target);
      sanitizeTargetForRecord(target, record, record.clonedTargets.has(target));
    }
  }
  if (beforeDecorationState) {
    const externalRecords = pendingSanitizations.filter(recordNeedsExternalSanitization);
    if (externalRecords.length > 0) {
      const hasTrackedInSubtree = new Set();
      const trackedAncestors = new Set();
      for (let index = liveElementsList.length - 1; index >= 0; index--) {
        const el = liveElementsList[index];
        let descendantTracked = false;
        if (Array.isArray(el.children)) {
          for (const child of el.children) {
            if (hasTrackedInSubtree.has(child)) {
              descendantTracked = true;
              break;
            }
          }
        }
        if (descendantTracked) trackedAncestors.add(el);
        if (descendantTracked || trackedElements.has(el)) hasTrackedInSubtree.add(el);
      }
      const externalIndex = buildRecordStyleIndex(externalRecords, { unsafeOnly: true });
      const recordsByPropertyObj = new Map();
      const recordsByStyleObj = new Map();
      const addToMapSet = (map, key, value) => {
        let set = map.get(key);
        if (!set) {
          set = new Set();
          map.set(key, set);
        }
        set.add(value);
      };
      for (const record of externalRecords) {
        if (record.propertyObjects) {
          for (const propObj of record.propertyObjects) {
            addToMapSet(recordsByPropertyObj, propObj, record);
          }
        }
        for (const val of record.values) {
          if (val && typeof val === "object") addToMapSet(recordsByStyleObj, val, record);
        }
      }
      const recordDedupKey = (record) => {
        if (
          record.declarativeOpaqueEntries.size > 0 ||
          record.declarativeOpaqueArrayItems.size > 0 ||
          record.accessorKeySignatures.size > 0 ||
          record.accessorArrayLengths.size > 0
        )
          return undefined;
        return JSON.stringify([
          [...record.declarativeSegments].sort(),
          [...record.declarativeCanonicalDecls].sort(),
          [...record.unsafeDeclarativeSegments].sort(),
          [...record.rejectedDeclarativeFragments].sort(),
          [...record.rejectedCanonicalFragments].sort(),
          [...record.declarativeEntries].sort(),
        ]);
      };
      let emittedHashes;
      let recordsByStructHash;
      let recordsByChildHash;
      const ensureExternalHashes = () => {
        if (emittedHashes) return;
        emittedHashes = computeSubtreeHashes(emittedRoot);
        recordsByStructHash = new Map();
        recordsByChildHash = new Map();
        const seenStructSig = new Map();
        const seenChildSig = new Map();
        const detachedStructHashes = new Map();
        const detachedChildHashes = new Map();
        const addDedupedHashRecord = (hashMap, sigMap, hash, dedupKey, record) => {
          if (dedupKey !== undefined) {
            let sigs = sigMap.get(hash);
            if (!sigs) {
              sigs = new Set();
              sigMap.set(hash, sigs);
            }
            if (sigs.has(dedupKey)) return;
            sigs.add(dedupKey);
          }
          addToMapSet(hashMap, hash, record);
        };
        for (const record of externalRecords) {
          const dedupKey = recordDedupKey(record);
          for (const target of record.trackedNodes) {
            let sHash = emittedHashes.structureHashes.get(target);
            let cHash = emittedHashes.childrenHashes.get(target);
            if (!sHash) {
              if (!detachedStructHashes.has(target)) {
                computeSubtreeHashes(target, detachedStructHashes, detachedChildHashes);
              }
              sHash = detachedStructHashes.get(target);
              cHash = detachedChildHashes.get(target);
            }
            if (sHash) {
              addDedupedHashRecord(recordsByStructHash, seenStructSig, sHash, dedupKey, record);
            }
            if (cHash && Array.isArray(target.children) && target.children.length > 0) {
              addDedupedHashRecord(recordsByChildHash, seenChildSig, cHash, dedupKey, record);
            }
          }
        }
      };
      const collectProvenanceRecords = (el, wasPreExisting) => {
        let provenance;
        const addSet = (set) => {
          if (!set) return;
          if (!provenance) {
            provenance = new Set(set);
            return;
          }
          for (const rec of set) provenance.add(rec);
        };
        if (el.properties && typeof el.properties === "object") {
          addSet(recordsByPropertyObj.get(el.properties));
          for (const key of Object.keys(el.properties)) {
            if (key.toLowerCase() !== "style") continue;
            const descriptor = Object.getOwnPropertyDescriptor(el.properties, key);
            if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
            const val = descriptor.value;
            if (val && typeof val === "object") addSet(recordsByStyleObj.get(val));
          }
        }
        if (!wasPreExisting) {
          ensureExternalHashes();
          const sHash = emittedHashes.structureHashes.get(el);
          if (sHash) addSet(recordsByStructHash.get(sHash));
          if (Array.isArray(el.children) && el.children.length > 0) {
            const cHash = emittedHashes.childrenHashes.get(el);
            if (cHash) addSet(recordsByChildHash.get(cHash));
          }
        }
        return provenance;
      };
      for (const el of liveElementsList) {
        if (
          trackedElements.has(el) ||
          pendingSanitizations.preservedUntrackedClones?.has(el) ||
          !hasStyleProperty(el)
        )
          continue;
        const wasPreExisting = beforeDecorationState.elements.has(el);
        if (wasPreExisting) {
          if (
            styleSnapshotEqual(
              captureStyleReferenceSnapshot(el),
              beforeDecorationState.styles.get(el),
            )
          )
            continue;
        } else if (trackedAncestors.has(el)) {
          continue;
        }
        const matchedBuckets = matchCandidateBucketsIndexed(el, externalIndex, !wasPreExisting);
        if (!matchedBuckets) continue;
        const provenanceRecords = collectProvenanceRecords(el, wasPreExisting);
        if (!provenanceRecords || provenanceRecords.size === 0) continue;
        const triedRecords = new Set();
        for (const bucket of matchedBuckets) {
          const [smaller, larger] =
            provenanceRecords.size <= bucket.records.size
              ? [provenanceRecords, bucket.records]
              : [bucket.records, provenanceRecords];
          for (const record of smaller) {
            if (triedRecords.has(record) || !larger.has(record)) continue;
            triedRecords.add(record);
            sanitizeTargetForRecord(el, record, !wasPreExisting);
          }
        }
      }
    }
  }
  if (frozenReplacements.size === 0) return emittedRoot;
  const updatedRoot = replaceTreeNodes(emittedRoot, frozenReplacements, scopePaths, clonedNodes);
  if (clonedNodes) {
    for (const [original, replacement] of frozenReplacements) {
      if (!clonedNodes.has(original)) clonedNodes.set(original, replacement);
    }
  }
  return updatedRoot;
}

function createDeclarativeStyleRecord(styleValue) {
  const record = {
    trackedNodes: new Set(),
    clonedTargets: new Set(),
    propertyObjects: new Set(),
    values: new Set([styleValue]),
    objectSnapshots: new Set(),
    arraySnapshots: new Set(),
    declarativeSegments: new Set(),
    declarativeCanonicalDecls: new Set(),
    unsafeDeclarativeSegments: new Set(),
    rejectedDeclarativeFragments: new Set(),
    rejectedCanonicalFragments: new Set(),
    declarativeEntries: new Set(),
    declarativeOpaqueEntries: new Map(),
    declarativeOpaqueArrayItems: new Set(),
    plainStyleObjects: [],
    plainStyleArrays: [],
    accessorKeySignatures: new Set(),
    accessorArrayLengths: new Set(),
  };
  if (typeof styleValue === "string") {
    addDeclarativeSegments(record, styleValue);
  } else if (Array.isArray(styleValue)) {
    if (hasOwnEnumerableAccessor(styleValue)) {
      record.accessorArrayLengths.add(styleValue.length);
    } else {
      record.plainStyleArrays.push(styleValue);
      recordPlainArrayDeclarative(record, styleValue);
    }
  } else if (styleValue && typeof styleValue === "object") {
    if (hasOwnEnumerableAccessor(styleValue)) {
      record.accessorKeySignatures.add(JSON.stringify(Object.keys(styleValue)));
    } else {
      record.plainStyleObjects.push(styleValue);
      recordPlainObjectDeclarative(record, styleValue);
    }
  }
  return record;
}

function cloneDeclarativeStyleTemplate(template, styleValue, mergedProperties) {
  const opaqueEntries = new Map();
  for (const [entryKey, opaqueSet] of template.declarativeOpaqueEntries) {
    opaqueEntries.set(entryKey, new Set(opaqueSet));
  }
  return {
    trackedNodes: new Set(),
    clonedTargets: new Set(),
    propertyObjects: new Set([mergedProperties]),
    values: new Set([styleValue]),
    objectSnapshots: new Set(template.objectSnapshots),
    arraySnapshots: new Set(template.arraySnapshots),
    declarativeSegments: new Set(template.declarativeSegments),
    declarativeCanonicalDecls: new Set(template.declarativeCanonicalDecls),
    unsafeDeclarativeSegments: new Set(template.unsafeDeclarativeSegments),
    rejectedDeclarativeFragments: new Set(template.rejectedDeclarativeFragments),
    rejectedCanonicalFragments: new Set(template.rejectedCanonicalFragments),
    declarativeEntries: new Set(template.declarativeEntries),
    declarativeOpaqueEntries: opaqueEntries,
    declarativeOpaqueArrayItems: new Set(template.declarativeOpaqueArrayItems),
    plainStyleObjects: [...template.plainStyleObjects],
    plainStyleArrays: [...template.plainStyleArrays],
    accessorKeySignatures: new Set(template.accessorKeySignatures),
    accessorArrayLengths: new Set(template.accessorArrayLengths),
  };
}

function applyDecorations(codeNode, decorations, source, logicalLines) {
  const captured = decorations.map(captureDecoration);
  for (const item of captured) validateDecorationDescriptor(item);
  const hasDecorationCallbacks = captured.some((item) => typeof item.transform === "function");
  const initialStyleTemplates = new Map();
  if (hasDecorationCallbacks) {
    for (let index = 0; index < captured.length; index++) {
      const props = captured[index].properties;
      if (!props || typeof props !== "object") continue;
      let hasStyle = false;
      let styleValue;
      for (const key of Object.keys(props)) {
        if (key.toLowerCase() !== "style") continue;
        const descriptor = Object.getOwnPropertyDescriptor(props, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
          hasStyle = false;
          break;
        }
        hasStyle = true;
        styleValue = descriptor.value;
      }
      if (hasStyle) {
        initialStyleTemplates.set(index, {
          styleValue,
          template: createDeclarativeStyleRecord(styleValue),
        });
      }
    }
  }
  const sanitizedStyleByDecoration = new Map();
  const sanitizedStyleObjects = new Map();
  const emptyPreSanitizedNodes = new Set();
  const sanitizeCallbackFreeStyle = (decorationIndex, raw) => {
    const cached = sanitizedStyleByDecoration.get(decorationIndex);
    if (cached && Object.is(cached.raw, raw)) return cached.sanitized;
    let sanitized;
    if (raw && typeof raw === "object") {
      sanitized = sanitizedStyleObjects.get(raw);
      if (sanitized === undefined) {
        sanitized = sanitizeCssDeclarations(Array.isArray(raw) ? raw.join(" ") : raw);
        sanitizedStyleObjects.set(raw, sanitized);
      }
    } else {
      sanitized = sanitizeCssDeclarations(typeof raw === "string" ? raw : String(raw ?? ""));
    }
    sanitizedStyleByDecoration.set(decorationIndex, { raw, sanitized });
    return sanitized;
  };
  const prepared = decorationNative((native) =>
    native.decorationSections(source, decorationRanges(captured)),
  );
  const sections = prepared.sections;
  const items = captured.map((item, index) => ({ ...item, ...prepared.ranges[index] }));
  const lines =
    logicalLines ??
    (codeNode.children || []).filter((node) => node.type === "element" && node.tagName === "span");
  const appliedDecorations = new Set();
  const pendingSanitizations = [];
  const preservedUntrackedClones = new Set();
  pendingSanitizations.preservedUntrackedClones = preservedUntrackedClones;
  const recordsByNode = new Map();
  const trackNodeForRecord = (record, targetNode) => {
    record.trackedNodes.add(targetNode);
    let records = recordsByNode.get(targetNode);
    if (!records) {
      records = new Set();
      recordsByNode.set(targetNode, records);
    }
    records.add(record);
  };
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
      appliedDecorations.add(edit.decoration);
      const decoration = items[edit.decoration];
      const tagName = decoration.tagName || "span";
      if (!isSafeDecorationTagName(tagName))
        throw new ShikiError(`Invalid HTML tag name ${JSON.stringify(tagName)}`, "ERR_USAGE");
      const line = objects[edit.line];
      let node = objects[edit.node];
      if (edit.target === "wrapper") {
        node = {
          type: "element",
          tagName,
          properties: {},
          children: line.children.slice(edit.start, edit.start + edit.count),
        };
        objects[edit.node] = node;
      }
      node.tagName = tagName;
      const mergedProperties = {};
      const existingProperties = node.properties || {};
      for (const [key, value] of Object.entries(existingProperties))
        assignOwnProperty(mergedProperties, key, value);
      for (const symbol of Object.getOwnPropertySymbols(existingProperties)) {
        if (Object.prototype.propertyIsEnumerable.call(existingProperties, symbol))
          assignOwnProperty(mergedProperties, symbol, existingProperties[symbol]);
      }
      let hasDecorationStyle = false;
      let decorationStyleValue;
      const decorationProperties = decoration.properties || {};
      for (const key of Object.keys(decorationProperties)) {
        const value = decorationProperties[key];
        if (!isSafeDecorationAttributeName(key))
          throw new ShikiError(`Invalid HTML attribute name ${JSON.stringify(key)}`, "ERR_USAGE");
        if (!isSafeDecorationAttributeValue(key, value))
          throw new ShikiError(
            `Invalid HTML attribute value for ${JSON.stringify(key)}`,
            "ERR_USAGE",
          );
        if (key.toLowerCase() === "style") {
          hasDecorationStyle = true;
          decorationStyleValue = value;
          for (const existingKey of Object.keys(mergedProperties)) {
            if (existingKey.toLowerCase() === "style" && existingKey !== "style") {
              delete mergedProperties[existingKey];
            }
          }
          assignOwnProperty(mergedProperties, "style", value);
          continue;
        }
        assignOwnProperty(mergedProperties, key, value);
      }
      for (const symbol of Object.getOwnPropertySymbols(decorationProperties)) {
        if (Object.prototype.propertyIsEnumerable.call(decorationProperties, symbol))
          assignOwnProperty(mergedProperties, symbol, decorationProperties[symbol]);
      }
      const canPreSanitizeStyle = hasDecorationStyle && !hasDecorationCallbacks;
      if (canPreSanitizeStyle) {
        const sanitized = sanitizeCallbackFreeStyle(edit.decoration, decorationStyleValue);
        if (sanitized) {
          assignOwnProperty(mergedProperties, "style", sanitized);
          emptyPreSanitizedNodes.delete(node);
        } else {
          assignOwnProperty(mergedProperties, "style", "");
          emptyPreSanitizedNodes.add(node);
        }
      }
      node.properties = mergedProperties;
      if (decoration.properties?.class) addClassToHast(node, decoration.properties.class);
      let currentRecord;
      if (hasDecorationStyle) {
        const previousRecords = recordsByNode.get(node);
        if (previousRecords) {
          for (const prev of previousRecords) {
            prev.trackedNodes.delete(node);
            prev.clonedTargets.delete(node);
          }
          recordsByNode.delete(node);
        }
        if (!canPreSanitizeStyle) {
          const initialTemplate = initialStyleTemplates.get(edit.decoration);
          if (initialTemplate && Object.is(initialTemplate.styleValue, decorationStyleValue)) {
            currentRecord = cloneDeclarativeStyleTemplate(
              initialTemplate.template,
              decorationStyleValue,
              mergedProperties,
            );
          } else {
            currentRecord = createDeclarativeStyleRecord(decorationStyleValue);
            currentRecord.propertyObjects.add(mergedProperties);
            if (
              !initialTemplate &&
              decorationStyleValue &&
              typeof decorationStyleValue === "object"
            ) {
              initialStyleTemplates.set(edit.decoration, {
                styleValue: decorationStyleValue,
                template: currentRecord,
              });
            }
          }
          if (node.properties && typeof node.properties === "object") {
            currentRecord.propertyObjects.add(node.properties);
          }
          trackNodeForRecord(currentRecord, node);
          pendingSanitizations.push(currentRecord);
        }
      }
      const {
        tracked: trackedInNode,
        beforeElements,
        beforeStyles,
        untrackedStyled,
        parentInfo,
      } = decoration.transform && recordsByNode.size > 0
        ? collectTrackedInSubtree(node, recordsByNode)
        : {
            tracked: [],
            beforeElements: new Set(),
            beforeStyles: new Map(),
            untrackedStyled: [],
            parentInfo: new Map(),
          };
      if (trackedInNode.length > 0) {
        const refreshed = new Set();
        for (const entry of trackedInNode) {
          for (const record of entry.records) {
            if (!refreshed.has(record)) {
              refreshed.add(record);
              snapshotPlainStyles(record);
            }
          }
        }
      }
      const transformed = decoration.transform?.(node, edit.target) || node;
      if (currentRecord && decoration.transform) snapshotPlainStyles(currentRecord);
      if (decoration.transform && trackedInNode.length > 0) {
        reconcileDetachedTrackedNodes(
          trackedInNode,
          beforeElements,
          beforeStyles,
          untrackedStyled,
          parentInfo,
          transformed,
          node,
          recordsByNode,
          trackNodeForRecord,
          preservedUntrackedClones,
        );
      }
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
  for (const target of emptyPreSanitizedNodes) {
    if (
      target.properties &&
      Object.hasOwn(target.properties, "style") &&
      target.properties.style === ""
    ) {
      delete target.properties.style;
    }
  }
  for (let index = 0; index < items.length; index++) {
    if (appliedDecorations.has(index)) continue;
    const properties = items[index].properties;
    if (!properties || typeof properties !== "object") continue;
    for (const key of Object.keys(properties)) {
      if (!isSafeDecorationAttributeName(key))
        throw new ShikiError(`Invalid HTML attribute name ${JSON.stringify(key)}`, "ERR_USAGE");
      if (!isUrlDecorationAttributeName(key)) continue;
      const value = properties[key];
      if (!isSafeDecorationAttributeValue(key, value))
        throw new ShikiError(
          `Invalid HTML attribute value for ${JSON.stringify(key)}`,
          "ERR_USAGE",
        );
    }
  }
  return pendingSanitizations;
}

function tokenCss(token) {
  const font = token.fontStyle || 0;
  const decorations =
    [font & 4 ? "underline" : "", font & 8 ? "line-through" : ""].filter(Boolean).join(" ") ||
    "none";
  const color = token.color ? (normalizeSafeCssColor(token.color) ?? "") : "";
  return `${color ? `color:${color};` : ""}font-style:${font & 1 ? "italic" : "normal"};font-weight:${font & 2 ? "bold" : "normal"};text-decoration:${decorations}`;
}
