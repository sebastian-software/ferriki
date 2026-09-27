import assert from "node:assert/strict";

import { MAX_ATTEMPTS, registryVersionUrl, verifyNpmPublication } from "./verify-npm-publish.mjs";

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

await assert.rejects(
  verifyNpmPublication({
    packageName: "@ferriki/core",
    version: "0.2.0",
    publishResult: "failure",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: "@ferriki/core", version: "0.2.0" }),
    }),
    sleepImpl: async () => {},
  }),
  /publish-npm concluded failure/,
);

console.log("Ferriki npm publication verification contract passed");
