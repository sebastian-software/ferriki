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

export function addScopeClasses(span, scopes) {
  const classes = [
    "token",
    ...scopes.flatMap((scope) => scopePrefixes(scope, "tok")),
    ...(scopes.length ? scopePrefixes(scopes.at(-1), "leaf") : []),
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
export function nestScopes(node, paths) {
  if (!node.children) return;
  const children = [];
  const parents = [children];
  let open = [];
  for (const child of node.children) {
    const scopes = paths.get(child);
    if (!scopes) {
      open = [];
      parents.length = 1;
      nestScopes(child, paths);
      children.push(child);
      continue;
    }
    let shared = 0;
    while (shared < open.length && open[shared] === scopes[shared]) shared++;
    parents.length = shared + 1;
    for (const scope of scopes.slice(shared)) {
      const wrapper = {
        type: "element",
        tagName: "span",
        properties: {
          class: [...scopePrefixes(scope, "scope"), `exact-${scopeClass(scope)}`].join(" "),
        },
        children: [],
      };
      parents.at(-1).push(wrapper);
      parents.push(wrapper.children);
    }
    parents.at(-1).push(child);
    open = scopes;
  }
  node.children = children;
}

function styleText(style) {
  return typeof style === "string"
    ? style
    : Object.entries(style)
        .map(([key, value]) => `${key}:${value}`)
        .join(";");
}

// Full digests avoid truncation collisions. Rules use zero specificity so ordinary
// scope selectors can override an existing theme without !important.
export function extractClassStyles(tree) {
  const rules = new Map();
  function visit(node) {
    if (node.type === "element" && node.properties?.style) {
      const style = styleText(node.properties.style);
      const name = `ferriki-style-${createHash("sha256").update(style).digest("hex")}`;
      const current = node.properties.class;
      node.properties.class = [Array.isArray(current) ? current.join(" ") : current, name]
        .filter(Boolean)
        .join(" ");
      delete node.properties.style;
      rules.set(name, `:where(.${name}){${style}}`);
    }
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return [...rules.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, rule]) => rule)
    .join("\n");
}

export function themeSwitchStyles(options) {
  if (!options.themes) return { className: "", css: "" };
  const inputKeys = Object.keys(options.themes).filter(
    (key) => options.themes[key] != null && options.themes[key] !== false,
  );
  const keys = [...inputKeys].sort();
  const defaultKey =
    typeof options.defaultColor === "string" && keys.includes(options.defaultColor)
      ? options.defaultColor
      : keys.includes("light")
        ? "light"
        : inputKeys[0];
  const prefix = options.cssVariablePrefix || "--shiki-";
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
