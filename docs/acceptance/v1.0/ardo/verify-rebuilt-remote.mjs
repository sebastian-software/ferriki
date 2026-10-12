import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const [sourceCommit, candidateRoot] = process.argv.slice(2);
assert.match(sourceCommit, /^[a-f0-9]{40}$/);
const requireFromArdo = createRequire(import.meta.resolve("ardo/vite"));
const { JsxCompiler } = await import(requireFromArdo.resolve("ferromark"));
const manifest = JSON.parse(
  readFileSync(join(candidateRoot, "assets/shiki/release-manifest.json"), "utf8"),
);
const byDigest = new Map(
  Object.entries(manifest.assets).map(([path, metadata]) => [
    metadata.sha256,
    { path, ...metadata },
  ]),
);
const fullSource = readFileSync("app/routes/evidence/compatibility.mdx", "utf8");
const markdown = fullSource.slice(fullSource.indexOf("```ts"));
const cacheDir = mkdtempSync(join(tmpdir(), "ferriki-248-native-cache-"));
const themes = { light: "github-light-default", dark: "github-dark-default" };
const server = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("./serve-ferriki-assets.mjs", import.meta.url)),
    candidateRoot,
    sourceCommit,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverRequests = "";
server.stderr.setEncoding("utf8").on("data", (chunk) => {
  serverRequests += chunk;
});
const port = await new Promise((resolve, reject) => {
  let output = "";
  const timeout = setTimeout(() => reject(new Error("asset mirror did not start")), 5_000);
  server.on("error", reject);
  server.on("exit", (code) => reject(new Error(`asset mirror exited: ${code}`)));
  server.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    const line = output.split("\n")[0];
    if (!/^\d+$/.test(line)) return;
    clearTimeout(timeout);
    resolve(Number(line));
  });
});
const settings = (remote) => ({
  theme: themes,
  lineNumbers: true,
  assets: { remote, cacheDir, baseUrl: `http://127.0.0.1:${port}`, commit: sourceCommit },
});
const compile = (remote) => new JsxCompiler(settings(remote)).compile(markdown);
const missingAsset = (error) => error.code === "GenericFailure" && /not cached/.test(error.message);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let receipt;
try {
  assert.throws(() => compile(false), missingAsset, "empty offline cache must fail");
  const online = compile(true);
  assert.equal(online.codeBlocks.length, 4);
  assert.match(online.body, /--shiki-light/);
  assert.match(online.body, /--shiki-dark/);
  let cached = readdirSync(cacheDir);
  assert.equal(cached.length, 7, `expected seven fetched assets, got ${cached.join(", ")}`);
  for (const digest of cached) {
    const metadata = byDigest.get(digest);
    assert.ok(metadata, `unknown cache entry ${digest}`);
    const bytes = readFileSync(join(cacheDir, digest));
    assert.equal(bytes.length, metadata.size, metadata.path);
    assert.equal(hash(bytes), digest, metadata.path);
  }
  assert.equal(compile(false).body, online.body, "warm offline output differs");
  const themeDigest = manifest.assets["themes/github-light-default.fktheme"].sha256;
  rmSync(join(cacheDir, themeDigest));
  assert.throws(() => compile(false), missingAsset, "missing cached theme must fail offline");
  assert.equal(compile(true).body, online.body, "explicit online recovery differs");
  writeFileSync(join(cacheDir, themeDigest), "corrupt");
  assert.throws(() => compile(false), missingAsset, "corrupt cached theme must fail offline");
  assert.equal(compile(true).body, online.body, "corrupt-cache recovery differs");
  cached = readdirSync(cacheDir);
  assert.equal(cached.length, 7);
  assert.equal(hash(readFileSync(join(cacheDir, themeDigest))), themeDigest);
  receipt = {
    sourceCommit,
    cacheDir,
    fetchedAssets: cached.length,
    cacheDigests: cached,
    fourFences: online.codeBlocks.length,
    offlineEqual: true,
    missingAssetRecovered: true,
    corruptAssetRecovered: true,
  };
} finally {
  server.kill("SIGTERM");
  if (server.exitCode === null) await once(server, "exit");
}
receipt.servedPaths = serverRequests.trim().split("\n");
assert.equal(receipt.servedPaths.length, 9, "unexpected mirror request count");
console.log(JSON.stringify(receipt, null, 2));
