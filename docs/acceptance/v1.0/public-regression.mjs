import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const scenario = process.argv[2];
const expectedVersion = process.env.FERRIKI_CANDIDATE_VERSION;
assert(expectedVersion && process.env.FERRIKI_CACHE_DIR);
const actualFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (...args) => {
  requests.push(String(args[0]));
  if (scenario === "offline") throw new Error("offline consumer must use its verified cache");
  return actualFetch(...args);
};
const ferriki = await import("@ferriki/core");
assert.equal(ferriki.ferrikiVersion(), expectedVersion);
const manifest = JSON.parse(
  await readFile(
    new URL("./node_modules/@ferriki/core/assets/shiki/release-manifest.json", import.meta.url),
  ),
);
assert.equal(manifest.commit, process.env.FERRIKI_CANDIDATE_SHA);
const options = { lang: "json", theme: "nord" };
if (scenario === "retry") {
  let failures = 0;
  globalThis.fetch = async () => {
    failures++;
    throw new Error("controlled transient outage");
  };
  const failed = await Promise.allSettled([
    ferriki.codeToHtml('{"value":"😀<&"}', options),
    ferriki.codeToHtmlWithCss('{"value":"😀<&"}', options),
  ]);
  assert.equal(failures, 1);
  assert(
    failed.every((result) => result.status === "rejected" && result.reason.code === "ERR_ASSET"),
  );
  assert.equal(failed[0].reason, failed[1].reason);
  globalThis.fetch = async (...args) => {
    requests.push(String(args[0]));
    return actualFetch(...args);
  };
}
const first = await ferriki.codeToHtmlWithCss('{"value":"😀<&"}', options);
assert(first.html.includes("😀") && !first.html.includes("<&"));
assert(first.css.includes(".ferriki-style-"));
assert.deepEqual(await ferriki.codeToHtmlWithCss('{"value":"😀<&"}', options), first);
assert.equal(requests.length, scenario === "offline" ? 0 : 2);
const assetPaths = ["languages/json.fkgram", "themes/nord.fktheme"];
if (scenario !== "offline") {
  assert.deepEqual(
    requests.map((url) => new URL(url).pathname).sort(),
    assetPaths.map((path) => `/${manifest.commit}/assets/shiki/${path}`).sort(),
  );
}
const expectedFiles = [];
for (const assetPath of assetPaths) {
  const asset = manifest.assets[assetPath];
  assert(asset, `release manifest omitted ${assetPath}`);
  expectedFiles.push(asset.sha256);
  const payload = await readFile(join(process.env.FERRIKI_CACHE_DIR, asset.sha256));
  assert.equal(payload.length, asset.size);
  assert.equal(createHash("sha256").update(payload).digest("hex"), asset.sha256);
}
assert.deepEqual((await readdir(process.env.FERRIKI_CACHE_DIR)).sort(), expectedFiles.sort());
console.log(
  JSON.stringify({
    scenario,
    version: expectedVersion,
    source: manifest.commit,
    requests,
    htmlBytes: first.html.length,
    cssBytes: first.css.length,
  }),
);
