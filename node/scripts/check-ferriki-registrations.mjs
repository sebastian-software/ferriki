import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHighlighter, createHighlighterCoreSync, ShikiError } from "../ferriki/index.mjs";
import { payloadPath } from "../ferriki/scripts/asset-path.mjs";

import "./test-asset-env.mjs";

const language = {
  name: "ferriki-registration",
  scopeName: "source.ferriki-registration",
  aliases: ["freg", "js"],
  patterns: [{ match: "\\bTODO\\b", name: "keyword.todo.ferriki" }],
};
const theme = {
  name: "ferriki-registration-theme",
  type: "light",
  fg: "#111111",
  bg: "#ffffff",
  settings: [
    {
      scope: "keyword.todo.ferriki",
      settings: { foreground: "#ff00aa", fontStyle: "bold" },
    },
  ],
};
const includedTheme = {
  name: "ferriki-registration-theme-included",
  include: "nord",
  settings: [
    {
      scope: "keyword.todo.ferriki",
      settings: { foreground: "#00aaff" },
    },
  ],
};
const childLanguage = {
  name: "ferriki-registration-child",
  scopeName: "source.ferriki-registration-child",
  patterns: [{ match: "\\bCHILD\\b", name: "keyword.child" }],
};
const parentLanguage = {
  name: "ferriki-registration-parent",
  scopeName: "source.ferriki-registration-parent",
  embeddedLangs: ["ferriki-registration-child"],
  patterns: [{ include: "source.ferriki-registration-child" }],
};
const injectionLanguage = {
  name: "ferriki-registration-injection",
  scopeName: "source.ferriki-registration-injection",
  injectTo: ["source.js"],
  patterns: [{ match: "\\bINJECTED\\b", name: "keyword.injected" }],
};

const highlighter = await createHighlighter({
  langs: [language],
  themes: [theme],
});
try {
  const html = highlighter.codeToHtml("TODO", {
    lang: "freg",
    theme: "ferriki-registration-theme",
  });
  assert.match(html, /ff00aa/i);

  const direct = highlighter.codeToHtml("TODO", { lang: language, theme });
  assert.match(direct, /TODO/);
  assert.match(direct, /ff00aa/i);

  highlighter.loadThemeSync(includedTheme);
  const included = highlighter.codeToHtml("TODO", {
    lang: "ferriki-registration",
    theme: "ferriki-registration-theme-included",
  });
  assert.match(included, /00aaff/i);

  // A user alias matching a standard alias must not hide the standard
  // catalog entry, even when the custom registration is loaded first.
  await highlighter.loadLanguage("js");
  assert(highlighter.getLoadedLanguages().includes("javascript"));

  assert.throws(
    () =>
      highlighter.loadLanguageSync({
        name: "invalid-registration",
        scopeName: "source.invalid-registration",
        patterns: [],
        unsupportedField: true,
      }),
    (error) =>
      error instanceof ShikiError && /Unsupported language registration field/.test(error.message),
  );
} finally {
  highlighter.dispose();
}

const grammarHighlighter = await createHighlighter({
  langs: [parentLanguage, childLanguage, injectionLanguage, "javascript"],
  themes: ["nord"],
});
try {
  const child = grammarHighlighter.codeToHtml("CHILD", {
    lang: "ferriki-registration-parent",
    theme: "nord",
  });
  assert.match(child, /CHILD/);
  const injected = grammarHighlighter.codeToHtml("INJECTED", {
    lang: "javascript",
    theme: "nord",
  });
  assert.match(injected, /INJECTED/);
} finally {
  grammarHighlighter.dispose();
}

const asyncHighlighter = await createHighlighter({
  langs: [async () => [language]],
  themes: [async () => theme],
});
asyncHighlighter.dispose();

assert.throws(
  () => createHighlighterCoreSync({ langs: [() => language] }),
  (error) => error instanceof ShikiError && /Async language\/theme input/.test(error.message),
);

const repositoryAssetRoot = fileURLToPath(new URL("../../assets/standard/", import.meta.url));
const packageAssetRoot = fileURLToPath(new URL("../ferriki/assets/standard/", import.meta.url));
const release = JSON.parse(await readFile(join(packageAssetRoot, "release-manifest.json"), "utf8"));
const remotePaths = new Map(
  Object.entries(release.assets).map(([key, asset]) => [`/${payloadPath(key, asset)}`, key]),
);
const requests = [];
const server = createServer(async (request, response) => {
  requests.push(request.url);
  const key = remotePaths.get(request.url);
  if (!key) {
    response.writeHead(404).end();
    return;
  }
  const payload = await readFile(join(repositoryAssetRoot, key)).catch(() => undefined);
  if (!payload) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-length": payload.length }).end(payload);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const tempRoot = await mkdtemp(join(tmpdir(), "ferriki-registration-prefetch-"));

function remoteAssets(cacheDir) {
  return { remote: true, baseUrl, cacheDir };
}

function assetUrl(key) {
  return `/${payloadPath(key, release.assets[key])}`;
}

async function cacheEntries(cacheDir) {
  try {
    return await readdir(cacheDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function verifyPrefetch(name, key, create, { notRequested = [] } = {}) {
  const cacheDir = join(tempRoot, name);
  assert.deepEqual(await cacheEntries(cacheDir), [], `${name} starts with an empty cache`);
  const requestOffset = requests.length;
  const instance = await create(cacheDir);
  try {
    const prefetchRequests = requests.slice(requestOffset);
    assert(
      prefetchRequests.includes(assetUrl(key)),
      `${name} requests the uncached ${key} payload`,
    );
    for (const unusedKey of notRequested) {
      assert(
        !prefetchRequests.includes(assetUrl(unusedKey)),
        `${name} does not request the unused ${unusedKey} payload`,
      );
    }
    assert.deepEqual(
      await readFile(join(cacheDir, release.assets[key].sha256)),
      await readFile(join(repositoryAssetRoot, key)),
      `${name} caches the verified ${key} payload`,
    );
    if (key.startsWith("languages/")) {
      const beforeSyncLoad = requests.length;
      instance.loadLanguageSync("javascript");
      assert(instance.getLoadedLanguages().includes("javascript"));
      assert.equal(
        requests.length,
        beforeSyncLoad,
        "a cached standard grammar loads synchronously",
      );
    } else {
      instance.loadLanguageSync(language);
      assert.match(
        instance.codeToHtml("TODO", { lang: language.name, theme: includedTheme.name }),
        /00aaff/i,
      );
    }
  } finally {
    instance.dispose();
  }
}

try {
  await verifyPrefetch("create-highlighter-theme-include", "themes/nord.fktheme", (cacheDir) =>
    createHighlighter({ themes: [includedTheme], assets: remoteAssets(cacheDir) }),
  );
  await verifyPrefetch("load-theme-include", "themes/nord.fktheme", async (cacheDir) => {
    const instance = createHighlighterCoreSync({ assets: remoteAssets(cacheDir) });
    try {
      await instance.loadTheme(includedTheme);
      return instance;
    } catch (error) {
      instance.dispose();
      throw error;
    }
  });

  const embeddedLanguagesRegistration = {
    name: "ferriki-registration-embedded-languages",
    scopeName: "source.ferriki-registration-embedded-languages",
    patterns: [{ match: "\\bEMBEDDED\\b", name: "keyword.embedded" }],
    embeddedLanguages: ["javascript"],
  };
  await verifyPrefetch(
    "create-highlighter-embedded-languages",
    "languages/javascript.fkgram",
    (cacheDir) =>
      createHighlighter({ langs: [embeddedLanguagesRegistration], assets: remoteAssets(cacheDir) }),
  );
  await verifyPrefetch(
    "load-language-embedded-languages",
    "languages/javascript.fkgram",
    async (cacheDir) => {
      const instance = createHighlighterCoreSync({ assets: remoteAssets(cacheDir) });
      try {
        await instance.loadLanguage(embeddedLanguagesRegistration);
        return instance;
      } catch (error) {
        instance.dispose();
        throw error;
      }
    },
  );

  const embeddedLangsRegistration = {
    name: "ferriki-registration-embedded-langs",
    scopeName: "source.ferriki-registration-embedded-langs",
    patterns: [{ match: "\\bEMBEDDED\\b", name: "keyword.embedded" }],
    embeddedLangs: ["javascript"],
  };
  await verifyPrefetch(
    "load-language-embedded-langs",
    "languages/javascript.fkgram",
    async (cacheDir) => {
      const instance = createHighlighterCoreSync({ assets: remoteAssets(cacheDir) });
      try {
        await instance.loadLanguage(embeddedLangsRegistration);
        return instance;
      } catch (error) {
        instance.dispose();
        throw error;
      }
    },
  );

  const bothEmbeddedLanguagesRegistration = {
    name: "ferriki-registration-embedded-languages-precedence",
    scopeName: "source.ferriki-registration-embedded-languages-precedence",
    patterns: [{ match: "\\bEMBEDDED\\b", name: "keyword.embedded" }],
    embeddedLangs: ["go"],
    embeddedLanguages: ["javascript"],
  };
  await verifyPrefetch(
    "load-language-embedded-languages-precedence",
    "languages/javascript.fkgram",
    async (cacheDir) => {
      const instance = createHighlighterCoreSync({ assets: remoteAssets(cacheDir) });
      try {
        await instance.loadLanguage(bothEmbeddedLanguagesRegistration);
        return instance;
      } catch (error) {
        instance.dispose();
        throw error;
      }
    },
    { notRequested: ["languages/go.fkgram"] },
  );

  const syncCacheDir = join(tempRoot, "sync-empty-cache");
  const syncInstance = createHighlighterCoreSync({ assets: remoteAssets(syncCacheDir) });
  const syncRequestOffset = requests.length;
  try {
    assert.throws(
      () => syncInstance.loadThemeSync(includedTheme),
      (error) =>
        error instanceof ShikiError &&
        error.code === "ERR_ASSET" &&
        /nord/.test(error.message) &&
        /asynchronous/.test(error.message),
    );
    syncInstance.loadLanguageSync(embeddedLanguagesRegistration);
    assert.throws(
      () => syncInstance.loadLanguageSync("javascript"),
      (error) =>
        error instanceof ShikiError &&
        error.code === "ERR_ASSET" &&
        /javascript/.test(error.message) &&
        /asynchronous/.test(error.message),
    );
    assert.equal(requests.length, syncRequestOffset, "sync registration never starts downloads");
    assert.deepEqual(
      await cacheEntries(syncCacheDir),
      [],
      "sync registration leaves the cache empty",
    );
  } finally {
    syncInstance.dispose();
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Ferriki custom language/theme registrations and prefetch verified");
