export type Grammar = {
  id: string;
  name: null | string;
  aliases: string[];
  role: "dependency" | "standard";
};

// Vite supplies compact metadata from the accepted grammar source lock at build time.
declare const __FERRIKI_GRAMMAR_CATALOG__: Grammar[];

export const grammarCatalog = __FERRIKI_GRAMMAR_CATALOG__;
export const grammarCount = grammarCatalog.length;
export const standardGrammarCount = grammarCatalog.filter(
  (entry) => entry.role === "standard",
).length;
export const supportGrammarCount = grammarCatalog.filter(
  (entry) => entry.role === "dependency",
).length;
