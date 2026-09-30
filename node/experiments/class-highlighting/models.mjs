import { createHash } from "node:crypto";

export const models = ["flat", "nested", "hybrid"];

// Reversible segment encoding: a literal '-' must not collide with a scope '.'.
export function scopeName(scope) {
  return scope
    .split(".")
    .map((part) => part.replace(/[^a-z0-9]/gi, (char) => `_${char.codePointAt(0).toString(16)}_`))
    .join("-");
}

export function prefixes(scope, role) {
  const parts = scope.split(".");
  return parts.map((_, index) => `${role}-${scopeName(parts.slice(0, index + 1).join("."))}`);
}

export function pathId(scopes) {
  return `path-${createHash("sha256").update(JSON.stringify(scopes)).digest("hex").slice(0, 16)}`;
}

export function flatClasses(scopes) {
  return [
    ...new Set([
      "token",
      ...scopes.flatMap((scope) => prefixes(scope, "tok")),
      ...scopes.slice(0, -1).flatMap((scope) => prefixes(scope, "ctx")),
      ...prefixes(scopes.at(-1), "leaf"),
    ]),
  ].sort();
}

export function identity(scopes, model) {
  return model === "flat" ? flatClasses(scopes).join(" ") : JSON.stringify(scopes);
}

export function exactSelector(scopes, model) {
  if (model === "hybrid") return `.${pathId(scopes)}`;
  if (model === "nested")
    return `.fixture > ${scopes.map((scope) => `.exact-${scopeName(scope)}`).join(" > ")} > .token`;
  return flatClasses(scopes)
    .map((name) => `.${name}`)
    .join("");
}

export function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderTokens(tokens, model) {
  let output = "";
  let open = [];
  for (const token of tokens) {
    if (model === "nested") {
      let shared = 0;
      while (shared < open.length && open[shared] === token.scopes[shared]) shared++;
      output += "</span>".repeat(open.length - shared);
      for (const scope of token.scopes.slice(shared)) {
        output += `<span class="${[...prefixes(scope, "scope"), `exact-${scopeName(scope)}`].join(" ")}">`;
      }
      open = token.scopes;
    }
    const classes = flatClasses(token.scopes);
    if (model === "hybrid") classes.push(pathId(token.scopes));
    output += `<span class="${classes.join(" ")}" data-token="${token.index}">${escapeHtml(token.content)}</span>`;
  }
  return output + "</span>".repeat(open.length);
}

export function declaration(style) {
  const fontStyle = style.fontStyle || 0;
  return `color:${style.color};font-style:${fontStyle & 1 ? "italic" : "normal"};font-weight:${fontStyle & 2 ? "700" : "400"};text-decoration-line:${[fontStyle & 4 ? "underline" : "", fontStyle & 8 ? "line-through" : ""].filter(Boolean).join(" ") || "none"}`;
}

export function classifyCollisions(paths, styles, model) {
  const groups = new Map();
  for (const path of paths) {
    const key = identity(path.scopes, model);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(path.id);
  }
  const conflicts = [];
  for (const [key, ids] of groups) {
    for (const [theme, table] of Object.entries(styles)) {
      if (new Set(ids.map((id) => JSON.stringify(table[id]))).size > 1) {
        conflicts.push({ theme, paths: ids, key });
      }
    }
  }
  return { groups: groups.size, conflicts };
}
