/* eslint-disable antfu/no-top-level-await -- This executable measures the fixed corpus with the current native build. */
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { createHighlighter } from "../../ferriki/index.mjs";
import { syntheticGrammar } from "./corpus.mjs";

const generated = new URL("../../.generated/class-highlighting/", import.meta.url);
const { cases } = JSON.parse(await readFile(new URL("data.json", generated), "utf8"));
const highlighter = await createHighlighter({
  langs: [...new Set(cases.map((item) => item.lang))].map((lang) =>
    lang === syntheticGrammar.name ? syntheticGrammar : lang,
  ),
  themes: ["monokai", "github-light"],
});
const results = {};
try {
  for (const [name, options] of [
    ["customCss", { theme: "none" }],
    ["singleTheme", { theme: "monokai" }],
    ["dualTheme", { themes: { light: "github-light", dark: "monokai" } }],
  ]) {
    const output = cases.map((item) =>
      highlighter.codeToHtmlWithCss(item.code, {
        lang: item.lang,
        tokenizeTimeLimit: 0,
        ...options,
      }),
    );
    const html = output.map((item) => item.html).join("");
    const css = [...new Set(output.flatMap((item) => item.css.split("\n")))].join("\n");
    results[name] = {
      htmlBytes: Buffer.byteLength(html),
      gzipHtmlBytes: gzipSync(html).length,
      cssBytes: Buffer.byteLength(css),
      gzipCssBytes: gzipSync(css).length,
    };
  }
} finally {
  highlighter.dispose();
}
await writeFile(
  new URL("production-sizes.json", generated),
  `${JSON.stringify(results, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
