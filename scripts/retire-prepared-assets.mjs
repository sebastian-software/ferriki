import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { digest, objectPath, payloadPath } from "./asset-store.mjs";

// One-time retirement of the complete v2 packages, not general CDN collection.
export function planRetirement(previous, current, protectedPaths = new Set()) {
  if ([previous, current].some((release) => release.storageLayout !== "language-hash-v2"))
    throw new Error("Retirement requires short-hash catalogs");
  const active = new Set([
    ...protectedPaths,
    ...Object.entries(current.assets).map(([key, asset]) =>
      payloadPath(key, asset, current.storageLayout),
    ),
  ]);
  return Object.entries(previous.assets)
    .filter(([key]) => key.endsWith(".fkbc"))
    .map(([key, asset]) => {
      const replacement = current.assets[key];
      const retiredPath = payloadPath(key, asset, previous.storageLayout);
      if (
        asset.formatVersion >>> 24 !== 2 ||
        !replacement ||
        replacement.formatVersion >>> 24 !== 3 ||
        asset.sha256 === replacement.sha256 ||
        active.has(retiredPath)
      )
        throw new Error(`Prepared package has no distinct cooperating replacement: ${key}`);
      return {
        path: retiredPath,
        ...asset,
        replacement: {
          path: payloadPath(key, replacement, current.storageLayout),
          ...replacement,
        },
      };
    });
}

async function each(items, action) {
  let cursor = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, async () => {
      while (cursor < items.length) await action(items[cursor++]);
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

export async function retirePreparedAssets({ hostname, zone, accessKey, plan, fetchImpl = fetch }) {
  if (
    !/^(?:[a-z0-9-]+\.)?storage\.bunnycdn\.com$/.test(hostname || "") ||
    !/^[a-z0-9-]+$/.test(zone || "") ||
    !accessKey ||
    plan.some((asset) => !/^[a-z0-9-]+\/[a-zA-Z0-9]{8}$/.test(asset.path))
  )
    throw new Error("Invalid prepared retirement configuration");
  const request = (key, method = "GET") =>
    fetchImpl(`https://${hostname}/${zone}/${key}`, {
      method,
      headers: { AccessKey: accessKey },
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
  async function verify(asset, missing = false) {
    const response = await request(asset.path);
    if (missing && response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Storage verification failed: ${asset.path}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.size || digest(bytes) !== asset.sha256)
      throw new Error(`Storage integrity mismatch: ${asset.path}`);
    return true;
  }
  // Finish every preflight before the first DELETE. Never replace a missing
  // current package with the retired one, and never delete unrecognized bytes.
  await each(plan, (asset) => verify(asset.replacement));
  const present = [];
  await each(plan, async (asset) => {
    if (await verify(asset, true)) present.push(asset);
  });
  await each(present, async (asset) => {
    const response = await request(asset.path, "DELETE");
    await response.body?.cancel();
    if (!response.ok && response.status !== 404)
      throw new Error(`Storage deletion failed: ${asset.path}: HTTP ${response.status}`);
    const after = await request(asset.path);
    await after.body?.cancel();
    if (after.status !== 404) throw new Error(`Deletion not confirmed: ${asset.path}`);
  });
  return {
    removedObjects: present.length,
    removedBytes: present.reduce((total, asset) => total + asset.size, 0),
    alreadyAbsent: plan.length - present.length,
  };
}

async function main() {
  const mode = process.argv[2] ?? "--check";
  if (process.argv.length > 3 || !["--check", "--apply"].includes(mode))
    throw new Error("Usage: node scripts/retire-prepared-assets.mjs [--check|--apply]");
  const root = new URL("../", import.meta.url);
  const snapshot = await readFile(
    new URL(
      "docs/benchmarks/precompiled-patterns/delegated-packages-2026-10-26/before-release.json.gz",
      root,
    ),
  );
  if (digest(snapshot) !== "1b223814931a1495ee25bde1d28339b975ee9d6467c7089ceb0a41e545428cef")
    throw new Error("Retired manifest differs from the accepted complete-package snapshot");
  const previous = JSON.parse(gunzipSync(snapshot));
  const lock = JSON.parse(await readFile(new URL("assets/catalog.json", root), "utf8"));
  const sources = JSON.parse(await readFile(new URL("assets/grammars/sources.json", root), "utf8"));
  const protectedPaths = new Set();
  for (const entry of sources.languages) {
    protectedPaths.add(objectPath("language", entry.id, entry.sha256));
    protectedPaths.add(objectPath("language", entry.id, entry.upstream_sha256));
  }
  for (const entry of lock.theme_sources)
    protectedPaths.add(objectPath("theme", entry.id, entry.sha256));
  const plan = planRetirement(previous, lock.release, protectedPaths);
  const bytes = plan.reduce((total, asset) => total + asset.size, 0);
  if (plan.length !== 94 || bytes !== 274444043)
    throw new Error("Retirement must select exactly the 94 accepted complete packages");
  console.log(
    JSON.stringify({ objects: plan.length, bytes, paths: plan.map((asset) => asset.path) }),
  );
  if (mode === "--apply")
    console.log(
      JSON.stringify(
        await retirePreparedAssets({
          hostname: process.env.BUNNY_STORAGE_HOSTNAME,
          zone: process.env.BUNNY_STORAGE_ZONE,
          accessKey: process.env.BUNNY_STORAGE_ACCESS_KEY,
          plan,
        }),
      ),
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main();
