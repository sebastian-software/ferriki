import { readFileSync } from "node:fs";

// Compare tokenizer/rendering behavior using identical grammar data. Ferriki's
// independently updated catalog need not match Shiki's historical bundle.
export function standardGrammarRegistrations(names) {
  const root = new URL("../../assets/upstream/curated/", import.meta.url);
  const { languages } = JSON.parse(readFileSync(new URL("languages.json", root), "utf8"));
  const byKey = new Map(
    languages.flatMap((entry) => [entry.id, ...entry.aliases].map((key) => [key, entry])),
  );
  const selected = new Map();
  function add(name) {
    const entry = byKey.get(name);
    if (!entry) throw new Error(`No standard reference grammar: ${name}`);
    if (selected.has(entry.id)) return;
    selected.set(entry.id, entry);
    for (const dependency of entry.embedded_langs) add(dependency);
  }
  for (const name of names) add(name);
  return [...selected.values()].map((entry) =>
    JSON.parse(readFileSync(new URL(`grammars/${entry.grammar_file}`, root), "utf8")),
  );
}

// Keep the theme identical too, independently of the comparator's release.
export function standardThemeRegistrations(names) {
  const root = new URL("../../assets/upstream/curated/", import.meta.url);
  const { themes } = JSON.parse(readFileSync(new URL("themes.json", root), "utf8"));
  return names.map((name) => {
    const entry = themes.find((theme) => theme.id === name);
    if (!entry) throw new Error(`No standard reference theme: ${name}`);
    return JSON.parse(readFileSync(new URL(`themes/${entry.theme_file}`, root), "utf8"));
  });
}
