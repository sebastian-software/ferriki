import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  digest,
  encodeCatalog,
  fetchBytes,
  objectPath,
  payloadPath,
  shortHash,
} from "./asset-store.mjs";
import { uploadImmutable } from "./bunny-storage.mjs";

test("short object names preserve full digest integrity and legacy full-hash paths", () => {
  const hash = digest(Buffer.from("payload"));
  assert.equal(payloadPath("languages/rust.fkgram", { sha256: hash }), `rust/${shortHash(hash)}`);
  assert.equal(
    payloadPath("themes/nord.fktheme", { sha256: hash }),
    `themes/nord/${shortHash(hash)}`,
  );
  assert.equal(shortHash("0".repeat(64)), "00000000");
  assert.equal(shortHash("a".repeat(64)), "Big46r2A");
  assert.equal(shortHash("f".repeat(64)), "Ha16AHYF");
  assert.equal(
    payloadPath("languages/rust.fkgram", { sha256: hash }, "language-hash-v1"),
    `rust/${hash}`,
  );
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

test("asset downloads recover from connection resets and temporary origin errors", async () => {
  let attempts = 0;
  let discarded = false;
  const bytes = await fetchBytes("https://assets.example/json/12345678", {
    fetchImpl: async (_, options) => {
      assert.equal(options.redirect, "error");
      assert(options.signal instanceof AbortSignal);
      attempts++;
      if (attempts === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      if (attempts === 2)
        return new Response(
          new ReadableStream({
            cancel() {
              discarded = true;
            },
          }),
          { status: 502 },
        );
      assert(discarded, "discard the failed response before retrying");
      return new Response("verified later");
    },
  });
  assert.equal(bytes.toString(), "verified later");
  assert.equal(attempts, 3);
});

test("asset downloads discard partial bytes after a transient stream failure", async () => {
  let attempts = 0;
  const bytes = await fetchBytes("https://assets.example/json/12345678", {
    fetchImpl: async () => {
      if (++attempts > 1) return new Response("complete");
      let reads = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (++reads === 1) controller.enqueue(new TextEncoder().encode("partial"));
            else
              controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
          },
        }),
      );
    },
  });
  assert.equal(bytes.toString(), "complete");
  assert.equal(attempts, 2);
});

test("asset downloads stop after three temporary failures", async () => {
  let attempts = 0;
  await assert.rejects(
    fetchBytes("https://assets.example/json/12345678", {
      fetchImpl: async () => {
        attempts++;
        return new Response(null, { status: 503 });
      },
    }),
    /HTTP 503/,
  );
  assert.equal(attempts, 3);
});

test("asset downloads do not retry permanent failures or oversized payloads", async () => {
  for (const [status, options, expected] of [
    [403, {}, /HTTP 403/],
    [404, {}, /HTTP 404/],
    [200, { limit: 2 }, /size limit/],
  ]) {
    let attempts = 0;
    await assert.rejects(
      fetchBytes("https://assets.example/json/12345678", {
        ...options,
        fetchImpl: async () => {
          attempts++;
          return new Response("large", { status });
        },
      }),
      expected,
    );
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  assert.equal(
    await fetchBytes("https://assets.example/json/12345678", {
      missing: true,
      fetchImpl: async () => {
        attempts++;
        return new Response(null, { status: 404 });
      },
    }),
    null,
  );
  assert.equal(attempts, 1);
});

test("asset downloads do not retry certificate or redirect failures", async () => {
  for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", undefined]) {
    let attempts = 0;
    const failure = new TypeError("fetch failed", { cause: { code } });
    await assert.rejects(
      fetchBytes("https://assets.example/json/12345678", {
        fetchImpl: async () => {
          attempts++;
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
  }
});
