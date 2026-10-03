/* eslint-disable security/detect-non-literal-fs-filename -- Paths are fixed relative to this script. */
// Checks the prerendered site after `react-router build`: every documentation
// page exists, the landing page carries the published version and the
// measured figures, and the prose around the benchmark still describes the
// committed report. A new measurement that changes the story fails here, so
// the words are updated with the numbers.
import { access, readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectedPages } from "./site-pages.mjs";

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

const pageFiles = await Promise.all(expectedPages.map(async (page) => [page, await read(page)]));
const linkCount = await verifyRenderedPages(pageFiles);

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
    assertNamedControls(page, html, tags);
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

function assertNamedControls(page, html, tags) {
  for (const tag of tags) {
    if (tag.name === "img") assertImageAlt(page, tag);
    else if (["a", "button"].includes(tag.name)) assertElementName(page, html, tag);
    else if (isNamedControl(tag)) assertControlName({ page, html, tags, tag });
  }
}

function assertImageAlt(page, tag) {
  if (attribute(tag.raw, "alt") === undefined)
    throw new Error(`${page} has an image without an alt attribute.`);
}

function assertElementName(page, html, tag) {
  if (!hasElementName(html, tag)) throw new Error(`${page} has an unnamed ${tag.name}.`);
}

function isNamedControl(tag) {
  if (tag.name === "input" && attribute(tag.raw, "type")?.toLowerCase() === "hidden") return false;
  return ["input", "select", "textarea"].includes(tag.name);
}

function assertControlName({ page, html, tags, tag }) {
  if (!hasAccessibleName(html, tags, tag)) throw new Error(`${page} has an unnamed ${tag.name}.`);
}

function hasElementName(html, tag) {
  const ariaName = attribute(tag.raw, "aria-label");
  const labelledBy = attribute(tag.raw, "aria-labelledby");
  const title = attribute(tag.raw, "title");
  const innerText = elementText(html, tag, tag.name);
  return [ariaName, labelledBy, title, innerText].some((name) => name?.trim());
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

function elementText(html, tag, name) {
  const start = tag.index + tag.raw.length;
  const end = html.indexOf(`</${name}`, start);
  if (end === -1) return "";
  let text = "";
  let insideTag = false;
  for (const character of html.slice(start, end)) {
    if (character === "<") insideTag = true;
    else if (character === ">") insideTag = false;
    else if (!insideTag) text += character;
  }
  return decodeHtml(text).trim();
}

function hasAccessibleName(html, tags, tag) {
  const ariaName = attribute(tag.raw, "aria-label");
  const labelledBy = attribute(tag.raw, "aria-labelledby");
  const title = attribute(tag.raw, "title");
  if ([ariaName, labelledBy, title].some((value) => value?.trim())) return true;

  const id = attribute(tag.raw, "id");
  if (
    id &&
    tags.some((candidate) => candidate.name === "label" && attribute(candidate.raw, "for") === id)
  )
    return true;
  const prefix = html.slice(0, tag.index);
  return prefix.lastIndexOf("<label") > prefix.lastIndexOf("</label");
}
