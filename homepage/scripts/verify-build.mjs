/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed relative to this script. */
// Checks the prerendered site after `react-router build`: every documentation
// page exists, the landing page carries the published version and HTML
// measurements, and the strict Node / optional Phiki cohorts match the report.
import { access, readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedPages } from "./site-pages.mjs";
import { verifyArdoAcceptanceHtml } from "./verify-ardo-acceptance.mjs";

const outputDirectory = new URL("../build/client/", import.meta.url);
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
const apiNames = ["codeToHtml"];
const nodeEngines = ["ferriki", "shiki-wasm", "shiki-js"];
const corpusSize = report.warm.codeToHtml.length;
const cohortErrors = [];

if (!report.method?.apis?.includes("codeToHtml")) {
  cohortErrors.push("the report does not identify its HTML measurement");
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

for (const engine of nodeEngines) {
  const result = report.agreement[engine];
  if (result?.documents !== corpusSize || result?.of !== corpusSize) {
    cohortErrors.push(`${engine} does not pass the strict full-corpus Node output gate`);
  }
}

for (const api of apiNames) {
  if (report.warm[api].length !== corpusSize) {
    cohortErrors.push(`${api} has a different document count from codeToHtml`);
  }
  for (const engine of nodeEngines) {
    if (totals[api][engine] !== undefined && report.agreement[engine].documents !== corpusSize) {
      cohortErrors.push(`${api} includes ${engine} without full-corpus Node agreement`);
    }
  }
}

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
const homepage = await read("index.html");
const benchmarks = await read("evidence/benchmarks/index.html");

const required = [
  [homepage, `v${version}`],
  [homepage, oneDecimal(factor("codeToHtml", "shiki-wasm"))],
  [homepage, oneDecimal(factor("codeToHtml", "shiki-js"))],
  [homepage, oneDecimal(cold)],
  [homepage, report.revision],
  [homepage, "codeToHtmlWithCss, reusable highlighters"],
  [homepage, 'class="site-header"'],
  [homepage, 'class="site-footer"'],
  [benchmarks, report.revision],
  [benchmarks, report.machine.cpu],
  [benchmarks, oneDecimal(factor("codeToHtml", "shiki-wasm"))],
];
for (const engine of ["shiki-wasm", "shiki-js"]) {
  required.push([benchmarks, oneDecimal(factor("codeToHtml", engine))]);
}
if (report.method?.apis?.some((api) => api !== "codeToHtml")) {
  required.push([benchmarks, "pre-removal HTML baseline"]);
  required.push([benchmarks, "archival measurements from the former Node API"]);
}

if (report.phiki?.status === "available") {
  const outputRows = report.outputAgreement?.documents ?? [];
  const phikiDifferences = outputRows.filter((entry) => entry.status === "different").length;
  const phikiErrors = outputRows.filter((entry) => entry.status === "error").length;
  required.push([benchmarks, "Phiki (PHP)"]);
  required.push([
    homepage,
    `matched on ${report.agreement.phiki.documents} of ${corpusSize} documents`,
  ]);
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
const linkCount = await verifyRenderedPages(pageFiles);
verifyArdoAcceptanceHtml(await read("evidence/compatibility/index.html"));

console.log(
  `Verified ${expectedPages.length} pages, ${linkCount} internal links and fragments, Ferriki v${version}, report ${report.revision}.`,
);

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
