import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, constants as fsConstants, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { protectedSelected, protectedUrl } from "./protected-assets.mjs";

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
const IPV4_LOOPBACK =
  /^127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
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
  const key = `${target}:${protectedSelected() ? "protected" : "public"}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = downloadAsset(asset, target).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

function hasControlOrSpace(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hexValue(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return undefined;
}

function decodePercentBytes(segment) {
  const bytes = [];
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code === 0x25) {
      if (i + 2 >= segment.length) return undefined;
      const high = hexValue(segment.charCodeAt(i + 1));
      const low = hexValue(segment.charCodeAt(i + 2));
      if (high === undefined || low === undefined) return undefined;
      bytes.push((high << 4) | low);
      i += 2;
    } else {
      bytes.push(code);
    }
  }
  return bytes;
}

export function isValidAssetUrl(rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl ||
    rawUrl.includes("\\") ||
    rawUrl.includes("?") ||
    rawUrl.includes("#") ||
    hasControlOrSpace(rawUrl) ||
    !/^https?:\/\//i.test(rawUrl)
  )
    return false;
  const schemeEnd = rawUrl.indexOf("://") + 3;
  const slashIndex = rawUrl.indexOf("/", schemeEnd);
  const authority =
    slashIndex === -1 ? rawUrl.slice(schemeEnd) : rawUrl.slice(schemeEnd, slashIndex);
  if (!authority || authority.includes("@") || authority.includes("%")) return false;
  if (slashIndex !== -1) {
    let end = rawUrl.length;
    while (end > slashIndex + 1 && rawUrl.charCodeAt(end - 1) === 47) end--;
    const rawPath = rawUrl.slice(slashIndex + 1, end);
    if (rawPath) {
      for (const segment of rawPath.split("/")) {
        if (!segment || segment === "." || segment === "..") return false;
        const decoded = decodePercentBytes(segment);
        if (
          !decoded ||
          decoded.length === 0 ||
          (decoded.length === 1 && decoded[0] === 0x2e) ||
          (decoded.length === 2 && decoded[0] === 0x2e && decoded[1] === 0x2e)
        )
          return false;
        for (const byte of decoded) {
          if (
            byte < 0x20 ||
            byte === 0x7f ||
            byte === 0x2f ||
            byte === 0x5c ||
            byte === 0x3f ||
            byte === 0x23
          )
            return false;
        }
      }
    }
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port === "0")
    return false;
  if (parsed.protocol === "https:") return isValidHostname(parsed.hostname);
  if (parsed.protocol === "http:") return isLoopbackHost(parsed.hostname);
  return false;
}

function isLoopbackHost(hostname) {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "localhost." ||
    lower === "[::1]" ||
    lower === "::1" ||
    IPV4_LOOPBACK.test(lower)
  );
}

function isValidHostname(hostname) {
  if (!hostname) return false;
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  const labels = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!labels) return false;
  return labels.split(".").every((label) => /^[a-z0-9-]+$/i.test(label));
}

function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

export function normalizeAssetBaseUrl(rawUrl) {
  if (!isValidAssetUrl(rawUrl)) return undefined;
  return trimTrailingSlashes(new URL(rawUrl).href);
}

function validatePlanAsset(asset) {
  if (
    !asset ||
    typeof asset.path !== "string" ||
    !isValidAssetUrl(asset.url) ||
    !/^[0-9a-f]{64}$/.test(asset.digest) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0
  )
    throw new Error("Native asset planner returned an invalid payload descriptor.");
}

async function downloadAsset(asset, target) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const isProtected = protectedSelected();
  const url = isProtected ? await protectedUrl(asset, signal) : asset.url;
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadAttempt(asset, target, signal, url, isProtected);
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

async function downloadAttempt(asset, target, signal, url, isProtected) {
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      redirect: "error",
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

    await publishTemporaryAsset(temporary, target, asset);
  } catch (error) {
    if (isProtected) throw new Error("Protected asset download failed.");
    throw error;
  } finally {
    // A successful rename consumes the temporary path. On a concurrent-cache
    // hit, this also removes the redundant file left by our completed download.
    await rm(temporary, { force: true });
  }
}

/**
 * Publishes a verified temporary file into the immutable cache without
 * unlinking a target that disappeared concurrently (ENOENT).
 */
export async function publishTemporaryAsset(
  temporary,
  target,
  asset,
  ops = { rename, rm, inspect: inspectCachedAsset },
) {
  try {
    await ops.rename(temporary, target);
  } catch (error) {
    // Another process can finish the same immutable digest between planning
    // and rename. Reuse it only if it is the exact pinned payload.
    if (!isAlreadyPresent(error)) throw error;
    const state = await ops.inspect(target, asset);
    if (state === "valid") return;
    if (state === "missing") {
      try {
        await ops.rename(temporary, target);
        return;
      } catch (retryError) {
        if (!isAlreadyPresent(retryError)) throw retryError;
        if ((await ops.inspect(target, asset)) === "valid") return;
        throw retryError;
      }
    }
    if (isLockContention(error)) throw error;
    await ops.rm(target, { force: true });
    await ops.rename(temporary, target);
  }
}

function isLockContention(error) {
  return Boolean(error && (error.code === "EACCES" || error.code === "EBUSY"));
}

async function inspectCachedAsset(target, asset) {
  let file;
  try {
    file = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== asset.size) return "corrupt";

    const hash = createHash("sha256");
    let size = 0;
    const stream = file.createReadStream({
      start: 0,
      end: asset.size,
      autoClose: false,
    });
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > asset.size) return "corrupt";
      hash.update(chunk);
    }
    return size === asset.size && hash.digest("hex") === asset.digest ? "valid" : "corrupt";
  } finally {
    await file.close();
  }
}

/** Checks a concurrent cache winner without reading beyond its pinned size. */
export async function matchesCachedAsset(target, asset) {
  return (await inspectCachedAsset(target, asset)) === "valid";
}

export function isAlreadyPresent(error) {
  return (
    error &&
    (error.code === "EEXIST" ||
      error.code === "EPERM" ||
      error.code === "ENOTEMPTY" ||
      error.code === "EACCES" ||
      error.code === "EBUSY")
  );
}
