import { createRequire } from "node:module";

const require = createRequire(new URL("../node/package.json", import.meta.url));

// These parsers are build dependencies. Downloaded grammars are always data.
export function parseGrammarSource(text, source) {
  if (/\.cson$/i.test(source)) {
    const { parse } = require("cson-parser");
    return parse(text);
  }
  if (/\.ya?ml$/i.test(source)) {
    const { load, JSON_SCHEMA } = require("js-yaml");
    const grammar = load(text, { schema: JSON_SCHEMA });
    const variables = grammar.variables || {};
    function expand(value, visiting = new Set()) {
      return value.replace(/\{\{([\w-]+)\}\}/g, (_, name) => {
        if (visiting.has(name) || typeof variables[name] !== "string")
          throw new Error(`Invalid grammar variable ${name} in ${source}`);
        return expand(variables[name], new Set([...visiting, name]));
      });
    }
    function walk(value) {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
      return typeof value === "string" ? expand(value) : value;
    }
    delete grammar.variables;
    return walk(grammar);
  }
  if (text.trimStart().startsWith("<")) {
    const { parse } = require("plist");
    return parse(text);
  }
  return JSON.parse(text);
}

export function applyGrammarPatches(grammar, patches = []) {
  for (const { path, before, after, reason } of patches) {
    if (!reason) throw new Error(`Grammar patch ${path} requires a reason`);
    const keys = path
      .split("/")
      .slice(1)
      .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
    let parent = grammar;
    for (const key of keys.slice(0, -1)) parent = parent[key];
    const key = keys.at(-1);
    if (JSON.stringify(parent[key]) !== JSON.stringify(before))
      throw new Error(`Grammar patch ${path} no longer matches its pinned source`);
    if (after === undefined) delete parent[key];
    else parent[key] = after;
  }
  return grammar;
}

export function normalizeGrammar(grammar, entry) {
  if (!grammar || typeof grammar !== "object" || !grammar.scopeName)
    throw new Error(`Invalid TextMate grammar: ${entry.id}`);
  const originalScope = grammar.scopeName;
  function rebase(value) {
    if (Array.isArray(value)) return value.map(rebase);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "include" &&
        typeof item === "string" &&
        (item === originalScope || item.startsWith(`${originalScope}#`))
          ? entry.scope_name + item.slice(originalScope.length)
          : rebase(item),
      ]),
    );
  }
  return {
    ...rebase(grammar),
    name: entry.id,
    scopeName: entry.scope_name,
    displayName: entry.display_name,
    aliases: entry.aliases,
    embeddedLangs: entry.embedded_langs,
    embeddedLangsLazy: entry.embedded_langs_lazy,
    injectTo: entry.inject_to,
  };
}
