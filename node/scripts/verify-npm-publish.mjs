import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FERRIKI_PLATFORM_TARGETS } from "../ferriki/platforms.mjs";

// npm can take several minutes to serve a version it already accepted, most
// visibly on a package's first real release: 0.4.0 of @ferriki/linux-x64-gnu
// appeared about six and a half minutes after its publish was confirmed, and
// 0.8.1 of @ferriki/linux-arm64-musl only after the former ten-minute window
// had closed. The packages are checked concurrently, so this window of twenty
// minutes bounds the whole job.
export const MAX_ATTEMPTS = 80;
export const RETRY_DELAY_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 10_000;

export const ASSETS_BASE_URL = "https://assets.ferriki.dev";
const CDN_CONCURRENCY = 8;

export function registryVersionUrl(packageName, version) {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function verifyNpmPublication({
  packageName,
  version,
  publishResult,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  const registryUrl = registryVersionUrl(packageName, version);
  let published = false;
  let provenance = false;
  let lastObservation = "the registry did not return the expected package metadata";
  // After a failed publish the registry state is reported once; waiting for
  // a version that was never accepted would only delay the failure.
  const maxAttempts = publishResult === "success" ? MAX_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(registryUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const metadata = await response.json();
        published = metadata.name === packageName && metadata.version === version;
        provenance = Boolean(metadata.dist?.attestations?.provenance);
        if (published && provenance) {
          console.log(
            `npm registry confirmed ${packageName}@${version} with provenance on attempt ${attempt}`,
          );
          break;
        }
        lastObservation = published
          ? "registry metadata is public but has no provenance attestation"
          : `registry returned ${metadata.name ?? "unknown"}@${metadata.version ?? "unknown"}`;
      } else {
        lastObservation = `registry returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastObservation = `registry request failed: ${error.message}`;
    }

    console.log(
      `npm release verification attempt ${attempt}/${maxAttempts} for ${packageName}: ${lastObservation}`,
    );
    if (attempt < maxAttempts) await sleepImpl(RETRY_DELAY_MS);
  }

  const failures = [];
  if (publishResult !== "success") failures.push(`publish-npm concluded ${publishResult}`);
  if (!published)
    failures.push(`expected ${packageName}@${version} at ${registryUrl}; ${lastObservation}`);
  if (!provenance) failures.push(`expected npm provenance for ${packageName}@${version}`);
  if (failures.length > 0)
    throw new Error(`npm release verification failed: ${failures.join("; ")}`);
}

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
      const url = `${ASSETS_BASE_URL}/${commit}/assets/shiki/${path}`;
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

async function verifyPublicInstall(packageName, version) {
  const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-public-install-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (args, options = {}) => {
    const result = spawnSync(npm, args, {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: options.stdio ?? "pipe",
      shell: process.platform === "win32",
      ...options,
    });
    if (result.status !== 0)
      throw new Error(
        `npm ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      );
  };

  try {
    run(["init", "--yes"], { stdio: "ignore" });
    run(["install", "--ignore-scripts", "--no-audit", "--no-fund", `${packageName}@${version}`], {
      stdio: "ignore",
    });
    const releaseManifest = JSON.parse(
      await readFile(
        join(
          tempRoot,
          "node_modules",
          ...packageName.split("/"),
          "assets",
          "shiki",
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
    const nodeResult = spawnSync(process.execPath, [probe], {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: "pipe",
      env,
    });
    if (nodeResult.status !== 0)
      throw new Error(
        `public Ferriki install probe failed:\n${nodeResult.stdout}\n${nodeResult.stderr}`,
      );
    const cached = await readdir(cacheDir);
    if (cached.length !== 2)
      throw new Error(
        `expected the rust grammar and nord theme in the cache, found ${cached.length} files`,
      );
    console.log(
      `public npm install verified for ${packageName}@${version}, highlighting from the CDN`,
    );

    await verifyCdnPayloads(releaseManifest);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const scriptsDirectory = fileURLToPath(new URL(".", import.meta.url));
  const packagePath = join(scriptsDirectory, "..", "ferriki", "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  assert(
    typeof packageJson.name === "string" && typeof packageJson.version === "string",
    "invalid Ferriki package manifest",
  );

  const packages = [
    { name: packageJson.name, version: packageJson.version },
    ...FERRIKI_PLATFORM_TARGETS.map((target) => ({
      name: target.packageName,
      version: packageJson.optionalDependencies?.[target.packageName],
    })),
  ];
  for (const pkg of packages)
    assert.equal(
      pkg.version,
      packageJson.version,
      `${pkg.name} must use the Ferriki release version`,
    );

  const publishResult = process.env.NPM_PUBLISH_RESULT ?? "unknown";
  const results = await Promise.allSettled(
    packages.map((pkg) =>
      verifyNpmPublication({ packageName: pkg.name, version: pkg.version, publishResult }),
    ),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason.message);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  await verifyPublicInstall(packageJson.name, packageJson.version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
