import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNpmPackMetadata } from "./npm-pack-metadata.mjs";

const packageName = "@ferriki/core";
const metadata = {
  name: packageName,
  filename: "ferriki-core-1.0.0.tgz",
  files: [{ path: "index.mjs", size: 10 }],
  unpackedSize: 10,
};

test("normalizes npm array-shaped pack metadata", () => {
  assert.deepEqual(normalizeNpmPackMetadata(JSON.stringify([metadata]), packageName), metadata);
});

test("normalizes npm 12 package-keyed pack metadata", () => {
  const { name: _name, ...keyedMetadata } = metadata;
  assert.deepEqual(
    normalizeNpmPackMetadata(JSON.stringify({ [packageName]: keyedMetadata }), packageName),
    metadata,
  );
});

test("rejects malformed pack metadata and mismatched package identities", () => {
  assert.throws(() => normalizeNpmPackMetadata("not JSON", packageName), /returned invalid JSON/);
  assert.throws(
    () =>
      normalizeNpmPackMetadata(
        JSON.stringify([{ ...metadata, name: "wrong-package" }]),
        packageName,
      ),
    /expected @ferriki\/core/,
  );
  assert.throws(
    () => normalizeNpmPackMetadata(JSON.stringify({ "@ferriki/other": metadata }), packageName),
    /expected only @ferriki\/core/,
  );
  assert.throws(
    () =>
      normalizeNpmPackMetadata(
        JSON.stringify({ [packageName]: { ...metadata, files: null } }),
        packageName,
      ),
    /must include a files array/,
  );
});
