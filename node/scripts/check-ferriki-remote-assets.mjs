// The Node asset boundary uses a real native plan and Node fetch against a
// local mirror. Rust plans manifest paths and verifies cache reads; JavaScript
// streams, hashes and atomically installs the bytes.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHighlighter, createHighlighterCoreSync } from "../ferriki/index.mjs";
import { createAssetDownloader } from "../ferriki/src/asset-download.mjs";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const repoAssets = fileURLToPath(new URL("../../assets/shiki/", import.meta.url));
const packageAssets = fileURLToPath(new URL("../ferriki/assets/shiki/", import.meta.url));
const prefix = `/${COMMIT}/assets/shiki/`;
const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-node-assets-check-"));
const assetRoot = join(tempRoot, "assets");
await mkdir(join(assetRoot, "languages"), { recursive: true });
await mkdir(join(assetRoot, "themes"), { recursive: true });
for (const relative of ["languages/manifest.fkindex", "themes/manifest.fkindex"])
  await copyFile(join(packageAssets, relative), join(assetRoot, relative));
const release = JSON.parse(
  await readFile(join(packageAssets, "release-manifest.json"), "utf8"),
);
release.commit = COMMIT;
await writeFile(join(assetRoot, "release-manifest.json"), JSON.stringify(release));

const requests = [];
const replaced = new Map();
const missing = new Set();
const delayed = new Set();
const delayedFinished = new Set();
const oversized = new Set();
const interrupted = new Set();
const server = createServer(async (request, response) => {
  requests.push(request.url);
  const relative = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : undefined;
  if (!relative || missing.has(relative)) {
    response.writeHead(404).end();
    return;
  }
  const body = replaced.has(relative)
    ? replaced.get(relative)
    : await readFile(join(repoAssets, relative)).catch(() => undefined);
  if (!body) {
    response.writeHead(404).end();
    return;
  }
  if (oversized.has(relative)) {
    const bytes = Buffer.concat([body, Buffer.from([0])]);
    response.writeHead(200, { "content-length": bytes.length }).end(bytes);
    return;
  }
  if (interrupted.has(relative)) {
    response.writeHead(200, { "content-length": body.length + 100 });
    response.write(body.subarray(0, 32));
    setTimeout(() => response.destroy(), 20);
    return;
  }
  if (delayed.has(relative)) await new Promise((resolve) => setTimeout(resolve, 180));
  response.writeHead(200, { "content-length": body.length }).end(body);
  if (delayed.has(relative)) delayedFinished.add(relative);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const binding = loadFerrikiNativeBinding();

function createNative(assets) {
  return binding.createHighlighter(JSON.stringify({ standardAssetRoot: assetRoot, assets }));
}

try {
  const cacheDir = join(tempRoot, "cache");
  const native = createNative({ remote: true, baseUrl, cacheDir });
  const download = createAssetDownloader(native);

  assert.throws(
    () => native.loadStandardGrammar("vue"),
    /not cached.*asynchronous/s,
    "a synchronous load never downloads",
  );
  assert.equal(requests.length, 0);

  const firstDownload = download(["vue"], ["nord"]);
  assert(firstDownload instanceof Promise);
  await firstDownload;
  assert(requests.some((url) => url.endsWith("/languages/vue.fkgram")));
  assert(requests.some((url) => url.endsWith("/themes/nord.fktheme")));
  assert(
    requests.some((url) => url.endsWith("/languages/typescript.fkgram")),
    "embedded languages are planned with their host grammar",
  );
  const cached = await readdir(cacheDir);
  assert.equal(cached.length, requests.length, "every downloaded payload is cached once by digest");
  assert(cached.every((name) => /^[0-9a-f]{64}$/.test(name)));

  assert(native.loadStandardGrammar("vue"), "the cached language loads synchronously");
  assert(native.loadStandardTheme("nord"));
  const html = native.codeToHtml(
    "<script setup lang='ts'>const a = 1</script>",
    JSON.stringify({ lang: "vue", theme: "nord" }),
  );
  assert.match(html, /<span/);

  const downloads = requests.length;
  await download(["vue"], ["nord"]);
  assert.equal(requests.length, downloads, "verified cache entries are not downloaded again");
  native.dispose();

  const offline = createNative({ remote: false, baseUrl, cacheDir: join(tempRoot, "empty") });
  await assert.rejects(createAssetDownloader(offline)(["rust"], []), /remote assets are turned off/);
  assert.equal(requests.length, downloads);
  offline.dispose();

  const dracula = release.assets["themes/dracula.fktheme"];
  const draculaPath = join(cacheDir, dracula.sha256);
  const tampered = createNative({ remote: true, baseUrl, cacheDir });
  replaced.set("themes/dracula.fktheme", Buffer.from("not the pinned theme"));
  await assert.rejects(createAssetDownloader(tampered)([], ["dracula"]), /did not match/);
  assert.equal(await readFile(draculaPath).catch(() => undefined), undefined);

  replaced.delete("themes/dracula.fktheme");
  await writeFile(draculaPath, Buffer.alloc(dracula.size, 0));
  assert.throws(
    () => tampered.loadStandardTheme("dracula"),
    /failed its SHA-256 or byte-size check/,
    "the final native catalog check rejects corrupted cache bytes",
  );
  await createAssetDownloader(tampered)([], ["dracula"]);
  assert.deepEqual(
    await readFile(draculaPath),
    await readFile(join(repoAssets, "themes/dracula.fktheme")),
    "a corrupt cache entry is removed and replaced with the pinned payload",
  );
  assert(tampered.loadStandardTheme("dracula"));

  missing.add("themes/monokai.fktheme");
  await assert.rejects(createAssetDownloader(tampered)([], ["monokai"]), /HTTP 404/);
  missing.clear();
  tampered.dispose();

  const settleCache = join(tempRoot, "settle-cache");
  const settling = createNative({ remote: true, baseUrl, cacheDir: settleCache });
  const settlePlan = JSON.parse(await settling.planAssets(["vue"], ["dracula"]));
  const slowPath = settlePlan[0].path;
  const invalidPath = settlePlan.at(-1).path;
  delayed.add(slowPath);
  replaced.set(invalidPath, Buffer.from("bad bytes"));
  await assert.rejects(
    createAssetDownloader(settling)(["vue"], ["dracula"]),
    /did not match/,
  );
  assert(delayedFinished.has(slowPath), "rejection waits for slower in-flight downloads to settle");
  assert(
    !(await readdir(settleCache)).some((name) => name.endsWith(".tmp")),
    "failed and completed downloads leave no temporary files",
  );
  delayed.clear();
  replaced.delete(invalidPath);
  settling.dispose();

  const oversizedCache = join(tempRoot, "oversized-cache");
  const oversizedNative = createNative({ remote: true, baseUrl, cacheDir: oversizedCache });
  oversized.add("themes/monokai.fktheme");
  await assert.rejects(
    createAssetDownloader(oversizedNative)([], ["monokai"]),
    /exceeded its release-pinned size/,
  );
  assert(!(await readdir(oversizedCache)).some((name) => name.endsWith(".tmp")));
  assert(
    !(await readdir(oversizedCache)).includes(
      release.assets["themes/monokai.fktheme"].sha256,
    ),
    "oversized decoded response bytes are never installed",
  );
  oversized.delete("themes/monokai.fktheme");
  oversizedNative.dispose();

  const interruptedCache = join(tempRoot, "interrupted-cache");
  const interruptedNative = createNative({ remote: true, baseUrl, cacheDir: interruptedCache });
  interrupted.add("languages/vue.fkgram");
  await assert.rejects(createAssetDownloader(interruptedNative)(["vue"], []));
  assert(
    !(await readdir(interruptedCache)).some((name) => name.endsWith(".tmp")),
    "a failed response stream leaves no partial cache file",
  );
  interrupted.delete("languages/vue.fkgram");
  interruptedNative.dispose();

  const concurrentCache = join(tempRoot, "concurrent-cache");
  const concurrent = createNative({ remote: true, baseUrl, cacheDir: concurrentCache });
  const concurrentDownload = createAssetDownloader(concurrent);
  const requestOffset = requests.length;
  await Promise.all([
    concurrentDownload(["rust"], ["nord"]),
    concurrentDownload(["rust"], ["nord"]),
  ]);
  const concurrentRequests = requests.slice(requestOffset);
  assert.equal(
    concurrentRequests.filter((url) => url.endsWith("/themes/nord.fktheme")).length,
    1,
    "overlapping asset loads share one in-process download per digest",
  );
  concurrent.dispose();

  const empty = { remote: false, cacheDir: join(tempRoot, "facade-empty") };
  await assert.rejects(createHighlighter({ assets: empty, langs: ["rust"] }), {
    name: "FerrikiError",
    code: "ERR_ASSET",
    message: /remote assets are turned off/,
  });
  assert.throws(() => createHighlighterCoreSync({ assets: empty, langs: ["rust"] }), {
    code: "ERR_ASSET",
    message: /not cached.*asynchronous/s,
  });
  const sync = createHighlighterCoreSync({ assets: empty });
  assert.throws(() => sync.loadLanguageSync("rust"), {
    code: "ERR_ASSET",
    message: /not cached.*asynchronous/s,
  });
  sync.dispose();
  for (const assets of [
    { remote: "no" },
    { baseUrl: "ftp://mirror" },
    { cacheDir: "" },
    { commit: COMMIT },
  ])
    assert.throws(() => createHighlighterCoreSync({ assets }), { code: "ERR_USAGE" });
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(`Ferriki Node asset downloads verified (${requests.length} local mirror requests)`);
