import assert from "node:assert/strict";
import { test } from "node:test";
import { digest, payloadPath } from "./asset-store.mjs";
import { planRetirement, retirePreparedAssets } from "./retire-prepared-assets.mjs";

function fixture() {
  const oldBytes = Buffer.from("complete fixture");
  const newBytes = Buffer.from("cooperating fixture");
  const asset = (bytes, version) => ({
    sha256: digest(bytes),
    size: bytes.length,
    formatVersion: version << 24,
  });
  const previous = {
    storageLayout: "language-hash-v2",
    assets: { "languages/rust.fkbc": asset(oldBytes, 2) },
  };
  const current = {
    storageLayout: "language-hash-v2",
    assets: { "languages/rust.fkbc": asset(newBytes, 3) },
  };
  const plan = planRetirement(previous, current);
  const store = new Map([
    [plan[0].path, oldBytes],
    [plan[0].replacement.path, newBytes],
    ["rust/unrelated", Buffer.from("preserve")],
  ]);
  const deleted = [];
  const options = {
    hostname: "storage.bunnycdn.com",
    zone: "fixture",
    accessKey: "fixture-key",
    plan,
    fetchImpl: async (url, request) => {
      assert.equal(request.redirect, "error");
      const key = new URL(url).pathname.slice("/fixture/".length);
      if (request.method === "DELETE") {
        deleted.push(key);
        store.delete(key);
        return new Response(null);
      }
      return store.has(key) ? new Response(store.get(key)) : new Response(null, { status: 404 });
    },
  };
  return { previous, current, plan, store, deleted, options };
}

test("retirement deletes only the obsolete object and is idempotent", async () => {
  const { plan, store, deleted, options } = fixture();
  assert.deepEqual(await retirePreparedAssets(options), {
    removedObjects: 1,
    removedBytes: plan[0].size,
    alreadyAbsent: 0,
  });
  assert.deepEqual(deleted, [plan[0].path]);
  assert.equal(store.size, 2);
  assert(store.has(plan[0].replacement.path));
  assert.deepEqual(await retirePreparedAssets(options), {
    removedObjects: 0,
    removedBytes: 0,
    alreadyAbsent: 1,
  });
});

test("missing replacements and unrecognized old bytes prevent all deletions", async () => {
  for (const corruptOld of [false, true]) {
    const { plan, store, deleted, options } = fixture();
    if (corruptOld) store.set(plan[0].path, Buffer.from("foreign bytes"));
    else store.delete(plan[0].replacement.path);
    await assert.rejects(retirePreparedAssets(options), /verification failed|integrity mismatch/);
    assert.deepEqual(deleted, []);
  }
});

test("a bad later object stops deletion of already verified objects", async () => {
  const { plan, store, deleted, options } = fixture();
  const second = {
    ...plan[0],
    path: plan[0].path.replace("rust/", "css/"),
    replacement: {
      ...plan[0].replacement,
      path: plan[0].replacement.path.replace("rust/", "css/"),
    },
  };
  store.set(second.replacement.path, store.get(plan[0].replacement.path));
  store.set(second.path, Buffer.from("foreign bytes"));
  await assert.rejects(
    retirePreparedAssets({ ...options, plan: [...plan, second] }),
    /integrity mismatch/,
  );
  assert.deepEqual(deleted, []);
});

test("an accepted DELETE must actually remove the object", async () => {
  const { options } = fixture();
  const fetchImpl = (url, request) =>
    request.method === "DELETE" ? new Response(null) : options.fetchImpl(url, request);
  await assert.rejects(retirePreparedAssets({ ...options, fetchImpl }), /Deletion not confirmed/);
});

test("active paths, identical objects, and incomplete replacement formats cannot retire", () => {
  const { previous, current, plan } = fixture();
  assert.throws(
    () => planRetirement(previous, current, new Set([plan[0].path])),
    /no distinct cooperating replacement/,
  );
  assert.throws(() => planRetirement(previous, previous), /no distinct cooperating replacement/);
  delete current.assets["languages/rust.fkbc"];
  assert.throws(() => planRetirement(previous, current), /no distinct cooperating replacement/);
  assert.equal(
    payloadPath("languages/rust.fkbc", previous.assets["languages/rust.fkbc"]),
    plan[0].path,
  );
});
