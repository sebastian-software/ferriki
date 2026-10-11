import assert from "node:assert/strict";

import { CRATES, verifyCrates, verifyCrateVersion } from "./verify-crates-publish.mjs";

const version = "0.14.0";
const seen = [];
const fetchImpl = async (url) => {
  seen.push(url);
  const name = url.split("/").at(-2);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      version: { crate: name, num: version, yanked: false, checksum: "a".repeat(64) },
    }),
  };
};
await verifyCrates({ version, publishResult: "success", fetchImpl });
assert.deepEqual(
  seen.map((url) => url.split("/").at(-2)),
  CRATES,
);
await assert.rejects(
  verifyCrates({ version, publishResult: "failure", fetchImpl }),
  /publish-crates concluded failure/,
);
for (const result of ["cancelled", "skipped", "unknown"]) {
  await assert.rejects(verifyCrates({ version, publishResult: result, fetchImpl }));
}
let attempts = 0;
await verifyCrateVersion({
  name: "ferriki",
  version,
  maxAttempts: 2,
  sleepImpl: async () => {},
  fetchImpl: async (url) => {
    attempts += 1;
    return attempts === 1 ? { ok: false, status: 404 } : fetchImpl(url);
  },
});
assert.equal(attempts, 2);
await assert.rejects(
  verifyCrateVersion({
    name: "ferriki",
    version,
    maxAttempts: 1,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  }),
  /HTTP 403/,
);
await assert.rejects(
  verifyCrateVersion({
    name: "ferriki",
    version,
    maxAttempts: 1,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        version: { crate: "foreign", num: version, yanked: false, checksum: "a".repeat(64) },
      }),
    }),
  }),
  /wrong crate/,
);
console.log("Ferriki crates.io publication verification passed with fake transport");
