import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupBootstrap } from "./cleanup-bootstrap-assets.mjs";
import { digest, objectPath } from "./asset-store.mjs";

test("migration cleanup only removes verified old objects and preserves short names", async () => {
  const bytes = Buffer.from("fixture");
  const short = objectPath("language", "rust", digest(bytes));
  const old = `rust/${digest(bytes)}`;
  const staging = "ferriki-bunny-assets/";
  const store = new Map([
    [short, bytes],
    [old, bytes],
    [staging + old, bytes],
  ]);
  let staged = true;
  const deleted = [];
  const options = {
    hostname: "storage.bunnycdn.com",
    zone: "fixture",
    accessKey: "fixture-key",
    objects: new Map([[short, bytes]]),
  };
  const fetchImpl = async (url, request) => {
    const key = new URL(url).pathname.slice("/fixture/".length);
    if (request.method === "DELETE") {
      deleted.push(key);
      if (key === staging) {
        staged = false;
        store.delete(staging + old);
      } else store.delete(key);
      return new Response(null, { status: 200 });
    }
    if (key === "")
      return Response.json(
        staged ? [{ ObjectName: "ferriki-bunny-assets", IsDirectory: true }] : [],
      );
    if (key.endsWith("/")) {
      if (!staged) return Response.json([]);
      return Response.json(
        key === staging
          ? [{ ObjectName: "rust", IsDirectory: true }]
          : [{ ObjectName: digest(bytes), IsDirectory: false }],
      );
    }
    return store.has(key) ? new Response(store.get(key)) : new Response(null, { status: 404 });
  };
  assert.deepEqual(await cleanupBootstrap({ ...options, fetchImpl }), {
    removedObjects: 2,
    removedStaging: true,
  });
  assert.deepEqual(deleted.sort(), [staging, old].sort());
  assert(store.get(short).equals(bytes));
  assert.deepEqual(await cleanupBootstrap({ ...options, fetchImpl }), {
    removedObjects: 0,
    removedStaging: false,
  });
});

test("unexpected staging files or different existing bytes prevent every deletion", async () => {
  const bytes = Buffer.from("fixture");
  const options = {
    hostname: "storage.bunnycdn.com",
    zone: "fixture",
    accessKey: "fixture-key",
    objects: new Map([[objectPath("language", "rust", digest(bytes)), bytes]]),
  };
  for (const unexpected of [true, false]) {
    let deletes = 0;
    const fetchImpl = async (url, request) => {
      if (request.method === "DELETE") {
        deletes++;
        return new Response(null);
      }
      if (new URL(url).pathname === "/fixture/")
        return Response.json([{ ObjectName: "ferriki-bunny-assets", IsDirectory: true }]);
      if (url.endsWith("/"))
        return Response.json(unexpected ? [{ ObjectName: "unknown", IsDirectory: false }] : []);
      return new Response("foreign bytes");
    };
    await assert.rejects(
      cleanupBootstrap({ ...options, fetchImpl }),
      /Unexpected staging object|integrity mismatch/,
    );
    assert.equal(deletes, 0);
  }
});
