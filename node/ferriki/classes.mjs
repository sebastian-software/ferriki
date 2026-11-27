import { createHash } from "node:crypto";

// Keep scope segments reversible: '.' separates segments, while '-' and '_' are encoded.
export function scopeClass(scope) {
  return scope
    .split(".")
    .map((part) =>
      part.replace(/[^a-zA-Z0-9]/gu, (char) => `_${char.codePointAt(0).toString(16)}_`),
    )
    .join("-");
}

function scopePrefixes(scope, prefix) {
  const parts = scope.split(".");
  return parts.map((_, index) => `${prefix}-${scopeClass(parts.slice(0, index + 1).join("."))}`);
}

// One cache per render: grammar scopes repeat across tokens and lines. Cache
// only derived classes; paths retain their original order and repeated scopes.
// Measurements and exact-output checks: benchmarks/curated/results/render-memoization.
export function createScopeClassCache() {
  const cache = new Map();
  return (scope) => {
    let classes = cache.get(scope);
    if (!classes) {
      classes = {
        token: scopePrefixes(scope, "tok"),
        leaf: scopePrefixes(scope, "leaf"),
        wrapper: [...scopePrefixes(scope, "scope"), `exact-${scopeClass(scope)}`].join(" "),
      };
      cache.set(scope, classes);
    }
    return classes;
  };
}

export function addScopeClasses(span, scopes, scopeClasses) {
  const classes = [
    "token",
    ...scopes.flatMap((scope) => scopeClasses(scope).token),
    ...(scopes.length ? scopeClasses(scopes.at(-1)).leaf : []),
  ];
  const current = span.properties.class;
  span.properties.class = [
    ...new Set([
      ...(Array.isArray(current)
        ? current
        : String(current || "")
            .split(/\s+/)
            .filter(Boolean)),
      ...classes,
    ]),
  ].join(" ");
}

// Decorators may introduce containers between tokens. Nest within those containers
// so their exact text ranges remain intact; resolved style classes do not depend on ancestry.
export function nestScopes(node, paths, scopeClasses) {
  if (!node || typeof node !== "object" || !Array.isArray(node.children)) return node;
  const children = [];
  const parents = [children];
  let open = [];
  let changed = false;
  for (const child of node.children) {
    const scopes = paths.get(child);
    if (!scopes) {
      open = [];
      parents.length = 1;
      const updated = nestScopes(child, paths, scopeClasses);
      if (updated !== child) changed = true;
      children.push(updated);
      continue;
    }
    changed = true;
    let shared = 0;
    while (shared < open.length && open[shared] === scopes[shared]) shared++;
    parents.length = shared + 1;
    for (const scope of scopes.slice(shared)) {
      const wrapper = {
        type: "element",
        tagName: "span",
        properties: {
          class: scopeClasses(scope).wrapper,
        },
        children: [],
      };
      parents.at(-1).push(wrapper);
      parents.push(wrapper.children);
    }
    parents.at(-1).push(child);
    open = scopes;
  }
  if (!changed) return node;
  const descriptor = Object.getOwnPropertyDescriptor(node, "children");
  const canAssignChildren = descriptor
    ? Object.hasOwn(descriptor, "value")
      ? descriptor.writable === true
      : typeof descriptor.set === "function"
    : Object.isExtensible(node);
  if (canAssignChildren) {
    node.children = children;
    return node;
  }
  return { ...node, children };
}

const SAFE_COLOR_FUNCTIONS = new Set([
  "color",
  "color-mix",
  "contrast-color",
  "env",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "light-dark",
  "oklab",
  "oklch",
  "rgb",
  "rgba",
  "var",
]);

const SAFE_CSS_MATH_FUNCTIONS = new Set([
  "abs",
  "acos",
  "asin",
  "atan",
  "atan2",
  "calc",
  "clamp",
  "cos",
  "exp",
  "hypot",
  "log",
  "max",
  "min",
  "mod",
  "pow",
  "rem",
  "round",
  "sign",
  "sin",
  "sqrt",
  "tan",
]);

const SAFE_COLOR_INNER_FUNCTIONS = new Set([...SAFE_COLOR_FUNCTIONS, ...SAFE_CSS_MATH_FUNCTIONS]);

const UNSAFE_CSS_FUNCTIONS = new Set([
  "attr",
  "behavior",
  "binding",
  "cross-fade",
  "element",
  "expression",
  "filter",
  "image",
  "image-rect",
  "image-set",
  "paint",
  "src",
  "url",
]);

const SAFE_DECORATION_TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "ins",
  "kbd",
  "label",
  "li",
  "main",
  "mark",
  "meter",
  "nav",
  "ol",
  "output",
  "p",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
]);

const MAX_CSS_IDENTIFIER_LENGTH = 128;
// Fits a max-length prefix (128) + max-length theme key (128) + "-text-decoration" (16).
const MAX_CSS_PROPERTY_NAME_LENGTH = 272;
const MAX_CSS_VALUE_LENGTH = 512;
const MAX_COMPOSED_LIGHT_DARK_LENGTH = 2 * (2 * MAX_CSS_VALUE_LENGTH + 160) + 32;
const MAX_COMPOSED_VAR_COLOR_LENGTH = MAX_COMPOSED_LIGHT_DARK_LENGTH + 128;
const MAX_VAR_COLOR_WRAPPER_DEPTH = 6;
const MAX_COMPOSED_COLOR_DEPTH = 4;
const FORBIDDEN_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isAsciiCssWhitespaceCode(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

export function trimAsciiSpaces(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) === 0x20) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

export function trimAsciiCssWhitespace(value) {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiCssWhitespaceCode(value.charCodeAt(start))) start++;
  while (end > start && isAsciiCssWhitespaceCode(value.charCodeAt(end - 1))) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function normalizeCssWhitespace(value) {
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
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      output += ch;
    } else {
      const code = value.charCodeAt(index);
      if (code === 0x0d && value.charCodeAt(index + 1) === 0x0a) {
        index++;
        output += " ";
      } else {
        output += code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? " " : ch;
      }
    }
  }
  return output;
}

export function isValidCssIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CSS_IDENTIFIER_LENGTH &&
    /^[a-zA-Z_][\w-]*$/u.test(value) &&
    !FORBIDDEN_PROTOTYPE_KEYS.has(value)
  );
}

export function isValidCssVariablePrefix(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_CSS_IDENTIFIER_LENGTH &&
    /^--[a-zA-Z_][\w-]*$/u.test(value)
  );
}

function hasOnlyValidCssCustomPropertyChars(str, startIndex) {
  for (let index = startIndex; index < str.length; index++) {
    const code = str.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = str.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (!isValidCssCustomPropertyChar(str[index], code)) return false;
  }
  return true;
}

export function isValidInlineCssVariablePrefix(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_CSS_IDENTIFIER_LENGTH &&
    value.startsWith("--") &&
    hasOnlyValidCssCustomPropertyChars(value, 2)
  );
}

export function isValidInlineThemeAlias(prefix, alias) {
  if (
    typeof prefix !== "string" ||
    typeof alias !== "string" ||
    alias.length === 0 ||
    FORBIDDEN_PROTOTYPE_KEYS.has(alias) ||
    !isValidInlineCssVariablePrefix(prefix) ||
    !hasOnlyValidCssCustomPropertyChars(alias, 0)
  )
    return false;
  return `${prefix}${alias}-text-decoration`.length <= MAX_CSS_PROPERTY_NAME_LENGTH;
}

function isValidHtmlTagNameChar(cp) {
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    cp === 0x2d ||
    cp === 0x2e ||
    cp === 0x5f ||
    cp === 0xb7 ||
    (cp >= 0xc0 && cp <= 0xd6) ||
    (cp >= 0xd8 && cp <= 0xf6) ||
    (cp >= 0xf8 && cp <= 0x37d) ||
    (cp >= 0x37f && cp <= 0x1fff) ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x203f ||
    cp === 0x2040 ||
    (cp >= 0x2070 && cp <= 0x218f) ||
    (cp >= 0x2c00 && cp <= 0x2fef) ||
    (cp >= 0x3001 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfdcf) ||
    (cp >= 0xfdf0 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0xeffff)
  );
}

export function isValidHtmlTagName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  const first = name.codePointAt(0);
  if (
    first === undefined ||
    !((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))
  ) {
    return false;
  }
  for (let index = 1; index < name.length;) {
    const cp = name.codePointAt(index);
    if (cp === undefined || !isValidHtmlTagNameChar(cp)) return false;
    index += cp > 0xffff ? 2 : 1;
  }
  return true;
}

export function isValidHtmlAttributeName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (
      code <= 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x22 || // "
      code === 0x27 || // '
      code === 0x2f || // /
      code === 0x3c || // <
      code === 0x3d || // =
      code === 0x3e // >
    )
      return false;
  }
  return true;
}

const UNSAFE_DECORATION_ATTRIBUTES = new Set([
  "action",
  "attributionsrc",
  "background",
  "formaction",
  "is",
  "ping",
  "srcdoc",
  "srcset",
]);

const URL_DECORATION_ATTRIBUTES = new Set(["cite", "data", "href", "poster", "src", "xlink:href"]);

export function isSafeDecorationTagName(name) {
  return (
    typeof name === "string" &&
    /^[a-zA-Z][a-zA-Z0-9]*$/u.test(name) &&
    SAFE_DECORATION_TAGS.has(name.toLowerCase())
  );
}

export function isSafeDecorationAttributeName(name) {
  if (!isValidHtmlAttributeName(name)) return false;
  const lower = name.toLowerCase();
  return !lower.startsWith("on") && !UNSAFE_DECORATION_ATTRIBUTES.has(lower);
}

export function isSafeDecorationUrl(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  const trimmed = trimAsciiSpaces(value);
  if (!trimmed) return true;
  if (trimmed.startsWith("//") || trimmed.startsWith("\\") || trimmed.startsWith("/\\"))
    return false;
  const firstDelimiter = trimmed.search(/[/?#]/u);
  const firstSegment = firstDelimiter === -1 ? trimmed : trimmed.slice(0, firstDelimiter);
  const colon = firstSegment.indexOf(":");
  if (colon !== -1) {
    const scheme = firstSegment.slice(0, colon).toLowerCase();
    if (scheme === "https" || scheme === "http") {
      if (!/^https?:\/\//iu.test(trimmed)) return false;
      const afterProtocol = trimmed.slice(colon + 3);
      const hostEnd = afterProtocol.search(/[/?#]/u);
      const host = hostEnd === -1 ? afterProtocol : afterProtocol.slice(0, hostEnd);
      return host.length > 0;
    }
    if (scheme === "mailto") return trimAsciiSpaces(trimmed.slice(colon + 1)).length > 0;
    return false;
  }
  return true;
}

export function isUrlDecorationAttributeName(name) {
  return typeof name === "string" && URL_DECORATION_ATTRIBUTES.has(name.toLowerCase());
}

export function isSafeDecorationAttributeValue(name, value) {
  if (typeof name !== "string") return false;
  if (URL_DECORATION_ATTRIBUTES.has(name.toLowerCase())) {
    return typeof value === "string" && isSafeDecorationUrl(value);
  }
  return true;
}

function isValidCssCustomPropertyChar(ch, code) {
  if (code < 0x80) return /[\w-]/u.test(ch);
  return code >= 0xa0 && !/\s/u.test(ch);
}

function consumeCssIdentEscape(str, backslashIndex) {
  if (str.charCodeAt(backslashIndex) !== 0x5c || backslashIndex + 1 >= str.length) return -1;
  const next = str.charCodeAt(backslashIndex + 1);
  if (next <= 0x1f || (next >= 0x7f && next <= 0x9f)) return -1;
  if (isAsciiHexCode(next)) {
    let hexEnd = backslashIndex + 1;
    while (
      hexEnd < str.length &&
      hexEnd - (backslashIndex + 1) < 6 &&
      isAsciiHexCode(str.charCodeAt(hexEnd))
    ) {
      hexEnd++;
    }
    const escapedCodePoint = Number.parseInt(str.slice(backslashIndex + 1, hexEnd), 16);
    if (
      escapedCodePoint <= 0x1f ||
      (escapedCodePoint >= 0x7f && escapedCodePoint <= 0x9f) ||
      escapedCodePoint > 0x10ffff ||
      (escapedCodePoint >= 0xd800 && escapedCodePoint <= 0xdfff)
    )
      return -1;
    if (
      hexEnd < str.length &&
      (str.charCodeAt(hexEnd) === 0x20 || str.charCodeAt(hexEnd) === 0x09)
    ) {
      hexEnd++;
    }
    return hexEnd;
  }
  if (next >= 0xd800 && next <= 0xdbff) {
    const low = str.charCodeAt(backslashIndex + 2);
    if (!(low >= 0xdc00 && low <= 0xdfff)) return -1;
    return backslashIndex + 3;
  }
  if (next >= 0xdc00 && next <= 0xdfff) return -1;
  return backslashIndex + 2;
}

function hasOnlyValidCssIdentTail(str, startIndex) {
  for (let index = startIndex; index < str.length; index++) {
    const code = str.charCodeAt(index);
    if (code === 0x5c) {
      const nextIndex = consumeCssIdentEscape(str, index);
      if (nextIndex === -1) return false;
      index = nextIndex - 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = str.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (!isValidCssCustomPropertyChar(str[index], code)) return false;
  }
  return true;
}

export function isValidCssCustomPropertyName(name) {
  if (
    typeof name !== "string" ||
    name.length < 3 ||
    name.length > MAX_CSS_PROPERTY_NAME_LENGTH ||
    !name.startsWith("--")
  )
    return false;
  return hasOnlyValidCssIdentTail(name, 2);
}

function isValidCssEnvName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_CSS_PROPERTY_NAME_LENGTH)
    return false;
  if (name.startsWith("--")) return isValidCssCustomPropertyName(name);
  let index = 0;
  if (name[0] === "-") {
    if (name.length < 2) return false;
    index = 1;
  }
  if (name.charCodeAt(index) === 0x5c) {
    const nextIndex = consumeCssIdentEscape(name, index);
    if (nextIndex === -1) return false;
    return hasOnlyValidCssIdentTail(name, nextIndex);
  }
  const firstCode = name.codePointAt(index);
  if (firstCode === undefined || (firstCode >= 0xd800 && firstCode <= 0xdfff)) return false;
  const firstChar = String.fromCodePoint(firstCode);
  const validStart =
    firstCode < 0x80 ? /^[a-zA-Z_]$/u.test(firstChar) : firstCode >= 0xa0 && !/\s/u.test(firstChar);
  if (!validStart) return false;
  return hasOnlyValidCssIdentTail(name, index + (firstCode > 0xffff ? 2 : 1));
}

function isValidCssEnvSpecifier(specifier) {
  if (
    typeof specifier !== "string" ||
    specifier.length === 0 ||
    specifier.length > MAX_CSS_PROPERTY_NAME_LENGTH
  )
    return false;
  let identEnd = 0;
  while (identEnd < specifier.length) {
    const code = specifier.charCodeAt(identEnd);
    if (code === 0x5c) {
      const nextIndex = consumeCssIdentEscape(specifier, identEnd);
      if (nextIndex === -1) return false;
      identEnd = nextIndex;
      continue;
    }
    if (isAsciiCssWhitespaceCode(code)) break;
    identEnd++;
  }
  if (identEnd === 0 || !isValidCssEnvName(specifier.slice(0, identEnd))) return false;
  const restParts = specifier
    .slice(identEnd)
    .split(/[ \t\n\r\f]+/u)
    .filter(Boolean);
  for (const part of restParts) {
    if (!/^\d+$/u.test(part)) return false;
  }
  return true;
}

function isValidCssPropertyName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_CSS_PROPERTY_NAME_LENGTH)
    return false;
  if (name.startsWith("--")) return isValidCssCustomPropertyName(name);
  const lower = name.toLowerCase();
  if (lower === "behavior" || lower === "-moz-binding") return false;
  return /^[a-zA-Z-][a-zA-Z0-9-]*$/u.test(name);
}

function validateVarOrEnvArguments(expr, openParen, isEnv) {
  let depth = 0;
  let comma = -1;
  let close = -1;
  let quote;
  let inComment = false;
  for (let cursor = openParen + 1; cursor < expr.length; cursor++) {
    const ch = expr[cursor];
    if (inComment) {
      if (ch === "*" && expr[cursor + 1] === "/") {
        inComment = false;
        cursor++;
      }
      continue;
    }
    if (ch === "\\") {
      if (cursor + 1 >= expr.length) return -1;
      const nextCode = expr.charCodeAt(cursor + 1);
      if (nextCode >= 0xd800 && nextCode <= 0xdbff) {
        const low = expr.charCodeAt(cursor + 2);
        if (!(low >= 0xdc00 && low <= 0xdfff)) return -1;
        cursor += 2;
      } else {
        cursor++;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "/" && expr[cursor + 1] === "*") {
      inComment = true;
      cursor++;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        close = cursor;
        break;
      }
      depth--;
    } else if (ch === "," && depth === 0 && comma === -1) {
      comma = cursor;
    }
  }
  if (close === -1 || quote !== undefined || inComment) return -1;
  const nameEnd = comma === -1 ? close : comma;
  const identName = trimAsciiCssWhitespace(expr.slice(openParen + 1, nameEnd));
  const valid = isEnv ? isValidCssEnvSpecifier(identName) : isValidCssCustomPropertyName(identName);
  return valid ? nameEnd : -1;
}

function stripCssVendorPrefix(lowerName) {
  for (const prefix of ["-webkit-", "-moz-", "-ms-", "-o-"]) {
    if (lowerName.length > prefix.length && lowerName.startsWith(prefix))
      return lowerName.slice(prefix.length);
  }
  return lowerName;
}

function isSafeAuthoredFunctionName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z_-][\w-]*$/u.test(name)) return false;
  const lower = name.toLowerCase();
  const unprefixed = stripCssVendorPrefix(lower);
  return !UNSAFE_CSS_FUNCTIONS.has(lower) && !UNSAFE_CSS_FUNCTIONS.has(unprefixed);
}

function splitOptionalImportant(value) {
  let quote;
  let bangIndex = -1;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (quote) {
      if (ch === "\\") {
        index++;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "!") {
      if (bangIndex !== -1) return undefined;
      bangIndex = index;
    }
  }
  if (bangIndex === -1) return { core: value, important: false };
  const core = trimAsciiCssWhitespace(value.slice(0, bangIndex));
  const flag = trimAsciiCssWhitespace(value.slice(bangIndex + 1));
  if (!core || flag.toLowerCase() !== "important") return undefined;
  return { core, important: true };
}

function validateCssFunctionExpression(
  expr,
  allowlist,
  requireOuterCall,
  allowBrackets,
  allowQuotes,
) {
  const safeColorMode = Boolean(allowlist);
  const stack = [];
  let quote;
  for (let index = 0; index < expr.length; index++) {
    const ch = expr[index];
    const code = expr.charCodeAt(index);
    if ((code <= 0x1f && !isAsciiCssWhitespaceCode(code)) || code === 0x7f) return false;
    if (quote) {
      if (ch === "\\") {
        if (index + 1 >= expr.length) return false;
        const next = expr[index + 1];
        const nextCode = expr.charCodeAt(index + 1);
        if ((nextCode <= 0x1f && !isAsciiCssWhitespaceCode(nextCode)) || nextCode === 0x7f)
          return false;
        if (next === "\n" || next === "\r" || next === "\f") return false;
        index++;
        continue;
      }
      if (ch === quote) quote = undefined;
      else if (ch === "\n" || ch === "\r" || ch === "\f") return false;
      continue;
    }
    if (allowQuotes && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (safeColorMode) {
      if (code < 0x80) {
        if (!/^[\w#(),.% /*+-]$/u.test(ch)) return false;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const low = expr.charCodeAt(index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
        index++;
        continue;
      } else if ((code >= 0xdc00 && code <= 0xdfff) || code < 0xa0 || /\s/u.test(ch)) {
        return false;
      }
    } else {
      if (/[{};<>\\`@:]/u.test(ch)) return false;
      if (ch === "/" && expr[index + 1] === "*") return false;
      if (ch === "*" && expr[index + 1] === "/") return false;
    }
    if (ch === "[") {
      if (!allowBrackets) return false;
      stack.push("[");
    } else if (ch === "]") {
      if (!allowBrackets || stack.pop() !== "[") return false;
    } else if (ch === "(") {
      let depth = 0;
      for (const item of stack) if (item === "(") depth++;
      const hasAdjacentIdent = index > 0 && /[\w-]/u.test(expr[index - 1]);
      if (hasAdjacentIdent) {
        let nameStart = index;
        while (nameStart > 0 && /[\w-]/u.test(expr[nameStart - 1])) nameStart--;
        const rawFnName = expr.slice(nameStart, index);
        const fnName = rawFnName.toLowerCase();
        const allowed = allowlist
          ? (depth === 0 ? allowlist[0] : allowlist[1]).has(fnName)
          : isSafeAuthoredFunctionName(rawFnName);
        if (!allowed) return false;
        if (fnName === "var" || fnName === "env") {
          const nameEnd = validateVarOrEnvArguments(expr, index, fnName === "env");
          if (nameEnd === -1) return false;
          stack.push("(");
          index = nameEnd - 1;
          continue;
        }
      } else {
        // Parenthesized grouping is only allowed inside an enclosing function
        // after an operator, comma, or opening parenthesis (not `url (evil)`).
        if (depth === 0) return false;
        let prev = index;
        while (prev > 0 && isAsciiCssWhitespaceCode(expr.charCodeAt(prev - 1))) prev--;
        if (prev === 0 || !"(),+-*/".includes(expr[prev - 1]) || expr[prev - 1] === ")")
          return false;
      }
      stack.push("(");
    } else if (ch === ")") {
      if (stack.pop() !== "(") return false;
      if (requireOuterCall && stack.length === 0 && index + 1 !== expr.length) return false;
    }
  }
  return quote === undefined && stack.length === 0;
}

function splitLightDarkArguments(trimmed) {
  if (
    trimmed.length <= 12 ||
    trimmed.slice(0, 11).toLowerCase() !== "light-dark(" ||
    !trimmed.endsWith(")")
  )
    return undefined;
  let depth = 0;
  let comma = -1;
  for (let index = 11; index < trimmed.length - 1; index++) {
    const ch = trimmed[index];
    if (ch === "\\") {
      if (index + 1 >= trimmed.length - 1) return undefined;
      const nextCode = trimmed.charCodeAt(index + 1);
      if (nextCode >= 0xd800 && nextCode <= 0xdbff) {
        const low = trimmed.charCodeAt(index + 2);
        if (!(low >= 0xdc00 && low <= 0xdfff) || index + 2 >= trimmed.length - 1) return undefined;
        index += 2;
      } else {
        index++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return undefined;
      depth--;
    } else if (ch === "," && depth === 0) {
      if (comma !== -1) return undefined;
      comma = index;
    }
  }
  if (depth !== 0 || comma === -1) return undefined;
  return [trimAsciiSpaces(trimmed.slice(11, comma)), trimAsciiSpaces(trimmed.slice(comma + 1, -1))];
}

function isSafeSingleCssColor(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CSS_VALUE_LENGTH)
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  const trimmed = trimAsciiSpaces(value);
  if (!trimmed) return false;
  if (trimmed.startsWith("#"))
    return /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(trimmed);
  if (!trimmed.includes("(") && !trimmed.includes(")"))
    return /^[a-zA-Z][a-zA-Z-]*$/u.test(trimmed);
  if (trimmed.includes("/*") || trimmed.includes("*/")) return false;
  const open = trimmed.indexOf("(");
  if (open <= 0) return false;
  if (!SAFE_COLOR_FUNCTIONS.has(trimmed.slice(0, open).toLowerCase())) return false;
  return validateCssFunctionExpression(
    trimmed,
    [SAFE_COLOR_FUNCTIONS, SAFE_COLOR_INNER_FUNCTIONS],
    true,
    false,
    false,
  );
}

function unwrapVarColorFallback(trimmed) {
  const prefix = trimmed.slice(0, 4).toLowerCase();
  const isVar = trimmed.length > 6 && prefix === "var(";
  const isEnv = !isVar && trimmed.length > 6 && prefix === "env(";
  if ((!isVar && !isEnv) || !trimmed.endsWith(")")) return undefined;
  let depth = 0;
  let comma = -1;
  for (let index = 4; index < trimmed.length - 1; index++) {
    const ch = trimmed[index];
    if (ch === "\\") {
      if (index + 1 >= trimmed.length - 1) return undefined;
      const nextCode = trimmed.charCodeAt(index + 1);
      if (nextCode >= 0xd800 && nextCode <= 0xdbff) {
        const low = trimmed.charCodeAt(index + 2);
        if (!(low >= 0xdc00 && low <= 0xdfff) || index + 2 >= trimmed.length - 1) return undefined;
        index += 2;
      } else {
        index++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return undefined;
      depth--;
    } else if (ch === "," && depth === 0 && comma === -1) {
      comma = index;
    }
  }
  if (depth !== 0 || comma === -1) return undefined;
  const identName = trimAsciiSpaces(trimmed.slice(4, comma));
  if (!(isEnv ? isValidCssEnvSpecifier(identName) : isValidCssCustomPropertyName(identName)))
    return undefined;
  return trimAsciiSpaces(trimmed.slice(comma + 1, -1));
}

function normalizeCssColorWhitespace(value, forceCollapse = false) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_COMPOSED_VAR_COLOR_LENGTH
  )
    return undefined;
  let needsCollapse = forceCollapse;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      needsCollapse = true;
    } else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return undefined;
    }
  }
  if (!needsCollapse) {
    const trimmed = trimAsciiSpaces(value);
    return trimmed.length > 0 ? trimmed : undefined;
  }
  let normalized = "";
  let pendingSpace = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (isAsciiCssWhitespaceCode(code)) {
      if (normalized.length > 0) pendingSpace = true;
    } else {
      if (pendingSpace) {
        normalized += " ";
        pendingSpace = false;
      }
      normalized += value[index];
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function isSafeNormalizedCssColor(normalized, depth = 0) {
  if (normalized.length <= MAX_CSS_VALUE_LENGTH && isSafeSingleCssColor(normalized)) return true;
  if (normalized.length > MAX_COMPOSED_VAR_COLOR_LENGTH || depth > MAX_COMPOSED_COLOR_DEPTH)
    return false;
  let inner = normalized;
  let unwrapped = 0;
  while (unwrapped < MAX_VAR_COLOR_WRAPPER_DEPTH) {
    const fallback = unwrapVarColorFallback(inner);
    if (fallback === undefined) break;
    inner = fallback;
    unwrapped++;
  }
  if (unwrapped === 0 && normalized.length > MAX_COMPOSED_LIGHT_DARK_LENGTH) return false;
  if (unwrapped > 0 && (inner.length === 0 || isSafeSingleCssColor(inner))) return true;
  if (depth >= MAX_COMPOSED_COLOR_DEPTH) return false;
  const args = splitLightDarkArguments(inner);
  return (
    args !== undefined &&
    isSafeNormalizedCssColor(args[0], depth + 1) &&
    isSafeNormalizedCssColor(args[1], depth + 1)
  );
}

export function normalizeSafeCssColor(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_COMPOSED_VAR_COLOR_LENGTH ||
    /<\/style/iu.test(value)
  )
    return undefined;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code <= 0x1f && !isAsciiCssWhitespaceCode(code)) || (code >= 0x7f && code <= 0x9f))
      return undefined;
  }
  const stripped = stripCssComments(value);
  if (stripped === undefined) return undefined;
  const normalized = normalizeCssColorWhitespace(stripped, stripped !== value);
  return normalized !== undefined && isSafeNormalizedCssColor(normalized) ? normalized : undefined;
}

export function isSafeCssColor(value) {
  return normalizeSafeCssColor(value) !== undefined;
}

function isSafeCssDeclarationValue(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CSS_VALUE_LENGTH)
    return false;
  if (/<\/style/iu.test(value)) return false;
  return validateCssFunctionExpression(value, undefined, false, true, true);
}

function isColorProperty(name) {
  const lower = name.toLowerCase();
  return lower === "color" || lower === "background-color";
}

export function splitCssDeclarations(style) {
  const declarations = [];
  let start = 0;
  let depth = 0;
  let quote;
  let inComment = false;
  for (let index = 0; index < style.length; index++) {
    const ch = style[index];
    if (inComment) {
      if (ch === "*" && style[index + 1] === "/") {
        inComment = false;
        index++;
      }
      continue;
    }
    if (ch === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "/" && style[index + 1] === "*") {
      inComment = true;
      index++;
    } else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      declarations.push(style.slice(start, index));
      start = index + 1;
    }
  }
  declarations.push(style.slice(start));
  return declarations;
}

function skipLeadingCssWhitespaceAndComments(value, start = 0) {
  let index = start;
  while (index < value.length) {
    if (isAsciiCssWhitespaceCode(value.charCodeAt(index))) {
      index++;
    } else if (value[index] === "/" && value[index + 1] === "*") {
      const close = value.indexOf("*/", index + 2);
      if (close === -1) return -1;
      index = close + 2;
    } else {
      break;
    }
  }
  return index;
}

function splitCssDeclarationSegment(segment) {
  const start = skipLeadingCssWhitespaceAndComments(segment, 0);
  if (start === -1) return undefined;
  let end = start;
  while (end < segment.length) {
    if (segment.charCodeAt(end) === 0x5c) {
      const next = consumeCssIdentEscape(segment, end);
      if (next === -1) return undefined;
      end = next;
      continue;
    }
    if (
      isAsciiCssWhitespaceCode(segment.charCodeAt(end)) ||
      segment[end] === ":" ||
      (segment[end] === "/" && segment[end + 1] === "*")
    ) {
      break;
    }
    end++;
  }
  if (end === start) return undefined;
  const colon = skipLeadingCssWhitespaceAndComments(segment, end);
  if (colon === -1 || segment[colon] !== ":") return undefined;
  return [segment.slice(start, end), segment.slice(colon + 1)];
}

function stripCssComments(value) {
  if (!value.includes("/*") && !value.includes("*/")) return value;
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
    if (ch === "/" && value[index + 1] === "*") {
      const close = value.indexOf("*/", index + 2);
      if (close === -1) return undefined;
      if (output.length > 0 && !isAsciiCssWhitespaceCode(output.charCodeAt(output.length - 1))) {
        output += " ";
      }
      index = close + 1;
      continue;
    }
    if (ch === "*" && value[index + 1] === "/") return undefined;
    output += ch;
  }
  return quote === undefined ? output : undefined;
}

function sanitizeDeclarationPair(rawName, rawValue) {
  if (typeof rawName !== "string" || typeof rawValue !== "string") return undefined;
  const name = trimAsciiCssWhitespace(rawName);
  for (const part of [rawName, rawValue]) {
    for (let index = 0; index < part.length; index++) {
      const code = part.charCodeAt(index);
      if ((code <= 0x1f && !isAsciiCssWhitespaceCode(code)) || code === 0x7f) return undefined;
    }
  }
  if (/<\/style/iu.test(rawName) || /<\/style/iu.test(rawValue)) return undefined;
  if (name.length === 0 || name.length > MAX_CSS_PROPERTY_NAME_LENGTH) return undefined;
  if (!isValidCssPropertyName(name)) return undefined;
  const strippedValue = stripCssComments(rawValue);
  if (strippedValue === undefined) return undefined;
  const value = trimAsciiCssWhitespace(strippedValue);
  if (value.length === 0) {
    if (
      name.startsWith("--") &&
      strippedValue.length > 0 &&
      strippedValue.length <= MAX_CSS_VALUE_LENGTH
    ) {
      return `${name}: `;
    }
    return undefined;
  }
  const allowsComposedColor = isColorProperty(name) || name.startsWith("--");
  const valuePrefix = value.slice(0, 4).toLowerCase();
  const maxValueLength =
    allowsComposedColor && (valuePrefix === "var(" || valuePrefix === "env(")
      ? MAX_COMPOSED_VAR_COLOR_LENGTH
      : allowsComposedColor && value.slice(0, 11).toLowerCase() === "light-dark("
        ? MAX_COMPOSED_LIGHT_DARK_LENGTH
        : MAX_CSS_VALUE_LENGTH;
  if (value.length > maxValueLength) return undefined;
  const parsed = splitOptionalImportant(value);
  if (!parsed) return undefined;
  const normalized = normalizeCssWhitespace(parsed.core);
  const valid =
    isColorProperty(name) || (name.startsWith("--") && value.length > MAX_CSS_VALUE_LENGTH)
      ? isSafeCssColor(normalized)
      : isSafeCssDeclarationValue(normalized);
  if (!valid) return undefined;
  return `${name}:${normalized}${parsed.important ? " !important" : ""}`;
}

function hasDisallowedCssControlChars(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code <= 0x1f && !isAsciiCssWhitespaceCode(code)) || code === 0x7f) return true;
  }
  return false;
}

function isAsciiHexCode(code) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function isValidTokenStylePropertyName(name) {
  if (isValidCssPropertyName(name)) return true;
  if (
    typeof name !== "string" ||
    name.length < 3 ||
    name.length > MAX_CSS_PROPERTY_NAME_LENGTH ||
    !name.startsWith("--")
  )
    return false;
  for (let index = 2; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code === 0x5c) {
      const nextIndex = consumeCssIdentEscape(name, index);
      if (nextIndex === -1) return false;
      index = nextIndex - 1;
      continue;
    }
    if (
      code <= 0x20 ||
      code === 0x7f ||
      code === 0x22 || // "
      code === 0x27 || // '
      code === 0x28 || // (
      code === 0x29 || // )
      code === 0x2f || // /
      code === 0x3a || // :
      code === 0x3b || // ;
      code === 0x7b || // {
      code === 0x7d || // }
      /\s/u.test(name[index])
    )
      return false;
  }
  return true;
}

export function formatSafeTokenStyleEntry(rawName, rawValue) {
  if (typeof rawName !== "string" || rawValue == null) return undefined;
  if (hasDisallowedCssControlChars(rawName)) return undefined;
  const name = trimAsciiCssWhitespace(rawName);
  if (!isValidTokenStylePropertyName(name)) return undefined;
  const value = String(rawValue);
  if (hasDisallowedCssControlChars(value)) return undefined;
  if (trimAsciiCssWhitespace(value).length === 0) {
    if (name.startsWith("--") && value.length > 0) return `${name}:${value}`;
    return undefined;
  }
  const stack = [];
  let quote;
  let inComment = false;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (inComment) {
      if (ch === "*" && value[index + 1] === "/") {
        inComment = false;
        index++;
      }
      continue;
    }
    if (ch === "\\") {
      if (index + 1 >= value.length) return undefined;
      index++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\n" || ch === "\r" || ch === "\f") return undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "/" && value[index + 1] === "*") {
      inComment = true;
      index++;
    } else if (ch === "*" && value[index + 1] === "/") {
      return undefined;
    } else if (ch === "{" || ch === "}" || (ch === ";" && stack.length === 0)) {
      return undefined;
    } else if (ch === "(" || ch === "[") {
      stack.push(ch);
    } else if (ch === ")") {
      if (stack.pop() !== "(") return undefined;
    } else if (ch === "]") {
      if (stack.pop() !== "[") return undefined;
    }
  }
  if (quote !== undefined || inComment || stack.length > 0) return undefined;
  return `${name}:${value}`;
}

export function sanitizeCssDeclarations(style) {
  if (typeof style === "string") {
    const declarations = [];
    for (const segment of splitCssDeclarations(style)) {
      if (hasDisallowedCssControlChars(segment) || /<\/style/iu.test(segment)) continue;
      const pair = splitCssDeclarationSegment(segment);
      if (!pair) continue;
      const sanitized = sanitizeDeclarationPair(pair[0], pair[1]);
      if (sanitized) declarations.push(sanitized);
    }
    return declarations.join(";");
  }
  if (style && typeof style === "object") {
    const declarations = [];
    for (const [key, value] of Object.entries(style)) {
      if (value == null) continue;
      const sanitized = sanitizeDeclarationPair(key, String(value));
      if (sanitized) declarations.push(sanitized);
    }
    return declarations.join(";");
  }
  return "";
}

// Full digests avoid truncation collisions. Rules use zero specificity so ordinary
// scope selectors can override an existing theme without !important.
export function extractClassStylesFromTree(tree) {
  const rules = new Map();
  const names = new Map();
  const sanitizedStyleCache = new Map();
  function sanitizeRawStyle(raw) {
    if (typeof raw === "string") {
      let cached = sanitizedStyleCache.get(raw);
      if (cached === undefined) {
        cached = sanitizeCssDeclarations(raw);
        sanitizedStyleCache.set(raw, cached);
      }
      return cached;
    }
    return sanitizeCssDeclarations(
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : Array.isArray(raw)
          ? raw.join(" ")
          : String(raw),
    );
  }
  function canMutateProperties(props, keysToDelete) {
    if (!Object.isExtensible(props)) return false;
    for (const key of keysToDelete) {
      const descriptor = Object.getOwnPropertyDescriptor(props, key);
      if (descriptor && !descriptor.configurable) return false;
    }
    const classDescriptor = Object.getOwnPropertyDescriptor(props, "class");
    if (classDescriptor && (!Object.hasOwn(classDescriptor, "value") || !classDescriptor.writable))
      return false;
    return true;
  }
  function canAssignProp(obj, key) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    if (descriptor) {
      return Object.hasOwn(descriptor, "value")
        ? descriptor.writable === true
        : typeof descriptor.set === "function";
    }
    return Object.isExtensible(obj);
  }
  function visit(node) {
    if (!node || typeof node !== "object") return node;
    let nextNode = node;
    if (node.type === "element" && node.properties) {
      const styleKeys = Object.keys(node.properties).filter((key) => key.toLowerCase() === "style");
      if (styleKeys.length > 0) {
        const raw = node.properties[styleKeys[0]];
        const style = raw == null ? "" : sanitizeRawStyle(raw);
        let generatedClassName;
        if (style) {
          generatedClassName = names.get(style);
          if (!generatedClassName) {
            generatedClassName = `ferriki-style-${createHash("sha256").update(style).digest("hex")}`;
            names.set(style, generatedClassName);
            rules.set(generatedClassName, `:where(.${generatedClassName}){${style}}`);
          }
        }
        const classKeys = generatedClassName
          ? Object.keys(node.properties).filter((key) => {
              const lower = key.toLowerCase();
              return lower === "class" || lower === "classname";
            })
          : [];
        const keysToDelete = [...styleKeys, ...classKeys.filter((key) => key !== "class")];
        const mergedClasses = [];
        if (generatedClassName) {
          for (const key of classKeys) {
            const rawClass = node.properties[key];
            if (Array.isArray(rawClass)) {
              for (const item of rawClass) {
                if (item != null && String(item)) mergedClasses.push(String(item));
              }
            } else if (rawClass != null && String(rawClass)) {
              mergedClasses.push(String(rawClass));
            }
          }
          mergedClasses.push(generatedClassName);
        }
        if (canMutateProperties(node.properties, keysToDelete)) {
          for (const key of keysToDelete) delete node.properties[key];
          if (generatedClassName) node.properties.class = mergedClasses.join(" ");
        } else {
          const skip = new Set(keysToDelete);
          const nextProperties = {};
          for (const [key, value] of Object.entries(node.properties)) {
            if (skip.has(key)) continue;
            Object.defineProperty(nextProperties, key, {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
          for (const symbol of Object.getOwnPropertySymbols(node.properties)) {
            if (Object.prototype.propertyIsEnumerable.call(node.properties, symbol)) {
              Object.defineProperty(nextProperties, symbol, {
                value: node.properties[symbol],
                enumerable: true,
                writable: true,
                configurable: true,
              });
            }
          }
          if (generatedClassName) nextProperties.class = mergedClasses.join(" ");
          if (canAssignProp(node, "properties")) {
            node.properties = nextProperties;
          } else {
            nextNode = { ...node, properties: nextProperties };
          }
        }
      }
    }
    if (Array.isArray(nextNode.children)) {
      let childrenChanged = false;
      const nextChildren = nextNode.children.map((child) => {
        const updated = visit(child);
        if (updated !== child) childrenChanged = true;
        return updated;
      });
      if (childrenChanged) {
        if (nextNode === node && !canAssignProp(nextNode, "children")) {
          nextNode = { ...nextNode, children: nextChildren };
        } else if (nextNode !== node) {
          nextNode = { ...nextNode, children: nextChildren };
        } else {
          nextNode.children = nextChildren;
        }
      }
    }
    return nextNode;
  }
  const nextTree = visit(tree);
  const css = [...rules.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, rule]) => rule)
    .join("\n");
  return { css, tree: nextTree };
}

export function extractClassStyles(tree) {
  return extractClassStylesFromTree(tree).css;
}

export function themeSwitchStyles(options) {
  if (!options.themes) return { className: "", css: "" };
  const inputKeys = Object.keys(options.themes).filter(
    (key) => options.themes[key] != null && options.themes[key] !== false,
  );
  if (inputKeys.some((key) => !isValidCssIdentifier(key)))
    throw new TypeError("Theme keys must be CSS identifiers");
  const keys = [...inputKeys].sort();
  const defaultKey =
    typeof options.defaultColor === "string" && keys.includes(options.defaultColor)
      ? options.defaultColor
      : keys.includes("light")
        ? "light"
        : inputKeys[0];
  const prefix = options.cssVariablePrefix || "--shiki-";
  if (!isValidCssVariablePrefix(prefix))
    throw new TypeError("cssVariablePrefix must be a CSS custom property prefix");
  // Initial selection is part of the namespace: blocks may use the same palettes
  // with different defaults without their collected stylesheets competing.
  const className = `ferriki-themes-${createHash("sha256")
    .update(
      JSON.stringify([
        keys,
        prefix,
        options.defaultColor === false ? null : defaultKey,
        options.defaultColor === "light-dark()",
      ]),
    )
    .digest("hex")}`;
  const root = `.${className}`;
  const declarations = (key, tokens) =>
    tokens
      ? `--ferriki-color:var(${prefix}${key});--ferriki-font-style:var(${prefix}${key}-font-style,normal);--ferriki-font-weight:var(${prefix}${key}-font-weight,normal);--ferriki-text-decoration:var(${prefix}${key}-text-decoration,none)`
      : `--ferriki-color:var(${prefix}${key});--ferriki-background:var(${prefix}${key}-bg)`;
  const rules = (key, selector) =>
    [
      ...(options.rootStyle === false ? [] : [`:where(${selector}){${declarations(key, false)}}`]),
      `:where(${selector
        .split(",")
        .map((part) => `${part} .token`)
        .join(",")}){${declarations(key, true)}}`,
    ].join("\n");
  const css = options.defaultColor === false ? [] : [rules(defaultKey, root)];
  if (options.defaultColor === "light-dark()")
    css.push(`@media (prefers-color-scheme:dark){${rules("dark", root)}}`);
  for (const key of keys) {
    const selector = `${root}[data-ferriki-theme="${key}"],[data-ferriki-theme="${key}"] ${root}:not([data-ferriki-theme])`;
    css.push(rules(key, selector));
  }
  return { className, css: css.join("\n") };
}
