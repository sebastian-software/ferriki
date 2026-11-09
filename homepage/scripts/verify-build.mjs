/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed relative to this script. */
/* cspell:words syntect */
// Checks the prerendered site after `ardo build`: every documentation
// page exists and wears the Monografie header and footer, the homepage carries
// the published version, the chart and first-use figures recomputed from the
// verified reports and the credits of its rendered specimens, the footprint
// page carries its committed record, and the strict Node / optional Phiki
// cohorts match the report.
import { access, readdir, readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { validateReport } from "../../node/scripts/run-blacksmith-comparison.mjs";
import { expectedPages } from "./site-pages.mjs";
import { verifyArdoAcceptanceHtml } from "./verify-ardo-acceptance.mjs";

/** A selector list split at its top-level commas, so `:is(a, b)` stays whole. */
function selectorList(prelude) {
  const selectors = [""];
  let depth = 0;
  for (const char of prelude) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) selectors.push("");
    else selectors[selectors.length - 1] += char;
  }
  return selectors.map((selector) => selector.trim());
}

// Shared presentation lives in ferramenta-family. The one exception is the
// homepage's own specimens: every rule there names an `fk-` class, so nothing
// reusable or global can grow in homepage/app.
const specimenStyles = join("components", "homepage-specimens.css");
const appFiles = await readdir(new URL("../app/", import.meta.url), { recursive: true });
for (const file of appFiles.filter((name) => name.endsWith(".css"))) {
  if (file !== specimenStyles) {
    throw new Error(`Use the shared theme instead of homepage/app/${file}`);
  }
  const css = await readFile(new URL(`../app/${file}`, import.meta.url), "utf8");
  const unscoped = css
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("{")
    .slice(0, -1)
    .map((chunk) =>
      chunk.slice(Math.max(chunk.lastIndexOf("}"), chunk.lastIndexOf(";")) + 1).trim(),
    )
    .filter((prelude) => !prelude.startsWith("@"))
    .flatMap((prelude) => selectorList(prelude))
    .filter((selector) => !/\.fk-/.test(selector));
  if (unscoped.length > 0) {
    throw new Error(`${file}: scope ${JSON.stringify(unscoped)} to an fk- class`);
  }
}

// No source imports the Ferra theme or the original kit.
const theme =
  /ferramenta-family\/(?:ferra(?:-ardo|-tokens|-fonts)?\.css|ferra"|landing\.css|chrome\.css)/;
for (const file of appFiles.filter((name) => /\.(?:tsx?|mdx?|css)$/.test(name))) {
  const source = await readFile(new URL(`../app/${file}`, import.meta.url), "utf8");
  if (theme.test(source))
    throw new Error(`app/${file} imports the Ferra theme or the original kit`);
}

const outputDirectory = new URL("../build/client/", import.meta.url);
// No built stylesheet carries a selector of the Ferra theme or the original kit.
const builtAssets = await readdir(new URL("assets/", outputDirectory));
for (const file of builtAssets.filter((name) => name.endsWith(".css"))) {
  const css = await readFile(new URL(`assets/${file}`, outputDirectory), "utf8");
  if (/\.(?:ferra-(?!mark|instrument|workshop-logo)|fam-)[a-z]/.test(css)) {
    throw new Error(`build/client/assets/${file} carries the Ferra theme or the original kit`);
  }
}
await Promise.all(expectedPages.map((page) => access(new URL(page, outputDirectory))));

const read = async (path) => {
  const html = await readFile(new URL(path, outputDirectory), "utf8");
  return html.replaceAll(/<!--[\s\S]*?-->/g, "").replaceAll(/href="(\/[^"?#]*?)\/"/g, 'href="$1"');
};
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

const { version } = await readJson(new URL("../../node/ferriki/package.json", import.meta.url));
const report = await readJson(
  new URL("../../docs/benchmarks/shiki-comparison.json", import.meta.url),
);
const footprint = await readJson(new URL("../app/data/footprint.json", import.meta.url));
const blacksmith = await readJson(
  new URL("../../docs/benchmarks/blacksmith-comparison.json", import.meta.url),
);
const preparedReport = await readJson(
  new URL("../../docs/benchmarks/regex-modes-comparison.json", import.meta.url),
);
const grammarSources = await readJson(
  new URL("../../assets/grammars/sources.json", import.meta.url),
);
const samples = await readJson(new URL("../app/data/homepage-samples.json", import.meta.url));

const totals = report.warmTotalMs;
const factor = (api, other) => totals[api][other] / totals[api].ferriki;
const apiNames = new Set(["codeToHtml"]);
const nodeEngines = ["ferriki", "shiki-wasm", "shiki-js"];
const corpusSize = report.warm.codeToHtml.length;
const cohortErrors = [];

if (!report.method?.apis?.includes("codeToHtml")) {
  cohortErrors.push("the report does not identify its HTML measurement");
}
const otherApis = (report.method?.apis ?? []).filter((api) => !apiNames.has(api));
if (otherApis.length > 0) {
  cohortErrors.push(`the report measures APIs the site does not present: ${otherApis.join(", ")}`);
}

if (
  !report.source ||
  !/^[\da-f]{40}$/.test(report.source.revision) ||
  !/^[\da-f]{40}$/.test(report.source.tree) ||
  report.source.workingTreeClean !== true ||
  !report.source.revision.startsWith(report.revision)
) {
  cohortErrors.push("the report has no valid clean source provenance");
}

// Reuse the benchmark's strict gates, including the narrowly documented YAML
// limitation. Validate original samples before checking compact published data.
const original = JSON.parse(
  gunzipSync(
    await readFile(
      new URL(`../../${report.evidence.archive}comparison-on.json.gz`, import.meta.url),
    ),
  ).toString("utf8"),
);
validateReport(original, "comparison", true);
for (const engine of nodeEngines) {
  if (JSON.stringify(report.agreement[engine]) !== JSON.stringify(original.agreement[engine]))
    cohortErrors.push(`${engine} agreement differs from the validated artifact`);
}
if (JSON.stringify(report.warmTotalMs) !== JSON.stringify(original.warmTotalMs))
  cohortErrors.push("published totals differ from the validated artifact");

if (report.phiki?.status === "available") {
  const phikiRows = report.outputAgreement?.documents ?? [];
  const reportPaths = report.warm.codeToHtml.map((row) => row.path);
  const phikiPaths = phikiRows.map((row) => row.path);
  const phikiMatches = phikiRows.filter((entry) => entry.status === "match").length;
  if (
    phikiRows.length !== corpusSize ||
    JSON.stringify(phikiPaths) !== JSON.stringify(reportPaths)
  ) {
    cohortErrors.push(
      "Phiki output classifications do not cover the HTML corpus in document order",
    );
  }
  if (
    report.agreement.phiki?.documents !== phikiMatches ||
    report.agreement.phiki?.of !== corpusSize
  ) {
    cohortErrors.push(
      "Phiki agreement counts do not match the per-document output classifications",
    );
  }
  if (phikiMatches === 0) {
    if (report.warmMatchingTotalMs !== undefined) {
      cohortErrors.push("an empty Phiki matching cohort has a warm aggregate");
    }
    if (
      report.coldMatching?.status !== "no-matching-documents" ||
      report.coldMatching.documents !== 0
    ) {
      cohortErrors.push("an empty Phiki matching cohort has an invalid cold result");
    }
  } else if (
    report.warmMatchingTotalMs?.documents !== phikiMatches ||
    report.coldMatching?.status !== "available" ||
    report.coldMatching.documents !== phikiMatches
  ) {
    cohortErrors.push("Phiki matching-cohort timings do not match the output classifications");
  }
} else if (
  report.phiki?.status === "skipped" &&
  (report.agreement.phiki?.status !== "skipped" || !report.phiki.reason)
) {
  cohortErrors.push("the skipped Phiki run has no recorded prerequisite reason");
}

if (cohortErrors.length > 0) {
  throw new Error(`The benchmark report is inconsistent:\n- ${cohortErrors.join("\n- ")}`);
}

const oneDecimal = (value) => `${value.toFixed(1)}×`;
const grouped = (value) => value.toLocaleString("en-US");
const homepage = await read("index.html");
const benchmarks = await read("evidence/benchmarks/index.html");
const footprintPage = await read("evidence/footprint/index.html");
const syntectGuide = await read("guide/ferriki-and-syntect/index.html");
const rustGuide = await read("rust/getting-started/index.html");

const prismComparison = await read("guide/ferriki-vs-prism/index.html");
const required = [
  [prismComparison, "Give your code examples the detail of your editor"],
  [prismComparison, "prism-example"],
  [prismComparison, "variable.parameter.ts"],
  [prismComparison, "Plain text"],
  [prismComparison, "prism-comparison-grid"],
  [homepage, `v${version}`],
  [homepage, preparedReport.runUrl],
  [homepage, preparedReport.measured],
  [homepage, "Your editor’s colors, on your page."],
  [homepage, 'class="mono fk-site"'],
  [homepage, 'data-product="ferriki"'],
  [homepage, "@ferriki/core/react/macro"],
  [homepage, `Real output of @ferriki/core ${samples.renderedWith["@ferriki/core"]}`],
  [homepage, `Real output of @ferriki/vite ${samples.renderedWith["@ferriki/vite"]}`],
  [homepage, `${report.agreement.ferriki.documents} / ${report.agreement.ferriki.of}`],
  [homepage, 'href="/guide/build-time-macros"'],
  [homepage, 'href="/guide/ferriki-and-syntect"'],
  [homepage, 'href="/evidence/benchmarks/#four-regex-policies"'],
  // The published anchors other pages and sites link to.
  ...[
    "sample",
    "evidence",
    "prepared-regex",
    "build-time",
    "themes",
    "code",
    "compatibility",
    "coverage",
    "pipeline",
    "start",
    "work",
  ].map((id) => [homepage, `id="${id}"`]),
  [syntectGuide, "Ferriki and syntect"],
  [syntectGuide, "as_24_bit_terminal_escaped"],
  [rustGuide, 'href="/guide/ferriki-and-syntect"'],
  [benchmarks, report.revision],
  [benchmarks, report.machine.cpu],
  [benchmarks, oneDecimal(factor("codeToHtml", "shiki-wasm"))],
  [benchmarks, 'id="rust-syntect-comparison"'],
  [benchmarks, "365.327 ms"],
  [benchmarks, "five untimed corpus warmups"],
  [footprintPage, grouped(footprint.addon.bytes)],
  [footprintPage, grouped(footprint.core.packedBytes)],
  [footprintPage, grouped(footprint.core.unpackedBytes)],
  [footprintPage, footprint.revision],
];
for (const engine of ["shiki-wasm", "shiki-js"]) {
  if (totals.codeToHtml[engine] !== undefined)
    required.push([benchmarks, oneDecimal(factor("codeToHtml", engine))]);
}
for (const profile of blacksmith.profiles) {
  required.push([benchmarks, profile.machine.cpu], [benchmarks, profile.runner]);
  required.push([benchmarks, profile.label]);
  for (const engine of ["shiki-wasm", "shiki-js"]) {
    if (profile.warm.on[engine] === undefined) {
      required.push([benchmarks, "Unsupported"]);
      continue;
    }
    const observedFactor = oneDecimal(profile.warm.on[engine] / profile.warm.on.ferriki);
    required.push([benchmarks, observedFactor]);
  }
}
// The homepage chart: each featured alternative's summed medians over Ferriki's
// prepared packages, over the language files both can highlight, recomputed here.
for (const profile of preparedReport.profiles) {
  for (const engine of ["shiki-wasm", "shiki-js", "prism"]) {
    const shared = profile.workloads.filter((entry) => entry.timings[engine] !== undefined);
    const sum = (id) => shared.reduce((total, entry) => total + entry.timings[id], 0);
    required.push([homepage, `${(sum(engine) / sum("ferriki-precompiled")).toFixed(2)}×`]);
  }
  for (const engine of ["ferriki-precompiled", "ferriki", "shiki-wasm"]) {
    const value = profile.cold[engine];
    required.push([homepage, `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`]);
  }
}
for (const profile of preparedReport.profiles) {
  const scenario = profile.memory.scenarios.find((entry) => entry.id === "repository");
  const reduction = Math.round(
    100 *
      (1 -
        scenario.engines["ferriki-precompiled"].finalRss.median /
          scenario.engines["shiki-wasm"].finalRss.median),
  );
  required.push(
    [homepage, `${reduction}% less memory`],
    [homepage, `${scenario.documents * scenario.passes} renders`],
  );
  required.push([benchmarks, profile.label], [benchmarks, profile.corpusMachines.comparison.cpu]);
  for (const engine of ["ferriki-off", "ferriki-eager", "ferriki-precompiled"]) {
    const value = profile.cold[engine];
    required.push([benchmarks, `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`]);
  }
}
required.push([benchmarks, blacksmith.runUrl], [benchmarks, "JSON and Astro"]);

if (report.phiki?.status === "available") {
  const outputRows = report.outputAgreement?.documents ?? [];
  const phikiDifferences = outputRows.filter((entry) => entry.status === "different").length;
  const phikiErrors = outputRows.filter((entry) => entry.status === "error").length;
  required.push([benchmarks, "Phiki (PHP)"]);
  if (phikiDifferences > 0) {
    required.push([
      benchmarks,
      "Phiki HTML differs; this per-document time is excluded from shared totals.",
    ]);
  }
  if (phikiErrors > 0) required.push([benchmarks, "Phiki could not render this document"]);
  if (report.agreement.phiki.documents === corpusSize) {
    required.push([benchmarks, "Phiki HTML: source and character styles match."]);
  }
  if (report.agreement.phiki.documents === 0) {
    required.push([benchmarks, "no equivalent-work aggregate is reported"]);
  } else {
    required.push([benchmarks, `${report.agreement.phiki.documents} of ${corpusSize} documents`]);
  }
} else if (report.phiki?.status === "skipped") {
  required.push([benchmarks, `Phiki was skipped: ${report.phiki.reason}`]);
}

const missing = required.filter(([html, fragment]) => !html.includes(fragment));
if (missing.length > 0) {
  throw new Error(
    `The prerendered pages are missing:\n- ${missing.map(([, fragment]) => fragment).join("\n- ")}`,
  );
}

const pageFiles = await Promise.all(expectedPages.map(async (page) => [page, await read(page)]));
// Every page wears the Monografie header and footer, never Ardo's, and stands on
// Monografie (ADR-0012 in ferramenta): no class of the Ferra theme or the
// original kit survives; only Ferra's identity assets keep the name.
// Documentation pages stand on the Monografie documentation page and keep their
// section navigation and the menu that carries it on narrow screens.
const ferraIdentity = new Set(["ferra-mark", "ferra-instrument", "ferra-workshop-logo"]);
for (const [page, html] of pageFiles) {
  const fragments = ['class="mono-header"', 'class="mono-footer"', 'rel="icon"'];
  if (page !== "index.html") {
    fragments.push(
      'class="mono mono-docs fk-docs"',
      'class="ardo-sidebar ',
      'aria-label="Toggle menu"',
    );
  }
  const absent = fragments.filter((fragment) => !html.includes(fragment));
  const stray = [
    ...['class="ardo-header', 'class="ardo-footer'].filter((fragment) => html.includes(fragment)),
    ...new Set(
      [...html.matchAll(/class="([^"]*)"/g)]
        .flatMap(([, value]) => value.split(/\s+/))
        .filter((name) => /^(?:ferra|fam)-/.test(name) && !ferraIdentity.has(name)),
    ),
  ];
  if (absent.length > 0 || stray.length > 0) {
    throw new Error(
      `${page}: missing ${JSON.stringify(absent)}, unexpected ${JSON.stringify(stray)}`,
    );
  }
}
const linkCount = await verifyRenderedPages(pageFiles);
verifyFocusableMarkdownCodeBlocks(await read("guide/getting-started/index.html"));
verifyFocusableMarkdownTables(await read("guide/api/index.html"));
verifyGrammarCoverage(await read("guide/languages-and-themes/index.html"));
verifyArdoAcceptanceHtml(await read("evidence/compatibility/index.html"));

console.log(
  `Verified ${expectedPages.length} pages, ${linkCount} internal links and fragments, Ferriki v${version}, report ${report.revision}.`,
);

function verifyGrammarCoverage(html) {
  const rows = [...html.matchAll(/<tr\s[^>]*data-grammar-id="([^"]+)"[^>]*>[\s\S]*?<\/tr>/g)];
  const actualIds = rows.map((row) => row[1]).sort();
  const expectedIds = grammarSources.languages.map((entry) => entry.id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error("The grammar overview must show every accepted catalog entry exactly once.");
  }
  for (const [row, id] of rows) {
    const entry = grammarSources.languages.find((language) => language.id === id);
    const tag = htmlTags(row)[0];
    const keys = [...row.matchAll(/<code\b[^>]*>([^<]*)<\/code>/g)].map((match) =>
      decodeHtml(match[1]),
    );
    if (
      attribute(tag.raw, "data-grammar-role") !== entry.role ||
      JSON.stringify(keys) !== JSON.stringify([entry.id, ...entry.aliases])
    ) {
      throw new Error(`The grammar overview has stale IDs, aliases, or role for ${id}.`);
    }
  }
}

async function verifyRenderedPages(pages) {
  const context = {
    outputPath: fileURLToPath(outputDirectory),
    pageIds: new Map(),
  };
  for (const [page, html] of pages) {
    const tags = htmlTags(html);
    assertPageStructure(page, tags);
    context.pageIds.set(page, collectIds(tags));
  }

  let internalLinks = 0;
  for (const [page, html] of pages) internalLinks += await verifyPageLinks(page, html, context);
  return internalLinks;
}

function verifyFocusableMarkdownTables(html) {
  const tables = htmlTags(html).filter((tag) => tag.name === "table");
  if (tables.length === 0) {
    throw new Error("The rendered API guide has no Markdown tables to verify.");
  }

  const accessible = [
    ...html.matchAll(/<div\s[^>]*role="region"[^>]*tabindex="0"[^>]*>[\s\S]*?<table\b/g),
  ];
  if (accessible.length !== tables.length) {
    throw new Error("Every Markdown table must have a focusable scrolling region.");
  }
}

function verifyFocusableMarkdownCodeBlocks(html) {
  const blocks = htmlTags(html).filter((tag) => tag.name === "pre");
  if (blocks.length === 0) {
    throw new Error("The rendered getting-started guide has no Markdown code blocks to verify.");
  }

  const missingTabIndex = blocks.filter((block) => attribute(block.raw, "tabindex") !== "0");
  if (missingTabIndex.length > 0) {
    throw new Error(
      `The rendered getting-started guide has ${missingTabIndex.length} Markdown code block(s) without keyboard focus.`,
    );
  }
}

function assertPageStructure(page, tags) {
  const h1Count = tags.filter((tag) => tag.name === "h1").length;
  if (h1Count !== 1) throw new Error(`${page} must contain exactly one h1; found ${h1Count}.`);
  const mainCount = tags.filter(
    (tag) => tag.name === "main" || attribute(tag.raw, "role") === "main",
  ).length;
  if (mainCount !== 1)
    throw new Error(`${page} must contain exactly one main landmark; found ${mainCount}.`);
}

async function verifyPageLinks(page, html, context) {
  let links = 0;
  for (const tag of htmlTags(html)) {
    if (tag.name === "a" && (await verifyInternalLink(page, tag, context))) links++;
  }
  return links;
}

async function verifyInternalLink(page, tag, context) {
  const rawHref = attribute(tag.raw, "href");
  if (rawHref === undefined) return false;
  const href = decodeHtml(rawHref).trim();
  if (href === "") return false;

  const sourcePath = page === "index.html" ? "/" : `/${page.replaceAll(/index\.html$/g, "")}`;
  const targetUrl = new URL(href, new URL(sourcePath, "https://ferriki.dev"));
  if (targetUrl.origin !== "https://ferriki.dev") return false;

  const targetPath = resolveTargetPath({
    targetUrl,
    href,
    sourcePage: page,
    outputPath: context.outputPath,
  });
  const absolutePath = resolve(context.outputPath, targetPath);
  await access(absolutePath).catch(() => {
    throw new Error(`${page} links to a missing built file: ${href} (${targetPath})`);
  });
  await verifyFragment({ page, targetPath, targetUrl, absolutePath, href, context });
  return true;
}

function resolveTargetPath({ targetUrl, href, sourcePage, outputPath }) {
  const decodedPath = decodeURIComponent(targetUrl.pathname);
  let targetPath = normalize(decodedPath.replaceAll(/^\/+/g, ""));
  if (targetPath === "" || decodedPath.endsWith("/") || !extname(targetPath))
    targetPath = join(targetPath, "index.html");
  const absolutePath = resolve(outputPath, targetPath);
  const relativePath = relative(outputPath, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`))
    throw new Error(`${sourcePage} links outside the built site: ${href}`);
  return targetPath;
}

async function verifyFragment({ page, targetPath, targetUrl, absolutePath, href, context }) {
  const fragment = decodeURIComponent(targetUrl.hash.slice(1));
  if (!fragment || !targetPath.endsWith(".html")) return;
  let ids = context.pageIds.get(targetPath);
  if (ids === undefined) {
    const html = await readFile(absolutePath, "utf8");
    ids = collectIds(htmlTags(html));
    context.pageIds.set(targetPath, ids);
  }
  if (!ids.has(fragment)) throw new Error(`${page} links to a missing fragment: ${href}`);
}

function collectIds(tags) {
  return new Set(
    tags
      .map((tag) => attribute(tag.raw, "id"))
      .filter((id) => id !== undefined)
      .map((id) => decodeHtml(id)),
  );
}

function htmlTags(html) {
  return [...html.matchAll(/<([a-z][a-z0-9:-]*)\b[^<>]*>/gi)].map((match) => ({
    name: match[1].toLowerCase(),
    raw: match[0],
    index: match.index,
  }));
}

function attribute(tag, name) {
  const wantedName = name.toLowerCase();
  const cursor = { index: skipTagName(tag) };
  while (cursor.index < tag.length) {
    skipWhitespace(tag, cursor);
    if (tag[cursor.index] === "/" || tag[cursor.index] === ">") break;
    const attributeName = readAttributeName(tag, cursor);
    if (attributeName === "") continue;
    const value = readAttributeValue(tag, cursor);
    if (attributeName === wantedName) return value;
  }
}

function skipTagName(tag) {
  let index = 1;
  while (index < tag.length && !/[\s/>]/.test(tag[index])) index++;
  return index;
}

function skipWhitespace(tag, cursor) {
  while (cursor.index < tag.length && /\s/.test(tag[cursor.index])) cursor.index++;
}

function readAttributeName(tag, cursor) {
  const start = cursor.index;
  while (cursor.index < tag.length && !/[\s=/>]/.test(tag[cursor.index])) cursor.index++;
  if (start === cursor.index) {
    cursor.index++;
    return "";
  }
  return tag.slice(start, cursor.index).toLowerCase();
}

function readAttributeValue(tag, cursor) {
  skipWhitespace(tag, cursor);
  if (tag[cursor.index] !== "=") return "";
  cursor.index++;
  skipWhitespace(tag, cursor);
  return readQuotedValue(tag, cursor) ?? readUnquotedValue(tag, cursor);
}

function readQuotedValue(tag, cursor) {
  const quote = tag[cursor.index];
  if (quote !== '"' && quote !== "'") return;
  const start = ++cursor.index;
  while (cursor.index < tag.length && tag[cursor.index] !== quote) cursor.index++;
  const value = tag.slice(start, cursor.index);
  cursor.index++;
  return value;
}

function readUnquotedValue(tag, cursor) {
  const start = cursor.index;
  while (cursor.index < tag.length && !/[\s>]/.test(tag[cursor.index])) cursor.index++;
  return tag.slice(start, cursor.index);
}

function decodeHtml(value) {
  return value
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&#39;|&apos;/gi, "'")
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")
    .replaceAll(/&#(\d+);?/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replaceAll(/&#x([\da-f]+);?/gi, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    );
}
