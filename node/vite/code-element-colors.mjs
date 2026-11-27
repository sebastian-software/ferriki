export const CODE_ELEMENT_COLOR_CLASS = "ferriki-color-token";
const PRESERVE_SCOPE_BOUNDARIES = Symbol.for("ferriki.preserve-scope-boundaries.v1");
const SANITIZED_CLONE_ORIGIN = Symbol.for("ferriki.sanitizedCloneOrigin");

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

const FERRIKI_PALETTE_PROPERTIES = new Set([
  "--ferriki-color",
  "--ferriki-background",
  "--ferriki-foreground",
  "--ferriki-background-color",
  "--ferriki-font-style",
  "--ferriki-font-weight",
  "--ferriki-text-decoration",
]);

const MAX_CSS_PROPERTY_NAME_LENGTH = 272;
const MAX_CSS_VALUE_LENGTH = 512;
const MAX_COMPOSED_LIGHT_DARK_LENGTH = 2 * (2 * MAX_CSS_VALUE_LENGTH + 160) + 32;
const MAX_COMPOSED_VAR_COLOR_LENGTH = MAX_COMPOSED_LIGHT_DARK_LENGTH + 128;
const MAX_VAR_COLOR_WRAPPER_DEPTH = 6;
const MAX_COMPOSED_COLOR_DEPTH = 4;

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
const EMPTY_PALETTE_ROLES = new Map();

export function createCodeElementColorTransformer() {
  const spans = new WeakMap();
  const baseRolesByOptions = new WeakMap();

  function getBasePaletteRoles(options) {
    if (!options || typeof options !== "object") return EMPTY_PALETTE_ROLES;
    let roles = baseRolesByOptions.get(options);
    if (!roles) {
      roles = buildPaletteRolesForAliases(
        cssVariablePrefixForOptions(options),
        options.themes && typeof options.themes === "object"
          ? Object.entries(options.themes)
              .filter(([, value]) => value != null && value !== false)
              .map(([key]) => key)
          : [],
      );
      baseRolesByOptions.set(options, roles);
    }
    return roles;
  }

  function paletteRolesForToken(options, token) {
    const base = getBasePaletteRoles(options);
    const variants = token?.variants;
    if (!variants || typeof variants !== "object") return base;
    const prefix = cssVariablePrefixForOptions(options);
    let extended;
    for (const alias of Object.keys(variants)) {
      if (base.has(`${prefix}${alias}`)) continue;
      if (!extended) extended = new Map(base);
      addAliasPaletteRoles(extended, prefix, alias);
    }
    return extended || base;
  }

  return {
    name: "ferriki-code-element-colors",
    enforce: "post",
    [PRESERVE_SCOPE_BOUNDARIES]: true,

    span(node, _line, _column, _lineNode, token) {
      if (!node || typeof node !== "object") return node;
      const category = categoryForToken(token);

      const styleColor = getStyleProperty(node.properties?.style, "color");
      const themeColor = renderedThemeColor(token, this.options);
      const normalizedThemeColor =
        themeColor !== undefined ? normalizeSafeCssColor(themeColor) : undefined;
      const normalizedStyleColor =
        styleColor !== undefined ? (normalizeSafeCssColor(styleColor) ?? styleColor) : undefined;
      const authoredColor =
        normalizedThemeColor !== undefined
          ? normalizedStyleColor !== normalizedThemeColor
          : styleColor !== undefined && themeColor === undefined;

      const themeColorValues = authoredColor
        ? new Set()
        : collectStylePropertyValues(node.properties?.style, "color");
      if (!authoredColor && normalizedThemeColor !== undefined)
        themeColorValues.add(normalizedThemeColor);
      if (!authoredColor && themeColor !== undefined) themeColorValues.add(themeColor.trim());
      const themeBgColorValues = collectStylePropertyValues(
        node.properties?.style,
        "background-color",
      );

      spans.set(node, {
        category,
        fallback: category ? tokenThemeFallback(token, this.options) : undefined,
        authoredColor,
        themeColorValues,
        themeBgColorValues,
        themeStyle: tokenThemeStyle(token, this.options),
        unsafeThemeColor: tokenHasUnsafeColor(token),
        paletteRoles: paletteRolesForToken(this.options, token),
      });
      return node;
    },

    root(root) {
      const baseRootRoles = getBasePaletteRoles(this?.options);
      let rootPaletteRoles = baseRootRoles;
      let clonedRootRoles = false;
      const replacements = new Map();
      visit(root, (node) => {
        const origin = node[SANITIZED_CLONE_ORIGIN];
        const record = spans.get(node) ?? (origin ? spans.get(origin) : undefined);
        if (!record) return;
        if (record.paletteRoles !== rootPaletteRoles && record.paletteRoles.size > 0) {
          for (const [name, role] of record.paletteRoles) {
            if (rootPaletteRoles.has(name)) continue;
            if (!clonedRootRoles) {
              rootPaletteRoles = new Map(rootPaletteRoles);
              clonedRootRoles = true;
            }
            rootPaletteRoles.set(name, role);
          }
        }

        if (!record.category) {
          const style = node.properties?.style;
          if (style === undefined) return;
          const sanitized =
            record.unsafeThemeColor && style === record.themeStyle
              ? safeThemeDeclarations(style, record.paletteRoles)
              : sanitizeSpanThemeProperties(style, {
                  sanitizeColors: !record.authoredColor,
                  paletteRoles: record.paletteRoles,
                  themeColorValues: record.themeColorValues,
                  themeBgColorValues: record.themeBgColorValues,
                });
          if (sanitized !== style) {
            const nextProperties = { ...(node.properties || {}) };
            if (isEmptyStyle(sanitized)) delete nextProperties.style;
            else nextProperties.style = sanitized;
            updateElementProperties(node, nextProperties, replacements);
          }
          return;
        }

        if (record.authoredColor) {
          const nextProperties = { ...(node.properties || {}) };
          const style = node.properties?.style;
          if (style !== undefined) {
            const sanitized = sanitizeSpanThemeProperties(style, {
              sanitizeColors: false,
              paletteRoles: record.paletteRoles,
            });
            if (sanitized !== style) {
              nextProperties.style = sanitized;
            }
          }
          addClassToProperties(nextProperties, "ferriki-color-authored");
          updateElementProperties(node, nextProperties, replacements);
          return;
        }

        const themeFallback = record.fallback;
        const customProperty = colorVariableExpression(record.category, themeFallback);
        let style = node.properties?.style;
        if (record.unsafeThemeColor && style === record.themeStyle)
          style = safeThemeDeclarations(style, record.paletteRoles);
        else if (style !== undefined)
          style = sanitizeSpanThemeProperties(style, {
            sanitizeColors: true,
            paletteRoles: record.paletteRoles,
            themeColorValues: record.themeColorValues,
            themeBgColorValues: record.themeBgColorValues,
          });
        const nextProperties = { ...(node.properties || {}) };
        nextProperties.style = setStyleProperties(style, {
          "--_ferriki-token-color": customProperty,
          color: "var(--_ferriki-token-color)",
        });
        addClassToProperties(nextProperties, CODE_ELEMENT_COLOR_CLASS);
        updateElementProperties(node, nextProperties, replacements);
      });

      const pre = findRootPre(root);
      if (pre) {
        const rawStyle = pre.properties?.style;
        const foreground = safeColorFallback(getStyleProperty(rawStyle, "color"));
        const background = safeColorFallback(getStyleProperty(rawStyle, "background-color"));
        const sanitizedStyle =
          rawStyle === undefined
            ? rawStyle
            : sanitizeSpanThemeProperties(rawStyle, {
                sanitizeColors: true,
                paletteRoles: rootPaletteRoles,
              });
        const nextProperties = { ...(pre.properties || {}) };
        nextProperties.style = setStyleProperties(sanitizedStyle, {
          color: `var(--ferriki-foreground, ${foreground})`,
          "background-color": `var(--ferriki-background-color, ${background})`,
        });
        updateElementProperties(pre, nextProperties, replacements);
      }
      return replacements.size > 0 ? replaceFrozenNodes(root, replacements) : root;
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
  const normalizedColor = token?.color ? (normalizeSafeCssColor(token.color) ?? token.color) : "";
  return `${normalizedColor ? `color:${normalizedColor};` : ""}font-style:${fontStyle & 1 ? "italic" : "normal"};font-weight:${fontStyle & 2 ? "bold" : "normal"};text-decoration:${decorations}`;
}

function tokenHasUnsafeColor(token) {
  const colors = token?.variants
    ? Object.values(token.variants).map((style) => style?.color)
    : [token?.color, getStyleProperty(token?.htmlStyle, "color")];
  return colors.some((color) => color !== undefined && !isSafeCssColor(color));
}

function cssVariablePrefixForOptions(options) {
  return typeof options?.cssVariablePrefix === "string" && options.cssVariablePrefix
    ? options.cssVariablePrefix
    : "--shiki-";
}

function addPaletteRole(roles, property, role) {
  let applicable = roles.get(property);
  if (!applicable) {
    applicable = new Set();
    roles.set(property, applicable);
  }
  applicable.add(role);
}

function addAliasPaletteRoles(roles, prefix, alias) {
  addPaletteRole(roles, `${prefix}${alias}`, "color");
  addPaletteRole(roles, `${prefix}${alias}-bg`, "color");
  addPaletteRole(roles, `${prefix}${alias}-font-style`, "font-style");
  addPaletteRole(roles, `${prefix}${alias}-font-weight`, "font-weight");
  addPaletteRole(roles, `${prefix}${alias}-text-decoration`, "text-decoration");
}

function buildPaletteRolesForAliases(prefix, aliases) {
  if (!aliases.length) return EMPTY_PALETTE_ROLES;
  const roles = new Map();
  for (const alias of aliases) addAliasPaletteRoles(roles, prefix, alias);
  return roles;
}

function safeThemeDeclarations(style, paletteRoles) {
  if (style && typeof style === "object" && !Array.isArray(style)) {
    return Object.fromEntries(
      Object.entries(style).filter(
        ([name, value]) =>
          isThemeStyleProperty(name, paletteRoles) &&
          isSafeThemePropertyValue(name, String(value ?? ""), paletteRoles),
      ),
    );
  }
  return splitDeclarations(typeof style === "string" ? style : "")
    .filter((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator < 0) return false;
      const name = declaration.slice(0, separator).trim();
      const value = declaration.slice(separator + 1).trim();
      return (
        isThemeStyleProperty(name, paletteRoles) &&
        isSafeThemePropertyValue(name, value, paletteRoles)
      );
    })
    .join(";");
}

function collectStylePropertyValues(style, name) {
  const values = new Set();
  if (typeof style === "string") {
    for (const declaration of splitDeclarations(style)) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      if (declaration.slice(0, separator).trim().toLowerCase() === name) {
        values.add(declaration.slice(separator + 1).trim());
      }
    }
  } else if (style && typeof style === "object" && !Array.isArray(style)) {
    for (const [key, value] of Object.entries(style)) {
      if (key.toLowerCase() === name && value != null) values.add(String(value).trim());
    }
  }
  return values;
}

function sanitizeSpanThemeProperties(
  style,
  { sanitizeColors, paletteRoles, themeColorValues, themeBgColorValues },
) {
  const isSafeEntry = (name, value) => {
    const lower = name.toLowerCase();
    if (isGeneratedPaletteCustomProperty(name, paletteRoles))
      return isSafeThemePropertyValue(name, value, paletteRoles);
    if (sanitizeColors && lower === "color") {
      if (themeColorValues && !themeColorValues.has(value)) return true;
      return isSafeThemePropertyValue(name, value, paletteRoles);
    }
    if (sanitizeColors && lower === "background-color") {
      if (themeBgColorValues && !themeBgColorValues.has(value)) return true;
      return isSafeThemePropertyValue(name, value, paletteRoles);
    }
    return true;
  };
  if (style && typeof style === "object" && !Array.isArray(style)) {
    let changed = false;
    const next = {};
    for (const [name, value] of Object.entries(style)) {
      if (!isSafeEntry(name, String(value ?? ""))) {
        changed = true;
        continue;
      }
      next[name] = value;
    }
    return changed ? next : style;
  }
  if (typeof style !== "string") return style;
  const declarations = splitDeclarations(style);
  let changed = false;
  const kept = [];
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 0) {
      changed = true;
      continue;
    }
    const name = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (!isSafeEntry(name, value)) {
      changed = true;
      continue;
    }
    kept.push(declaration);
  }
  return changed ? kept.join(";") : style;
}

function isEmptyStyle(style) {
  if (typeof style === "string") return style.length === 0;
  if (style && typeof style === "object") return Object.keys(style).length === 0;
  return true;
}

function isGeneratedPaletteCustomProperty(name, paletteRoles) {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_CSS_PROPERTY_NAME_LENGTH)
    return false;
  if (paletteRoles?.has(name)) return true;
  if (/^--_ferriki-[\w-]+$/u.test(name)) return true;
  if (FERRIKI_PALETTE_PROPERTIES.has(name)) return true;
  return /^--ferriki-[a-z0-9-]+-color$/u.test(name);
}

function isThemeStyleProperty(name, paletteRoles) {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_CSS_PROPERTY_NAME_LENGTH)
    return false;
  return (
    ["color", "background-color", "font-style", "font-weight", "text-decoration"].includes(
      name.toLowerCase(),
    ) || isGeneratedPaletteCustomProperty(name, paletteRoles)
  );
}

function isSafeValueForRole(role, value) {
  if (role === "color") return isSafeCssColor(value);
  if (role === "font-style") return isSafeFontStyleValue(value);
  if (role === "font-weight") return isSafeFontWeightValue(value);
  if (role === "text-decoration") return isSafeTextDecorationValue(value);
  return false;
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
    if (ch === "/" && value[index + 1] === "*") {
      const close = value.indexOf("*/", index + 2);
      if (close === -1) return undefined;
      index = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "!") {
      if (bangIndex !== -1) return undefined;
      bangIndex = index;
    }
  }
  if (bangIndex === -1) return { core: value, important: false };
  const core = trimAsciiSpaces(value.slice(0, bangIndex));
  const flag = trimAsciiSpaces(value.slice(bangIndex + 1));
  if (!core || flag.toLowerCase() !== "important") return undefined;
  return { core, important: true };
}

function isSafeThemePropertyValue(name, value, paletteRoles) {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = splitOptionalImportant(value);
  if (!parsed || parsed.core.length > MAX_COMPOSED_VAR_COLOR_LENGTH) return false;
  const core = parsed.core;
  const explicitRoles = paletteRoles?.get(name);
  if (explicitRoles) {
    for (const role of explicitRoles) {
      if (isSafeValueForRole(role, core)) return true;
    }
    return false;
  }
  const lower = name.toLowerCase();
  if (lower === "font-style" || lower.endsWith("-font-style")) return isSafeFontStyleValue(core);
  if (lower === "font-weight" || lower.endsWith("-font-weight")) return isSafeFontWeightValue(core);
  if (lower === "text-decoration" || lower.endsWith("-text-decoration"))
    return isSafeTextDecorationValue(core);
  return isSafeCssColor(core);
}

function trimAsciiSpaces(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) === 0x20) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function isSafeFontStyleValue(value) {
  if (value.length > MAX_CSS_VALUE_LENGTH || hasControlChars(value)) return false;
  const trimmed = trimAsciiSpaces(value);
  if (/^(?:normal|italic|oblique|inherit|initial|unset|revert|revert-layer)$/iu.test(trimmed))
    return true;
  if (/^oblique +[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|rad|grad|turn)?$/iu.test(trimmed)) {
    const angle = trimmed.slice(7).trim();
    const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(deg|rad|grad|turn)?$/iu.exec(angle);
    if (!match) return false;
    const num = Number(match[1]);
    if (!Number.isFinite(num)) return false;
    const unit = match[2]?.toLowerCase();
    if (!unit) return num === 0;
    const degrees =
      unit === "deg"
        ? num
        : unit === "grad"
          ? num * 0.9
          : unit === "turn"
            ? num * 360
            : (num * 180) / Math.PI;
    return degrees >= -90 && degrees <= 90;
  }
  return isSafeCssVarExpression(trimmed);
}

function isSafeFontWeightValue(value) {
  if (value.length > MAX_CSS_VALUE_LENGTH || hasControlChars(value)) return false;
  const trimmed = trimAsciiSpaces(value);
  if (/^(?:normal|bold|bolder|lighter|inherit|initial|unset|revert|revert-layer)$/iu.test(trimmed))
    return true;
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) && num >= 1 && num <= 1000;
  }
  return isSafeCssVarExpression(trimmed);
}

const SAFE_TEXT_DECORATION_TOKENS = new Set([
  "auto",
  "blink",
  "dashed",
  "dotted",
  "double",
  "from-font",
  "inherit",
  "initial",
  "line-through",
  "none",
  "overline",
  "revert",
  "revert-layer",
  "solid",
  "underline",
  "unset",
  "wavy",
]);

function splitTopLevelSpaces(value) {
  const tokens = [];
  let start = -1;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (ch === "(") {
      if (start === -1) start = index;
      depth++;
    } else if (ch === ")") {
      if (depth === 0) return undefined;
      depth--;
    } else if (ch === " " && depth === 0) {
      if (start !== -1) {
        tokens.push(value.slice(start, index));
        start = -1;
      }
    } else if (start === -1) {
      start = index;
    }
  }
  if (depth !== 0) return undefined;
  if (start !== -1) tokens.push(value.slice(start));
  return tokens;
}

function isSafeTextDecorationValue(value) {
  if (value.length > MAX_CSS_VALUE_LENGTH || hasControlChars(value)) return false;
  const trimmed = trimAsciiSpaces(value);
  if (!trimmed) return false;
  if (isSafeCssVarExpression(trimmed)) return true;
  const tokens = splitTopLevelSpaces(trimmed);
  if (!tokens || tokens.length === 0) return false;
  return tokens.every(
    (token) =>
      SAFE_TEXT_DECORATION_TOKENS.has(token.toLowerCase()) ||
      /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|ch|ex|lh|%)?$/iu.test(token) ||
      isSafeSingleCssColor(token),
  );
}

function isSafeCssVarExpression(trimmed) {
  if (!/^var\(/iu.test(trimmed)) return false;
  return isSafeSingleCssColor(trimmed);
}

function hasControlChars(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isValidCssCustomPropertyChar(ch, code) {
  if (code < 0x80) return /[\w-]/u.test(ch);
  return code >= 0xa0 && !/\s/u.test(ch);
}

function isAsciiHexCode(code) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
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

function isValidCssCustomPropertyName(name) {
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

function colorVariableExpression(category, themeFallback) {
  const categories = [category, ...(CATEGORY_FALLBACKS[category] || [])];
  let expression = safeColorFallback(themeFallback);
  for (let index = categories.length - 1; index >= 0; index--)
    expression = `var(--ferriki-${categories[index]}-color, ${expression})`;
  return expression;
}

function safeColorFallback(value) {
  if (typeof value !== "string") return "inherit";
  const parsed = splitOptionalImportant(value);
  const normalized = parsed ? normalizeSafeCssColor(parsed.core) : undefined;
  return normalized ?? "inherit";
}

function validateVarOrEnvArguments(expr, openParen, isEnv) {
  let depth = 0;
  let comma = -1;
  let close = -1;
  for (let cursor = openParen + 1; cursor < expr.length; cursor++) {
    const ch = expr[cursor];
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
    if (ch === "(") depth++;
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
  if (close === -1) return -1;
  const nameEnd = comma === -1 ? close : comma;
  const identName = trimAsciiSpaces(expr.slice(openParen + 1, nameEnd));
  const valid = isEnv ? isValidCssEnvSpecifier(identName) : isValidCssCustomPropertyName(identName);
  return valid ? nameEnd : -1;
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
  if (hasControlChars(value)) return false;
  const normalized = trimAsciiSpaces(value);
  if (!normalized) return false;
  if (normalized.startsWith("#"))
    return /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(normalized);
  if (!normalized.includes("(") && !normalized.includes(")"))
    return /^[a-zA-Z][a-zA-Z-]*$/u.test(normalized);
  if (normalized.includes("/*") || normalized.includes("*/")) return false;

  const open = normalized.indexOf("(");
  if (open <= 0 || !SAFE_COLOR_FUNCTIONS.has(normalized.slice(0, open).toLowerCase())) return false;

  let depth = 0;
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    const code = normalized.charCodeAt(index);
    if (code < 0x80) {
      if (!/^[\w#(),.% /*+-]$/u.test(character)) return false;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = normalized.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index++;
      continue;
    } else if ((code >= 0xdc00 && code <= 0xdfff) || code < 0xa0 || /\s/u.test(character)) {
      return false;
    }
    if (character === "(") {
      const hasAdjacentIdent = index > 0 && /[\w-]/u.test(normalized[index - 1]);
      if (hasAdjacentIdent) {
        let nameStart = index;
        while (nameStart > 0 && /[\w-]/u.test(normalized[nameStart - 1])) nameStart--;
        const fnName = normalized.slice(nameStart, index).toLowerCase();
        const allowed = depth === 0 ? SAFE_COLOR_FUNCTIONS : SAFE_COLOR_INNER_FUNCTIONS;
        if (!allowed.has(fnName)) return false;
        if (fnName === "var" || fnName === "env") {
          const nameEnd = validateVarOrEnvArguments(normalized, index, fnName === "env");
          if (nameEnd === -1) return false;
          depth++;
          index = nameEnd - 1;
          continue;
        }
      } else {
        if (depth === 0) return false;
        let prev = index;
        while (prev > 0 && normalized[prev - 1] === " ") prev--;
        if (prev === 0 || !"(,+-*/".includes(normalized[prev - 1])) return false;
      }
      depth++;
    } else if (character === ")") {
      if (--depth < 0) return false;
      if (depth === 0 && index + 1 !== normalized.length) return false;
    }
  }
  return depth === 0;
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

function isAsciiCssWhitespaceCode(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
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

function isSafeComposedCssColor(expr, depth = 0) {
  if (expr.length <= MAX_CSS_VALUE_LENGTH && isSafeSingleCssColor(expr)) return true;
  if (expr.length > MAX_COMPOSED_VAR_COLOR_LENGTH || depth > MAX_COMPOSED_COLOR_DEPTH) return false;
  let inner = expr;
  let unwrapped = 0;
  while (unwrapped < MAX_VAR_COLOR_WRAPPER_DEPTH) {
    const fallback = unwrapVarColorFallback(inner);
    if (fallback === undefined) break;
    inner = fallback;
    unwrapped++;
  }
  if (unwrapped === 0 && expr.length > MAX_COMPOSED_LIGHT_DARK_LENGTH) return false;
  if (unwrapped > 0 && (inner.length === 0 || isSafeSingleCssColor(inner))) return true;
  if (depth >= MAX_COMPOSED_COLOR_DEPTH) return false;
  const args = splitLightDarkArguments(inner);
  return (
    args !== undefined &&
    isSafeComposedCssColor(args[0], depth + 1) &&
    isSafeComposedCssColor(args[1], depth + 1)
  );
}

function normalizeSafeCssColor(value) {
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
  return normalized !== undefined && isSafeComposedCssColor(normalized, 0) ? normalized : undefined;
}

function isSafeCssColor(value) {
  return normalizeSafeCssColor(value) !== undefined;
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

function updateElementProperties(node, nextProperties, replacements) {
  if (canAssignOwnDataProperty(node, "properties")) {
    node.properties = nextProperties;
    return node;
  }
  const cloned = { ...node, properties: nextProperties };
  replacements.set(node, cloned);
  return cloned;
}

function replaceFrozenNodes(root, replacements) {
  const memo = new Map();
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
        } else if (next === current && canAssignOwnDataProperty(next, "children")) {
          next.children = nextChildren;
        } else {
          next = { ...next, children: nextChildren };
        }
      }
    }
    memo.set(current, next);
    return next;
  };
  return cloneIfNeeded(root);
}

function addClassToProperties(properties, className) {
  const current = properties.class;
  const classes = Array.isArray(current)
    ? current
    : typeof current === "string"
      ? current.split(/\s+/u).filter(Boolean)
      : [];
  properties.class = [...new Set([...classes, className])].join(" ");
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
