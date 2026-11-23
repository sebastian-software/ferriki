import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { createAssetDownloader } from "../ferriki/src/asset-download.mjs";
import { protectedSelected, protectedUrl } from "../ferriki/src/protected-assets.mjs";

const body = Buffer.from("release pinned bytes");
const digest = createHash("sha256").update(body).digest("hex");
const path = "/themes/nord/DVzhgQds";
const signed = `https://protected-assets.ferriki.dev${path}?token=HS256-example&expires=1234`;
const asset = {
  path: "themes/nord.fktheme",
  url: `https://assets.ferriki.dev${path}`,
  digest,
  size: body.length,
};
const issued = () => Response.json({ url: signed, bytes: body.length, sha256: digest });

test("selection is explicit and signed responses are scoped to the requested asset", async () => {
  assert.equal(protectedSelected({ FERRIKI_DOWNLOAD_TOKEN: "secret" }), false);
  assert.equal(protectedSelected({ FERRIKI_ASSETS_PROTECTED: "1" }), true);
  assert.throws(() => protectedSelected({ FERRIKI_ASSETS_PROTECTED: "maybe" }));
  const env = { FERRIKI_DOWNLOAD_TOKEN: "test-bearer" };
  const fetcher = async (url, options) => {
    assert.equal(url, "https://downloads.ferriki.dev/v1/downloads");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer test-bearer");
    assert.deepEqual(JSON.parse(options.body), { path, sha256: digest });
    return issued();
  };
  assert.equal(await protectedUrl(asset, undefined, env, fetcher), signed);
  for (const url of [
    signed.replace("protected-assets.ferriki.dev", "evil.test"),
    signed.replace(path, "/other"),
    `${signed}&extra=1`,
    `${signed}&token=again`,
    `${signed}#x`,
  ]) {
    await assert.rejects(
      protectedUrl(asset, undefined, env, async () =>
        Response.json({ url, bytes: body.length, sha256: digest }),
      ),
      (error) => !error.message.includes("HS256-example"),
    );
  }
  await assert.rejects(
    protectedUrl(asset, undefined, env, async () =>
      Response.json({ url: signed, bytes: 1, sha256: digest }),
    ),
  );
  await assert.rejects(
    protectedUrl({ ...asset, url: `https://mirror.test${path}` }, undefined, env, async () => {
      throw new Error("must not call");
    }),
  );
  await assert.rejects(protectedUrl(asset, undefined, {}, fetcher));
});

test("protected cache misses send no bearer to the CDN and never fall back publicly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ferriki-protected-"));
  const previousFetch = globalThis.fetch;
  const previous = {
    protected: process.env.FERRIKI_ASSETS_PROTECTED,
    token: process.env.FERRIKI_DOWNLOAD_TOKEN,
  };
  process.env.FERRIKI_ASSETS_PROTECTED = "1";
  process.env.FERRIKI_DOWNLOAD_TOKEN = "test-bearer";
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push(url);
      if (url === "https://downloads.ferriki.dev/v1/downloads") return issued();
      assert.equal(url, signed);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, undefined);
      return new Response(body);
    };
    const native = { planAssets: async () => [asset], assetCacheDir: () => dir };
    await createAssetDownloader(native)([], []);
    assert.deepEqual(await readFile(join(dir, digest)), body);
    assert.deepEqual(calls, ["https://downloads.ferriki.dev/v1/downloads", signed]);
    await rm(join(dir, digest));
    calls.length = 0;
    globalThis.fetch = async (url) => {
      calls.push(url);
      return new Response(null, { status: 403 });
    };
    await assert.rejects(createAssetDownloader(native)([], []), /authorization failed/);
    assert.deepEqual(calls, ["https://downloads.ferriki.dev/v1/downloads"]);
    calls.length = 0;
    const mirror = {
      ...native,
      planAssets: async () => [{ ...asset, url: `https://mirror.test${path}` }],
    };
    await assert.rejects(createAssetDownloader(mirror)([], []), /default CDN/);
    assert.deepEqual(calls, []);
    delete process.env.FERRIKI_DOWNLOAD_TOKEN;
    await createAssetDownloader({ planAssets: async () => [], assetCacheDir: () => dir })([], []);
    await assert.rejects(createAssetDownloader(native)([], []), /FERRIKI_DOWNLOAD_TOKEN/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previous.protected === undefined) delete process.env.FERRIKI_ASSETS_PROTECTED;
    else process.env.FERRIKI_ASSETS_PROTECTED = previous.protected;
    if (previous.token === undefined) delete process.env.FERRIKI_DOWNLOAD_TOKEN;
    else process.env.FERRIKI_DOWNLOAD_TOKEN = previous.token;
    await rm(dir, { recursive: true, force: true });
  }
});
