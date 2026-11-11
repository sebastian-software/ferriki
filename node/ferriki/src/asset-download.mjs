import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
// Identifies the client like the Rust loader's `ferriki/<version>`.
const USER_AGENT = `ferriki/${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version} (node)`;
const MAX_DOWNLOAD_WORKERS = 6;
const inFlight = new Map();

/** Plans native manifest assets, then downloads cache misses with Node fetch. */
export function createAssetDownloader(native) {
  return async (languages, themes) => {
    const plan = await native.planAssets(languages, themes);
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
        // A missing or corrupt optional bytecode sidecar falls back to compiling
        // the grammar source. Required grammar and theme downloads still fail.
        if (/^languages\/[a-z0-9-]+\.fkbc$/.test(asset.path)) continue;
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
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadAttempt(asset, target, signal);
    } catch (error) {
      if (signal.aborted || attempt + 1 >= DOWNLOAD_ATTEMPTS) throw error;
      const wait = retryDelay(error, attempt);
      if (wait === undefined) throw error;
      await delay(wait, undefined, { signal });
    }
  }
}

class DownloadHttpError extends Error {
  constructor(url, response) {
    super(`Downloading ${url} failed: HTTP ${response.status}`);
    this.status = response.status;
    this.retryAfter = response.headers.get("retry-after");
  }
}

function retryDelay(error, attempt) {
  let wait = RETRY_DELAY_MS * 2 ** attempt;
  if (error instanceof DownloadHttpError) {
    if (error.status !== 408 && error.status !== 429 && (error.status < 500 || error.status > 599))
      return;
    if (error.retryAfter !== null) {
      const after = /^\d+$/.test(error.retryAfter)
        ? Number(error.retryAfter) * 1_000
        : Date.parse(error.retryAfter) - Date.now();
      if (!Number.isNaN(after)) wait = Math.max(wait, after);
    }
  } else if (!isTransientNetworkError(error)) return;
  // A longer server-directed pause should fail rather than retrying early or
  // holding an asset worker indefinitely.
  return wait <= MAX_RETRY_DELAY_MS ? wait : undefined;
}

function isTransientNetworkError(error) {
  return (
    error?.name === "TimeoutError" ||
    TRANSIENT_NETWORK_CODES.has(error?.code) ||
    (error instanceof AggregateError &&
      error.errors.length > 0 &&
      error.errors.every(isTransientNetworkError)) ||
    (error?.cause !== undefined && isTransientNetworkError(error.cause))
  );
}

async function downloadAttempt(asset, target, signal) {
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    const response = await fetch(asset.url, {
      headers: { "user-agent": USER_AGENT },
      signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new DownloadHttpError(asset.url, response);
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
      if (!(await matchesCachedAsset(target, asset))) {
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

/** Checks a concurrent cache winner without reading beyond its pinned size. */
export async function matchesCachedAsset(target, asset) {
  const file = await open(target, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== asset.size) return false;

    const hash = createHash("sha256");
    let size = 0;
    const stream = file.createReadStream({
      start: 0,
      end: asset.size,
      autoClose: false,
    });
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > asset.size) return false;
      hash.update(chunk);
    }
    return size === asset.size && hash.digest("hex") === asset.digest;
  } finally {
    await file.close();
  }
}

function isAlreadyPresent(error) {
  return error && (error.code === "EEXIST" || error.code === "EPERM" || error.code === "ENOTEMPTY");
}
