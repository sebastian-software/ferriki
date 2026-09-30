// The package ships no payloads (ADR 0013). This check runs the download path
// against a local mirror: the native prefetch runs off the event loop, fetches a
// language with its embedded languages, verifies and caches the payloads, and
// the synchronous loads then read only the cache. The public facade has no
// commit option, so the check drives the native binding with one.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHighlighter, createHighlighterCoreSync } from "../ferriki/index.mjs";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const repoAssets = fileURLToPath(new URL("../../assets/shiki/", import.meta.url));
const packageAssets = fileURLToPath(new URL("../ferriki/assets/shiki/", import.meta.url));
const prefix = `/${COMMIT}/assets/shiki/`;

const requests = [];
const replaced = new Map();
const server = createServer(async (request, response) => {
  requests.push(request.url);
  const relative = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : undefined;
  const body = replaced.has(relative)
    ? replaced.get(relative)
    : relative && (await readFile(join(repoAssets, relative)).catch(() => undefined));
  if (!body) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-length": body.length }).end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const binding = loadFerrikiNativeBinding();
const cacheDir = await mkdtemp(join(tmpdir(), "ferriki-remote-check-"));
const create = (assets) =>
  binding.createHighlighter(
    JSON.stringify({ standardAssetRoot: packageAssets, assets: { commit: COMMIT, ...assets } }),
  );

try {
  const native = create({ remote: true, baseUrl, cacheDir });

  assert.throws(
    () => native.loadStandardGrammar("vue"),
    /not cached.*asynchronous/s,
    "a synchronous load never downloads",
  );
  assert.equal(requests.length, 0);

  // The prefetch is an N-API async task on the libuv pool: it returns a promise.
  const prefetch = native.prefetchAssets(["vue"], ["nord"]);
  assert(prefetch instanceof Promise);
  await prefetch;
  assert(requests.some((url) => url.endsWith("/languages/vue.fkgram")));
  assert(requests.some((url) => url.endsWith("/themes/nord.fktheme")));
  assert(
    requests.some((url) => url.endsWith("/languages/typescript.fkgram")),
    "embedded languages are fetched with their host language",
  );
  const cached = await readdir(cacheDir);
  assert.equal(cached.length, requests.length, "every download is cached once, by digest");
  assert(cached.every((name) => /^[0-9a-f]{64}$/.test(name)));

  assert(native.loadStandardGrammar("vue"), "the cached language loads synchronously");
  assert(native.loadStandardTheme("nord"));
  const html = native.codeToHtml(
    "<script setup lang='ts'>const a = 1</script>",
    JSON.stringify({ lang: "vue", theme: "nord" }),
  );
  assert.match(html, /<span/);

  const downloads = requests.length;
  await native.prefetchAssets(["vue"], ["nord"]);
  assert.equal(requests.length, downloads, "cached payloads are not downloaded again");
  native.dispose();

  const offline = create({ remote: false, baseUrl, cacheDir: join(cacheDir, "empty") });
  await assert.rejects(offline.prefetchAssets(["rust"], []), /remote assets are turned off/);
  assert.equal(requests.length, downloads);
  offline.dispose();

  replaced.set("themes/dracula.fktheme", Buffer.from("not the pinned theme"));
  const tampered = create({ remote: true, baseUrl, cacheDir });
  await assert.rejects(tampered.prefetchAssets([], ["dracula"]), /did not match/);
  assert.equal((await readdir(cacheDir)).length, cached.length, "tampered bytes are not cached");
  replaced.set("themes/dracula.fktheme", undefined);
  await assert.rejects(tampered.prefetchAssets([], ["dracula"]), /HTTP 404/);
  tampered.dispose();

  // The public facade maps asset failures to ERR_ASSET and rejects bad options.
  const empty = { remote: false, cacheDir: join(cacheDir, "facade-empty") };
  await assert.rejects(createHighlighter({ assets: empty, langs: ["rust"] }), {
    name: "FerrikiError",
    code: "ERR_ASSET",
    message: /remote assets are turned off/,
  });
  assert.throws(() => createHighlighterCoreSync({ assets: empty, langs: ["rust"] }), {
    code: "ERR_ASSET",
    message: /not cached/,
  });
  for (const assets of [
    { remote: "no" },
    { baseUrl: "ftp://mirror" },
    { cacheDir: "" },
    { commit: COMMIT },
  ])
    assert.throws(() => createHighlighterCoreSync({ assets }), { code: "ERR_USAGE" });
} finally {
  server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

console.log(`Ferriki remote assets verified (${requests.length} requests against a local mirror)`);
