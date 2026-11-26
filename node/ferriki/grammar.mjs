#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import process from "node:process";

const MAX_GRAMMAR_BYTES = 8 * 1024 * 1024;
const usage =
  "Usage: ferriki grammar fetch <file|https-url|github:owner/repo@commit/path> --name <id> [--output <file>] [--aliases <a,b>] [--embedded <id,id>] [--inject-to <scope,scope>] [--sha256 <digest>]";

function hasControlChar(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasControlOrSpace(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function resolveGitHubSource(input) {
  const match = /^github:([^/@]+)\/([^/@]+)@([a-f0-9]{40})\/(.+)$/.exec(input);
  if (!match) throw new Error("GitHub sources require owner/repo@<40-character-commit>/path");
  const [, owner, repo, commit, path] = match;
  if (
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".." ||
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(repo)
  )
    throw new Error("Invalid GitHub repository in grammar source");
  if (path.startsWith("/") || path.endsWith("/") || /[?#\\]/.test(path) || hasControlChar(path))
    throw new Error("Invalid GitHub grammar path");
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === "..")
      throw new Error("Invalid GitHub grammar path");
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Invalid GitHub grammar path");
    }
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      hasControlChar(decoded)
    )
      throw new Error("Invalid GitHub grammar path");
  }
  const encodedPath = path.replaceAll(" ", "%20");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${encodedPath}`;
}

function validateRemoteUrl(rawUrl) {
  if (rawUrl.includes("\\") || hasControlOrSpace(rawUrl) || /^https?:\/\/[^/?#]*@/i.test(rawUrl))
    throw new Error("Invalid grammar URL");
  if (/^http:/i.test(rawUrl)) throw new Error("Grammar URL must use https:");
  if (!/^https:\/\/[^/?#]+/i.test(rawUrl)) throw new Error("Invalid grammar URL");
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid grammar URL");
  }
  if (parsed.username || parsed.password)
    throw new Error("Grammar URL must not contain credentials");
  if (parsed.protocol !== "https:") throw new Error("Grammar URL must use https:");
  if (!parsed.hostname) throw new Error("Invalid grammar URL");
}

async function readBoundedLocalFile(filePath) {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Grammar input must be a regular file");
    if (metadata.size > MAX_GRAMMAR_BYTES) throw new Error("Grammar exceeds 8 MiB");
    const chunks = [];
    let total = 0;
    const scratch = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const remaining = MAX_GRAMMAR_BYTES + 1 - total;
      const toRead = Math.min(scratch.length, remaining);
      const { bytesRead } = await handle.read(scratch, 0, toRead, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_GRAMMAR_BYTES) throw new Error("Grammar exceeds 8 MiB");
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main(args) {
  if (args.length === 0 || args.includes("--help")) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const [group, command, input, ...flags] = args;
  if (group !== "grammar" || command !== "fetch" || !input) throw new Error(usage);
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i];
    if (
      !["--name", "--output", "--aliases", "--embedded", "--inject-to", "--sha256"].includes(key) ||
      !flags[i + 1]
    )
      throw new Error(`Invalid option ${key}\n${usage}`);
    options[key.slice(2)] = flags[i + 1];
  }
  if (!options.name || !/^[a-z0-9][a-z0-9-]*$/.test(options.name))
    throw new Error("--name requires a lowercase language ID");
  let source = input;
  if (source.startsWith("github:")) source = resolveGitHubSource(source);
  let bytes;
  if (/^https?:/i.test(source)) {
    validateRemoteUrl(source);
    const response = await fetch(source, {
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Grammar download failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("Grammar download failed: response has no body");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_GRAMMAR_BYTES) throw new Error("Grammar exceeds 8 MiB");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else {
    bytes = await readBoundedLocalFile(source);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (options.sha256 && options.sha256 !== sha256) throw new Error("Grammar SHA-256 mismatch");
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(
      "Expected a JSON TextMate grammar (.tmLanguage.json); convert YAML/PLIST/CSON to JSON first",
    );
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    typeof raw.scopeName !== "string" ||
    !raw.scopeName
  )
    throw new Error("Grammar requires a non-empty scopeName");
  const fields = [
    "scopeName",
    "patterns",
    "repository",
    "injections",
    "injectionSelector",
    "fileTypes",
    "firstLineMatch",
    "balancedBracketSelectors",
    "unbalancedBracketSelectors",
    "foldingStartMarker",
    "foldingStopMarker",
  ];
  const grammar = Object.fromEntries(
    fields.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]),
  );
  grammar.name = options.name;
  for (const [flag, key] of [
    ["aliases", "aliases"],
    ["embedded", "embeddedLangs"],
    ["inject-to", "injectTo"],
  ])
    if (options[flag]) grammar[key] = options[flag].split(",").filter(Boolean);

  // Exercise the actual native registration and compilation before writing.
  const { bundledLanguages, createHighlighterCoreSync } = await import("./index.mjs");
  if (Object.hasOwn(bundledLanguages, grammar.name))
    throw new Error(
      `Language ID ${grammar.name} is already standard; choose a distinct --name for this external grammar`,
    );
  const highlighter = createHighlighterCoreSync({
    langs: [grammar],
    themes: [{ name: "grammar-validation", fg: "#000000", bg: "#ffffff", settings: [] }],
    assets: { remote: false },
  });
  try {
    highlighter.codeToHtml(" ", { lang: grammar.name, theme: "grammar-validation" });
  } finally {
    highlighter.dispose();
  }
  const output = `${JSON.stringify(grammar, null, 2)}\n`;
  if (options.output) {
    const files = [
      [options.output, output],
      [
        `${options.output}.lock.json`,
        `${JSON.stringify({ source, sha256, name: grammar.name, scopeName: grammar.scopeName }, null, 2)}\n`,
      ],
    ];
    const created = [];
    const handles = [];
    try {
      for (const [path, content] of files) {
        const handle = await open(path, "wx");
        created.push(path);
        handles.push(handle);
        await handle.writeFile(content);
      }
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.close()));
      handles.length = 0;
      await Promise.all(created.map((path) => unlink(path)));
      throw error;
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
    }
    process.stdout.write(`Fetched ${grammar.name} (${sha256})\n`);
  } else process.stdout.write(output);
}
