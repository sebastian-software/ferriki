/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed relative to this script. */
// Checks the prerendered site after `react-router build`: every documentation
// page exists, the landing page carries the published version and the
// measured figures, and the prose around the benchmark still describes the
// committed report. A new measurement that changes the story fails here, so
// the words are updated with the numbers.
import { access, readFile } from "node:fs/promises";

const outputDirectory = new URL("../build/client/", import.meta.url);
const expectedPages = [
  "index.html",
  "guide/getting-started/index.html",
  "guide/migrating-from-shiki/index.html",
  "guide/languages-and-themes/index.html",
  "guide/api/index.html",
  "guide/troubleshooting/index.html",
  "rust/getting-started/index.html",
  "evidence/benchmarks/index.html",
  "evidence/compatibility/index.html",
];

await Promise.all(expectedPages.map((page) => access(new URL(page, outputDirectory))));

const read = (path) => readFile(new URL(path, outputDirectory), "utf8");
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

const { version } = await readJson(new URL("../../node/ferriki/package.json", import.meta.url));
const report = await readJson(
  new URL("../../docs/benchmarks/shiki-comparison.json", import.meta.url),
);

const totals = report.warmTotalMs;
const factor = (api, other) => totals[api][other] / totals[api].ferriki;
const cold = report.cold["shiki-wasm"].medianMs / report.cold.ferriki.medianMs;

// The claims the landing page and the benchmark page make in words.
const claims = [
  ["codeToHtml is faster than Shiki with WASM", factor("codeToHtml", "shiki-wasm") > 1.1],
  ["codeToHtml is faster than Shiki with the JS engine", factor("codeToHtml", "shiki-js") > 1.1],
  ["codeToHast is slower than Shiki with WASM", factor("codeToHast", "shiki-wasm") < 1],
  [
    "codeToTokensBase is about even with Shiki with WASM",
    Math.abs(factor("codeToTokensBase", "shiki-wasm") - 1) < 0.2,
  ],
  ["cold start is faster than Shiki with WASM", cold > 1.1],
  [
    "every engine agrees on every document",
    Object.values(report.agreement).every((entry) => entry.documents === entry.of),
  ],
];
const broken = claims.filter(([, holds]) => !holds).map(([claim]) => claim);
if (broken.length > 0) {
  throw new Error(
    `The benchmark report no longer supports what the site says:\n- ${broken.join("\n- ")}\nUpdate app/routes/home.tsx and app/routes/evidence/benchmarks.mdx with the new report.`,
  );
}

const oneDecimal = (value) => `${value.toFixed(1)}×`;
const homepage = await read("index.html");
const benchmarks = await read("evidence/benchmarks/index.html");

const required = [
  [homepage, `v${version}`],
  [homepage, oneDecimal(factor("codeToHtml", "shiki-wasm"))],
  [homepage, oneDecimal(factor("codeToHtml", "shiki-js"))],
  [homepage, oneDecimal(cold)],
  [homepage, report.revision],
  [homepage, 'class="site-header"'],
  [homepage, 'class="site-footer"'],
  [benchmarks, report.revision],
  [benchmarks, report.machine.cpu],
  [benchmarks, oneDecimal(factor("codeToHast", "shiki-wasm"))],
];
const missing = required.filter(([html, fragment]) => !html.includes(fragment));
if (missing.length > 0) {
  throw new Error(
    `The prerendered pages are missing:\n- ${missing.map(([, fragment]) => fragment).join("\n- ")}`,
  );
}

console.log(
  `Verified ${expectedPages.length} pages, Ferriki v${version}, report ${report.revision}.`,
);
