import { createRequire } from "node:module";

const require = createRequire(new URL("../node/package.json", import.meta.url));

const YAML_VARIABLE_EXPANSION_BYTE_LIMIT = 8 * 1024 * 1024;
const YAML_VARIABLE_EXPANSION_INTERMEDIATE_BYTE_LIMIT = 16 * 1024 * 1024;
const YAML_VARIABLE_EXPANSION_SUBSTITUTION_LIMIT = 100_000;
const YAML_VARIABLE_EXPANSION_DEPTH_LIMIT = 64;

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
    const budget = { expandedBytes: 0, intermediateBytes: 0, substitutions: 0 };
    function exceeded(limit, maximum) {
      throw new Error(
        "YAML grammar variable expansion in " +
          source +
          " exceeded the " +
          limit +
          " limit (" +
          maximum +
          ")",
      );
    }
    function expand(value, visiting = new Set(), depth = 0) {
      if (!/\{\{([\w-]+)\}\}/.test(value)) return { value, hasVariables: false, bytes: 0 };

      const parts = [];
      let outputBytes = 0;
      let position = 0;
      function append(part, bytes = Buffer.byteLength(part, "utf8")) {
        if (outputBytes + bytes > YAML_VARIABLE_EXPANSION_BYTE_LIMIT)
          exceeded("expanded string bytes", "8 MiB");
        outputBytes += bytes;
        parts.push(part);
      }

      const pattern = /\{\{([\w-]+)\}\}/g;
      let match;
      while ((match = pattern.exec(value))) {
        append(value.slice(position, match.index));
        const name = match[1];
        if (visiting.has(name) || typeof variables[name] !== "string")
          throw new Error(`Invalid grammar variable ${name} in ${source}`);
        if (depth >= YAML_VARIABLE_EXPANSION_DEPTH_LIMIT)
          exceeded("nesting depth", YAML_VARIABLE_EXPANSION_DEPTH_LIMIT);
        budget.substitutions += 1;
        if (budget.substitutions > YAML_VARIABLE_EXPANSION_SUBSTITUTION_LIMIT)
          exceeded("substitution count", "100,000");
        const expanded = expand(variables[name], new Set([...visiting, name]), depth + 1);
        const bytes = expanded.hasVariables
          ? expanded.bytes
          : Buffer.byteLength(expanded.value, "utf8");
        if (budget.intermediateBytes + bytes > YAML_VARIABLE_EXPANSION_INTERMEDIATE_BYTE_LIMIT)
          exceeded("intermediate variable output bytes", "16 MiB");
        budget.intermediateBytes += bytes;
        append(expanded.value, bytes);
        position = pattern.lastIndex;
      }
      append(value.slice(position));
      return { value: parts.join(""), hasVariables: true, bytes: outputBytes };
    }
    function walk(value) {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
      if (typeof value !== "string") return value;
      const expanded = expand(value);
      if (!expanded.hasVariables) return value;
      if (budget.expandedBytes + expanded.bytes > YAML_VARIABLE_EXPANSION_BYTE_LIMIT)
        exceeded("total expanded bytes", "8 MiB");
      budget.expandedBytes += expanded.bytes;
      return expanded.value;
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
