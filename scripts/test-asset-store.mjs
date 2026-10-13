import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { digest, encodeCatalog, objectPath, payloadPath } from "./asset-store.mjs";
import { uploadImmutable } from "./bunny-storage.mjs";

test("canonical language and theme objects are named by their full digest", () => {
  const hash = digest(Buffer.from("payload"));
  assert.equal(payloadPath("languages/rust.fkgram", { sha256: hash }), `rust/${hash}`);
  assert.equal(payloadPath("themes/nord.fktheme", { sha256: hash }), `themes/nord/${hash}`);
  assert.throws(() => objectPath("language", "../rust", hash));
  assert.throws(() => objectPath("language", "rust", "short-hash"));
});

test("metadata encoding preserves the native postcard catalog format", async () => {
  const root = new URL("../", import.meta.url);
  const lock = JSON.parse(await readFile(new URL("assets/catalog.json", root), "utf8"));
  for (const [kind, folder, value] of [
    ["language", "languages", lock.languages],
    ["theme", "themes", lock.themes],
  ])
    assert.deepEqual(
      encodeCatalog(value, kind),
      await readFile(new URL(`assets/standard/${folder}/manifest.fkindex`, root)),
    );
});

test("immutable publication verifies uploads, skips identical bytes, and preserves conflicts", async () => {
  const store = new Map();
  const calls = [];
  const bytes = Buffer.from("compiled grammar");
  const key = objectPath("language", "rust", digest(bytes));
  const options = {
    hostname: "storage.bunnycdn.com",
    zone: "fixture-zone",
    accessKey: "fixture-secret",
    objects: new Map([[key, bytes]]),
  };
  const fetchImpl = async (url, request) => {
    assert.equal(new URL(url).host, "storage.bunnycdn.com");
    assert.equal(request.headers.AccessKey, "fixture-secret");
    assert.equal(request.redirect, "error");
    calls.push(request.method || "GET");
    if (request.method === "PUT") {
      store.set(url, request.body);
      return new Response(null, { status: 201 });
    }
    return store.has(url) ? new Response(store.get(url)) : new Response(null, { status: 404 });
  };
  assert.deepEqual(await uploadImmutable({ ...options, fetchImpl }), { uploaded: 1, skipped: 0 });
  assert.deepEqual(calls, ["GET", "PUT", "GET"]);
  calls.length = 0;
  assert.deepEqual(await uploadImmutable({ ...options, fetchImpl }), { uploaded: 0, skipped: 1 });
  assert.deepEqual(calls, ["GET"]);
  store.set(`https://storage.bunnycdn.com/fixture-zone/${key}`, Buffer.from("foreign bytes"));
  calls.length = 0;
  await assert.rejects(uploadImmutable({ ...options, fetchImpl }), /differs/);
  assert.deepEqual(calls, ["GET"]);
  await assert.rejects(
    uploadImmutable({ ...options, hostname: "foreign.example", fetchImpl }),
    /Set BUNNY/,
  );
});

test("failed upload read-back never reports successful publication", async () => {
  const bytes = Buffer.from("payload");
  let gets = 0;
  await assert.rejects(
    uploadImmutable({
      hostname: "storage.bunnycdn.com",
      zone: "fixture",
      accessKey: "fixture-secret",
      objects: new Map([[objectPath("language", "rust", digest(bytes)), bytes]]),
      fetchImpl: async (_, req) => {
        if (req.method === "PUT") return new Response(null, { status: 201 });
        return ++gets === 1 ? new Response(null, { status: 404 }) : new Response("truncated");
      },
    }),
    /read-back/,
  );
});
