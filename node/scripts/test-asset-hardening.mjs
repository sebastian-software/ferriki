import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createAssetDownloader,
  isAlreadyPresent,
  isValidAssetUrl,
  matchesCachedAsset,
  normalizeAssetBaseUrl,
  publishTemporaryAsset,
} from "../ferriki/src/asset-download.mjs";

const run = promisify(execFile);
const grammarCli = fileURLToPath(new URL("../ferriki/grammar.mjs", import.meta.url));
const body = Buffer.from("release pinned bytes");
const digest = createHash("sha256").update(body).digest("hex");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("asset downloader and facade URL validator accept only safe https or loopback http URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ferriki-url-validation-"));
  const previousFetch = globalThis.fetch;
  const previousProtected = process.env.FERRIKI_ASSETS_PROTECTED;
  delete process.env.FERRIKI_ASSETS_PROTECTED;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(body);
  };
  try {
    for (const badUrl of [
      "http://example.com/rust/Big46r2A",
      "http://assets.ferriki.dev/rust/Big46r2A",
      "http://localhost.evil.test/rust/Big46r2A",
      "http://127.0.0.1.evil.test/rust/Big46r2A",
      "http://0.0.0.0:8080/rust/Big46r2A",
      "http://128.0.0.1:8080/assets",
      "file:///etc/passwd",
      "ftp://mirror.test/rust/Big46r2A",
      "https://user:pass@assets.ferriki.dev/rust/Big46r2A",
      "http://localhost@evil.test/rust/Big46r2A",
      "http://localhost%40evil.test/rust/Big46r2A",
      "https://assets.ferriki.dev/rust/Big46r2A?token=1",
      "https://assets.ferriki.dev/rust/Big46r2A?",
      "https://assets.ferriki.dev/rust/Big46r2A#frag",
      "https://assets.ferriki.dev/rust/Big46r2A#",
      "https://assets.ferriki.dev/rust\\Big46r2A",
      "https://assets.ferriki.dev/rust/../Big46r2A",
      "https://assets.ferriki.dev/rust/%2e%2e/Big46r2A",
      "https://mirror.example/%2e%2e",
      "https://mirror.example/a%2fb",
      "https://mirror.example/a%2",
      "https://assets.ferriki.dev/rust/a%2fb",
      "https://assets.ferriki.dev:0/rust/Big46r2A",
      "https://mirror..example/assets",
      "https://./assets",
      "https://../assets",
      "https://mirror.example../assets",
      "https://bad_host.example/assets",
      "https://assets.ferriki.dev/rust/Big46r2A ",
      "not-a-url",
    ]) {
      assert.equal(isValidAssetUrl(badUrl), false, `expected invalid asset URL: ${badUrl}`);
      const native = {
        planAssets: async () => [
          { path: "themes/nord.fktheme", url: badUrl, digest, size: body.length },
        ],
        assetCacheDir: () => dir,
      };
      await assert.rejects(
        createAssetDownloader(native)([], []),
        /invalid payload descriptor/,
        `expected invalid asset URL to be rejected: ${badUrl}`,
      );
    }
    assert.deepEqual(calls, [], "rejected URLs must never reach fetch");

    for (const validUrl of [
      "https://assets.ferriki.dev/themes/nord/DVzhgQds",
      "HTTPS://mirror.example/assets",
      "HTTP://localhost:8080/mirror",
      "https://mirror.example/ferriki/",
      "https://mirror.example/archive%FF",
      "https://bücher.example/assets/",
      "http://127.0.0.1:8080/themes/nord/DVzhgQds",
      "http://127.0.0.2:8080/assets",
      "http://localhost:8080/themes/nord/DVzhgQds",
      "http://localhost.:8080/assets",
      "http://[::1]:8080/themes/nord/DVzhgQds",
      "http://[0:0:0:0:0:0:0:1]:8080/assets",
    ]) {
      assert.equal(isValidAssetUrl(validUrl), true, `expected valid asset URL: ${validUrl}`);
      calls.length = 0;
      const targetDir = join(dir, createHash("sha256").update(validUrl).digest("hex").slice(0, 8));
      const native = {
        planAssets: async () => [
          { path: "themes/nord.fktheme", url: validUrl, digest, size: body.length },
        ],
        assetCacheDir: () => targetDir,
      };
      await createAssetDownloader(native)([], []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, validUrl);
      assert.equal(calls[0].options.redirect, "error");
      assert.deepEqual(await readFile(join(targetDir, digest)), body);
    }
    assert.equal(
      normalizeAssetBaseUrl("HTTPS://mirror.example/assets"),
      "https://mirror.example/assets",
    );
    assert.equal(
      normalizeAssetBaseUrl("https://bücher.example/assets/"),
      "https://xn--bcher-kva.example/assets",
    );
    assert.equal(
      normalizeAssetBaseUrl("https://mirror.example./assets/"),
      "https://mirror.example./assets",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProtected === undefined) delete process.env.FERRIKI_ASSETS_PROTECTED;
    else process.env.FERRIKI_ASSETS_PROTECTED = previousProtected;
    await rm(dir, { recursive: true, force: true });
  }
});

test("public asset downloads refuse HTTP redirects without retrying", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ferriki-redirect-refusal-"));
  const previousFetch = globalThis.fetch;
  const previousProtected = process.env.FERRIKI_ASSETS_PROTECTED;
  delete process.env.FERRIKI_ASSETS_PROTECTED;
  const calls = [];
  const redirectError = new TypeError("fetch failed", {
    cause: new Error("unexpected redirect"),
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    throw redirectError;
  };
  try {
    const assetUrl = "https://assets.ferriki.dev/themes/nord/DVzhgQds";
    const native = {
      planAssets: async () => [
        { path: "themes/nord.fktheme", url: assetUrl, digest, size: body.length },
      ],
      assetCacheDir: () => dir,
    };
    await assert.rejects(createAssetDownloader(native)([], []), (error) => error === redirectError);
    assert.equal(calls.length, 1, "redirects must not be retried");
    assert.equal(calls[0].options.redirect, "error", "public fetch must pass redirect: error");
    assert.deepEqual(await readdir(dir), [], "failed redirect must leave no cached or temp files");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProtected === undefined) delete process.env.FERRIKI_ASSETS_PROTECTED;
    else process.env.FERRIKI_ASSETS_PROTECTED = previousProtected;
    await rm(dir, { recursive: true, force: true });
  }
});

test("matchesCachedAsset handles ENOENT cleanly and isAlreadyPresent covers Windows lock codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ferriki-cache-race-"));
  try {
    const descriptor = { digest, size: body.length };
    assert.equal(
      await matchesCachedAsset(join(dir, "missing-entry"), descriptor),
      false,
      "ENOENT returns false cleanly so fallback rename can proceed",
    );
    const subdir = join(dir, "a-directory");
    await mkdir(subdir);
    assert.equal(await matchesCachedAsset(subdir, descriptor), false);
    const validFile = join(dir, digest);
    await writeFile(validFile, body);
    assert.equal(await matchesCachedAsset(validFile, descriptor), true);
    if (process.platform !== "win32") {
      const fifo = join(dir, "fifo-entry");
      await run("mkfifo", [fifo]);
      const moduleUrl = new URL("../ferriki/src/asset-download.mjs", import.meta.url).href;
      const { stdout } = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { matchesCachedAsset } from ${JSON.stringify(moduleUrl)};
           const matched = await matchesCachedAsset(${JSON.stringify(fifo)}, ${JSON.stringify(descriptor)});
           process.stdout.write(String(matched));`,
        ],
        { timeout: 5000 },
      );
      assert.equal(
        stdout,
        "false",
        "FIFO target must be rejected immediately without blocking open",
      );
    }

    for (const code of ["EEXIST", "EPERM", "ENOTEMPTY", "EACCES", "EBUSY"]) {
      assert.equal(isAlreadyPresent({ code }), true, `expected ${code} to be treated as present`);
    }
    for (const code of ["ENOENT", "ENOSPC", "EROFS"]) {
      assert.equal(isAlreadyPresent({ code }), false, `unexpected match for ${code}`);
    }

    // ENOENT between rename failure and inspect must retry rename directly without calling rm(target).
    let rmCalls = 0;
    let renameCalls = 0;
    await publishTemporaryAsset("tmp", "target", descriptor, {
      rename: async () => {
        renameCalls++;
        if (renameCalls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
      rm: async () => {
        rmCalls++;
      },
      inspect: async () => "missing",
    });
    assert.equal(renameCalls, 2);
    assert.equal(rmCalls, 0, "ENOENT fallback must never unlink target");

    // If a concurrent winner appears before the retry rename, re-verify it without calling rm(target).
    rmCalls = 0;
    renameCalls = 0;
    let inspectCalls = 0;
    await publishTemporaryAsset("tmp", "target", descriptor, {
      rename: async () => {
        renameCalls++;
        throw Object.assign(new Error("exists"), { code: "EACCES" });
      },
      rm: async () => {
        rmCalls++;
      },
      inspect: async () => {
        inspectCalls++;
        return inspectCalls === 1 ? "missing" : "valid";
      },
    });
    assert.equal(renameCalls, 2);
    assert.equal(inspectCalls, 2);
    assert.equal(rmCalls, 0, "concurrent winner after ENOENT must never be unlinked");

    // Lock contention (EACCES/EBUSY) with a non-matching target must never unlink target.
    for (const code of ["EACCES", "EBUSY"]) {
      rmCalls = 0;
      renameCalls = 0;
      const lockError = Object.assign(new Error(code), { code });
      await assert.rejects(
        publishTemporaryAsset("tmp", "target", descriptor, {
          rename: async () => {
            renameCalls++;
            throw lockError;
          },
          rm: async () => {
            rmCalls++;
          },
          inspect: async () => "corrupt",
        }),
        (error) => error === lockError,
      );
      assert.equal(renameCalls, 1);
      assert.equal(rmCalls, 0, `${code} contention must never unlink target`);
    }

    // Non-lock EEXIST on a verified corrupt target unlinks target before retrying rename.
    rmCalls = 0;
    renameCalls = 0;
    await publishTemporaryAsset("tmp", "target", descriptor, {
      rename: async () => {
        renameCalls++;
        if (renameCalls === 1) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
      rm: async () => {
        rmCalls++;
      },
      inspect: async () => "corrupt",
    });
    assert.equal(renameCalls, 2);
    assert.equal(rmCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grammar fetch rejects all HTTP URLs and GitHub path traversal before fetch and enforces redirect: error", async () => {
  const stub = `data:text/javascript,${encodeURIComponent(
    `globalThis.fetch = async (url, options) => {
      throw new Error("FETCH_CALLED:" + url + "|redirect=" + options?.redirect);
    };`,
  )}`;

  for (const [badUrl, expectedMessage] of [
    ["http://example.com/grammar.json", /Grammar URL must use https:/],
    ["HTTP://example.com/grammar.json", /Grammar URL must use https:/],
    ["http://127.0.0.1:8080/grammar.json", /Grammar URL must use https:/],
    ["http://localhost:8080/grammar.json", /Grammar URL must use https:/],
    ["http://[::1]:8080/grammar.json", /Grammar URL must use https:/],
    ["http://localhost.evil.test/grammar.json", /Grammar URL must use https:/],
    ["https://user:pass@example.com/grammar.json", /Invalid grammar URL/],
    ["https://example.com/grammars\\a.json", /Invalid grammar URL/],
    ["https:/grammars/example.json", /Invalid grammar URL/],
    ["https:///grammars/example.json", /Invalid grammar URL/],
  ]) {
    await assert.rejects(
      run(process.execPath, [
        "--import",
        stub,
        grammarCli,
        "grammar",
        "fetch",
        badUrl,
        "--name",
        "ext-test",
      ]),
      (error) =>
        error.code !== 0 &&
        expectedMessage.test(error.stderr) &&
        !error.stderr.includes("FETCH_CALLED:"),
      `expected grammar fetch to reject ${badUrl} before fetch`,
    );
  }

  for (const badGitHub of [
    `github:owner/repo@${COMMIT}//grammar.json`,
    `github:owner/repo@${COMMIT}/grammars/a.json/`,
    `github:owner/repo@${COMMIT}/grammars//a.json`,
    `github:owner/repo@${COMMIT}/./grammar.json`,
    `github:owner/repo@${COMMIT}/grammars/./a.json`,
    `github:owner/repo@${COMMIT}/../grammar.json`,
    `github:owner/repo@${COMMIT}/grammars/../a.json`,
    `github:owner/repo@${COMMIT}/%2e%2e/a.json`,
    `github:owner/repo@${COMMIT}/a%2fb.json`,
    `github:owner/repo@${COMMIT}/a%5cb.json`,
    `github:owner/repo@${COMMIT}/grammar.json?raw=1`,
    `github:owner/repo@${COMMIT}/grammar.json#frag`,
    `github:owner/repo@${COMMIT}/grammars\\a.json`,
    `github:../repo@${COMMIT}/grammar.json`,
    `github:owner/..@${COMMIT}/grammar.json`,
  ]) {
    await assert.rejects(
      run(process.execPath, [
        "--import",
        stub,
        grammarCli,
        "grammar",
        "fetch",
        badGitHub,
        "--name",
        "ext-test",
      ]),
      (error) =>
        error.code !== 0 &&
        /Invalid GitHub/.test(error.stderr) &&
        !error.stderr.includes("FETCH_CALLED:"),
      `expected grammar fetch to reject ${badGitHub} before fetch`,
    );
  }

  await assert.rejects(
    run(process.execPath, [
      "--import",
      stub,
      grammarCli,
      "grammar",
      "fetch",
      "https://example.test/grammar.json",
      "--name",
      "ext-test",
    ]),
    /FETCH_CALLED:https:\/\/example\.test\/grammar\.json\|redirect=error/,
    "grammar fetch must pass redirect: error for HTTPS URLs",
  );
  await assert.rejects(
    run(process.execPath, [
      "--import",
      stub,
      grammarCli,
      "grammar",
      "fetch",
      "https://grammar.example?ref=team@v1",
      "--name",
      "ext-test",
    ]),
    /FETCH_CALLED:https:\/\/grammar\.example\?ref=team@v1\|redirect=error/,
    "grammar fetch must allow @ in query strings outside the authority",
  );
  await assert.rejects(
    run(process.execPath, [
      "--import",
      stub,
      grammarCli,
      "grammar",
      "fetch",
      `github:owner/repo@${COMMIT}/grammars/lang.tmLanguage.json`,
      "--name",
      "ext-test",
    ]),
    new RegExp(
      `FETCH_CALLED:https://raw\\.githubusercontent\\.com/owner/repo/${COMMIT}/grammars/lang\\.tmLanguage\\.json\\|redirect=error`,
    ),
    "grammar fetch must rewrite valid GitHub paths and pass redirect: error",
  );
  await assert.rejects(
    run(process.execPath, [
      "--import",
      stub,
      grammarCli,
      "grammar",
      "fetch",
      `github:owner/repo@${COMMIT}/syntaxes/My Language.tmLanguage.json`,
      "--name",
      "ext-test",
    ]),
    new RegExp(
      `FETCH_CALLED:https://raw\\.githubusercontent\\.com/owner/repo/${COMMIT}/syntaxes/My%20Language\\.tmLanguage\\.json\\|redirect=error`,
    ),
    "grammar fetch must preserve literal spaces in GitHub paths as %20",
  );

  // Local grammar files must reject oversized sparse files and non-regular files before buffering.
  const localDir = await mkdtemp(join(tmpdir(), "ferriki-grammar-local-"));
  try {
    const oversized = join(localDir, "oversized.json");
    const sparse = await open(oversized, "w");
    await sparse.truncate(8 * 1024 * 1024 + 1);
    await sparse.close();
    await assert.rejects(
      run(process.execPath, [grammarCli, "grammar", "fetch", oversized, "--name", "ext-test"]),
      /Grammar exceeds 8 MiB/,
      "oversized sparse local grammar must fail before buffering",
    );
    await assert.rejects(
      run(process.execPath, [grammarCli, "grammar", "fetch", localDir, "--name", "ext-test"]),
      /regular file/,
      "directory local grammar input must fail immediately",
    );
    if (process.platform !== "win32") {
      const fifo = join(localDir, "grammar.fifo");
      await run("mkfifo", [fifo]);
      await assert.rejects(
        run(process.execPath, [grammarCli, "grammar", "fetch", fifo, "--name", "ext-test"], {
          timeout: 5000,
        }),
        (error) => !error.killed && error.signal !== "SIGTERM" && /regular file/.test(error.stderr),
        "FIFO local grammar input must fail immediately without blocking",
      );
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
});
