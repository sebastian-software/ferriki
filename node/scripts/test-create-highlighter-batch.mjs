import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const planCalls = [];
const loadOrder = [];
const evictCalls = [];
let planHandler = null;
let planError = null;
let loadGrammarError = null;
let planEntries = [];
let planCacheDir = "/tmp/ferriki-mock-cache";
let disposedCount = 0;
let unreadyStandardLanguages = new Set();

globalThis.__ferrikiBatchTestBinding = {
  ferrikiVersion: () => "0.0.0-test",
  createHighlighter() {
    const loadedScopes = new Set();
    const loadedLangIds = new Set();
    return {
      async planAssets(languages, themes) {
        planCalls.push({ languages: [...languages], themes: [...themes] });
        if (planHandler) return planHandler(languages, themes);
        if (planError) throw planError;
        return planEntries;
      },
      assetCacheDir: () => planCacheDir,
      isStandardLanguageReady(lang) {
        return loadedLangIds.has(lang) && !unreadyStandardLanguages.has(lang);
      },
      evictVerifiedAssets(languages, themes) {
        evictCalls.push({ languages: [...languages], themes: [...themes] });
      },
      loadStandardGrammar(lang) {
        loadOrder.push(`lang:${lang}`);
        if (loadGrammarError) throw loadGrammarError;
        if (lang === "typescript" || lang === "ts" || lang === "source.ts") {
          loadedScopes.add("source.ts");
          loadedLangIds.add("typescript");
          return "source.ts";
        }
        if (lang === "json" || lang === "source.json") {
          loadedScopes.add("source.json");
          loadedLangIds.add("json");
          return "source.json";
        }
        if (lang === "vue" || lang === "source.vue") {
          loadedScopes.add("source.vue");
          loadedLangIds.add("vue");
          return "source.vue";
        }
        if (loadedScopes.has(lang)) return lang;
        return null;
      },
      loadCustomGrammar(json) {
        const parsed = JSON.parse(json);
        if (parsed.patterns?.some((rule) => typeof rule?.match === "number")) {
          throw new Error("Failed to parse custom language registration: invalid pattern match");
        }
        loadOrder.push(`custom-lang:${parsed.name}`);
        loadedScopes.add(parsed.scopeName);
        loadedLangIds.add(parsed.name);
        return parsed.scopeName;
      },
      loadStandardTheme(theme) {
        loadOrder.push(`theme:${theme}`);
        return theme === "nord" || theme === "vitesse-light";
      },
      loadCustomTheme(json) {
        const parsed = JSON.parse(json);
        loadOrder.push(`custom-theme:${parsed.name}`);
        return true;
      },
      getLoadedGrammarScopes: () => [...loadedScopes],
      getLoadedLanguages: () => [...loadedLangIds],
      getRegexDiagnosticsJson: () => "{}",
      dispose() {
        disposedCount += 1;
      },
    };
  },
};

const loaderHookSource = `
const mockCatalogSource = ${JSON.stringify(`
export const languageCatalog = [
  { id: "typescript", scopeName: "source.ts", aliases: ["ts"], embeddedLangs: [], embeddedLangsLazy: [], injectTo: [] },
  { id: "json", scopeName: "source.json", aliases: [], embeddedLangs: [], embeddedLangsLazy: [], injectTo: [] },
  { id: "vue", scopeName: "source.vue", aliases: [], embeddedLangs: ["typescript"], embeddedLangsLazy: [], injectTo: [] },
];
export const themeCatalog = [
  { id: "nord", themeType: "dark" },
  { id: "vitesse-light", themeType: "light" },
];
`)};

const mockNativeSource = ${JSON.stringify(`
export function loadFerrikiNativeBinding() {
  return globalThis.__ferrikiBatchTestBinding;
}
export function tryLoadFerrikiNativeBinding() {
  return globalThis.__ferrikiBatchTestBinding;
}
`)};

const mockFsPromisesSource = ${JSON.stringify(`
import * as realFsPromises from "node:fs/promises";
export * from "node:fs/promises";
export async function rename(oldPath, newPath) {
  if (globalThis.__ferrikiBatchTestRenameHook) {
    return globalThis.__ferrikiBatchTestRenameHook(realFsPromises.rename, oldPath, newPath);
  }
  return realFsPromises.rename(oldPath, newPath);
}
`)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("assets/standard/catalog.mjs")) {
    return { url: "ferriki-test://catalog.mjs", shortCircuit: true };
  }
  if (specifier.endsWith("/native.mjs") || specifier === "../native.mjs") {
    return { url: "ferriki-test://native.mjs", shortCircuit: true };
  }
  if (specifier === "node:fs/promises" && context.parentURL?.endsWith("/asset-download.mjs")) {
    return { url: "ferriki-test://fs-promises.mjs", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === "ferriki-test://catalog.mjs") {
    return { format: "module", source: mockCatalogSource, shortCircuit: true };
  }
  if (url === "ferriki-test://native.mjs") {
    return { format: "module", source: mockNativeSource, shortCircuit: true };
  }
  if (url === "ferriki-test://fs-promises.mjs") {
    return { format: "module", source: mockFsPromisesSource, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

register(`data:text/javascript;base64,${Buffer.from(loaderHookSource).toString("base64")}`);

const {
  bundledLanguages,
  bundledThemes,
  createHighlighter,
  getSingletonHighlighter,
  ShikiError,
  FerrikiError,
} = await import("../ferriki/src/index.mjs");

function waitWithAbort(gate, signal) {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    gate.then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function resetTracking() {
  process.env.FERRIKI_ASSETS_PROTECTED = "0";
  globalThis.__ferrikiBatchTestRenameHook = null;
  planCalls.length = 0;
  loadOrder.length = 0;
  evictCalls.length = 0;
  planHandler = null;
  planError = null;
  loadGrammarError = null;
  planEntries = [];
  planCacheDir = "/tmp/ferriki-mock-cache";
  disposedCount = 0;
  unreadyStandardLanguages = new Set();
}

test("createHighlighter prefetches languages and themes in a single batched planAssets call", async () => {
  resetTracking();
  const highlighter = await createHighlighter({
    langs: ["ts", "json"],
    themes: ["nord", "vitesse-light"],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["ts", "json"], themes: ["nord", "vitesse-light"] }]);
    assert.deepEqual(loadOrder, ["lang:ts", "lang:json", "theme:nord", "theme:vitesse-light"]);
    assert.equal(
      Object.keys(highlighter).some((key) => key.toLowerCase().includes("batch")),
      false,
      "internal batch helper must remain a private symbol, not an enumerable method",
    );

    // Warm repeated loads of already-loaded languages (including alias/canonical)
    // and themes skip planAssets completely.
    planCalls.length = 0;
    await highlighter.loadLanguage("typescript", "ts", "json");
    await highlighter.loadTheme("nord", "vitesse-light");
    assert.equal(planCalls.length, 0, "already-loaded assets must not re-run planAssets");
  } finally {
    highlighter.dispose();
  }
});

test("createHighlighter preserves language-before-theme error precedence and disposes on failure", async () => {
  resetTracking();
  planError = new Error("offline cache miss");
  await assert.rejects(
    createHighlighter({ langs: ["nonexistent-language"], themes: ["nord"] }),
    (error) => {
      assert(error instanceof ShikiError);
      assert.equal(error.code, "ERR_UNSUPPORTED");
      assert.match(error.message, /nonexistent-language/);
      return true;
    },
  );
  assert.equal(planCalls.length, 0, "unknown language error must precede theme prefetch");
  assert.equal(disposedCount, 1);

  resetTracking();
  planError = new Error("offline cache miss");
  await assert.rejects(
    createHighlighter({
      langs: [{ name: "broken", scopeName: "source.broken", patterns: "not-an-array" }],
      themes: ["nord"],
    }),
    (error) => {
      assert(error instanceof ShikiError);
      assert.equal(error.code, "ERR_USAGE");
      return true;
    },
  );
  assert.equal(planCalls.length, 0, "invalid language registration must precede theme prefetch");
  assert.equal(disposedCount, 1);

  resetTracking();
  planError = new Error("network failure");
  await assert.rejects(createHighlighter({ langs: ["typescript"], themes: ["nord"] }), (error) => {
    assert(error instanceof FerrikiError);
    assert.equal(error.code, "ERR_ASSET");
    return true;
  });
  assert.deepEqual(planCalls, [
    { languages: ["typescript"], themes: ["nord"] },
    { languages: ["typescript"], themes: [] },
  ]);
  assert.equal(disposedCount, 1);
});

test("createHighlighter prefers required language download errors over earlier theme failures", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-batch-error-order-"));
  const previousFetch = globalThis.fetch;
  const tsDigest = createHash("sha256").update("typescript-grammar").digest("hex");
  const themeDigest = createHash("sha256").update("nord-theme").digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: tsDigest,
      size: 18,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: 10,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  const failureOrder = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes("/themes/nord/")) {
      // Theme fails immediately with permanent 404.
      failureOrder.push("theme");
      return new Response(null, { status: 404 });
    }
    // Language fails later with permanent 403.
    await delay(40);
    failureOrder.push("language");
    return new Response(null, { status: 403 });
  };
  try {
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(
          error.message,
          /typescript\/12345678.*HTTP 403/,
          "required language download failure must beat an earlier theme download failure",
        );
        return true;
      },
    );
    assert.deepEqual(
      failureOrder,
      ["theme", "language"],
      "theme request must fail before language request to verify language error precedence",
    );
    assert.equal(disposedCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("getSingletonHighlighter avoids redundant initial prefetch and preserves loaded languages if a follow-up theme fails", async () => {
  resetTracking();
  const first = await getSingletonHighlighter({ langs: ["typescript"], themes: ["nord"] });
  try {
    assert.deepEqual(planCalls, [{ languages: ["typescript"], themes: ["nord"] }]);
    planCalls.length = 0;

    // Follow-up load on an existing singleton loads languages before themes.
    const second = await getSingletonHighlighter({ langs: ["json"], themes: ["vitesse-light"] });
    assert.equal(second, first);
    assert.deepEqual(planCalls, [
      { languages: ["json"], themes: [] },
      { languages: [], themes: ["vitesse-light"] },
    ]);
    planCalls.length = 0;

    // Warm follow-up for already-loaded language + theme skips planAssets.
    await getSingletonHighlighter({ langs: ["ts"], themes: ["nord"] });
    assert.equal(planCalls.length, 0);
  } finally {
    first.dispose();
  }

  // Lazy theme loader observes newly loaded languages, and a failing theme
  // request leaves the newly requested language loaded on the singleton.
  resetTracking();
  const base = await getSingletonHighlighter({ langs: ["typescript"], themes: ["nord"] });
  try {
    let seenLanguages = [];
    await assert.rejects(
      getSingletonHighlighter({
        langs: ["json"],
        themes: [
          () => {
            seenLanguages = base.getLoadedLanguages();
            return "missing-theme";
          },
        ],
      }),
      (error) => {
        assert(error instanceof ShikiError);
        assert.equal(error.code, "ERR_UNSUPPORTED");
        return true;
      },
    );
    assert(
      seenLanguages.includes("json"),
      `lazy theme loader must see newly loaded languages, saw: ${JSON.stringify(seenLanguages)}`,
    );
    assert(
      base.getLoadedLanguages().includes("json"),
      "existing singleton must keep newly loaded language even when theme load fails",
    );
  } finally {
    base.dispose();
  }
});

test("createHighlighter recursively resolves nested lazy registrations before batching", async () => {
  resetTracking();
  const highlighter = await createHighlighter({
    langs: [() => bundledLanguages.json],
    themes: [() => bundledThemes.nord],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }

  resetTracking();
  const cyclic = () => cyclic;
  await assert.rejects(createHighlighter({ langs: [cyclic], themes: ["nord"] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
  assert.equal(planCalls.length, 0);
  assert.equal(disposedCount, 1);
});

test("createHighlighter allows custom grammar scopeName referenced later in the same batch", async () => {
  resetTracking();
  const highlighter = await createHighlighter({
    langs: [{ name: "demo", scopeName: "source.demo", patterns: [] }, "source.demo"],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(loadOrder, ["custom-lang:demo", "lang:source.demo", "theme:nord"]);
    assert.deepEqual(planCalls, [{ languages: [], themes: ["nord"] }]);
  } finally {
    highlighter.dispose();
  }
});

test("createHighlighter reports native custom-grammar errors before prefetching uncached themes", async () => {
  resetTracking();
  planError = new Error("offline cache miss for nord");
  await assert.rejects(
    createHighlighter({
      langs: [{ name: "bad-native", scopeName: "source.bad", patterns: [{ match: 5 }] }],
      themes: ["nord"],
    }),
    (error) => {
      assert(error instanceof ShikiError);
      assert.equal(error.code, "ERR_ASSET");
      assert.match(error.message, /invalid custom language|Failed to parse custom language/i);
      return true;
    },
  );
  assert.equal(planCalls.length, 0, "native custom-grammar validation must precede theme prefetch");
  assert.equal(disposedCount, 1);
});

test("custom language aliased to a standard ID does not suppress standard grammar prefetch", async () => {
  resetTracking();
  const highlighter = await createHighlighter({
    langAlias: { demo: "json" },
    langs: [{ name: "demo", scopeName: "source.demo", patterns: [] }],
    themes: ["nord"],
  });
  try {
    planCalls.length = 0;
    await highlighter.loadLanguage("json");
    assert.deepEqual(
      planCalls,
      [{ languages: ["json"], themes: [] }],
      "loading a custom grammar with an alias to a standard ID must not skip prefetching the standard grammar",
    );
  } finally {
    highlighter.dispose();
  }
});

test("failed optional sidecar download is retried on explicit language reload", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-sidecar-retry-"));
  const previousFetch = globalThis.fetch;
  const sidecarBody = Buffer.from("sidecar-bytes");
  const sidecarDigest = createHash("sha256").update(sidecarBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/json.fkbc",
      digest: sidecarDigest,
      size: sidecarBody.length,
      url: "https://mirror.example/json/12345678",
    },
  ];
  let failSidecar = true;
  globalThis.fetch = async () => {
    if (failSidecar) return new Response(null, { status: 404 });
    return new Response(sidecarBody, { status: 200 });
  };
  try {
    const highlighter = await createHighlighter({ langs: ["json"], themes: ["nord"] });
    try {
      assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
      planCalls.length = 0;

      // Explicit reload retries planning/downloading because json's .fkbc failed.
      failSidecar = false;
      await highlighter.loadLanguage("json");
      assert.deepEqual(
        planCalls,
        [{ languages: ["json"], themes: [] }],
        "explicit loadLanguage must retry after a failed optional sidecar download",
      );
      planCalls.length = 0;
      planEntries = [];

      // Once sidecar download succeeds, subsequent reloads skip planAssets.
      await highlighter.loadLanguage("json");
      assert.equal(planCalls.length, 0);
    } finally {
      highlighter.dispose();
    }
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("mixed standard and unknown languages fall back to language-first ERR_ASSET when offline", async () => {
  resetTracking();
  planError = new Error(
    "Asset languages/json.fkgram is not cached and remote assets are turned off.",
  );
  await assert.rejects(
    createHighlighter({
      langs: ["json", "unknown-language"],
      themes: ["nord"],
    }),
    (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      assert.match(error.message, /languages\/json\.fkgram/);
      return true;
    },
  );
  assert.deepEqual(
    planCalls,
    [{ languages: ["json"], themes: [] }],
    "mixed known+unknown languages must fall back to language-first prefetch before themes",
  );
  assert.equal(disposedCount, 1);
});

test("root language reload retries when an embedded dependency sidecar previously failed", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-embedded-sidecar-retry-"));
  const previousFetch = globalThis.fetch;
  const sidecarBody = Buffer.from("ts-sidecar");
  const sidecarDigest = createHash("sha256").update(sidecarBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkbc",
      digest: sidecarDigest,
      size: sidecarBody.length,
      url: "https://mirror.example/typescript/12345678",
    },
  ];
  let failSidecar = true;
  globalThis.fetch = async () => {
    if (failSidecar) return new Response(null, { status: 404 });
    return new Response(sidecarBody, { status: 200 });
  };
  try {
    const highlighter = await createHighlighter({ langs: ["vue"], themes: ["nord"] });
    try {
      assert.deepEqual(planCalls, [{ languages: ["vue"], themes: ["nord"] }]);
      planCalls.length = 0;

      // Embedded typescript.fkbc failed during vue load; reloading vue retries planning.
      failSidecar = false;
      await highlighter.loadLanguage("vue");
      assert.deepEqual(
        planCalls,
        [{ languages: ["vue"], themes: [] }],
        "reloading a root language must retry after an embedded dependency sidecar failed",
      );
      planCalls.length = 0;
      planEntries = [];

      // Once clean, reloading vue skips planAssets.
      await highlighter.loadLanguage("vue");
      assert.equal(planCalls.length, 0);
    } finally {
      highlighter.dispose();
    }
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw scope-name requests stay on the language-first path before theme prefetch", async () => {
  resetTracking();
  planError = new Error(
    "Asset themes/nord.fktheme is not cached and remote assets are turned off.",
  );
  loadGrammarError = new Error("Asset languages/typescript.fkgram is not cached.");
  await assert.rejects(createHighlighter({ langs: ["source.ts"], themes: ["nord"] }), (error) => {
    assert(error instanceof FerrikiError);
    assert.equal(error.code, "ERR_ASSET");
    assert.match(
      error.message,
      /languages\/typescript\.fkgram/,
      "scope-name language error must precede theme planning",
    );
    return true;
  });
  assert.equal(planCalls.length, 0, "theme planning must not run before scope-name language load");
  assert.equal(disposedCount, 1);
});

test("failed asset download evicts staged verified payloads on a live highlighter", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-evict-on-fail-"));
  const previousFetch = globalThis.fetch;
  const dummyDigest = createHash("sha256").update("placeholder").digest("hex");
  const highlighter = await createHighlighter({ langs: [], themes: [] });
  try {
    planCalls.length = 0;
    evictCalls.length = 0;
    planCacheDir = dir;
    planEntries = [
      {
        path: "languages/json.fkgram",
        digest: dummyDigest,
        size: 11,
        url: "https://mirror.example/json/12345678",
      },
    ];
    globalThis.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(highlighter.loadLanguage("typescript", "json"), (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      return true;
    });
    assert.deepEqual(evictCalls, [{ languages: ["typescript", "json"], themes: [] }]);
  } finally {
    globalThis.fetch = previousFetch;
    highlighter.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("async loadLanguage retries planning after a sync or fallback load left sidecar unready", async () => {
  resetTracking();
  const highlighter = await createHighlighter({ langs: [], themes: [] });
  try {
    // Simulate loadLanguageSync (or corrupt decoded sidecar fallback) where the
    // grammar registered but native sidecar readiness is still false.
    unreadyStandardLanguages.add("json");
    highlighter.loadLanguageSync("json");
    planCalls.length = 0;

    await highlighter.loadLanguage("json");
    assert.deepEqual(
      planCalls,
      [{ languages: ["json"], themes: [] }],
      "async loadLanguage must plan again when native reports sidecar not ready",
    );

    // Once native reports the sidecar attached, subsequent calls skip planAssets.
    unreadyStandardLanguages.delete("json");
    planCalls.length = 0;
    await highlighter.loadLanguage("json");
    assert.equal(planCalls.length, 0);
  } finally {
    highlighter.dispose();
  }
});

test("registration failure evicts unconsumed staged payloads without disrupting overlapping calls", async () => {
  resetTracking();
  const highlighter = await createHighlighter({ langs: [], themes: [] });
  try {
    // Standalone registration failure after prefetch succeeds evicts staged nord.
    evictCalls.length = 0;
    await assert.rejects(highlighter.loadTheme("missing-theme", "nord"), (error) => {
      assert(error instanceof ShikiError);
      assert.equal(error.code, "ERR_UNSUPPORTED");
      return true;
    });
    assert.deepEqual(evictCalls, [{ languages: [], themes: ["nord"] }]);

    // Overlapping concurrent call for nord prevents the failing call from evicting nord.
    evictCalls.length = 0;
    let releaseSecondPlan;
    const secondPlanGate = new Promise((resolve) => {
      releaseSecondPlan = resolve;
    });
    let calls = 0;
    planHandler = async () => {
      calls += 1;
      if (calls === 1) return [];
      await secondPlanGate;
      return [];
    };
    const failing = highlighter.loadTheme("missing-theme", "nord");
    const succeeding = highlighter.loadTheme("nord");
    await assert.rejects(failing, (error) => error instanceof ShikiError);
    assert.equal(
      evictCalls.length,
      0,
      "failing call must not evict nord while an overlapping loadTheme still needs it",
    );
    releaseSecondPlan();
    await succeeding;
    assert.deepEqual(
      evictCalls,
      [{ languages: [], themes: ["nord"] }],
      "succeeding load releases any unconsumed staged payloads once its refcount hits zero",
    );
  } finally {
    highlighter.dispose();
  }
});

test("required grammar download failures reject without waiting for slow theme downloads", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-fast-fail-lang-"));
  const previousFetch = globalThis.fetch;
  const dummyDigest = createHash("sha256").update("placeholder").digest("hex");
  const themeDigest = createHash("sha256").update("slow-theme-body").digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: dummyDigest,
      size: 11,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: 15,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  let releaseThemeFetch;
  const themeGate = new Promise((resolve) => {
    releaseThemeFetch = resolve;
  });
  let themeSettled = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/themes/nord/")) {
      await waitWithAbort(themeGate, init?.signal);
      themeSettled = true;
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 403 });
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(error.message, /typescript\/12345678.*HTTP 403/);
        return true;
      },
    );
    assert.equal(
      themeSettled,
      false,
      "caller must receive required grammar failure without waiting for the stalled theme fetch",
    );
    assert.equal(disposedCount, 1);

    releaseThemeFetch();
    await delay(20);
    assert.equal(unhandled.length, 0, "abandoned theme abort must not trigger unhandledRejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("successful loads release unconsumed staged payloads on completion", async () => {
  resetTracking();
  const highlighter = await createHighlighter({ langs: [], themes: [] });
  try {
    evictCalls.length = 0;
    // Loading `"none"` prefetches backing theme `"nord"` without registering `"nord"`.
    await highlighter.loadTheme("none");
    assert.deepEqual(evictCalls, [{ languages: [], themes: ["nord"] }]);

    // Loading a custom grammar with embeddedLangs stages `"json"` without calling loadStandardGrammar("json").
    evictCalls.length = 0;
    await highlighter.loadLanguage({
      name: "custom-with-json",
      scopeName: "source.custom-with-json",
      embeddedLangs: ["json"],
      patterns: [],
    });
    assert.deepEqual(evictCalls, [{ languages: ["json"], themes: [] }]);
  } finally {
    highlighter.dispose();
  }
});

test("resolveRegistrations allows deep finite wrapper chains and duplicate loaders while rejecting cycles", async () => {
  resetTracking();
  let deepLang = bundledLanguages.json;
  for (let i = 0; i < 20; i++) {
    deepLang = { default: deepLang };
  }
  let deepTheme = "nord";
  for (let i = 0; i < 20; i++) {
    deepTheme = { default: deepTheme };
  }
  const highlighter = await createHighlighter({
    langs: [deepLang, bundledLanguages.json],
    themes: [deepTheme],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }

  resetTracking();
  const cyclicDefault = {};
  cyclicDefault.default = cyclicDefault;
  await assert.rejects(createHighlighter({ langs: [cyclicDefault], themes: ["nord"] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });

  const cyclicArray = [];
  cyclicArray.push(cyclicArray);
  await assert.rejects(createHighlighter({ langs: cyclicArray, themes: ["nord"] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
});

test("combined planning failure on a theme cache error still surfaces language download failures first", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-theme-plan-err-"));
  const previousFetch = globalThis.fetch;
  const dummyDigest = createHash("sha256").update("placeholder").digest("hex");
  planCacheDir = dir;
  planHandler = async (languages, themes) => {
    if (themes.length > 0) {
      throw new Error("Cannot read asset nord from the cache: expected a regular file.");
    }
    return [
      {
        path: "languages/typescript.fkgram",
        digest: dummyDigest,
        size: 11,
        url: "https://mirror.example/typescript/12345678",
      },
    ];
  };
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(
          error.message,
          /typescript\/12345678.*HTTP 404/,
          "required language download failure must beat a theme planning failure",
        );
        return true;
      },
    );
    assert.deepEqual(planCalls, [
      { languages: ["typescript"], themes: ["nord"] },
      { languages: ["typescript"], themes: [] },
    ]);
    assert.equal(disposedCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("in-flight grammar downloads settle before rejecting so immediate retries make fresh requests", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-settle-grammars-"));
  const previousFetch = globalThis.fetch;
  const tsDigest = createHash("sha256").update("ts-grammar").digest("hex");
  const jsonBody = Buffer.from("json-grammar-body");
  const jsonDigest = createHash("sha256").update(jsonBody).digest("hex");
  const themeDigest = createHash("sha256").update("slow-theme-body").digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: tsDigest,
      size: 10,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "languages/json.fkgram",
      digest: jsonDigest,
      size: jsonBody.length,
      url: "https://mirror.example/json/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: 15,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  let releaseThemeFetch;
  const themeGate = new Promise((resolve) => {
    releaseThemeFetch = resolve;
  });
  let themeSettled = false;
  let jsonAttempts = 0;
  let firstJsonSettled = false;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/themes/nord/")) {
      await waitWithAbort(themeGate, init?.signal);
      themeSettled = true;
      return new Response(null, { status: 404 });
    }
    if (target.includes("/json/")) {
      jsonAttempts += 1;
      if (jsonAttempts === 1) {
        await delay(25);
        firstJsonSettled = true;
        return new Response(null, { status: 404 });
      }
      return new Response(jsonBody, { status: 200 });
    }
    return new Response(null, { status: 403 });
  };
  try {
    await assert.rejects(
      createHighlighter({ langs: ["typescript", "json"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(error.message, /typescript\/12345678.*HTTP 403/);
        return true;
      },
    );
    assert.equal(
      firstJsonSettled,
      true,
      "all in-flight grammar downloads must settle before rejecting",
    );
    assert.equal(
      themeSettled,
      false,
      "grammar failure must still reject without waiting on slow theme downloads",
    );

    // Immediate retry for json makes a fresh fetch instead of inheriting the old failure.
    planEntries = [
      {
        path: "languages/json.fkgram",
        digest: jsonDigest,
        size: jsonBody.length,
        url: "https://mirror.example/json/12345678",
      },
    ];
    const retryHighlighter = await createHighlighter({ langs: ["json"], themes: [] });
    try {
      assert.equal(jsonAttempts, 2, "immediate retry must issue a fresh grammar fetch");
    } finally {
      retryHighlighter.dispose();
    }

    releaseThemeFetch();
    await delay(20);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRegistrations rejects objects with null or empty default fields", async () => {
  for (const invalid of [{ default: null }, { default: "" }]) {
    resetTracking();
    await assert.rejects(createHighlighter({ langs: [invalid], themes: [] }), (error) => {
      assert(error instanceof ShikiError);
      assert.equal(error.code, "ERR_USAGE");
      return true;
    });
    assert.equal(disposedCount, 1);

    resetTracking();
    await assert.rejects(createHighlighter({ langs: [], themes: [invalid] }), (error) => {
      assert(error instanceof ShikiError);
      assert.equal(error.code, "ERR_USAGE");
      return true;
    });
    assert.equal(disposedCount, 1);
  }
});

test("sidecar failure only marks affected languages for replanning, not unrelated batch peers", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-sidecar-selective-"));
  const previousFetch = globalThis.fetch;
  const tsSidecarBody = Buffer.from("ts-sidecar-bytes");
  const tsSidecarDigest = createHash("sha256").update(tsSidecarBody).digest("hex");
  const jsonSidecarBody = Buffer.from("json-sidecar-bytes");
  const jsonSidecarDigest = createHash("sha256").update(jsonSidecarBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkbc",
      digest: tsSidecarDigest,
      size: tsSidecarBody.length,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "languages/json.fkbc",
      digest: jsonSidecarDigest,
      size: jsonSidecarBody.length,
      url: "https://mirror.example/json/12345678",
    },
  ];
  globalThis.fetch = async (url) => {
    if (String(url).includes("/json/")) return new Response(null, { status: 404 });
    return new Response(tsSidecarBody, { status: 200 });
  };
  try {
    const highlighter = await createHighlighter({ langs: ["json", "typescript"], themes: [] });
    try {
      planCalls.length = 0;
      // TypeScript's sidecar succeeded; reloading it must not replan.
      await highlighter.loadLanguage("typescript");
      assert.equal(
        planCalls.length,
        0,
        "unrelated language whose sidecar succeeded must not be replanned",
      );

      // JSON's sidecar failed; reloading it still retries planning.
      planEntries = [];
      await highlighter.loadLanguage("json");
      assert.deepEqual(planCalls, [{ languages: ["json"], themes: [] }]);
    } finally {
      highlighter.dispose();
    }
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("native grammar errors take precedence when simultaneous theme prefetch fails", async () => {
  // Case 1: theme download fails (404) while cached grammar fails native registration.
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-native-lang-over-theme-"));
  const previousFetch = globalThis.fetch;
  const dummyDigest = createHash("sha256").update("placeholder").digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "themes/nord.fktheme",
      digest: dummyDigest,
      size: 11,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  loadGrammarError = new Error("Corrupt grammar payload for typescript");
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(
          error.message,
          /Corrupt grammar payload for typescript/,
          "native grammar error must beat a theme download failure",
        );
        return true;
      },
    );
    assert.deepEqual(planCalls, [{ languages: ["typescript"], themes: ["nord"] }]);
    assert.equal(disposedCount, 1);

    // Case 2: combined planning fails on theme cache while cached grammar fails native registration.
    resetTracking();
    loadGrammarError = new Error("Corrupt grammar payload for typescript");
    planHandler = async (_languages, themes) => {
      if (themes.length > 0) {
        throw new Error("Cannot read asset nord from the cache: expected a regular file.");
      }
      return [];
    };
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(
          error.message,
          /Corrupt grammar payload for typescript/,
          "native grammar error must beat a theme planning failure",
        );
        return true;
      },
    );
    assert.deepEqual(planCalls, [
      { languages: ["typescript"], themes: ["nord"] },
      { languages: ["typescript"], themes: [] },
    ]);
    assert.equal(disposedCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("abandoned theme download does not poison an explicit retry", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-abandoned-theme-retry-"));
  const previousFetch = globalThis.fetch;
  const tsDigest = createHash("sha256").update("ts-grammar").digest("hex");
  const themeBody = Buffer.from("nord-theme-body");
  const themeDigest = createHash("sha256").update(themeBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: tsDigest,
      size: 10,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: themeBody.length,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  let releaseStalledTheme;
  const stalledThemeGate = new Promise((resolve) => {
    releaseStalledTheme = resolve;
  });
  let notifyThemeStarted;
  const themeStarted = new Promise((resolve) => {
    notifyThemeStarted = resolve;
  });
  let stalledThemeFinished = false;
  let themeAttempts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/themes/nord/")) {
      themeAttempts += 1;
      if (themeAttempts === 1) {
        notifyThemeStarted();
        await waitWithAbort(stalledThemeGate, init?.signal);
        stalledThemeFinished = true;
        return new Response(null, { status: 404 });
      }
      return new Response(themeBody, { status: 200 });
    }
    await themeStarted;
    return new Response(null, { status: 403 });
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(error.message, /typescript\/12345678.*HTTP 403/);
        return true;
      },
    );
    assert.equal(stalledThemeFinished, false);

    // Explicit retry for nord while the abandoned request is still stalled must
    // issue a fresh fetch instead of waiting on or inheriting the abandoned one.
    planEntries = [
      {
        path: "themes/nord.fktheme",
        digest: themeDigest,
        size: themeBody.length,
        url: "https://mirror.example/themes/nord/12345678",
      },
    ];
    const retryHighlighter = await createHighlighter({ langs: [], themes: ["nord"] });
    try {
      assert.equal(themeAttempts, 2, "explicit retry must start a fresh theme download");
      assert.equal(
        stalledThemeFinished,
        false,
        "retry must complete without waiting on the abandoned theme request",
      );
    } finally {
      retryHighlighter.dispose();
    }

    releaseStalledTheme();
    await delay(20);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRegistrations handles 4000-level nested arrays without stack overflow while catching cycles", async () => {
  resetTracking();
  let deeplyNested = "json";
  for (let i = 0; i < 4000; i++) {
    deeplyNested = [deeplyNested];
  }
  const highlighter = await createHighlighter({
    langs: [deeplyNested],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }

  resetTracking();
  const cyclicFnArray = () => [cyclicFnArray];
  await assert.rejects(createHighlighter({ langs: [cyclicFnArray], themes: ["nord"] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
});

test("abandoned theme fetch aborts when the last waiter leaves, but stays alive when shared", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-abort-abandoned-theme-"));
  const previousFetch = globalThis.fetch;
  const tsDigest = createHash("sha256").update("ts-grammar-abort").digest("hex");
  const themeBody = Buffer.from("nord-theme-abort-body");
  const themeDigest = createHash("sha256").update(themeBody).digest("hex");
  planCacheDir = dir;

  try {
    // Part 1: Sole waiter abandons theme when grammar fails -> fetch signal aborts immediately.
    let unsharedThemeSignal;
    let releaseUnsharedTheme;
    const unsharedThemeGate = new Promise((resolve) => {
      releaseUnsharedTheme = resolve;
    });
    let notifyUnsharedThemeStarted;
    const unsharedThemeStarted = new Promise((resolve) => {
      notifyUnsharedThemeStarted = resolve;
    });
    planEntries = [
      {
        path: "languages/typescript.fkgram",
        digest: tsDigest,
        size: 16,
        url: "https://mirror.example/typescript/12345678",
      },
      {
        path: "themes/nord.fktheme",
        digest: themeDigest,
        size: themeBody.length,
        url: "https://mirror.example/themes/nord/12345678",
      },
    ];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/themes/nord/")) {
        unsharedThemeSignal = init?.signal;
        notifyUnsharedThemeStarted();
        await waitWithAbort(unsharedThemeGate, init?.signal);
        return new Response(themeBody, { status: 200 });
      }
      await unsharedThemeStarted;
      return new Response(null, { status: 403 });
    };
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        return true;
      },
    );
    assert(unsharedThemeSignal, "theme fetch must receive an AbortSignal");
    assert.equal(
      unsharedThemeSignal.aborted,
      true,
      "theme fetch signal must abort once its last waiter abandons it",
    );
    releaseUnsharedTheme();
    await delay(10);

    // Part 2: Second concurrent caller shares the theme -> first caller's grammar
    // failure must NOT abort the shared theme fetch, and second caller succeeds.
    resetTracking();
    planCacheDir = dir;
    let sharedThemeSignal;
    let sharedThemeFetches = 0;
    let releaseSharedTheme;
    const sharedThemeGate = new Promise((resolve) => {
      releaseSharedTheme = resolve;
    });
    let notifySharedThemeStarted;
    const sharedThemeStarted = new Promise((resolve) => {
      notifySharedThemeStarted = resolve;
    });
    let notifyBothPlanned;
    const bothPlanned = new Promise((resolve) => {
      notifyBothPlanned = resolve;
    });
    let plannedCount = 0;
    let releaseGrammarFail;
    const grammarFailGate = new Promise((resolve) => {
      releaseGrammarFail = resolve;
    });
    planHandler = async (languages, themes) => {
      const entries = [];
      if (languages.length > 0) {
        entries.push({
          path: "languages/typescript.fkgram",
          digest: tsDigest,
          size: 16,
          url: "https://mirror.example/typescript/12345678",
        });
      }
      if (themes.length > 0) {
        entries.push({
          path: "themes/nord.fktheme",
          digest: themeDigest,
          size: themeBody.length,
          url: "https://mirror.example/themes/nord/12345678",
        });
      }
      plannedCount += 1;
      if (plannedCount === 2) notifyBothPlanned();
      return entries;
    };
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/themes/nord/")) {
        sharedThemeFetches += 1;
        sharedThemeSignal = init?.signal;
        notifySharedThemeStarted();
        await sharedThemeGate;
        if (init?.signal?.aborted) throw new Error("unexpected abort");
        return new Response(themeBody, { status: 200 });
      }
      await grammarFailGate;
      return new Response(null, { status: 403 });
    };
    const failingCaller = createHighlighter({ langs: ["typescript"], themes: ["nord"] });
    const sharingCaller = createHighlighter({ langs: [], themes: ["nord"] });
    // Synchronize until both callers have planned and joined the shared theme fetch.
    await Promise.all([sharedThemeStarted, bothPlanned]);
    await delay(5);
    releaseGrammarFail();
    await assert.rejects(failingCaller, (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      return true;
    });
    assert.equal(sharedThemeFetches, 1, "concurrent callers must share one theme fetch");
    assert.equal(
      sharedThemeSignal.aborted,
      false,
      "shared theme fetch must NOT abort while another waiter is still active",
    );
    releaseSharedTheme();
    const sharedHighlighter = await sharingCaller;
    sharedHighlighter.dispose();
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRegistrations bounds infinite fresh-closure generator loaders with ERR_USAGE", async () => {
  resetTracking();
  const again = () => () => again();
  await assert.rejects(createHighlighter({ langs: [again], themes: [] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
  assert.equal(disposedCount, 1);

  resetTracking();
  const againViaArray = () => [() => againViaArray()];
  await assert.rejects(createHighlighter({ langs: [againViaArray], themes: [] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
  assert.equal(disposedCount, 1);
});

test('loading theme "none" consumes staged backing theme once without exposing it or replanning', async () => {
  resetTracking();
  const highlighter = await createHighlighter({ langs: [], themes: ["none"] });
  try {
    assert.deepEqual(planCalls, [{ languages: [], themes: ["nord"] }]);
    assert.deepEqual(
      loadOrder,
      ["theme:nord"],
      'async "none" load must consume staged backing theme nord immediately',
    );
    assert.deepEqual(
      highlighter.getLoadedThemes(),
      ["none"],
      'backing theme nord must not leak into public getLoadedThemes() for "none"',
    );

    // Subsequent loadTheme("none") skips planning and does not reload backing nord.
    planCalls.length = 0;
    loadOrder.length = 0;
    await highlighter.loadTheme("none");
    assert.equal(planCalls.length, 0, 'warm loadTheme("none") must not replan backing theme nord');
    assert.deepEqual(loadOrder, []);
    assert.deepEqual(highlighter.getLoadedThemes(), ["none"]);

    // Explicitly loading nord later skips planning too and exposes nord publicly.
    await highlighter.loadTheme("nord");
    assert.equal(planCalls.length, 0, "already-loaded backing theme nord must not be replanned");
    assert.deepEqual(highlighter.getLoadedThemes(), ["none", "nord"]);
  } finally {
    highlighter.dispose();
  }
});

test('custom theme object named "none" does not load or require backing theme nord', async () => {
  resetTracking();
  // Fail planning if nord were ever requested from an empty offline cache.
  planError = new Error("nord is not cached and remote assets are turned off");
  const highlighter = await createHighlighter({
    langs: [],
    themes: [{ name: "none", settings: [] }],
  });
  try {
    assert.equal(planCalls.length, 0, "custom theme object must not plan backing theme nord");
    assert.deepEqual(
      loadOrder,
      [],
      'custom theme object named "none" must not load standard backing theme nord',
    );
    assert.deepEqual(highlighter.getLoadedThemes(), ["none"]);
  } finally {
    highlighter.dispose();
  }
});

test("aborted unshared streaming theme download cleans up its .tmp file before rejecting", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-tmp-cleanup-on-abort-"));
  const previousFetch = globalThis.fetch;
  const tsDigest = createHash("sha256").update("ts-grammar-tmp").digest("hex");
  const themeBody = Buffer.from("nord-streaming-theme-body");
  const themeDigest = createHash("sha256").update(themeBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: tsDigest,
      size: 14,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: themeBody.length,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  let notifyChunkWritten;
  const chunkWritten = new Promise((resolve) => {
    notifyChunkWritten = resolve;
  });
  let releaseGrammar;
  const grammarGate = new Promise((resolve) => {
    releaseGrammar = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes("/themes/nord/")) {
      const stream = new ReadableStream({
        start(controller) {
          // Emit a partial chunk so createWriteStream opens and writes a .tmp file,
          // then stay open until pipeline aborts on the abandoned signal.
          controller.enqueue(themeBody.subarray(0, 8));
          notifyChunkWritten();
        },
      });
      return new Response(stream, { status: 200 });
    }
    await grammarGate;
    return new Response(null, { status: 403 });
  };
  try {
    const pending = createHighlighter({ langs: ["typescript"], themes: ["nord"] });
    await chunkWritten;
    // Give the write stream a tick to flush the first chunk and create the .tmp file on disk.
    let tmpSeen = false;
    for (let i = 0; i < 40; i++) {
      const files = await readdir(dir);
      if (files.some((name) => name.endsWith(".tmp"))) {
        tmpSeen = true;
        break;
      }
      await delay(5);
    }
    assert.equal(tmpSeen, true, "streaming theme download must have created a .tmp file");

    releaseGrammar();
    await assert.rejects(pending, (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      assert.match(error.message, /typescript\/12345678.*HTTP 403/);
      return true;
    });

    // Immediately upon rejection, zero leftover .tmp files may remain in cacheDir.
    const remaining = await readdir(dir);
    assert.deepEqual(
      remaining.filter((name) => name.endsWith(".tmp")),
      [],
      `aborted theme download must remove its .tmp file before rejecting, found: ${JSON.stringify(remaining)}`,
    );
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("unabortable fetch wrapper on abandoned theme does not block grammar rejection", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-unabortable-fetch-"));
  const previousFetch = globalThis.fetch;
  const tsDigest = createHash("sha256").update("ts-grammar-unabortable").digest("hex");
  const themeBody = Buffer.from("nord-unabortable-theme-body");
  const themeDigest = createHash("sha256").update(themeBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: tsDigest,
      size: 22,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: themeBody.length,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  let releaseHungTheme;
  const hungThemeGate = new Promise((resolve) => {
    releaseHungTheme = resolve;
  });
  let notifyHungThemeStarted;
  const hungThemeStarted = new Promise((resolve) => {
    notifyHungThemeStarted = resolve;
  });
  let themeResolved = false;
  // Deliberately ignore `init.signal` to simulate a custom fetch wrapper that
  // hangs forever even after AbortController.abort() is called.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/themes/nord/")) {
      notifyHungThemeStarted();
      await hungThemeGate;
      themeResolved = true;
      return new Response(themeBody, { status: 200 });
    }
    await hungThemeStarted;
    return new Response(null, { status: 403 });
  };
  try {
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(error.message, /typescript\/12345678.*HTTP 403/);
        return true;
      },
    );
    assert.equal(
      themeResolved,
      false,
      "grammar rejection must not block waiting on an unabortable theme fetch()",
    );

    // Even if the hung fetch resolves later with a 200 body, the aborted check
    // prevents creating any .tmp or cached file.
    releaseHungTheme();
    await delay(20);
    assert.equal(themeResolved, true);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("overlapping loadLanguage(vue) keeps embedded typescript staged until overlapping load finishes", async () => {
  resetTracking();
  const highlighter = await createHighlighter({ langs: [], themes: [] });
  try {
    evictCalls.length = 0;
    let releaseSecondPlan;
    const secondPlanGate = new Promise((resolve) => {
      releaseSecondPlan = resolve;
    });
    let calls = 0;
    planHandler = async () => {
      calls += 1;
      if (calls === 1) return [];
      await secondPlanGate;
      return [];
    };

    // Call 1 loads vue (which embeds typescript); Call 2 overlaps loading typescript + json.
    const vueLoad = highlighter.loadLanguage("vue");
    const tsJsonLoad = highlighter.loadLanguage("typescript", "json");
    await vueLoad;
    assert.deepEqual(
      evictCalls,
      [{ languages: ["vue"], themes: [] }],
      "finishing vue must evict only vue while an overlapping call still needs embedded typescript",
    );

    releaseSecondPlan();
    await tsJsonLoad;
    assert.deepEqual(
      evictCalls,
      [
        { languages: ["vue"], themes: [] },
        { languages: ["typescript", "json"], themes: [] },
      ],
      "embedded typescript is evicted only after all overlapping callers finish",
    );
  } finally {
    highlighter.dispose();
  }
});

test("resolveRegistrations allows 70 static .default wrappers while bounding dynamic generators", async () => {
  resetTracking();
  let wrappedLang = "json";
  for (let i = 0; i < 70; i++) {
    wrappedLang = { default: wrappedLang };
  }
  const highlighter = await createHighlighter({
    langs: [wrappedLang],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("abandoned streaming theme with never-settling ReadableStream.cancel() still unlinks .tmp and rejects", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-hanging-cancel-"));
  const previousFetch = globalThis.fetch;
  const tsDigest = createHash("sha256").update("ts-grammar-hanging-cancel").digest("hex");
  const themeBody = Buffer.from("nord-hanging-cancel-body");
  const themeDigest = createHash("sha256").update(themeBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: tsDigest,
      size: 25,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: themeBody.length,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  let notifyChunkEnqueued;
  const chunkEnqueued = new Promise((resolve) => {
    notifyChunkEnqueued = resolve;
  });
  let releaseGrammar;
  const grammarGate = new Promise((resolve) => {
    releaseGrammar = resolve;
  });
  let cancelCalled = false;
  let releaseCancel;
  const cancelGate = new Promise((resolve) => {
    releaseCancel = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes("/themes/nord/")) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(themeBody.subarray(0, 8));
          notifyChunkEnqueued();
        },
        cancel() {
          cancelCalled = true;
          return cancelGate;
        },
      });
      return new Response(stream, { status: 200 });
    }
    await grammarGate;
    return new Response(null, { status: 403 });
  };
  try {
    const pending = createHighlighter({ langs: ["typescript"], themes: ["nord"] });
    await chunkEnqueued;
    let tmpSeen = false;
    for (let i = 0; i < 40; i++) {
      const files = await readdir(dir);
      if (files.some((name) => name.endsWith(".tmp"))) {
        tmpSeen = true;
        break;
      }
      await delay(5);
    }
    assert.equal(tmpSeen, true, "streaming theme download must have created a .tmp file");

    releaseGrammar();
    await assert.rejects(pending, (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      assert.match(error.message, /typescript\/12345678.*HTTP 403/);
      return true;
    });

    // Local .tmp file must already be removed even though cancel() has NOT settled.
    const remaining = await readdir(dir);
    assert.deepEqual(
      remaining.filter((name) => name.endsWith(".tmp")),
      [],
      `aborted download must unlink .tmp immediately without waiting for ReadableStream.cancel(), found: ${JSON.stringify(remaining)}`,
    );
    assert.equal(cancelCalled, true);

    releaseCancel();
    await delay(10);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRegistrations bounds hostile fresh-wrapper .default getters with ERR_USAGE", async () => {
  resetTracking();
  const makeFreshDefault = () => ({
    get default() {
      return makeFreshDefault();
    },
  });
  await assert.rejects(createHighlighter({ langs: [makeFreshDefault()], themes: [] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
  assert.equal(disposedCount, 1);
});

test("failed temporary file cleanup surfaces error and stops download retries", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-rm-tmp-error-"));
  const previousFetch = globalThis.fetch;
  const themeBody = Buffer.from("nord-rm-fail-body");
  const themeDigest = createHash("sha256").update(themeBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: themeBody.length,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  let fetchAttempts = 0;
  let streamController;
  let notifyChunkEnqueued;
  const chunkEnqueued = new Promise((resolve) => {
    notifyChunkEnqueued = resolve;
  });
  globalThis.fetch = async () => {
    fetchAttempts += 1;
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(themeBody.subarray(0, 6));
        notifyChunkEnqueued();
      },
    });
    return new Response(stream, { status: 200 });
  };
  try {
    const pending = createHighlighter({ langs: [], themes: ["nord"] });
    await chunkEnqueued;
    let tmpName;
    for (let i = 0; i < 40; i++) {
      const files = await readdir(dir);
      tmpName = files.find((name) => name.endsWith(".tmp"));
      if (tmpName) break;
      await delay(5);
    }
    assert(tmpName, "expected a .tmp file to be created");

    // Replace the .tmp file with a directory so non-recursive `rm(temporary, { force: true })`
    // deterministically fails with EISDIR (even as root), then trigger a transient stream error.
    const tmpPath = join(dir, tmpName);
    await rm(tmpPath);
    await mkdir(tmpPath);
    const transient = Object.assign(new Error("simulated reset"), { code: "ECONNRESET" });
    streamController.error(transient);

    await assert.rejects(pending, (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      assert.match(error.message, /EISDIR|EPERM|is a directory/i);
      return true;
    });
    assert.equal(
      fetchAttempts,
      1,
      "non-ENOENT temporary file cleanup error must stop retries instead of retrying",
    );
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRegistrations reads a lazy thenable's .then getter only once", async () => {
  resetTracking();
  let thenReads = 0;
  const oneShotThenable = {
    get then() {
      thenReads += 1;
      if (thenReads > 1) return undefined;
      return (resolve) => resolve("json");
    },
  };
  const highlighter = await createHighlighter({
    langs: [oneShotThenable],
    themes: ["nord"],
  });
  try {
    assert.equal(thenReads, 1, "thenable .then getter must be evaluated only once");
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("resolveRegistrations invokes thenables asynchronously and rejects self-resolving thenables", async () => {
  resetTracking();
  let thenInvoked = false;
  const asyncThenable = {
    then(resolve) {
      thenInvoked = true;
      resolve("json");
    },
  };
  const pending = createHighlighter({ langs: [asyncThenable], themes: ["nord"] });
  assert.equal(
    thenInvoked,
    false,
    "thenable.then() must execute asynchronously in a microtask, not synchronously",
  );
  const highlighter = await pending;
  try {
    assert.equal(thenInvoked, true);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }

  resetTracking();
  const selfResolving = {
    then(resolve) {
      resolve(selfResolving);
    },
  };
  await assert.rejects(createHighlighter({ langs: [selfResolving], themes: [] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
  assert.equal(disposedCount, 1);
});

test("native grammar error rejects immediately when language prefetch finishes while theme fetch is stalled", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-native-err-fast-"));
  const previousFetch = globalThis.fetch;
  const tsBody = Buffer.from("typescript-grammar-payload");
  const tsDigest = createHash("sha256").update(tsBody).digest("hex");
  const themeBody = Buffer.from("nord-stalled-theme-payload");
  const themeDigest = createHash("sha256").update(themeBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: tsDigest,
      size: tsBody.length,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: themeBody.length,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  loadGrammarError = new Error("Corrupt native grammar payload for typescript");
  let releaseStalledTheme;
  const stalledThemeGate = new Promise((resolve) => {
    releaseStalledTheme = resolve;
  });
  let notifyThemeStarted;
  const themeStarted = new Promise((resolve) => {
    notifyThemeStarted = resolve;
  });
  let themeFinished = false;
  let themeSignal;
  // Theme fetch stalls indefinitely even if signal aborts (worst-case unabortable wrapper).
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/themes/nord/")) {
      themeSignal = init?.signal;
      notifyThemeStarted();
      await stalledThemeGate;
      themeFinished = true;
      return new Response(themeBody, { status: 200 });
    }
    await themeStarted;
    return new Response(tsBody, { status: 200 });
  };
  try {
    await assert.rejects(
      createHighlighter({ langs: ["typescript"], themes: ["nord"] }),
      (error) => {
        assert(error instanceof FerrikiError);
        assert.equal(error.code, "ERR_ASSET");
        assert.match(error.message, /Corrupt native grammar payload for typescript/);
        return true;
      },
    );
    assert.equal(
      themeFinished,
      false,
      "native grammar error must reject immediately without waiting for the stalled theme fetch",
    );
    assert.equal(
      themeSignal?.aborted,
      true,
      "stalled unshared theme fetch must be aborted when native grammar registration fails",
    );
    assert.equal(disposedCount, 1);

    releaseStalledTheme();
    await delay(10);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort arriving during theme publication waits for publication to settle without racing", async () => {
  resetTracking();
  const dir = await mkdtemp(join(tmpdir(), "ferriki-abort-during-publish-"));
  const previousFetch = globalThis.fetch;
  const tsDigest = createHash("sha256").update("ts-grammar-publish-race").digest("hex");
  const themeBody = Buffer.from("nord-publish-race-verified-body");
  const themeDigest = createHash("sha256").update(themeBody).digest("hex");
  planCacheDir = dir;
  planEntries = [
    {
      path: "languages/typescript.fkgram",
      digest: tsDigest,
      size: 23,
      url: "https://mirror.example/typescript/12345678",
    },
    {
      path: "themes/nord.fktheme",
      digest: themeDigest,
      size: themeBody.length,
      url: "https://mirror.example/themes/nord/12345678",
    },
  ];
  let notifyPublishEntered;
  const publishEntered = new Promise((resolve) => {
    notifyPublishEntered = resolve;
  });
  let releasePublish;
  const publishGate = new Promise((resolve) => {
    releasePublish = resolve;
  });
  let themeSignal;
  let capturedTemporaryPath;
  globalThis.__ferrikiBatchTestRenameHook = async (realRename, oldPath, newPath) => {
    capturedTemporaryPath = oldPath;
    notifyPublishEntered();
    await publishGate;
    return realRename(oldPath, newPath);
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/themes/nord/")) {
      themeSignal = init?.signal;
      return new Response(themeBody, { status: 200 });
    }
    await publishEntered;
    return new Response(null, { status: 403 });
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    let rejectedEarly = false;
    const pending = createHighlighter({ langs: ["typescript"], themes: ["nord"] }).catch(
      (error) => {
        rejectedEarly = true;
        throw error;
      },
    );
    await publishEntered;
    // Wait a tick for the grammar 403 failure to trigger abort while publication is paused.
    await delay(15);
    assert.equal(themeSignal?.aborted, true, "theme download signal must abort on grammar failure");
    assert.equal(
      rejectedEarly,
      false,
      "caller must wait for in-progress publishTemporaryAsset to settle before rejecting",
    );
    // The detached abort handler must NOT have unlinked `temporary` while publishTemporaryAsset holds it.
    assert.deepEqual(
      await readFile(capturedTemporaryPath),
      themeBody,
      "abort during publishTemporaryAsset must not delete temporary file out from under rename",
    );

    releasePublish();
    await assert.rejects(pending, (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      assert.match(error.message, /typescript\/12345678.*HTTP 403/);
      return true;
    });
    const remaining = await readdir(dir);
    assert.deepEqual(
      remaining.filter((name) => name.endsWith(".tmp")),
      [],
      `no .tmp files may linger after rejection: ${JSON.stringify(remaining)}`,
    );
    assert.deepEqual(
      await readFile(join(dir, themeDigest)),
      themeBody,
      "in-progress publication must complete atomically with verified bytes",
    );
    assert.equal(unhandled.length, 0);
  } finally {
    globalThis.__ferrikiBatchTestRenameHook = null;
    process.off("unhandledRejection", onUnhandled);
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRegistrations bounds hostile getter-backed infinite nested arrays with ERR_USAGE", async () => {
  resetTracking();
  const makeInfiniteArray = () => {
    const arr = [];
    Object.defineProperty(arr, 0, {
      enumerable: true,
      get() {
        return makeInfiniteArray();
      },
    });
    arr.length = 1;
    return arr;
  };
  await assert.rejects(createHighlighter({ langs: [makeInfiniteArray()], themes: [] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
  assert.equal(disposedCount, 1);
});

test("resolveRegistrations evaluates getter-backed array elements strictly left-to-right", async () => {
  resetTracking();
  const accessOrder = [];
  const ordered = [];
  const items = ["json", "ts", "vue"];
  for (let i = 0; i < items.length; i++) {
    Object.defineProperty(ordered, i, {
      enumerable: true,
      get() {
        accessOrder.push(i);
        return items[i];
      },
    });
  }
  ordered.length = items.length;
  const highlighter = await createHighlighter({
    langs: [ordered],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(
      accessOrder,
      [0, 1, 2],
      "array elements must be read strictly in left-to-right index order",
    );
    assert.deepEqual(loadOrder, ["lang:json", "lang:ts", "lang:vue", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("resolveRegistrations snapshots top-level and nested caller arrays before async loaders suspend and handles shadowed .call", async () => {
  resetTracking();
  let releaseLoader;
  const loaderGate = new Promise((resolve) => {
    releaseLoader = resolve;
  });
  const shadowedThen = function (resolve) {
    loaderGate.then(() => resolve("json"));
  };
  shadowedThen.call = null;
  const nestedArray = ["typescript", ["vue"]];
  const langs = [{ then: shadowedThen }, nestedArray];
  const pending = createHighlighter({ langs, themes: ["nord"] });
  // Mutating/clearing both the top-level and nested arrays while the loader is
  // pending must not drop registrations that were synchronously present.
  langs.length = 0;
  nestedArray.length = 0;
  releaseLoader();
  const highlighter = await pending;
  try {
    assert.deepEqual(planCalls, [{ languages: ["json", "typescript", "vue"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "lang:typescript", "lang:vue", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("resolveRegistrations captures array length once and bounds huge sparse arrays", async () => {
  resetTracking();
  const selfAppending = [];
  Object.defineProperty(selfAppending, 0, {
    enumerable: true,
    get() {
      selfAppending.push("typescript");
      return "json";
    },
  });
  selfAppending.length = 1;
  const highlighter = await createHighlighter({
    langs: [selfAppending],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(
      planCalls,
      [{ languages: ["json"], themes: ["nord"] }],
      "elements appended by a getter during snapshotting must not be picked up",
    );
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }

  resetTracking();
  const hugeSparse = [];
  hugeSparse.length = 1_000_000;
  await assert.rejects(createHighlighter({ langs: [hugeSparse], themes: [] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
  assert.equal(disposedCount, 1);
});

test("resolveRegistrations enforces a single cumulative item budget across dynamic loader arrays", async () => {
  resetTracking();
  // Five loaders each returning an individually-valid 5,000-item array exceed
  // the shared 20,000-item budget and must fail cleanly with ERR_USAGE (not RangeError).
  const loaders = Array.from({ length: 5 }, () => () => Array.from({ length: 5000 }, () => "json"));
  await assert.rejects(createHighlighter({ langs: loaders, themes: [] }), (error) => {
    assert(error instanceof ShikiError);
    assert.equal(error.code, "ERR_USAGE");
    return true;
  });
  assert.equal(disposedCount, 1);
});

test("resolveRegistrations preserves native Promise semantics even when .then is overridden", async () => {
  resetTracking();
  const nullThenPromise = Promise.resolve("json");
  nullThenPromise.then = null;
  const throwingThenPromise = Promise.resolve("typescript");
  throwingThenPromise.then = () => {
    throw new Error("overridden .then must not run on native Promise");
  };
  const highlighter = await createHighlighter({
    langs: [nullThenPromise, throwingThenPromise],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["json", "typescript"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "lang:typescript", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("resolveRegistrations invokes custom .then on Promise subclasses", async () => {
  resetTracking();
  class LanguagePromise extends Promise {
    then(onFulfilled, onRejected) {
      return super.then(
        (value) => onFulfilled?.(value === "not-a-ferriki-language" ? "json" : value),
        onRejected,
      );
    }
  }
  const highlighter = await createHighlighter({
    langs: [LanguagePromise.resolve("not-a-ferriki-language")],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("throwing theme include getter still lets uncached language ERR_ASSET win first", async () => {
  resetTracking();
  const throwingTheme = {
    name: "bad-include",
    settings: [],
    get include() {
      throw new Error("theme include getter boom");
    },
  };
  planError = new Error(
    "Asset languages/json.fkgram is not cached and remote assets are turned off.",
  );
  await assert.rejects(
    createHighlighter({
      langs: ["json"],
      themes: [throwingTheme],
    }),
    (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      assert.match(error.message, /languages\/json\.fkgram/);
      return true;
    },
  );
  assert.deepEqual(planCalls, [{ languages: ["json"], themes: [] }]);
  assert.equal(disposedCount, 1);

  // When languages succeed, the theme getter error surfaces cleanly (without re-evaluating).
  resetTracking();
  let getterCalls = 0;
  const oneShotThrowingTheme = {
    name: "bad-include-once",
    settings: [],
    get include() {
      getterCalls += 1;
      throw new Error("theme include getter boom");
    },
  };
  await assert.rejects(
    createHighlighter({
      langs: ["json"],
      themes: [oneShotThrowingTheme],
    }),
    /theme include getter boom/,
  );
  assert.equal(getterCalls, 1, "throwing theme include getter must not be evaluated twice");
  assert.equal(disposedCount, 1);
});

test("resolveRegistrations awaits callable thenables returned by loaders instead of invoking them", async () => {
  resetTracking();
  const callableThenable = () => {
    throw new Error("callable thenable must be awaited via .then, not invoked as a function");
  };
  callableThenable.then = (resolve) => resolve("json");

  const highlighter = await createHighlighter({
    langs: [() => callableThenable],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("resolveRegistrations allows stateful loader functions returning [load] then a language", async () => {
  resetTracking();
  let calls = 0;
  const load = () => (++calls === 1 ? [load] : "json");

  const highlighter = await createHighlighter({
    langs: [load],
    themes: ["nord"],
  });
  try {
    assert.equal(calls, 2);
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("resolveRegistrations awaits native Promises without an extra .constructor read", async () => {
  resetTracking();
  let constructorReads = 0;
  const oneShotConstructorPromise = Promise.resolve("json");
  Object.defineProperty(oneShotConstructorPromise, "constructor", {
    configurable: true,
    get() {
      constructorReads += 1;
      if (constructorReads > 1) {
        throw new Error("Promise.constructor must not be read more than once");
      }
      return Promise;
    },
  });

  const highlighter = await createHighlighter({
    langs: [oneShotConstructorPromise],
    themes: ["nord"],
  });
  try {
    assert(constructorReads <= 1, `expected at most 1 constructor read, got ${constructorReads}`);
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});

test("throwing language name getter preserves first-read errors while speculative batch checks fall back cleanly", async () => {
  // Case A: getter succeeds during languagePrefetchNames and throws only during
  // speculative canBatchLanguagesWithThemes -> falls back to language-first planning.
  resetTracking();
  let speculativeReads = 0;
  const throwingOnSpeculativeBatchCheck = {
    get name() {
      speculativeReads += 1;
      if (speculativeReads <= 2) return "json";
      throw new Error("speculative batch check getter boom");
    },
  };
  planError = new Error(
    "Asset languages/json.fkgram is not cached and remote assets are turned off.",
  );
  await assert.rejects(
    createHighlighter({
      langs: ["json", throwingOnSpeculativeBatchCheck],
      themes: ["nord"],
    }),
    (error) => {
      assert(error instanceof FerrikiError);
      assert.equal(error.code, "ERR_ASSET");
      assert.match(error.message, /languages\/json\.fkgram/);
      return true;
    },
  );
  assert.deepEqual(planCalls, [{ languages: ["json"], themes: [] }]);
  assert.equal(disposedCount, 1);

  // Case B: getter throws on its first read (even if a second read would succeed)
  // -> languagePrefetchNames propagates the original error instead of swallowing it.
  resetTracking();
  let firstReadCalls = 0;
  const throwingOnFirstRead = {
    get name() {
      firstReadCalls += 1;
      if (firstReadCalls === 1) throw new Error("first-read name getter boom");
      return "json";
    },
  };
  await assert.rejects(
    createHighlighter({
      langs: [throwingOnFirstRead],
      themes: ["nord"],
    }),
    /first-read name getter boom/,
  );
  assert.equal(firstReadCalls, 1, "first-read name getter error must not be swallowed");
  assert.equal(planCalls.length, 0);
  assert.equal(disposedCount, 1);
});

test("circular langAlias rejects with ERR_USAGE before asset planning", async () => {
  resetTracking();
  planError = new Error(
    "Asset languages/json.fkgram is not cached and remote assets are turned off.",
  );
  await assert.rejects(
    createHighlighter({
      langAlias: { a: "b", b: "a" },
      langs: ["json", "a"],
      themes: ["nord"],
    }),
    (error) => {
      assert(error instanceof ShikiError);
      assert.equal(error.code, "ERR_USAGE");
      return true;
    },
  );
  assert.equal(
    planCalls.length,
    0,
    "circular langAlias ShikiError must propagate before asset planning",
  );
  assert.equal(disposedCount, 1);
});

test("resolveRegistrations awaits a callable thenable resolved from an outer thenable", async () => {
  resetTracking();
  const callableThenable = () => {
    throw new Error("nested callable thenable must be awaited via .then, not invoked");
  };
  callableThenable.then = (resolve) => resolve("json");

  const highlighter = await createHighlighter({
    langs: [() => ({ then: (resolve) => resolve(callableThenable) })],
    themes: ["nord"],
  });
  try {
    assert.deepEqual(planCalls, [{ languages: ["json"], themes: ["nord"] }]);
    assert.deepEqual(loadOrder, ["lang:json", "theme:nord"]);
  } finally {
    highlighter.dispose();
  }
});
