import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CRATES = ["ferriki-textmate", "ferriki-asset-gen", "ferriki"];
const REGISTRY = "https://crates.io/api/v1/crates";
const MAX_ATTEMPTS = 40;
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function verifyCrateVersion({
  name,
  version,
  fetchImpl = fetch,
  sleepImpl = sleep,
  maxAttempts = MAX_ATTEMPTS,
}) {
  const url = `${REGISTRY}/${name}/${encodeURIComponent(version)}`;
  let lastObservation = "version is not public";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": "ferriki-release-verifier (https://github.com/sebastian-software/ferriki)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) {
      const metadata = await response.json();
      assert.equal(metadata.version?.num, version, `${name} returned the wrong version`);
      assert.equal(metadata.version?.crate, name, `${name} returned the wrong crate`);
      assert.equal(metadata.version?.yanked, false, `${name}@${version} is yanked`);
      assert.match(
        metadata.version?.checksum ?? "",
        /^[0-9a-f]{64}$/,
        `${name} has no published checksum`,
      );
      console.log(`crates.io confirmed ${name}@${version}`);
      return;
    }
    if (response.status !== 404) throw new Error(`${url} returned HTTP ${response.status}`);
    lastObservation = `${url} returned HTTP 404`;
    if (attempt < maxAttempts) await sleepImpl(RETRY_DELAY_MS);
  }
  throw new Error(`${name}@${version} was not available: ${lastObservation}`);
}

export async function verifyCrates({
  version,
  publishResult,
  fetchImpl = fetch,
  sleepImpl = sleep,
  maxAttempts = MAX_ATTEMPTS,
}) {
  if (publishResult !== "success") throw new Error(`publish-crates concluded ${publishResult}`);
  assert.match(version ?? "", /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i);
  const results = await Promise.allSettled(
    CRATES.map((name) => verifyCrateVersion({ name, version, fetchImpl, sleepImpl, maxAttempts })),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason.message);
  if (failures.length) throw new Error(failures.join("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyCrates({
    version: process.env.FERRIKI_RELEASE_VERSION,
    publishResult: process.env.CRATES_PUBLISH_RESULT,
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
