import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  MAX_ATTEMPTS,
  registryVersionUrl,
  runPublicNpmInstall,
  verifyCdnPayloads,
  verifyPublicAssetCache,
  verifyNpmPublication as verifyPublication,
} from "./verify-npm-publish.mjs";

let npmVersionProbes = 0;
await assert.rejects(
  async () =>
    runPublicNpmInstall({
      packageName: "@ferriki/core",
      version: "1.0.0",
      cwd: tmpdir(),
      nodeVersion: "v22.23.3",
      spawnImpl: (_command, args, options) => {
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        if (args[0] === "--version") {
          npmVersionProbes += 1;
          return spawn(process.execPath, ["-e", 'process.stdout.write("10.9.9\\n")'], {
            ...options,
            shell: false,
          });
        }
        assert.deepEqual(args, [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "@ferriki/core@1.0.0",
        ]);
        return spawn(
          process.execPath,
          [
            "-e",
            `process.stdout.write("old output\\n".repeat(160000));
             process.stdout.write("NODE_AUTH_TOKEN=" + "A".repeat(100000) + "SecretSliceMarker\\n");
             process.stdout.write("stdout trailing diagnostic\\n");
             process.stderr.write("warning\\n".repeat(160000));
             process.stderr.write("npm error https://writer:secret@registry.npmjs.org/x?token=private\\n");
             process.stderr.write("NODE_AUTH_TOKEN=hidden\\n");
             process.stderr.write("npm error code ETARGET\\n");
             process.exitCode = 1;`,
          ],
          { ...options, shell: false },
        );
      },
    }),
  (error) => {
    assert.match(error.message, /@ferriki\/core@1\.0\.0/);
    assert.match(error.message, /Node v22\.23\.3, npm 10\.9\.9/);
    assert.match(error.message, /exit status 1; signal none; spawn error none/);
    assert.match(error.message, /stdout tail:[\s\S]*stdout trailing diagnostic/);
    assert.match(error.message, /stderr tail:[\s\S]*npm error code ETARGET/);
    assert.doesNotMatch(
      error.message,
      /writer:secret|token=private|NODE_AUTH_TOKEN=hidden|SecretSliceMarker/,
    );
    assert(error.message.length < 5_000, "diagnostic tails must remain bounded");
    return true;
  },
);
assert.equal(npmVersionProbes, 1, "npm version is queried only after a failure");

let successfulInstallCalls = 0;
assert.equal(
  await runPublicNpmInstall({
    packageName: "@ferriki/core",
    version: "1.0.0",
    cwd: tmpdir(),
    spawnImpl: (_command, args, options) => {
      assert.equal(args[0], "install", "a successful install does not probe npm again");
      successfulInstallCalls += 1;
      return spawn(
        process.execPath,
        [
          "-e",
          'process.stdout.write("warning\\n".repeat(160000)); process.stderr.write("notice\\n".repeat(200000));',
        ],
        { ...options, shell: false },
      );
    },
  }),
  undefined,
);
assert.equal(successfulInstallCalls, 1);

await assert.rejects(
  async () =>
    runPublicNpmInstall({
      packageName: "@ferriki/vite",
      version: "1.0.0",
      cwd: tmpdir(),
      npmCommand: join(tmpdir(), `ferriki-missing-npm-${randomUUID()}`),
      spawnImpl: (command, args, options) => spawn(command, args, { ...options, shell: false }),
    }),
  (error) => {
    assert.match(error.message, /@ferriki\/vite@1\.0\.0/);
    assert.match(error.message, /npm unavailable/);
    assert.match(error.message, /exit status (?:none|-?\d+); signal none; spawn error ENOENT:/);
    assert.match(error.message, /stdout tail:\n\(empty\)/);
    return true;
  },
  "a real spawn failure must retain the executable error",
);

// The main package and its sidecars live in the `@ferriki` scope, so the
// helper has to encode the scope separator for the registry path.
assert.equal(
  registryVersionUrl("@ferriki/linux-x64-gnu", "0.2.0"),
  "https://registry.npmjs.org/%40ferriki%2Flinux-x64-gnu/0.2.0",
);
assert.equal(
  registryVersionUrl("@ferriki/core", "0.2.0"),
  "https://registry.npmjs.org/%40ferriki%2Fcore/0.2.0",
);
assert.equal(
  registryVersionUrl("@ferriki/vite", "0.2.0"),
  "https://registry.npmjs.org/%40ferriki%2Fvite/0.2.0",
);

let attempts = 0;
await verifyNpmPublication({
  packageName: "@ferriki/core",
  version: "0.2.0",
  publishResult: "success",
  fetchImpl: async () => {
    attempts += 1;
    return {
      ok: attempts === 2,
      status: attempts === 2 ? 200 : 404,
      json: async () => ({
        name: "@ferriki/core",
        version: "0.2.0",
        dist: { attestations: { provenance: {} } },
      }),
    };
  },
  sleepImpl: async () => {},
});
assert.equal(attempts, 2);

let viteAttempts = 0;
await verifyNpmPublication({
  packageName: "@ferriki/vite",
  version: "0.8.3",
  publishResult: "success",
  fetchImpl: async (url) => {
    viteAttempts += 1;
    assert.equal(url, "https://registry.npmjs.org/%40ferriki%2Fvite/0.8.3");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        name: "@ferriki/vite",
        version: "0.8.3",
        dist: { attestations: { provenance: {} } },
      }),
    };
  },
  sleepImpl: async () => {},
});
assert.equal(viteAttempts, 1);

let wrongVersionAttempts = 0;
await assert.rejects(
  verifyNpmPublication({
    packageName: "@ferriki/core",
    version: "0.2.0",
    publishResult: "success",
    fetchImpl: async () => {
      wrongVersionAttempts += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: "@ferriki/core",
          version: "0.1.0",
          dist: { attestations: { provenance: {} } },
        }),
      };
    },
    sleepImpl: async () => {},
  }),
  /expected @ferriki\/core@0\.2\.0/,
);
assert.equal(wrongVersionAttempts, MAX_ATTEMPTS);

let failedPublishAttempts = 0;
await assert.rejects(
  verifyNpmPublication({
    packageName: "@ferriki/core",
    version: "0.2.0",
    publishResult: "failure",
    fetchImpl: async () => {
      failedPublishAttempts += 1;
      return { ok: false, status: 404, json: async () => ({}) };
    },
    sleepImpl: async () => {},
  }),
  /publish-npm concluded failure/,
);
assert.equal(failedPublishAttempts, 1, "a failed publish must not wait out the retry window");

// Registry fixtures below focus on version processing and provenance. The
// shared suite separately exercises channel propagation and missing dist-tags.
function verifyNpmPublication(options) {
  return verifyPublication({ ...options, checkDistTag: false });
}

const assetCache = await mkdtemp(join(tmpdir(), "ferriki-public-cache-contract-"));
const cachePayloads = ["rust grammar", "prepared regex", "nord theme"].map((value) =>
  new TextEncoder().encode(value),
);
const cachePaths = ["languages/rust.fkgram", "languages/rust.fkbc", "themes/nord.fktheme"];
const cacheManifest = {
  assets: Object.fromEntries(
    cachePaths.map((path, index) => [
      path,
      {
        sha256: createHash("sha256").update(cachePayloads[index]).digest("hex"),
        size: cachePayloads[index].length,
      },
    ]),
  ),
};
try {
  for (const [index, path] of cachePaths.entries()) {
    await writeFile(join(assetCache, cacheManifest.assets[path].sha256), cachePayloads[index]);
  }
  await verifyPublicAssetCache(cacheManifest, assetCache);
  const prepared = cacheManifest.assets["languages/rust.fkbc"];
  const preparedFile = join(assetCache, prepared.sha256);
  await rm(preparedFile);
  await assert.rejects(verifyPublicAssetCache(cacheManifest, assetCache), /prepared regex package/);
  const corrupt = cachePayloads[1].slice();
  corrupt[0] ^= 1;
  await writeFile(preparedFile, corrupt);
  await assert.rejects(verifyPublicAssetCache(cacheManifest, assetCache), /cached SHA-256 differs/);
  await writeFile(preparedFile, "truncated");
  await assert.rejects(verifyPublicAssetCache(cacheManifest, assetCache), /cached size differs/);
  const { "languages/rust.fkbc": _prepared, ...withoutPrepared } = cacheManifest.assets;
  await assert.rejects(
    verifyPublicAssetCache({ assets: withoutPrepared }, assetCache),
    /manifest is missing languages\/rust.fkbc/,
  );
} finally {
  await rm(assetCache, { recursive: true, force: true });
}

console.log("Ferriki npm publication verification contract passed");

// The CDN check fails on a missing commit, a non-200 answer or foreign bytes.
const payload = new TextEncoder().encode("payload");
const pinned = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  assets: {
    "themes/nord.fktheme": {
      sha256: createHash("sha256").update(payload).digest("hex"),
      size: payload.length,
    },
  },
};
const serve =
  (bytes, status = 200) =>
  async (url) => {
    assert.equal(
      url,
      `https://assets.ferriki.dev/${pinned.commit}/assets/shiki/themes/nord.fktheme`,
    );
    return { ok: status === 200, status, arrayBuffer: async () => bytes.buffer };
  };
await verifyCdnPayloads(pinned, { fetchImpl: serve(payload) });
await assert.rejects(
  verifyCdnPayloads(pinned, { fetchImpl: serve(new TextEncoder().encode("tampered")) }),
  /does not match its pinned SHA-256/,
);
await assert.rejects(verifyCdnPayloads(pinned, { fetchImpl: serve(payload, 404) }), /HTTP 404/);
await assert.rejects(
  verifyCdnPayloads({ ...pinned, commit: undefined }, { fetchImpl: serve(payload) }),
  /not pinned to a commit/,
);

await verifyCdnPayloads(
  { ...pinned, storageLayout: "language-hash-v1" },
  {
    fetchImpl: async (url) => {
      assert.equal(
        url,
        `https://assets.ferriki.dev/themes/nord/${pinned.assets["themes/nord.fktheme"].sha256}`,
      );
      return { ok: true, arrayBuffer: async () => payload.buffer };
    },
  },
);

await verifyCdnPayloads(
  { ...pinned, storageLayout: "language-hash-v2" },
  {
    fetchImpl: async (url) => {
      assert.equal(url, "https://assets.ferriki.dev/themes/nord/HrW53YkZ");
      return { ok: true, arrayBuffer: async () => payload.buffer };
    },
  },
);
