export const CODE_ELEMENT_COLOR_CLASS = "ferriki-color-token";
const PRESERVE_SCOPE_BOUNDARIES = Symbol.for("ferriki.preserve-scope-boundaries.v1");

/**
 * Public semantic color variables recognized by Ferriki's prepared code element.
 * Each category has a matching `--ferriki-<category>-color` CSS custom property.
 */
export const CODE_ELEMENT_COLOR_CATEGORIES = Object.freeze([
  "keyword",
  "string",
  "comment",
  "number",
  "boolean",
  "constant",
  "function",
  "type",
  "variable",
  "parameter",
  "property",
  "operator",
  "punctuation",
  "tag",
  "attribute",
  "regexp",
  "escape",
  "builtin",
  "namespace",
  "class",
  "interface",
  "enum",
  "struct",
  "type-parameter",
  "method",
  "macro",
  "decorator",
  "annotation",
  "label",
  "heading",
  "markup",
  "inserted",
  "deleted",
  "invalid",
]);

const CATEGORY_FALLBACKS = Object.freeze({
  escape: ["string"],
  regexp: ["string"],
  parameter: ["variable"],
  property: ["variable"],
  boolean: ["constant"],
  class: ["type"],
  interface: ["type"],
  enum: ["type"],
  struct: ["type"],
  "type-parameter": ["type"],
  method: ["function"],
  builtin: ["function", "variable"],
  heading: ["markup"],
  inserted: ["markup"],
  deleted: ["markup"],
});

const SAFE_COLOR_FUNCTIONS = new Set([
  "color",
  "color-mix",
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

const SCOPE_MATCHERS = [
  ["escape", /(?:^|\.)constant\.character\.escape(?:\.|$)|(?:^|\.)escape(?:\.|$)/u],
  ["regexp", /(?:^|\.)(?:string\.regexp|regexp)(?:\.|$)|character-class\.regexp/u],
  ["boolean", /(?:^|\.)constant\.language\.boolean(?:\.|$)/u],
  ["number", /(?:^|\.)constant\.numeric(?:\.|$)|(?:^|\.)number(?:\.|$)/u],
  ["comment", /(?:^|\.)comment(?:\.|$)/u],
  ["string", /(?:^|\.)string(?:\.|$)/u],
  ["invalid", /(?:^|\.)invalid(?:\.|$)/u],
  ["inserted", /(?:^|\.)markup\.inserted(?:\.|$)/u],
  ["deleted", /(?:^|\.)markup\.deleted(?:\.|$)/u],
  ["heading", /(?:^|\.)(?:markup\.heading|entity\.name\.section)(?:\.|$)/u],
  ["markup", /(?:^|\.)markup(?:\.|$)/u],
  ["tag", /(?:^|\.)entity\.name\.tag(?:\.|$)|(?:^|\.)tag(?:\.|$)/u],
  ["attribute", /(?:^|\.)entity\.other\.attribute-name(?:\.|$)|(?:^|\.)attribute(?:\.|$)/u],
  [
    "property",
    /(?:^|\.)(?:variable\.other\.property|support\.type\.property-name|entity\.name\.property|meta\.object-literal\.key)(?:\.|$)/u,
  ],
  ["parameter", /(?:^|\.)(?:variable\.parameter|entity\.name\.parameter|meta\.parameter)(?:\.|$)/u],
  ["type-parameter", /(?:^|\.)(?:entity\.name\.type\.parameter|type-parameter)(?:\.|$)/u],
  ["class", /(?:^|\.)entity\.name\.class(?:\.|$)/u],
  ["interface", /(?:^|\.)entity\.name\.interface(?:\.|$)/u],
  ["enum", /(?:^|\.)entity\.name\.enum(?:\.|$)/u],
  ["struct", /(?:^|\.)entity\.name\.struct(?:\.|$)/u],
  ["namespace", /(?:^|\.)entity\.name\.namespace(?:\.|$)|(?:^|\.)namespace(?:\.|$)/u],
  ["annotation", /(?:^|\.)(?:entity\.name\.annotation|storage\.type\.annotation)(?:\.|$)/u],
  ["decorator", /(?:^|\.)(?:entity\.name\.decorator|meta\.decorator)(?:\.|$)/u],
  ["macro", /(?:^|\.)(?:support\.macro|entity\.name\.macro|macro)(?:\.|$)/u],
  ["label", /(?:^|\.)entity\.name\.label(?:\.|$)/u],
  ["method", /(?:^|\.)(?:entity\.name\.function\.member|meta\.method-call|meta\.method)(?:\.|$)/u],
  [
    "builtin",
    /(?:^|\.)(?:support\.function\.builtin|support\.variable|support\.constant)(?:\.|$)/u,
  ],
  [
    "function",
    /(?:^|\.)(?:entity\.name\.function|support\.function|variable\.function|meta\.function-call)(?:\.|$)/u,
  ],
  [
    "type",
    /(?:^|\.)(?:entity\.name\.type|support\.type|storage\.type\.primitive|keyword\.type)(?:\.|$)/u,
  ],
  ["operator", /(?:^|\.)keyword\.operator(?:\.|$)|(?:^|\.)operator(?:\.|$)/u],
  ["punctuation", /(?:^|\.)(?:punctuation|meta\.brace|meta\.delimiter)(?:\.|$)/u],
  ["constant", /(?:^|\.)constant(?:\.|$)/u],
  ["variable", /(?:^|\.)(?:variable|entity\.name\.variable)(?:\.|$)/u],
  ["keyword", /(?:^|\.)(?:keyword|storage)(?:\.|$)/u],
];

/**
 * Add inherited semantic color overrides to a prepared code block's HAST.
 * Scope identity must be present on each token; Vite supplies it with
 * `includeExplanation: "scopeName"` and preserves scope boundaries in its
 * native shadow presentation.
 *
 * The transformer changes only theme-colored semantic spans. An earlier user
 * span transformer that supplies a distinct color keeps that authored color.
 */
export function createCodeElementColorTransformer() {
  const spans = new WeakMap();

  return {
    name: "ferriki-code-element-colors",
    enforce: "post",
    [PRESERVE_SCOPE_BOUNDARIES]: true,

    span(node, _line, _column, _lineNode, token) {
      const category = categoryForToken(token);
      if (!category || !node || typeof node !== "object") return node;

      const styleColor = getStyleProperty(node.properties?.style, "color");
      const themeColor = renderedThemeColor(token, this.options);
      const authoredColor =
        themeColor !== undefined && isSafeCssColor(themeColor)
          ? styleColor !== themeColor
          : styleColor !== undefined && themeColor === undefined;

      spans.set(node, {
        category,
        fallback: tokenThemeFallback(token, this.options),
        authoredColor,
        themeStyle: tokenThemeStyle(token, this.options),
        unsafeThemeColor: tokenHasUnsafeColor(token),
      });
      return node;
    },

    root(root) {
      visit(root, (node) => {
        const record = spans.get(node);
        if (!record) return;
        if (record.authoredColor) {
          addClass(node, "ferriki-color-authored");
          return;
        }
        const themeFallback = record.fallback;
        const customProperty = colorVariableExpression(record.category, themeFallback);
        let style = node.properties?.style;
        if (record.unsafeThemeColor && style === record.themeStyle)
          style = safeThemeDeclarations(style);
        node.properties = { ...(node.properties || {}) };
        node.properties.style = setStyleProperties(style, {
          "--_ferriki-token-color": customProperty,
          color: "var(--_ferriki-token-color)",
        });
        addClass(node, CODE_ELEMENT_COLOR_CLASS);
      });

      const pre = findRootPre(root);
      if (pre) {
        const style = pre.properties?.style;
        pre.properties = { ...(pre.properties || {}) };
        const foreground = safeColorFallback(getStyleProperty(style, "color"));
        const background = safeColorFallback(getStyleProperty(style, "background-color"));
        pre.properties.style = setStyleProperties(style, {
          color: `var(--ferriki-foreground, ${foreground})`,
          "background-color": `var(--ferriki-background-color, ${background})`,
        });
      }
      return root;
    },
  };
}

function categoryForToken(token) {
  const scopes =
    Array.isArray(token?.scopeNames) && token.scopeNames.length
      ? token.scopeNames
      : explanationScopeNames(token?.explanation);
  if (!Array.isArray(scopes)) return undefined;

  for (let index = scopes.length - 1; index >= 0; index--) {
    const scope = scopes[index];
    if (typeof scope !== "string") continue;

    if (/^punctuation\.definition\.string(?:\.|$)/u.test(scope)) return "string";
    if (/^punctuation\.definition\.comment(?:\.|$)/u.test(scope)) return "comment";
    if (/^punctuation\.definition\.regexp(?:\.|$)/u.test(scope)) return "regexp";
    if (
      /(?:^|\.)constant\.language(?:\.|$)/u.test(scope) &&
      /^(?:true|false)$/iu.test(token.content || "")
    )
      return "boolean";

    for (const [category, matcher] of SCOPE_MATCHERS) {
      if (matcher.test(scope)) return category;
    }
  }
  return undefined;
}

function explanationScopeNames(explanation) {
  if (!Array.isArray(explanation)) return undefined;
  return explanation.flatMap((entry) =>
    Array.isArray(entry?.scopes)
      ? entry.scopes.map((scope) => scope?.scopeName).filter((name) => typeof name === "string")
      : [],
  );
}

function tokenThemeFallback(token, options = {}) {
  const variants = token?.variants;
  const defaultColor = options.defaultColor;
  const variantNames = variants && typeof variants === "object" ? Object.keys(variants) : [];
  const fallbackVariant =
    typeof defaultColor === "string" && variants?.[defaultColor]
      ? defaultColor
      : variantNames.includes("light")
        ? "light"
        : variantNames[0];

  if (variants && defaultColor === "light-dark()") {
    const light = safeColorFallback(variants.light?.color);
    const dark = safeColorFallback(variants.dark?.color);
    if (variants.light && variants.dark) return `light-dark(${light}, ${dark})`;
  }

  const variantColor = safeColorFallback(variants?.[fallbackVariant]?.color);
  if (variants && options.styleMode === "classes") return `var(--ferriki-color, ${variantColor})`;
  if (variants && options.styleMode !== "classes")
    return `var(--_ferriki-token-theme-color, ${variantColor})`;

  return safeColorFallback(token?.color ?? getStyleProperty(token?.htmlStyle, "color"));
}

function renderedThemeColor(token, options = {}) {
  const htmlColor = getStyleProperty(token?.htmlStyle, "color");
  if (htmlColor !== undefined) return htmlColor;
  if (token?.variants && options.styleMode === "classes") return "var(--ferriki-color)";
  if (token?.variants && options.styleMode !== "classes") {
    const fallback = tokenThemeFallback(token, options);
    return fallback;
  }
  return token?.color;
}

function tokenThemeStyle(token, options = {}) {
  if (typeof token?.htmlStyle === "string") return token.htmlStyle;
  if (token?.htmlStyle && typeof token.htmlStyle === "object")
    return Object.entries(token.htmlStyle)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
  if (options.styleMode !== "classes") return undefined;
  const fontStyle = token?.fontStyle || 0;
  const decorations =
    [fontStyle & 4 ? "underline" : "", fontStyle & 8 ? "line-through" : ""]
      .filter(Boolean)
      .join(" ") || "none";
  return `${token?.color ? `color:${token.color};` : ""}font-style:${fontStyle & 1 ? "italic" : "normal"};font-weight:${fontStyle & 2 ? "bold" : "normal"};text-decoration:${decorations}`;
}

function tokenHasUnsafeColor(token) {
  const colors = token?.variants
    ? Object.values(token.variants).map((style) => style?.color)
    : [token?.color, getStyleProperty(token?.htmlStyle, "color")];
  return colors.some((color) => color !== undefined && !isSafeCssColor(color));
}

function safeThemeDeclarations(style) {
  if (style && typeof style === "object") {
    return Object.fromEntries(Object.entries(style).filter(([name]) => isThemeStyleProperty(name)));
  }
  return splitDeclarations(typeof style === "string" ? style : "")
    .filter((declaration) => {
      const separator = declaration.indexOf(":");
      return separator >= 0 && isThemeStyleProperty(declaration.slice(0, separator).trim());
    })
    .join(";");
}

function isThemeStyleProperty(name) {
  return (
    ["color", "background-color", "font-style", "font-weight", "text-decoration"].includes(name) ||
    name.startsWith("--shiki-") ||
    name.startsWith("--ferriki-") ||
    name.startsWith("--_ferriki-")
  );
}

function colorVariableExpression(category, themeFallback) {
  const categories = [category, ...(CATEGORY_FALLBACKS[category] || [])];
  let expression = safeColorFallback(themeFallback);
  for (let index = categories.length - 1; index >= 0; index--)
    expression = `var(--ferriki-${categories[index]}-color, ${expression})`;
  return expression;
}

function safeColorFallback(value) {
  return isSafeCssColor(value) ? value.trim() : "inherit";
}

function isSafeCssColor(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  const normalized = value.trim();
  if (!normalized || /[;{}<>"'\\`!@]/u.test(normalized) || !/^[\w#().,%\s/+*-]+$/u.test(normalized))
    return false;

  let depth = 0;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
    if (character === "(") depth++;
    if (character === ")" && --depth < 0) return false;
  }
  if (depth !== 0) return false;

  for (const [, name] of normalized.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*\(/gu)) {
    if (!SAFE_COLOR_FUNCTIONS.has(name.toLowerCase())) return false;
  }
  return true;
}

function getStyleProperty(style, name) {
  if (typeof style === "string") {
    let value;
    for (const declaration of splitDeclarations(style)) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      if (declaration.slice(0, separator).trim().toLowerCase() === name)
        value = declaration.slice(separator + 1).trim();
    }
    return value;
  }
  if (style && typeof style === "object") {
    const camelName = name.replace(/-([a-z])/gu, (_match, character) => character.toUpperCase());
    const value = style[name] ?? style[camelName];
    return value === undefined ? undefined : String(value).trim();
  }
  return undefined;
}

function setStyleProperties(style, updates) {
  if (style && typeof style === "object" && !Array.isArray(style)) return { ...style, ...updates };

  const declarations = splitDeclarations(typeof style === "string" ? style : "");
  const properties = new Map();
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const name = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (name) properties.set(name, value);
  }
  for (const [name, value] of Object.entries(updates)) properties.set(name, value);
  return [...properties].map(([name, value]) => `${name}:${value}`).join(";");
}

function splitDeclarations(style) {
  const declarations = [];
  let start = 0;
  let depth = 0;
  let quote;
  let comment = false;
  for (let index = 0; index < style.length; index++) {
    const character = style[index];
    if (comment) {
      if (character === "*" && style[index + 1] === "/") {
        comment = false;
        index++;
      }
      continue;
    }
    if (character === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "/" && style[index + 1] === "*") {
      comment = true;
      index++;
    } else if ("([{".includes(character)) depth++;
    else if (")]}".includes(character)) depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) {
      declarations.push(style.slice(start, index).trim());
      start = index + 1;
    }
  }
  declarations.push(style.slice(start).trim());
  return declarations.filter(Boolean);
}

function addClass(node, className) {
  const current = node.properties?.class;
  const classes = Array.isArray(current)
    ? current
    : typeof current === "string"
      ? current.split(/\s+/u).filter(Boolean)
      : [];
  node.properties.class = [...new Set([...classes, className])].join(" ");
}

function visit(node, callback) {
  if (!node || typeof node !== "object") return;
  callback(node);
  if (Array.isArray(node.children)) for (const child of node.children) visit(child, callback);
}

function findRootPre(root) {
  let found;
  visit(root, (node) => {
    if (!found && node.type === "element" && node.tagName === "pre") found = node;
  });
  return found;
}
