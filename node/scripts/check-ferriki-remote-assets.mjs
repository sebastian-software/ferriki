// The Node asset boundary uses a real native plan and Node fetch against a
// local mirror. Rust plans manifest paths and verifies cache reads; JavaScript
// streams, hashes and atomically installs the bytes.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createHighlighter, createHighlighterCoreSync } from "../ferriki/index.mjs";

import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import { payloadPath } from "../ferriki/scripts/asset-path.mjs";
import { createAssetDownloader, matchesCachedAsset } from "../ferriki/src/asset-download.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const repoAssets = fileURLToPath(new URL("../../assets/standard/", import.meta.url));
const packageAssets = fileURLToPath(new URL("../ferriki/assets/standard/", import.meta.url));
const packageReleasePath = join(packageAssets, "release-manifest.json");
const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-node-assets-check-"));
const assetRoot = join(tempRoot, "assets");
await mkdir(join(assetRoot, "languages"), { recursive: true });
await mkdir(join(assetRoot, "themes"), { recursive: true });
for (const relative of ["languages/manifest.fkindex", "themes/manifest.fkindex"])
  await copyFile(join(packageAssets, relative), join(assetRoot, relative));
const originalPackageRelease = await readFile(packageReleasePath, "utf8");
const release = JSON.parse(originalPackageRelease);
release.commit = COMMIT;
await writeFile(join(assetRoot, "release-manifest.json"), JSON.stringify(release));

const remotePaths = new Map(
  Object.entries(release.assets).map(([key, asset]) => [`/${payloadPath(key, asset)}`, key]),
);
const remotePath = (key) => `/${payloadPath(key, release.assets[key])}`;
const requests = [];
const userAgents = new Set();
const replaced = new Map();
const missing = new Set();
const delayed = new Set();
const delayedFinished = new Set();
const oversized = new Set();
const interrupted = new Set();
const server = createServer(async (request, response) => {
  requests.push(request.url);
  userAgents.add(request.headers["user-agent"]);
  const relative = remotePaths.get(request.url);
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
  return binding.createHighlighter({ standardAssetRoot: assetRoot, assets });
}

async function runOneShotProbe(scenario, cacheDir, remote = true) {
  const probe = fileURLToPath(new URL("./fixtures/one-shot-asset-probe.mjs", import.meta.url));
  const child = spawn(process.execPath, [probe, scenario], {
    env: {
      ...process.env,
      FERRIKI_ASSETS_BASE_URL: baseUrl,
      FERRIKI_ASSETS_REMOTE: remote ? "1" : "0",
      FERRIKI_CACHE_DIR: cacheDir,
    },
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => (output += chunk));
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, 0, `${scenario} exited ${result.signal || result.code}:\n${output}`);
  assert.match(output, new RegExp(`One-shot asset probe passed: ${scenario}`));
}

try {
  const cacheDir = join(tempRoot, "cache");
  const native = createNative({ remote: true, baseUrl, cacheDir });
  const download = createAssetDownloader(native);

  const collisionAsset = release.assets["themes/nord.fktheme"];
  const collisionDescriptor = {
    size: collisionAsset.size,
    digest: collisionAsset.sha256,
  };
  const collisionPath = join(tempRoot, "collision-cache-entry");
  const collisionBytes = await readFile(join(repoAssets, "themes/nord.fktheme"));
  await writeFile(collisionPath, collisionBytes);
  assert.equal(
    await matchesCachedAsset(collisionPath, collisionDescriptor),
    true,
    "a valid concurrent cache winner passes digest verification",
  );
  const wrongSizeBytes = Buffer.from(collisionBytes);
  wrongSizeBytes[0] ^= 0xff;
  await writeFile(collisionPath, wrongSizeBytes);
  assert.equal(
    await matchesCachedAsset(collisionPath, collisionDescriptor),
    false,
    "a same-size corrupt cache winner fails digest verification",
  );
  await writeFile(collisionPath, collisionBytes.subarray(0, collisionBytes.length - 1));
  assert.equal(
    await matchesCachedAsset(collisionPath, collisionDescriptor),
    false,
    "a truncated cache winner fails its size check",
  );
  const sparseCollisionPath = join(tempRoot, "sparse-collision-cache-entry");
  const sparseCollision = await open(sparseCollisionPath, "w");
  await sparseCollision.truncate(collisionAsset.size + 64 * 1024 * 1024);
  await sparseCollision.close();
  assert.equal(
    await matchesCachedAsset(sparseCollisionPath, collisionDescriptor),
    false,
    "an oversized sparse cache winner is rejected from metadata without reading it",
  );

  assert.throws(
    () => native.loadStandardGrammar("vue"),
    /not cached.*asynchronous/s,
    "a synchronous load never downloads",
  );
  assert.equal(requests.length, 0);

  const firstDownload = download(["vue"], ["nord"]);
  assert(firstDownload instanceof Promise);
  await firstDownload;
  assert(requests.includes(remotePath("languages/vue.fkgram")));
  const { version } = JSON.parse(
    await readFile(new URL("../ferriki/package.json", import.meta.url)),
  );
  assert.deepEqual([...userAgents], [`ferriki/${version} (node)`]);
  assert(requests.includes(remotePath("themes/nord.fktheme")));
  assert(
    requests.includes(remotePath("languages/typescript.fkgram")),
    "embedded languages are planned with their host grammar",
  );
  const cached = await readdir(cacheDir);
  assert.equal(cached.length, requests.length, "every downloaded payload is cached once by digest");
  assert(cached.every((name) => /^[0-9a-f]{64}$/.test(name)));

  assert(native.loadStandardGrammar("vue"), "the cached language loads synchronously");
  assert(native.loadStandardTheme("nord"));
  const html = native.codeToHtml("<script setup lang='ts'>const a = 1</script>", {
    lang: "vue",
    theme: "nord",
  });
  assert.match(html, /<span/);

  const downloads = requests.length;
  await download(["vue"], ["nord"]);
  assert.equal(requests.length, downloads, "verified cache entries are not downloaded again");
  native.dispose();

  const offline = createNative({ remote: false, baseUrl, cacheDir: join(tempRoot, "empty") });
  await assert.rejects(
    createAssetDownloader(offline)(["rust"], []),
    /remote assets are turned off/,
  );
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

  for (const failure of ["missing", "corrupt"]) {
    const sidecarCache = join(tempRoot, `bytecode-${failure}`);
    if (failure === "missing") missing.add("languages/rust.fkbc");
    else replaced.set("languages/rust.fkbc", Buffer.from("invalid bytecode"));
    const fallback = await createHighlighter({
      langs: ["rust"],
      themes: ["nord"],
      assets: { remote: true, baseUrl, cacheDir: sidecarCache },
    });
    assert.match(fallback.codeToHtml("fn main() {}", { lang: "rust", theme: "nord" }), /<span/);
    fallback.dispose();
    assert.equal(
      await readFile(join(sidecarCache, release.assets["languages/rust.fkbc"].sha256)).catch(
        () => undefined,
      ),
      undefined,
      "failed optional bytecode is never cached",
    );
    missing.delete("languages/rust.fkbc");
    replaced.delete("languages/rust.fkbc");
    const offlineFallback = await createHighlighter({
      langs: ["rust"],
      themes: ["nord"],
      assets: { remote: false, cacheDir: sidecarCache },
    });
    assert.match(
      offlineFallback.codeToHtml("fn main() {}", { lang: "rust", theme: "nord" }),
      /<span/,
    );
    offlineFallback.dispose();
  }

  const settleCache = join(tempRoot, "settle-cache");
  const settling = createNative({ remote: true, baseUrl, cacheDir: settleCache });
  const settlePlan = await settling.planAssets(["vue"], ["dracula"]);
  const slowPath = settlePlan[0].path;
  const invalidPath = settlePlan.at(-1).path;
  delayed.add(slowPath);
  replaced.set(invalidPath, Buffer.from("bad bytes"));
  await assert.rejects(createAssetDownloader(settling)(["vue"], ["dracula"]), /did not match/);
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
    !(await readdir(oversizedCache)).includes(release.assets["themes/monokai.fktheme"].sha256),
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
    concurrentRequests.filter((url) => url === remotePath("themes/nord.fktheme")).length,
    1,
    "overlapping asset loads share one in-process download per digest",
  );
  concurrent.dispose();

  // Each probe imports the public facade in a new process with an empty cache.
  // The parent serves release-pinned fixture bytes and observes every download.
  const singleCache = join(tempRoot, "one-shot-single-cache");
  // A checkout has no publish commit. Give the generated, untracked package
  // manifest a local mirror commit for these facade probes, then restore it.
  await writeFile(packageReleasePath, JSON.stringify(release));
  const singleOffset = requests.length;
  await runOneShotProbe("css-single", singleCache);
  const singleRequests = requests.slice(singleOffset);
  assert.deepEqual(
    new Set(singleRequests.map((url) => remotePaths.get(url))),
    new Set(["languages/json.fkgram", "languages/json.fkbc", "themes/nord.fktheme"]),
  );
  assert.equal(singleRequests.length, 3, "warm CSS shorthand calls do not redownload assets");

  const embeddedCache = join(tempRoot, "one-shot-embedded-cache");
  const embeddedOffset = requests.length;
  await runOneShotProbe("css-multi-embedded", embeddedCache);
  const embeddedRequests = requests.slice(embeddedOffset);
  for (const path of [
    "languages/vue.fkgram",
    "languages/typescript.fkgram",
    "themes/vitesse-light.fktheme",
    "themes/nord.fktheme",
  ])
    assert(
      embeddedRequests.includes(remotePath(path.replace(/^\//, ""))),
      `CSS shorthand did not fetch ${path}`,
    );
  assert.equal(
    embeddedRequests.length,
    new Set(embeddedRequests).size,
    "warm multi-theme CSS shorthand calls do not redownload assets",
  );

  const offlineOffset = requests.length;
  await runOneShotProbe("css-offline", join(tempRoot, "one-shot-offline-cache"), false);
  assert.equal(requests.length, offlineOffset, "offline CSS shorthand never fetches");

  const integrityCache = join(tempRoot, "one-shot-integrity-cache");
  replaced.set("themes/nord.fktheme", Buffer.from("not the pinned theme"));
  await runOneShotProbe("css-integrity", integrityCache);
  replaced.delete("themes/nord.fktheme");
  assert.equal(
    await readFile(join(integrityCache, release.assets["themes/nord.fktheme"].sha256)).catch(
      () => undefined,
    ),
    undefined,
    "the CSS shorthand never caches a corrupt theme",
  );

  const retryCache = join(tempRoot, "one-shot-retry-cache");
  const retryOffset = requests.length;
  await runOneShotProbe("singleton-retry", retryCache);
  const retryRequests = requests.slice(retryOffset);
  assert.equal(
    retryRequests.length,
    3,
    "only the explicit retry downloads grammar, bytecode and theme",
  );

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
  await writeFile(packageReleasePath, originalPackageRelease);
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(`Ferriki Node asset downloads verified (${requests.length} local mirror requests)`);
