import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createHighlighter,
  createHighlighterCoreSync,
  FerrikiError,
  ShikiError,
} from "../ferriki/index.mjs";
import { loadFerrikiNativeBinding } from "../ferriki/native.mjs";
import { createAssetDownloader } from "../ferriki/src/asset-download.mjs";
import { TEST_ASSET_CACHE_DIR } from "./test-asset-env.mjs";

const standardAssetRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../ferriki/assets/standard",
);

function isDisposedError(error) {
  return (
    error instanceof ShikiError &&
    error.code === "ERR_USAGE" &&
    /Shiki instance has been disposed/i.test(error.message)
  );
}

function openFdCount() {
  for (const dir of ["/dev/fd", "/proc/self/fd"]) {
    try {
      return readdirSync(dir).length;
    } catch {
      // Try next platform path.
    }
  }
  return undefined;
}

test("native FerrikiHighlighter.dispose releases NodeAssetHost and is idempotent", async () => {
  const native = loadFerrikiNativeBinding().createHighlighter({
    standardAssetRoot,
    assets: { remote: false, cacheDir: TEST_ASSET_CACHE_DIR },
  });
  assert.equal(native.loadStandardTheme("nord"), true);
  assert.equal(native.loadStandardGrammar("javascript"), "source.js");
  assert.ok(native.getLoadedLanguages().includes("javascript"));
  assert.equal(native.assetCacheDir(), TEST_ASSET_CACHE_DIR);

  native.dispose();
  assert.deepEqual(native.getLoadedLanguages(), []);
  assert.equal(native.assetCacheDir(), null);
  assert.deepEqual(await native.planAssets(["javascript"], ["nord"]), []);

  // Calling dispose() twice remains idempotent.
  native.dispose();
  assert.equal(native.assetCacheDir(), null);
});

test("createHighlighterCoreSync disposes native state when startup loads fail", () => {
  const binding = loadFerrikiNativeBinding();
  const originalCreate = binding.createHighlighter;
  let capturedNative;
  let disposeCalls = 0;
  let proto;
  let originalDispose;

  function withNativeDisposeSpy(fn) {
    capturedNative = undefined;
    disposeCalls = 0;
    binding.createHighlighter = function wrappedCreateHighlighter(...args) {
      const instance = originalCreate.apply(this, args);
      capturedNative = instance;
      proto = Object.getPrototypeOf(instance);
      if (!originalDispose) {
        originalDispose = proto.dispose;
        proto.dispose = function wrappedDispose(...disposeArgs) {
          if (this === capturedNative) disposeCalls++;
          return originalDispose.apply(this, disposeArgs);
        };
      }
      return instance;
    };
    try {
      fn();
    } finally {
      binding.createHighlighter = originalCreate;
      if (proto && originalDispose) {
        proto.dispose = originalDispose;
        originalDispose = undefined;
        proto = undefined;
      }
    }
  }

  for (const [options, expectedCode] of [
    [{ langs: ["definitely-not-a-language"] }, "ERR_UNSUPPORTED"],
    [{ langs: ["javascript"], themes: ["definitely-not-a-theme"] }, "ERR_UNSUPPORTED"],
    [{ langs: [{ name: "broken", scopeName: "source.broken", patterns: "invalid" }] }, "ERR_USAGE"],
  ]) {
    withNativeDisposeSpy(() => {
      assert.throws(
        () => createHighlighterCoreSync(options),
        (error) => error instanceof ShikiError && error.code === expectedCode,
      );
      assert.ok(
        capturedNative,
        "native highlighter should have been created before startup failed",
      );
      assert.equal(
        disposeCalls,
        1,
        "partially initialized native highlighter must be disposed exactly once on factory failure",
      );
      assert.equal(capturedNative.assetCacheDir(), null);
      assert.deepEqual(capturedNative.getLoadedLanguages(), []);
    });
  }

  const baselineFds = openFdCount();
  if (baselineFds !== undefined) {
    // Control check: verify `regexMode: "prepared"` opens sidecar FDs and
    // releases them on dispose() before asserting the failed-startup loop.
    const preparedAssets = { remote: false, cacheDir: TEST_ASSET_CACHE_DIR };
    const control = createHighlighterCoreSync({
      regexMode: "prepared",
      langs: ["javascript"],
      themes: ["nord"],
      assets: preparedAssets,
    });
    const activeFds = openFdCount();
    control.dispose();
    const afterControlDisposeFds = openFdCount();
    assert.ok(
      activeFds > baselineFds,
      `Expected regexMode: "prepared" to open sidecar FDs (before=${baselineFds}, active=${activeFds})`,
    );
    assert.ok(
      afterControlDisposeFds <= baselineFds + 2,
      `Expected control dispose() to release sidecar FDs (before=${baselineFds}, after=${afterControlDisposeFds})`,
    );

    const beforeLoopFds = openFdCount();
    for (let index = 0; index < 20; index++) {
      assert.throws(
        () =>
          createHighlighterCoreSync({
            regexMode: "prepared",
            langs: ["javascript"],
            themes: ["definitely-not-a-theme"],
            assets: preparedAssets,
          }),
        (error) => error instanceof ShikiError && error.code === "ERR_UNSUPPORTED",
      );
    }
    const afterLoopFds = openFdCount();
    // Allow minor runtime noise while catching a per-call sidecar FD leak (~7 FDs/call).
    assert.ok(
      afterLoopFds - beforeLoopFds < 10,
      `Expected no sidecar FD leak across failed createHighlighterCoreSync calls (before=${beforeLoopFds}, after=${afterLoopFds})`,
    );
  }
});

test("createHighlighter rejects cleanly on startup failure without leaking", async () => {
  await assert.rejects(
    createHighlighter({ langs: ["javascript"], themes: ["definitely-not-a-theme"] }),
    (error) => error instanceof ShikiError && error.code === "ERR_UNSUPPORTED",
  );
});

test("dispose clears state, stays idempotent, and enforces assertActive across all methods", async () => {
  const highlighter = createHighlighterCoreSync({
    langs: ["javascript"],
    themes: ["nord"],
    langAlias: { myjs: "javascript" },
  });

  assert.ok(highlighter.getLoadedLanguages().includes("javascript"));
  assert.ok(highlighter.getLoadedLanguages().includes("myjs"));
  assert.deepEqual(highlighter.getLoadedThemes(), ["nord"]);
  assert.equal(highlighter.resolveLangAlias("myjs"), "javascript");
  assert.equal(typeof highlighter.getRegexDiagnostics(), "object");

  highlighter.dispose();
  // Repeated dispose() and Symbol.dispose calls must stay idempotent.
  highlighter.dispose();
  highlighter[Symbol.dispose]();

  assert.throws(() => highlighter.getLoadedThemes(), isDisposedError);
  assert.throws(() => highlighter.getLoadedLanguages(), isDisposedError);
  assert.throws(() => highlighter.getRegexDiagnostics(), isDisposedError);
  assert.throws(() => highlighter.resolveLangAlias("myjs"), isDisposedError);
  assert.throws(() => highlighter.loadLanguageSync("typescript"), isDisposedError);
  assert.throws(() => highlighter.loadThemeSync("vitesse-light"), isDisposedError);
  assert.throws(
    () => highlighter.codeToHtml("const x = 1", { lang: "javascript", theme: "nord" }),
    isDisposedError,
  );
  assert.throws(
    () => highlighter.codeToHtmlWithCss("const x = 1", { lang: "javascript", theme: "nord" }),
    isDisposedError,
  );
  assert.throws(
    () => highlighter.getLastGrammarState("const x = 1", { lang: "javascript", theme: "nord" }),
    isDisposedError,
  );
  assert.throws(
    () => highlighter.getLastGrammarState("plain", { lang: "text", theme: "nord" }),
    isDisposedError,
  );

  let languageLoaderCalled = false;
  await assert.rejects(
    highlighter.loadLanguage(async () => {
      languageLoaderCalled = true;
      return [];
    }),
    isDisposedError,
  );
  assert.equal(languageLoaderCalled, false);

  let themeLoaderCalled = false;
  await assert.rejects(
    highlighter.loadTheme(async () => {
      themeLoaderCalled = true;
      return { name: "never", settings: [] };
    }),
    isDisposedError,
  );
  assert.equal(themeLoaderCalled, false);
});

test("dispose succeeds and releases native state even if a callback freezes default transformers", () => {
  const highlighter = createHighlighterCoreSync({
    langs: ["javascript"],
    themes: ["nord"],
    transformers: [
      {
        preprocess(code, options) {
          Object.freeze(options.transformers);
          return code;
        },
      },
    ],
  });

  const html = highlighter.codeToHtml("const answer = 42", {
    lang: "javascript",
    theme: "nord",
  });
  assert.ok(html.includes("const"));

  highlighter.dispose();
  assert.throws(() => highlighter.getLoadedThemes(), isDisposedError);
  assert.throws(() => highlighter.getLoadedLanguages(), isDisposedError);
});

test("dispose called inside a transformer preprocess callback throws ERR_USAGE instead of ERR_INTERNAL", () => {
  for (const run of [
    (h, transformers) =>
      h.codeToHtml("const x = 1", { lang: "javascript", theme: "nord", transformers }),
    (h, transformers) =>
      h.codeToHtmlWithCss("const x = 1", { lang: "javascript", theme: "nord", transformers }),
    (h, transformers) =>
      h.getLastGrammarState("const x = 1", { lang: "javascript", theme: "nord", transformers }),
  ]) {
    const highlighter = createHighlighterCoreSync({
      langs: ["javascript"],
      themes: ["nord"],
    });
    const disposingTransformer = {
      preprocess(code) {
        highlighter.dispose();
        return code;
      },
    };
    assert.throws(() => run(highlighter, [disposingTransformer]), isDisposedError);
  }
});

test("dispose called from an option getter throws ERR_USAGE instead of TypeError", () => {
  for (const run of [
    (h) =>
      h.codeToHtml("const x = 1", {
        lang: "javascript",
        themes: { light: "nord", dark: "nord" },
        get rootStyle() {
          h.dispose();
          return false;
        },
      }),
    (h) =>
      h.codeToHtmlWithCss("const x = 1", {
        lang: "javascript",
        themes: { light: "nord", dark: "nord" },
        get rootStyle() {
          h.dispose();
          return false;
        },
      }),
    (h) =>
      h.codeToHtml("const x = 1", {
        lang: "javascript",
        theme: "nord",
        get rootStyle() {
          h.dispose();
          return false;
        },
      }),
  ]) {
    const highlighter = createHighlighterCoreSync({
      langs: ["javascript"],
      themes: ["nord"],
    });
    assert.throws(() => run(highlighter), isDisposedError);
  }
});

test("dispose called during custom registration serialization throws ERR_USAGE instead of ERR_ASSET", () => {
  const themeHighlighter = createHighlighterCoreSync({
    langs: ["javascript"],
    themes: ["nord"],
  });
  assert.throws(
    () =>
      themeHighlighter.loadThemeSync({
        name: "disposing-theme",
        get settings() {
          themeHighlighter.dispose();
          return [];
        },
      }),
    isDisposedError,
  );

  const langHighlighter = createHighlighterCoreSync({
    langs: ["javascript"],
    themes: ["nord"],
  });
  assert.throws(
    () =>
      langHighlighter.loadLanguageSync({
        name: "disposing-lang",
        scopeName: "source.disposing",
        get patterns() {
          langHighlighter.dispose();
          return [];
        },
      }),
    isDisposedError,
  );
});

test("throwing option getter in codeToHtml preserves FerrikiError ERR_INTERNAL wrapping", () => {
  const highlighter = createHighlighterCoreSync({
    langs: ["javascript"],
    themes: ["nord"],
  });
  try {
    assert.throws(
      () =>
        highlighter.codeToHtml("const x = 1", {
          lang: "javascript",
          theme: "nord",
          get rootStyle() {
            throw new Error("getter exploded");
          },
        }),
      (error) =>
        error instanceof FerrikiError &&
        error.code === "ERR_INTERNAL" &&
        /getter exploded/.test(error.message),
    );
  } finally {
    highlighter.dispose();
  }
});

test("dispose during pending planAssets reports ERR_USAGE instead of ERR_ASSET", async () => {
  let resolvePlan;
  let disposed = false;
  let assetCacheDirCalls = 0;
  const fakeNative = {
    planAssets() {
      return new Promise((resolve) => {
        resolvePlan = resolve;
      });
    },
    assetCacheDir() {
      assetCacheDirCalls++;
      return disposed ? null : TEST_ASSET_CACHE_DIR;
    },
  };
  const download = createAssetDownloader(fakeNative, () => {
    if (disposed) throw new ShikiError("Shiki instance has been disposed", "ERR_USAGE");
  });

  const pending = download(["javascript"], []);
  disposed = true;
  resolvePlan([
    {
      path: "languages/javascript.fkasset",
      url: "https://example.test/javascript.fkasset",
      digest: "a".repeat(64),
      size: 10,
    },
  ]);

  await assert.rejects(pending, isDisposedError);
  assert.equal(assetCacheDirCalls, 0);

  // If planAssets rejects after dispose(), report ERR_USAGE rather than the asset error.
  let rejectPlan;
  let planDisposed = false;
  const failingPlanDownload = createAssetDownloader(
    {
      planAssets: () =>
        new Promise((_resolve, reject) => {
          rejectPlan = reject;
        }),
      assetCacheDir: () => TEST_ASSET_CACHE_DIR,
    },
    () => {
      if (planDisposed) throw new ShikiError("Shiki instance has been disposed", "ERR_USAGE");
    },
  );
  const pendingRejectedPlan = failingPlanDownload(["javascript"], []);
  planDisposed = true;
  rejectPlan(new Error("manifest unreadable"));
  await assert.rejects(pendingRejectedPlan, isDisposedError);

  // Active instances still surface the underlying plan error unchanged.
  const activeFailingPlan = createAssetDownloader(
    {
      planAssets: () => Promise.reject(new Error("manifest unreadable")),
      assetCacheDir: () => TEST_ASSET_CACHE_DIR,
    },
    () => {},
  );
  await assert.rejects(activeFailingPlan(["javascript"], []), /manifest unreadable/);

  // If downloadAssets rejects after dispose() runs while a fetch is pending, report ERR_USAGE.
  const previousProtected = process.env.FERRIKI_ASSETS_PROTECTED;
  delete process.env.FERRIKI_ASSETS_PROTECTED;
  const originalFetch = globalThis.fetch;
  let rejectFetch;
  let resolveFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  let fetchDisposed = false;
  const fetchCache = mkdtempSync(join(tmpdir(), "ferriki-dispose-fetch-"));
  globalThis.fetch = () =>
    new Promise((_resolve, reject) => {
      rejectFetch = reject;
      resolveFetchStarted();
    });
  try {
    const failingDownload = createAssetDownloader(
      {
        planAssets: async () => [
          {
            path: "languages/javascript.fkasset",
            url: "https://example.test/javascript.fkasset",
            digest: "b".repeat(64),
            size: 10,
          },
        ],
        assetCacheDir: () => fetchCache,
      },
      () => {
        if (fetchDisposed) throw new ShikiError("Shiki instance has been disposed", "ERR_USAGE");
      },
    );
    const pendingDownload = failingDownload(["javascript"], []);
    await fetchStarted;
    fetchDisposed = true;
    rejectFetch(new Error("network failed"));
    await assert.rejects(pendingDownload, isDisposedError);
  } finally {
    if (previousProtected === undefined) delete process.env.FERRIKI_ASSETS_PROTECTED;
    else process.env.FERRIKI_ASSETS_PROTECTED = previousProtected;
    globalThis.fetch = originalFetch;
    rmSync(fetchCache, { recursive: true, force: true });
  }

  // Also verify against a real highlighter instance by synchronizing on native.planAssets entry.
  const emptyCache = mkdtempSync(join(tmpdir(), "ferriki-dispose-plan-"));
  const binding = loadFerrikiNativeBinding();
  const originalCreate = binding.createHighlighter;
  let capturedNative;
  let proto;
  let originalPlanAssets;
  let resolvePlanStarted;
  const planStarted = new Promise((resolve) => {
    resolvePlanStarted = resolve;
  });
  let releasePlan;
  const planGate = new Promise((resolve) => {
    releasePlan = resolve;
  });

  binding.createHighlighter = function wrappedCreateHighlighter(...args) {
    const instance = originalCreate.apply(this, args);
    capturedNative = instance;
    proto = Object.getPrototypeOf(instance);
    if (!originalPlanAssets) {
      originalPlanAssets = proto.planAssets;
      proto.planAssets = async function wrappedPlanAssets(...planArgs) {
        if (this !== capturedNative) return originalPlanAssets.apply(this, planArgs);
        const realPlanPromise = originalPlanAssets.apply(this, planArgs);
        resolvePlanStarted();
        await planGate;
        return realPlanPromise;
      };
    }
    return instance;
  };
  try {
    const highlighter = createHighlighterCoreSync({
      assets: { remote: true, cacheDir: emptyCache },
    });
    const loading = highlighter.loadLanguage("javascript");
    await planStarted;
    highlighter.dispose();
    releasePlan();
    await assert.rejects(loading, isDisposedError);
  } finally {
    binding.createHighlighter = originalCreate;
    if (proto && originalPlanAssets) proto.planAssets = originalPlanAssets;
    rmSync(emptyCache, { recursive: true, force: true });
  }
});

test("dispose called from a theme registration name getter in prepareOptions throws ERR_USAGE before native resolveGrammarScope", () => {
  const highlighter = createHighlighterCoreSync({
    langs: ["javascript"],
    themes: ["nord"],
  });
  let nameReads = 0;
  const disposingTheme = {
    get name() {
      nameReads++;
      // Read 1: registrationName() in loadThemeSync; Read 2: JSON.stringify in loadThemeSync;
      // Read 3: registrationName(prepared.theme) in prepareOptions (right before resolveGrammarScope).
      if (nameReads >= 3) highlighter.dispose();
      return "custom-dispose-on-prepare";
    },
    settings: [{ settings: { foreground: "#ffffff", background: "#000000" } }],
  };
  assert.throws(
    () => highlighter.codeToHtml("const x = 1", { lang: "javascript", theme: disposingTheme }),
    isDisposedError,
  );
  assert.ok(nameReads >= 3);
});
