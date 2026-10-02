import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_WORKERS = 6;
const inFlight = new Map();

/** Plans native manifest assets, then downloads cache misses with Node fetch. */
export function createAssetDownloader(native) {
  return async (languages, themes) => {
    const encodedPlan = await native.planAssets(languages, themes);
    const plan = JSON.parse(encodedPlan);
    if (!Array.isArray(plan)) throw new Error("Native asset planner returned an invalid plan.");
    if (plan.length === 0) return;

    const cacheDir = native.assetCacheDir();
    if (typeof cacheDir !== "string" || !cacheDir)
      throw new Error("Native asset planner did not provide a cache directory.");
    await downloadAssets(plan, cacheDir);
  };
}

async function downloadAssets(plan, cacheDir) {
  let next = 0;
  let firstError;
  const workerCount = Math.min(plan.length, MAX_DOWNLOAD_WORKERS);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!firstError) {
      const asset = plan[next++];
      if (!asset) return;
      try {
        await downloadOnce(asset, cacheDir);
      } catch (error) {
        firstError ??= error;
      }
    }
  });

  // Each worker records failures and settles before this async boundary rejects.
  await Promise.all(workers);
  if (firstError) throw firstError;
}

function downloadOnce(asset, cacheDir) {
  validatePlanAsset(asset);
  const target = resolve(cacheDir, asset.digest);
  const existing = inFlight.get(target);
  if (existing) return existing;

  const pending = downloadAsset(asset, target).finally(() => {
    if (inFlight.get(target) === pending) inFlight.delete(target);
  });
  inFlight.set(target, pending);
  return pending;
}

function validatePlanAsset(asset) {
  if (
    !asset ||
    typeof asset.path !== "string" ||
    typeof asset.url !== "string" ||
    !/^[0-9a-f]{64}$/.test(asset.digest) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0
  )
    throw new Error("Native asset planner returned an invalid payload descriptor.");
}

async function downloadAsset(asset, target) {
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Downloading ${asset.url} failed: HTTP ${response.status}`);
    }
    if (!response.body) throw new Error(`Downloading ${asset.url} failed: response has no body.`);

    const hash = createHash("sha256");
    let size = 0;
    const verifyAndBound = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.byteLength;
        if (size > asset.size) {
          callback(new Error(`${asset.url} exceeded its release-pinned size.`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      verifyAndBound,
      createWriteStream(temporary, { flags: "wx" }),
    );
    if (size !== asset.size || hash.digest("hex") !== asset.digest)
      throw new Error(
        `${asset.url} did not match its release-pinned SHA-256 and size; it was not cached.`,
      );

    try {
      await rename(temporary, target);
    } catch (error) {
      // Another process can finish the same immutable digest between planning
      // and rename. Reuse it only if it is the exact pinned payload.
      if (!isAlreadyPresent(error)) throw error;
      const cached = await readFile(target);
      const cachedDigest = createHash("sha256").update(cached).digest("hex");
      if (cached.byteLength !== asset.size || cachedDigest !== asset.digest) {
        await rm(target, { force: true });
        await rename(temporary, target);
      }
    }
  } finally {
    // A successful rename consumes the temporary path. On a concurrent-cache
    // hit, this also removes the redundant file left by our completed download.
    await rm(temporary, { force: true });
  }
}

function isAlreadyPresent(error) {
  return error && (error.code === "EEXIST" || error.code === "EPERM" || error.code === "ENOTEMPTY");
}
