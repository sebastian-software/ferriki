import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { payloadPath } from "../ferriki/scripts/asset-path.mjs";

export const ASSETS_BASE_URL = "https://assets.ferriki.dev";
const CDN_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * ADR 0013 release check: every payload the release manifest pins must be
 * served by the CDN at the release commit with exactly the pinned bytes.
 */
export async function verifyCdnPayloads(releaseManifest, { fetchImpl = fetch } = {}) {
  const { commit, assets } = releaseManifest;
  if (!/^[0-9a-f]{40}$/.test(commit ?? ""))
    throw new Error("the published release manifest is not pinned to a commit");
  const entries = Object.entries(assets);
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const [path, asset] = entries[next++];
      const url = ["language-hash-v1", "language-hash-v2"].includes(releaseManifest.storageLayout)
        ? `${ASSETS_BASE_URL}/${payloadPath(path, asset, releaseManifest.storageLayout)}`
        : `${ASSETS_BASE_URL}/${commit}/assets/shiki/${path}`;
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
          failures.push(`${url} returned HTTP ${response.status}`);
          continue;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== asset.sha256 || bytes.length !== asset.size)
          failures.push(`${url} does not match its pinned SHA-256 and size`);
      } catch (error) {
        failures.push(`${url} failed: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CDN_CONCURRENCY, entries.length) }, worker));
  if (failures.length > 0)
    throw new Error(
      `CDN verification failed for ${failures.length} payloads:\n${failures.join("\n")}`,
    );
  console.log(`CDN serves all ${entries.length} payloads of ${commit} with their pinned digests`);
}

/** Verify the cold-install probe cached all three pinned default assets. */
export async function verifyPublicAssetCache(releaseManifest, cacheDir) {
  const paths = ["languages/rust.fkgram", "languages/rust.fkbc", "themes/nord.fktheme"];
  const expected = paths.map((path) => {
    const asset = releaseManifest.assets[path];
    assert(asset, `the release manifest is missing ${path}`);
    return { path, ...asset };
  });
  assert.deepEqual(
    (await readdir(cacheDir)).sort(),
    expected.map((asset) => asset.sha256).sort(),
    "the public install must cache the rust grammar, prepared regex package, and nord theme",
  );
  for (const asset of expected) {
    const bytes = await readFile(join(cacheDir, asset.sha256));
    assert.equal(bytes.length, asset.size, `${asset.path}: cached size differs`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
      `${asset.path}: cached SHA-256 differs`,
    );
  }
}

export async function verifyPublicPackage(pkg, { directory: tempRoot, run }) {
  const packageName = pkg.name;
  const version = pkg.version;
  if (packageName === "@ferriki/core") {
    const releaseManifest = JSON.parse(
      await readFile(
        join(
          tempRoot,
          "node_modules",
          ...packageName.split("/"),
          "assets",
          "standard",
          "release-manifest.json",
        ),
        "utf8",
      ),
    );
    const expectedCommit = process.env.GITHUB_SHA;
    if (expectedCommit && releaseManifest.commit !== expectedCommit)
      throw new Error(
        `the published release manifest is pinned to ${releaseManifest.commit}, not the release commit ${expectedCommit}`,
      );

    // The package bundles no payloads (ADR 0013): highlighting from an empty
    // cache downloads them from the CDN at the stamped commit.
    const cacheDir = join(tempRoot, "asset-cache");
    const probe = join(tempRoot, "probe.mjs");
    await writeFile(
      probe,
      `
      const ferriki = await import(${JSON.stringify(packageName)})
      if (typeof ferriki.ferrikiVersion !== 'function' || !ferriki.ferrikiVersion())
        throw new Error('public Ferriki install did not load its native binding')
      const html = await ferriki.codeToHtml('fn main() {}', { lang: 'rust', theme: 'nord' })
      if (!/<span style="color:#/.test(html))
        throw new Error('public Ferriki install did not highlight from the CDN: ' + html)
    `,
    );
    const env = { ...process.env, FERRIKI_CACHE_DIR: cacheDir };
    delete env.FERRIKI_ASSETS_REMOTE;
    delete env.FERRIKI_ASSETS_BASE_URL;
    const nodeResult = run(process.execPath, [probe], {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: "pipe",
      env,
    });
    if (nodeResult.status !== 0)
      throw new Error(
        `public Ferriki install probe failed:\n${nodeResult.stdout}\n${nodeResult.stderr}`,
      );
    await verifyPublicAssetCache(releaseManifest, cacheDir);
    console.log(
      `public npm install verified for ${packageName}@${version}, highlighting from the CDN`,
    );

    await verifyCdnPayloads(releaseManifest);
  } else if (packageName === "@ferriki/vite") {
    const probe = join(tempRoot, "probe.mjs");
    await writeFile(
      probe,
      `
      import assert from 'node:assert/strict'
      import { createServer } from 'vite'
      import { ferriki } from ${JSON.stringify(packageName)}
      assert.equal(typeof createServer, 'function', 'the Vite peer dependency did not install')
      assert.equal(typeof ferriki, 'function', 'the public package did not export ferriki')
      const plugin = ferriki({ assets: { remote: false } })
      assert.equal(plugin.name, '@ferriki/vite')
      assert.equal(plugin.enforce, 'pre')
    `,
    );
    const nodeResult = run(process.execPath, [probe], {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (nodeResult.status !== 0)
      throw new Error(
        `public Vite package probe failed:\n${nodeResult.stdout}\n${nodeResult.stderr}`,
      );
    console.log(`public npm install verified for ${packageName}@${version} with its Vite peer`);
  }
}
