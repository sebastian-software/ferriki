import assert from "node:assert/strict";

import { createHash } from "node:crypto";

import {
  MAX_ATTEMPTS,
  registryVersionUrl,
  verifyCdnPayloads,
  verifyNpmPublication,
} from "./verify-npm-publish.mjs";

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
