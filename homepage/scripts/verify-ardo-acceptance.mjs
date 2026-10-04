/* eslint-disable security/detect-non-literal-fs-filename -- The optional HTML path is used by the local contract proof. */
// Checks the compiled compatibility page's native Markdown highlighting corpus.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function verifyArdoAcceptanceHtml(output) {
  verifyTypeScript(output);
  verifyTsx(output);
  verifyEmbeddedHtml(output);
  verifyUnknownLanguage(output);
}

function verifyTypeScript(output) {
  const typescript = codeBlockByTitle(output, "src/add.ts");
  requireFragments(typescript, "TypeScript", [
    'data-label="typescript"',
    "--shiki-light",
    "--shiki-dark",
    'data-ln="1"',
    'data-ln="2"',
  ]);
  requireClass(typescript, "shiki", "TypeScript");
  requireStyledText(typescript, "export", "TypeScript");
  requireHighlightedLine(typescript, 2, "TypeScript");
  requireText(typescript, "return left + right;");
}

function verifyTsx(output) {
  const tsx = codeBlockByTitle(output, "src/Button.tsx");
  requireFragments(tsx, "TSX", [
    'data-label="tsx"',
    "--shiki-light",
    "--shiki-dark",
    'data-ln="1"',
    'data-ln="3"',
  ]);
  requireClass(tsx, "shiki", "TSX");
  requireStyledText(tsx, "button", "TSX");
  requireHighlightedLine(tsx, 3, "TSX");
  requireText(tsx, 'return <button type="button">{label}</button>;');
}

function verifyEmbeddedHtml(output) {
  const embeddedHtml = codeBlockByTitle(output, "public/widget.html");
  requireFragments(embeddedHtml, "embedded HTML", [
    'data-label="embedded"',
    "--shiki-light",
    "--shiki-dark",
    'data-ln="3"',
    'data-ln="7"',
  ]);
  requireClass(embeddedHtml, "shiki", "embedded HTML");
  requireHighlightedLine(embeddedHtml, 3, "embedded HTML CSS");
  requireHighlightedLine(embeddedHtml, 7, "embedded HTML JavaScript");
  requireText(embeddedHtml, 'document.querySelector(".notice")?.classList.add("ready");');
  requireText(embeddedHtml, ".notice {");
  requireText(embeddedHtml, "color: rebeccapurple;");
  requireStyledText(embeddedHtml, "rebeccapurple", "embedded HTML CSS");
  requireStyledText(embeddedHtml, "querySelector", "embedded HTML JavaScript");
}

function verifyUnknownLanguage(output) {
  const fallback = codeBlockByTitle(output, "data/example.unknown");
  requireFragments(fallback, "unknown-language fallback", [
    'data-label="fallback"',
    "&lt;raw value=&quot;literal &amp; safe&quot;&gt;",
  ]);
  requireText(fallback, '<raw value="literal & safe">');
  if (hasClass(fallback, "shiki") || /<span\b[^<>]+style=/i.test(fallback)) {
    throw new Error("The unknown-language example retained syntax-token styling.");
  }
}

function codeBlockByTitle(html, title) {
  const marker = `data-code-title="${title}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) throw new Error(`The rendered page is missing ${marker}.`);

  const start = html.lastIndexOf("<pre", markerIndex);
  const end = html.indexOf("</pre>", markerIndex);
  if (start === -1 || end === -1) {
    throw new Error(`Could not isolate the rendered code block titled ${JSON.stringify(title)}.`);
  }
  if (html.includes(marker, markerIndex + marker.length)) {
    throw new Error(
      `The rendered page contains duplicate code block title ${JSON.stringify(title)}.`,
    );
  }
  return html.slice(start, end + "</pre>".length);
}

function requireFragments(block, label, fragments) {
  const missing = fragments.filter((fragment) => !block.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`${label} output is missing: ${missing.join(", ")}`);
  }
}

function requireClass(block, className, label) {
  if (!hasClass(block, className)) {
    throw new Error(`${label} output is missing the ${JSON.stringify(className)} class.`);
  }
}

function hasClass(block, className) {
  return [...block.matchAll(/\bclass="([^"]*)"/g)].some(([, value]) =>
    value.split(/\s+/).includes(className),
  );
}

function requireHighlightedLine(block, line, label) {
  const lineSpan = [...block.matchAll(/<span\b([^<>]*)>/g)].find(
    ([, attributes]) => /\bdata-ln="(\d+)"/.exec(attributes)?.[1] === String(line),
  );
  if (!lineSpan) throw new Error(`${label} output is missing line ${line}.`);

  const classes = /\bclass="([^"]*)"/.exec(lineSpan[1])?.[1].split(/\s+/) ?? [];
  if (!classes.includes("ox-code-line--highlight") || !classes.includes("highlighted")) {
    throw new Error(`${label} output is missing the highlight annotation on line ${line}.`);
  }
}

function requireStyledText(block, text, label) {
  const spans = [...block.matchAll(/<span\b([^<>]*)>([^<]*)<\/span>/g)];
  const highlighted = spans.some(
    ([, attributes, content]) => /\bstyle=/.test(attributes) && decodeHtml(content).includes(text),
  );
  if (!highlighted) {
    throw new Error(`${label} output is missing syntax-token styling for ${JSON.stringify(text)}.`);
  }
}

function requireText(block, text) {
  const actual = decodeHtml(block.replaceAll(/<[^<>]*>/g, ""));
  if (!actual.includes(text)) {
    throw new Error(`The rendered code block is missing source text ${JSON.stringify(text)}.`);
  }
}

function decodeHtml(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

async function main() {
  const htmlPath = process.argv[2]
    ? pathToFileURL(process.argv[2])
    : new URL("../build/client/evidence/compatibility/index.html", import.meta.url);
  verifyArdoAcceptanceHtml(await readFile(htmlPath, "utf8"));
  console.log("Verified native Markdown highlighting fixtures in the production HTML.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
