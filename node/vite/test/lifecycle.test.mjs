import { EventEmitter } from "node:events";
import { readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createServer } from "vite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ferriki } from "../index.mjs";

const createHighlighterMock = vi.hoisted(() => vi.fn());

vi.mock("@ferriki/core", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createHighlighter: createHighlighterMock,
  };
});

function context() {
  return {
    warn: vi.fn(),
    error(error) {
      throw error;
    },
  };
}

function makeFakeHighlighter(overrides = {}) {
  let disposed = false;
  function assertNotDisposed() {
    if (disposed) throw new Error("Shiki instance has been disposed");
  }
  const customLoadLanguage = overrides.loadLanguage;
  const loadLanguage = vi.fn(async (...args) => {
    assertNotDisposed();
    if (customLoadLanguage) return await customLoadLanguage(...args);
  });
  const customCodeToHtml = overrides.codeToHtml;
  const codeToHtml = vi.fn((code, ...rest) => {
    assertNotDisposed();
    if (customCodeToHtml) return customCodeToHtml(code, ...rest);
    return `<pre class="shiki"><code>${code}</code></pre>`;
  });
  const customCodeToHtmlWithCss = overrides.codeToHtmlWithCss;
  const codeToHtmlWithCss = vi.fn((code, ...rest) => {
    assertNotDisposed();
    if (customCodeToHtmlWithCss) return customCodeToHtmlWithCss(code, ...rest);
    return {
      html: `<pre class="shiki"><code>${code}</code></pre>`,
      css: ".ferriki-style-1{color:red}",
    };
  });
  const dispose = vi.fn(() => {
    disposed = true;
  });
  return {
    ...overrides,
    loadLanguage,
    codeToHtml,
    codeToHtmlWithCss,
    dispose,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  createHighlighterMock.mockReset();
});

describe("@ferriki/vite highlighter lifecycle and concurrency", () => {
  it("clears a rejected highlighterPromise so subsequent transforms succeed", async () => {
    const highlighter = makeFakeHighlighter();
    createHighlighterMock
      .mockRejectedValueOnce(new Error("transient CDN error"))
      .mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const source = `import { code } from "@ferriki/core/macro"; export const block = code("x", { language: "ts" });`;

    await expect(vitePlugin.transform.handler.call(context(), source, "/src/a.ts")).rejects.toThrow(
      "transient CDN error",
    );

    const recovered = await vitePlugin.transform.handler.call(context(), source, "/src/a.ts");
    expect(recovered.code).toContain('"code":"x"');
    expect(createHighlighterMock).toHaveBeenCalledTimes(2);
    expect(highlighter.dispose).not.toHaveBeenCalled();

    await vitePlugin.closeBundle();
    expect(highlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight transform to finish before disposing on closeBundle and allows clean reuse", async () => {
    const createStarted = deferred();
    const inflightCreate = deferred();
    const loadStarted = deferred();
    const inflightLang = deferred();
    const firstHighlighter = makeFakeHighlighter({
      loadLanguage: () => {
        loadStarted.resolve();
        return inflightLang.promise;
      },
    });
    const secondHighlighter = makeFakeHighlighter();
    createHighlighterMock
      .mockImplementationOnce(() => {
        createStarted.resolve();
        return inflightCreate.promise;
      })
      .mockResolvedValueOnce(secondHighlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const source = `import { code } from "@ferriki/core/macro"; export const block = code("x", { language: "ts" });`;

    const firstTransform = vitePlugin.transform.handler.call(context(), source, "/src/inflight.ts");
    await createStarted.promise;

    // Teardown begins while createHighlighter() is still pending.
    let closeFinished = false;
    const closing = vitePlugin.closeBundle().then(() => {
      closeFinished = true;
    });

    inflightCreate.resolve(firstHighlighter);
    await loadStarted.promise;

    // The active transform is still awaiting loadLanguage(), so dispose() must NOT have run yet.
    expect(firstHighlighter.dispose).not.toHaveBeenCalled();
    expect(closeFinished).toBe(false);

    inflightLang.resolve();
    const firstResult = await firstTransform;
    expect(firstResult.code).toContain('"code":"x"');
    await closing;
    expect(closeFinished).toBe(true);
    expect(firstHighlighter.dispose).toHaveBeenCalledTimes(1);

    // Calling closeBundle again is a no-op.
    await vitePlugin.closeBundle();
    expect(firstHighlighter.dispose).toHaveBeenCalledTimes(1);

    // A later transform gets a fresh highlighter instance.
    const reuseResult = await vitePlugin.transform.handler.call(context(), source, "/src/reuse.ts");
    expect(reuseResult.code).toContain('"code":"x"');
    expect(createHighlighterMock).toHaveBeenCalledTimes(2);
    expect(secondHighlighter.dispose).not.toHaveBeenCalled();

    await vitePlugin.closeBundle();
    expect(secondHighlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("holds one highlighter session across multiple macros in a transform during shutdown", async () => {
    const firstMacroStarted = deferred();
    const firstMacroRelease = deferred();
    const secondMacroStarted = deferred();
    const secondMacroRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "ts") {
          firstMacroStarted.resolve();
          return firstMacroRelease.promise;
        }
        if (language === "rust") {
          secondMacroStarted.resolve();
          return secondMacroRelease.promise;
        }
        return Promise.resolve();
      },
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const source = `import { code } from "@ferriki/core/macro";
export const first = code("one", { language: "ts" });
export const second = code("two", { language: "rust" });`;

    const transformPromise = vitePlugin.transform.handler.call(
      context(),
      source,
      "/src/two-macros.ts",
    );
    await Promise.all([firstMacroStarted.promise, secondMacroStarted.promise]);

    // Begin shutdown while both distinct language loads are in flight concurrently.
    let closeFinished = false;
    const closing = vitePlugin.closeBundle().then(() => {
      closeFinished = true;
    });

    firstMacroRelease.resolve();
    await Promise.resolve();

    // Macro #2 must keep the same session alive without creating a second highlighter or disposing early.
    expect(createHighlighterMock).toHaveBeenCalledTimes(1);
    expect(highlighter.dispose).not.toHaveBeenCalled();
    expect(closeFinished).toBe(false);

    secondMacroRelease.resolve();
    const result = await transformPromise;
    expect(result.code).toContain('"code":"one"');
    expect(result.code).toContain('"code":"two"');
    await closing;
    expect(closeFinished).toBe(true);
    expect(createHighlighterMock).toHaveBeenCalledTimes(1);
    expect(highlighter.codeToHtml).toHaveBeenCalledTimes(2);
    expect(highlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared highlighter alive for parallel environment transforms when another environment closes first", async () => {
    const ssrLoadStarted = deferred();
    const ssrLangLoad = deferred();
    const firstHighlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          ssrLoadStarted.resolve();
          return ssrLangLoad.promise;
        }
        return Promise.resolve();
      },
    });
    const secondHighlighter = makeFakeHighlighter();
    createHighlighterMock
      .mockResolvedValueOnce(firstHighlighter)
      .mockResolvedValueOnce(secondHighlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const clientSource = `import { code } from "@ferriki/core/macro"; export const a = code("client", { language: "ts" });`;
    const ssrSource = `import { code } from "@ferriki/core/macro"; export const b = code("ssr", { language: "rust" });`;

    const clientTransform = vitePlugin.transform.handler.call(
      { ...context(), environment: { name: "client" } },
      clientSource,
      "/src/client.ts",
    );
    const ssrTransform = vitePlugin.transform.handler.call(
      { ...context(), environment: { name: "ssr" } },
      ssrSource,
      "/src/ssr.ts",
    );

    const [clientResult] = await Promise.all([clientTransform, ssrLoadStarted.promise]);
    expect(clientResult.code).toContain('"code":"client"');

    // Client environment finishes and calls closeBundle while SSR is still awaiting loadLanguage("rust").
    const clientClosing = vitePlugin.closeBundle();
    expect(firstHighlighter.dispose).not.toHaveBeenCalled();

    // A new transform starting after client closeBundle acquires a fresh highlighter cleanly.
    const lateTransform = vitePlugin.transform.handler.call(
      { ...context(), environment: { name: "ssr" } },
      clientSource,
      "/src/ssr-late.ts",
    );
    expect((await lateTransform).code).toContain('"code":"client"');
    expect(createHighlighterMock).toHaveBeenCalledTimes(2);
    expect(firstHighlighter.dispose).not.toHaveBeenCalled();

    // Completing SSR's pending load finishes rendering without hitting use-after-dispose, then disposes firstHighlighter.
    ssrLangLoad.resolve();
    expect((await ssrTransform).code).toContain('"code":"ssr"');
    await clientClosing;
    expect(firstHighlighter.dispose).toHaveBeenCalledTimes(1);
    expect(secondHighlighter.dispose).not.toHaveBeenCalled();

    await vitePlugin.closeBundle();
    expect(secondHighlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["inline", "classes"])(
    "disposes the highlighter when dev server httpServer closes in %s styleMode",
    async (styleMode) => {
      const disposed = deferred();
      const highlighter = makeFakeHighlighter();
      const originalDispose = highlighter.dispose;
      highlighter.dispose = vi.fn(() => {
        originalDispose();
        disposed.resolve();
      });
      createHighlighterMock.mockResolvedValueOnce(highlighter);

      const vitePlugin = ferriki({ theme: "nord", styleMode });
      const httpServer = new EventEmitter();
      vitePlugin.configureServer({
        config: { base: "/" },
        httpServer,
        middlewares: { use() {} },
        ws: { send() {} },
      });

      const source = `import { code } from "@ferriki/core/macro"; export const block = code("x", { language: "ts" });`;
      await vitePlugin.transform.handler.call(context(), source, "/src/dev.ts");
      expect(highlighter.dispose).not.toHaveBeenCalled();

      httpServer.emit("close");
      await disposed.promise;
      expect(highlighter.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it("does not let a stale rejected language load delete a newer retry promise", async () => {
    const firstLoadStarted = deferred();
    const secondLoadStarted = deferred();
    const firstAttempt = deferred();
    const secondAttempt = deferred();
    const loadLanguage = vi
      .fn()
      .mockImplementationOnce(() => {
        firstLoadStarted.resolve();
        return firstAttempt.promise;
      })
      .mockImplementationOnce(() => {
        secondLoadStarted.resolve();
        return secondAttempt.promise;
      });
    const highlighter = makeFakeHighlighter({ loadLanguage });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const source = `import { code } from "@ferriki/core/macro"; export const block = code("x", { language: "ts" });`;

    // When waiter1 catches ERR_UNSUPPORTED, it deletes loading1 and synchronously
    // invokes context.warn(). Starting the retry inside warn() caches loading2 in
    // `loads` BEFORE waiter2's rejection reaction runs on the next microtask.
    let retryPromise;
    const waiter1Context = {
      ...context(),
      warn: vi.fn(() => {
        retryPromise = vitePlugin.transform.handler.call(context(), source, "/src/retry.ts");
      }),
    };

    // Two concurrent transforms share firstAttempt (loading1).
    const waiter1 = vitePlugin.transform.handler.call(waiter1Context, source, "/src/w1.ts");
    const waiter2 = vitePlugin.transform.handler.call(context(), source, "/src/w2.ts");

    await firstLoadStarted.promise;
    expect(highlighter.loadLanguage).toHaveBeenCalledTimes(1);

    firstAttempt.reject(
      Object.assign(new Error("transient unsupported"), { code: "ERR_UNSUPPORTED" }),
    );
    await Promise.all([waiter1, waiter2]);
    expect(waiter1Context.warn).toHaveBeenCalledTimes(1);
    expect(retryPromise).toBeDefined();
    await secondLoadStarted.promise;
    expect(highlighter.loadLanguage).toHaveBeenCalledTimes(2);

    // If waiter2's stale catch had deleted loading2, joiner would trigger a 3rd loadLanguage call.
    const joiner = vitePlugin.transform.handler.call(context(), source, "/src/joiner.ts");
    secondAttempt.resolve();
    const [retryResult, joinerResult] = await Promise.all([retryPromise, joiner]);
    expect(retryResult.code).toContain('"code":"x"');
    expect(joinerResult.code).toContain('"code":"x"');
    expect(highlighter.loadLanguage).toHaveBeenCalledTimes(2);

    await vitePlugin.closeBundle();
    expect(highlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("prevents a stale HMR transform from evicting a newer transform's virtual CSS", async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "ts") {
          firstStarted.resolve();
          return firstRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code === "old" ? ".ferriki-style-old{color:red}" : ".ferriki-style-new{color:blue}",
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const oldSource = `import { code } from "@ferriki/core/macro"; export const block = code("old", { language: "ts" });`;
    const newSource = `import { code } from "@ferriki/core/macro"; export const block = code("new", { language: "rust" });`;

    const staleTransform = vitePlugin.transform.handler.call(context(), oldSource, "/src/race.ts");
    await firstStarted.promise;

    // A newer HMR transform for the same module completes first.
    const latestResult = await vitePlugin.transform.handler.call(
      context(),
      newSource,
      "/src/race.ts",
    );
    const latestCssId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(latestResult.code)?.[1];
    expect(latestCssId).toBeTruthy();
    expect(vitePlugin.resolveId(latestCssId)).toBe(`\0${latestCssId}`);
    expect(vitePlugin.load(`\0${latestCssId}`)).toBe(".ferriki-style-new{color:blue}");

    // Now the stale earlier transform settles; it stays styled without evicting latestCssId.
    firstRelease.resolve();
    const staleResult = await staleTransform;
    expect(staleResult.code).toContain('"code":"old"');
    const staleCssId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(staleResult.code)?.[1];
    expect(staleCssId).toBeTruthy();
    expect(staleCssId).not.toBe(latestCssId);
    expect(vitePlugin.resolveId(staleCssId)).toBe(`\0${staleCssId}`);
    expect(vitePlugin.load(`\0${staleCssId}`)).toBe(".ferriki-style-old{color:red}");
    expect(vitePlugin.resolveId(latestCssId)).toBe(`\0${latestCssId}`);
    expect(vitePlugin.load(`\0${latestCssId}`)).toBe(".ferriki-style-new{color:blue}");

    await vitePlugin.closeBundle();
  });

  it("keeps class styles available for out-of-order React transforms without overwriting latest blocks", async () => {
    const oldStarted = deferred();
    const oldRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          oldStarted.resolve();
          return oldRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code.includes("old")
          ? ".ferriki-style-react-old{color:red}"
          : ".ferriki-style-react-new{color:blue}",
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const send = vi.fn();
    vitePlugin.configureServer({
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send },
    });

    const oldSource = `import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="old" language="rust" />;`;
    const newSource = `import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="new" language="ts" />;`;

    const staleTransform = vitePlugin.transform.handler.call(
      context(),
      oldSource,
      "/src/react-race.tsx",
    );
    await oldStarted.promise;

    await vitePlugin.transform.handler.call(context(), newSource, "/src/react-race.tsx");
    expect(Object.values(vitePlugin.api.codeElementBlocks())).toHaveLength(1);
    expect(Object.values(vitePlugin.api.codeElementBlocks())[0]).toContain("new");
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-react-new");

    send.mockClear();
    oldRelease.resolve();
    await staleTransform;

    // Newer module blocks stay authoritative while rules from both returned transforms remain available.
    expect(Object.values(vitePlugin.api.codeElementBlocks())).toHaveLength(1);
    expect(Object.values(vitePlugin.api.codeElementBlocks())[0]).toContain("new");
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-react-new");
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-react-old");
    expect(send).toHaveBeenCalledOnce();

    await vitePlugin.closeBundle();
  });

  it("prevents an out-of-order stale transform from suppressing a newer edit's unknown-language warning", async () => {
    const oldStarted = deferred();
    const oldRelease = deferred();
    const loadLanguage = vi.fn((language) => {
      if (language === "stale-unknown") {
        oldStarted.resolve();
        return oldRelease.promise;
      }
      return Promise.reject(Object.assign(new Error("unknown lang"), { code: "ERR_UNSUPPORTED" }));
    });
    const highlighter = makeFakeHighlighter({ loadLanguage });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const file = "/src/warn-race.ts";
    const oldSource = `import { code } from "@ferriki/core/macro"; export const a = code("old", { language: "stale-unknown" });`;
    const newSource = `import { code } from "@ferriki/core/macro"; export const b = code("new", { language: "fresh-unknown" });`;

    const staleContext = context();
    const staleTransform = vitePlugin.transform.handler.call(staleContext, oldSource, file);
    await oldStarted.promise;

    // File is edited: hotUpdate resets warnedFiles and newer transform starts.
    await vitePlugin.hotUpdate({ type: "update", file, read: () => newSource });
    const freshContext = context();
    const freshTransform = vitePlugin.transform.handler.call(freshContext, newSource, file);

    // Stale transform rejects AFTER newer generation started: it must neither warn nor poison warnedFiles.
    oldRelease.reject(Object.assign(new Error("stale unknown"), { code: "ERR_UNSUPPORTED" }));
    await Promise.all([staleTransform, freshTransform]);

    expect(staleContext.warn).not.toHaveBeenCalled();
    expect(freshContext.warn).toHaveBeenCalledTimes(1);
    expect(freshContext.warn.mock.calls[0][0]).toContain("fresh-unknown");

    await vitePlugin.closeBundle();
  });

  it("invalidates an in-flight first transform when hotUpdate removes the macro import", async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: () => {
        firstStarted.resolve();
        return firstRelease.promise;
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: ".ferriki-style-inflight{color:red}",
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const source = `import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="const x = 1;" language="ts" />;`;

    const firstTransform = vitePlugin.transform.handler.call(
      context(),
      source,
      "/src/inflight-remove.tsx",
    );
    await firstStarted.promise;

    // Before any React block or CSS is committed, an edit removes the macro import.
    await vitePlugin.hotUpdate({
      type: "update",
      file: "/src/inflight-remove.tsx",
      read: () => "export const block = <p>plain</p>;",
    });

    firstRelease.resolve();
    await firstTransform;

    expect(vitePlugin.api.codeElementBlocks()).toEqual({});
    // Removed macro imports must NOT re-inject CSS into codeElementCss() when the stale transform settles.
    expect(vitePlugin.api.codeElementCss()).toBe("");

    // Future edits to that now-ordinary file do not re-read it (no dead generation key left behind).
    const readAfterRemoval = vi.fn(() => "export const block = <p>still plain</p>;");
    await vitePlugin.hotUpdate({
      type: "update",
      file: "/src/inflight-remove.tsx",
      read: readAfterRemoval,
    });
    expect(readAfterRemoval).not.toHaveBeenCalled();

    await vitePlugin.closeBundle();
    expect(vitePlugin.api.codeElementCss()).toBe("");
  });

  it("keeps recently superseded virtual CSS resolvable in a bounded FIFO cache without evicting owned CSS", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:red}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    // Pin one CSS hash via /src/pinned.ts, and start /src/churn.ts with CSS A.
    const pinnedResult = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const p = code("pinned", { language: "ts" });',
      "/src/pinned.ts",
    );
    const pinnedCssId = cssIdOf(pinnedResult);

    const firstResult = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("v0", { language: "ts" });',
      "/src/churn.ts",
    );
    const cssA = cssIdOf(firstResult);

    // Replacing CSS A with CSS B keeps CSS A resolvable for already-returned JS modules.
    const secondResult = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("v1", { language: "ts" });',
      "/src/churn.ts",
    );
    const cssB = cssIdOf(secondResult);
    expect(cssB).not.toBe(cssA);
    expect(vitePlugin.resolveId(cssA)).toBe(`\0${cssA}`);
    expect(vitePlugin.load(`\0${cssA}`)).toBe(".ferriki-style-v0{color:red}");
    expect(vitePlugin.resolveId(cssB)).toBe(`\0${cssB}`);
    expect(vitePlugin.load(`\0${cssB}`)).toBe(".ferriki-style-v1{color:red}");

    // Churn past the 64-entry bounded RAM cache: CSS A is evicted from RAM (`resolveId` is null),
    // yet remains reloadable from the bounded LRU spill cache until teardown, while latest & pinned stay in RAM.
    let latestCssId = cssB;
    for (let index = 2; index <= 66; index++) {
      const next = await vitePlugin.transform.handler.call(
        context(),
        `import { code } from "@ferriki/core/macro"; export const x = code("v${index}", { language: "ts" });`,
        "/src/churn.ts",
      );
      latestCssId = cssIdOf(next);
      vitePlugin.load(`\0${latestCssId}`);
    }
    expect(vitePlugin.resolveId(cssA)).toBe(`\0${cssA}`);
    expect(vitePlugin.load(`\0${cssA}`)).toBe(".ferriki-style-v0{color:red}");
    expect(vitePlugin.resolveId(latestCssId)).toBe(`\0${latestCssId}`);
    expect(vitePlugin.resolveId(pinnedCssId)).toBe(`\0${pinnedCssId}`);
    expect(vitePlugin.load(`\0${pinnedCssId}`)).toBe(".ferriki-style-pinned{color:red}");

    await vitePlugin.closeBundle();
    expect(vitePlugin.resolveId(cssA)).toBeNull();
    expect(vitePlugin.load(`\0${cssA}`)).toBeNull();
  });

  it("keeps pending virtual CSS resolvable across 70 edits and retires abandoned imports past 256", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:green}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    const pinned = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const p = code("owned", { language: "ts" });',
      "/src/owned.ts",
    );
    const pinnedCssId = cssIdOf(pinned);

    const first = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("pending0", { language: "ts" });',
      "/src/bulk.ts",
    );
    const pendingCssId = cssIdOf(first);

    // Supersede with 70 newer stylesheets before Vite loads pendingCssId.
    for (let index = 1; index <= 70; index++) {
      await vitePlugin.transform.handler.call(
        context(),
        `import { code } from "@ferriki/core/macro"; export const x = code("pending${index}", { language: "ts" });`,
        "/src/bulk.ts",
      );
    }

    // The unserved pending import must still resolve and load cleanly.
    expect(vitePlugin.resolveId(pendingCssId)).toBe(`\0${pendingCssId}`);
    expect(vitePlugin.load(`\0${pendingCssId}`)).toBe(".ferriki-style-pending0{color:green}");

    // Fresh unowned pending imports beyond MAX_PENDING_CSS (256) spill to disk so resolveId + load still succeed!
    const spilledPendingFirst = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("spilled-pending-0", { language: "ts" });',
      "/src/bulk.ts",
    );
    const spilledPendingCssId = cssIdOf(spilledPendingFirst);
    for (let index = 1; index <= 300; index++) {
      await vitePlugin.transform.handler.call(
        context(),
        `import { code } from "@ferriki/core/macro"; export const x = code("spilled-pending-${index}", { language: "ts" });`,
        "/src/bulk.ts",
      );
    }
    expect(vitePlugin.resolveId(spilledPendingCssId)).toBe(`\0${spilledPendingCssId}`);
    expect(vitePlugin.load(`\0${spilledPendingCssId}`)).toBe(
      ".ferriki-style-spilled-pending-0{color:green}",
    );

    // Abandoned pending imports older than ABANDONED_CSS_TTL_MS (5 minutes) retire without spilling.
    vi.useFakeTimers();
    try {
      const abandonedFirst = await vitePlugin.transform.handler.call(
        context(),
        'import { code } from "@ferriki/core/macro"; export const x = code("abandoned0", { language: "ts" });',
        "/src/bulk.ts",
      );
      const abandonedCssId = cssIdOf(abandonedFirst);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      let latestCssId = abandonedCssId;
      for (let index = 1; index <= 260; index++) {
        const next = await vitePlugin.transform.handler.call(
          context(),
          `import { code } from "@ferriki/core/macro"; export const x = code("abandoned${index}", { language: "ts" });`,
          "/src/bulk.ts",
        );
        latestCssId = cssIdOf(next);
      }
      expect(vitePlugin.resolveId(abandonedCssId)).toBeNull();
      expect(vitePlugin.load(`\0${abandonedCssId}`)).toBeNull();
      expect(vitePlugin.resolveId(latestCssId)).toBe(`\0${latestCssId}`);
      expect(vitePlugin.resolveId(pinnedCssId)).toBe(`\0${pinnedCssId}`);
    } finally {
      vi.useRealTimers();
    }

    await vitePlugin.closeBundle();
  });

  it("pins stale transform CSS before trim and tracks pending loads per Vite environment", async () => {
    const staleStarted = deferred();
    const staleRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          staleStarted.resolve();
          return staleRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:purple}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };

    // Start a stale transform while 65 superseded entries accumulate.
    const staleTransform = vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("stale", { language: "rust" });',
      "/src/stale-full.ts",
    );
    await staleStarted.promise;

    for (let index = 0; index <= 65; index++) {
      const next = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        `import { code } from "@ferriki/core/macro"; export const x = code("fill${index}", { language: "ts" });`,
        "/src/stale-full.ts",
      );
      vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
    }

    staleRelease.resolve();
    const staleResult = await staleTransform;
    const staleCssId = cssIdOf(staleResult);
    expect(staleCssId).toBeTruthy();
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, staleCssId)).toBe(
      `\0${staleCssId}`,
    );
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${staleCssId}`)).toBe(
      ".ferriki-style-stale{color:purple}",
    );

    // Client and SSR emit the same CSS hash, then both supersede it before loading.
    const sharedSource =
      'import { code } from "@ferriki/core/macro"; export const x = code("shared-env", { language: "ts" });';
    const clientShared = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      sharedSource,
      "/src/shared-env.ts",
    );
    const ssrShared = await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      sharedSource,
      "/src/shared-env.ts",
    );
    const sharedCssId = cssIdOf(clientShared);
    expect(sharedCssId).toBe(cssIdOf(ssrShared));

    // Supersede both environments and churn > 64 loaded superseded entries.
    const replacementSource =
      'import { code } from "@ferriki/core/macro"; export const x = code("replaced-env", { language: "ts" });';
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      replacementSource,
      "/src/shared-env.ts",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      replacementSource,
      "/src/shared-env.ts",
    );

    // Client resolves & loads sharedCssId first, then 65 other loaded superseded entries churn.
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${sharedCssId}`)).toBe(
      ".ferriki-style-shared-env{color:purple}",
    );
    for (let index = 0; index <= 65; index++) {
      const next = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        `import { code } from "@ferriki/core/macro"; export const x = code("after-client-${index}", { language: "ts" });`,
        "/src/churn-after-client.ts",
      );
      vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
    }

    // SSR's pending claim still protects sharedCssId until SSR resolves and loads it!
    expect(vitePlugin.resolveId.call({ environment: ssrEnv }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    expect(vitePlugin.load.call({ environment: ssrEnv }, `\0${sharedCssId}`)).toBe(
      ".ferriki-style-shared-env{color:purple}",
    );

    await vitePlugin.closeBundle();
  });

  it("spills evicted already-issued CSS to a private temp directory, handles >1 MiB payloads, and cleans up on teardown", async () => {
    const bigCss = `.ferriki-style-big{${"a:1;".repeat(320_000)}}`;
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code === "big" ? bigCss : `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const httpServer = new EventEmitter();
    vitePlugin.configureServer({
      config: { base: "/" },
      httpServer,
      middlewares: { use() {} },
      ws: { send() {} },
    });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    const first = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("delayed0", { language: "ts" });',
      "/src/resolved.ts",
    );
    const delayedCssId = cssIdOf(first);
    expect(vitePlugin.resolveId(delayedCssId)).toBe(`\0${delayedCssId}`);

    const bigResult = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("big", { language: "ts" });',
      "/src/resolved.ts",
    );
    const bigCssId = cssIdOf(bigResult);
    expect(vitePlugin.resolveId(bigCssId)).toBe(`\0${bigCssId}`);

    // Churn 300 unrelated transforms & 100 loaded superseded entries so both issued IDs are
    // evicted from in-memory virtualCss, and simulate hours of idle time.
    vi.useFakeTimers();
    try {
      for (let index = 1; index <= 300; index++) {
        const next = await vitePlugin.transform.handler.call(
          context(),
          `import { code } from "@ferriki/core/macro"; export const x = code("churn${index}", { language: "ts" });`,
          "/src/resolved.ts",
        );
        if (index <= 100) vitePlugin.load(`\0${cssIdOf(next)}`);
      }
      vi.advanceTimersByTime(2 * 60 * 60 * 1000);

      // Evicted from in-memory virtualCss, yet both already-issued short IDs stay resolvable and reloadable from spill!
      expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);
      expect(vitePlugin.resolveId(delayedCssId)).toBe(`\0${delayedCssId}`);
      expect(vitePlugin.resolveId(bigCssId)).toBe(`\0${bigCssId}`);
      expect(vitePlugin.load(`\0${delayedCssId}`)).toBe(".ferriki-style-delayed0{color:teal}");
      expect(vitePlugin.load(`\0${delayedCssId}`)).toBe(".ferriki-style-delayed0{color:teal}");
      expect(vitePlugin.load(`\0${bigCssId}`)).toBe(bigCss);
      expect(vitePlugin.load(`\0${bigCssId}`)).toBe(bigCss);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);

      // Unissued or malformed IDs are rejected with null.
      expect(vitePlugin.load(`\0virtual:ferriki-vite/${"0".repeat(64)}.css`)).toBeNull();
      expect(vitePlugin.load(`\0virtual:ferriki-vite/../escape.css`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    // Closing the dev server cleans up the spill directory and removes the process exit listener.
    httpServer.emit("close");
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
    expect(vitePlugin.load(`\0${delayedCssId}`)).toBeNull();
    expect(vitePlugin.load(`\0${bigCssId}`)).toBeNull();

    // Build mode also uses exact `\0${cssId}` IDs and cleans up cleanly in closeBundle().
    const buildHighlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(buildHighlighter);
    vitePlugin.configResolved({ command: "build", base: "/" });
    const built = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("built0", { language: "ts" });',
      "/src/built.ts",
    );
    const builtCssId = cssIdOf(built);
    expect(vitePlugin.resolveId(builtCssId)).toBe(`\0${builtCssId}`);
    expect(vitePlugin.load(`\0${builtCssId}`)).toBe(".ferriki-style-built0{color:teal}");

    await vitePlugin.closeBundle();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
  });

  it("does not let unrelated owned modules evict unowned pending CSS and supports 300 bulk resolutions", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:navy}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    // Create an unowned pending CSS A (superseded before load).
    const first = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("unownedA", { language: "ts" });',
      "/src/replaced.ts",
    );
    const unownedPendingCssA = cssIdOf(first);
    await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("replacementB", { language: "ts" });',
      "/src/replaced.ts",
    );

    // 260 distinct still-owned modules must NOT consume unowned pending budget or evict CSS A.
    for (let index = 0; index < 260; index++) {
      await vitePlugin.transform.handler.call(
        context(),
        `import { code } from "@ferriki/core/macro"; export const m = code("owned${index}", { language: "ts" });`,
        `/src/owned-${index}.ts`,
      );
    }
    expect(vitePlugin.resolveId(unownedPendingCssA)).toBe(`\0${unownedPendingCssA}`);
    expect(vitePlugin.load(`\0${unownedPendingCssA}`)).toBe(".ferriki-style-unownedA{color:navy}");

    // A bulk burst of 300 resolved unowned stylesheets keeps RAM bounded while all 300 remain loadable via spill.
    const bulkResolved = [];
    for (let index = 0; index < 300; index++) {
      const next = await vitePlugin.transform.handler.call(
        context(),
        `import { code } from "@ferriki/core/macro"; export const x = code("bulk-res-${index}", { language: "ts" });`,
        "/src/bulk-res.ts",
      );
      const cssId = cssIdOf(next);
      expect(vitePlugin.resolveId(cssId)).toBe(`\0${cssId}`);
      bulkResolved.push(`\0${cssId}`);
    }
    await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("bulk-res-final", { language: "ts" });',
      "/src/bulk-res.ts",
    );

    expect(vitePlugin.load(bulkResolved[0])).toBe(".ferriki-style-bulk-res-0{color:navy}");
    expect(vitePlugin.load(bulkResolved[150])).toBe(".ferriki-style-bulk-res-150{color:navy}");
    expect(vitePlugin.load(bulkResolved[299])).toBe(".ferriki-style-bulk-res-299{color:navy}");

    await vitePlugin.closeBundle();
  });

  it("preserves overlapping pending CSS transforms and keeps abandoned resolutions zero-retained", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:olive}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];
    const clientEnv = { name: "client" };

    // Case A: Transform 1 (X) -> resolveId 1 -> Transform 2 (Y) -> Transform 3 (X) -> Transform 4 (Z)
    // -> load 1 -> 67 unrelated CSS -> resolveId 3 & load 3 must still succeed!
    const t1 = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("hashX", { language: "ts" });',
      "/src/overlap-a.ts",
    );
    const cssX = cssIdOf(t1);
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssX)).toBe(`\0${cssX}`);

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("hashY", { language: "ts" });',
      "/src/overlap-a.ts",
    );
    const t3 = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("hashX", { language: "ts" });',
      "/src/overlap-a.ts",
    );
    expect(cssIdOf(t3)).toBe(cssX);
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("hashZ", { language: "ts" });',
      "/src/overlap-a.ts",
    );

    // Load 1 completes for Transform 1's resolution; Transform 3's newer pending claim must survive.
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssX}`)).toBe(
      ".ferriki-style-hashX{color:olive}",
    );

    for (let index = 0; index < 67; index++) {
      const next = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        `import { code } from "@ferriki/core/macro"; export const x = code("churnA-${index}", { language: "ts" });`,
        "/src/churn-overlap-a.ts",
      );
      const id = cssIdOf(next);
      const resolved = vitePlugin.resolveId.call({ environment: clientEnv }, id);
      vitePlugin.load.call({ environment: clientEnv }, resolved);
    }

    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssX)).toBe(`\0${cssX}`);
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssX}`)).toBe(
      ".ferriki-style-hashX{color:olive}",
    );

    // Case B: Two overlapping transforms in the same environment emit hash B before either resolves;
    // both modules then switch to other CSS -> resolveId 1 + load 1 -> 67 unrelated stylesheets ->
    // resolveId 2 + load 2 must still succeed because the 2nd pending claim survived!
    const b1 = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("hashB", { language: "ts" });',
      "/src/overlap-b1.ts",
    );
    const b2 = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("hashB", { language: "ts" });',
      "/src/overlap-b2.ts",
    );
    const cssB = cssIdOf(b1);
    expect(cssIdOf(b2)).toBe(cssB);

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("hashB-alt1", { language: "ts" });',
      "/src/overlap-b1.ts",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("hashB-alt2", { language: "ts" });',
      "/src/overlap-b2.ts",
    );

    // First import resolves and loads; the second transform's pending claim remains pinned across 67 edits.
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssB)).toBe(`\0${cssB}`);
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssB}`)).toBe(
      ".ferriki-style-hashB{color:olive}",
    );
    for (let index = 0; index < 67; index++) {
      const next = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        `import { code } from "@ferriki/core/macro"; export const x = code("churnB-${index}", { language: "ts" });`,
        "/src/churn-overlap-b.ts",
      );
      const id = cssIdOf(next);
      const resolved = vitePlugin.resolveId.call({ environment: clientEnv }, id);
      vitePlugin.load.call({ environment: clientEnv }, resolved);
    }

    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssB)).toBe(`\0${cssB}`);
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssB}`)).toBe(
      ".ferriki-style-hashB{color:olive}",
    );

    await vitePlugin.closeBundle.call({ environment: clientEnv });
  });

  it("does not let an earlier closeBundle clear CSS claims created by a replacement session", async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const firstHighlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          firstStarted.resolve();
          return firstRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:maroon}`,
      }),
    });
    const secondHighlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:maroon}`,
      }),
    });
    createHighlighterMock
      .mockResolvedValueOnce(firstHighlighter)
      .mockResolvedValueOnce(secondHighlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];
    const clientEnv = { name: "client" };

    // Start transform T1 on firstHighlighter and block before it finishes.
    const t1 = vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("t1", { language: "rust" });',
      "/src/t1.ts",
    );
    await firstStarted.promise;

    // Begin closeBundle for the first session while T1 is still active.
    const firstClose = vitePlugin.closeBundle.call({ environment: clientEnv });

    // Replacement session starts while firstClose is waiting, emits replacementCssId, then supersedes it.
    const t2 = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("replacement", { language: "ts" });',
      "/src/replacement.ts",
    );
    const replacementCssId = cssIdOf(t2);
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("replacement-v2", { language: "ts" });',
      "/src/replacement.ts",
    );

    // Finish T1 so firstClose completes its finally block.
    firstRelease.resolve();
    await t1;
    await firstClose;

    // Churn 65 loaded superseded entries; if firstClose had cleared replacementCssId's claim,
    // replacementCssId would have been evicted from supersededCss.
    for (let index = 0; index <= 65; index++) {
      const next = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        `import { code } from "@ferriki/core/macro"; export const x = code("post-close-${index}", { language: "ts" });`,
        "/src/post-close.ts",
      );
      vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
    }

    expect(vitePlugin.resolveId.call({ environment: clientEnv }, replacementCssId)).toBe(
      `\0${replacementCssId}`,
    );
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${replacementCssId}`)).toBe(
      ".ferriki-style-replacement{color:maroon}",
    );

    await vitePlugin.closeBundle.call({ environment: clientEnv });
  });

  it("retains all rules from a single superseded React transform with more than 64 blocks", async () => {
    const oldStarted = deferred();
    const oldRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          oldStarted.resolve();
          return oldRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:indigo}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const manyBlocks = Array.from(
      { length: 70 },
      (_, index) => `<Code source="block-${index}" language="rust" />`,
    ).join("");
    const oldSource = `import { Code } from "@ferriki/core/react/macro"; export const page = <>${manyBlocks}</>;`;
    const newSource = `import { Code } from "@ferriki/core/react/macro"; export const page = <Code source="fresh-only" language="ts" />;`;

    const staleTransform = vitePlugin.transform.handler.call(
      context(),
      oldSource,
      "/src/many-blocks.tsx",
    );
    await oldStarted.promise;

    await vitePlugin.transform.handler.call(context(), newSource, "/src/many-blocks.tsx");
    oldRelease.resolve();
    await staleTransform;

    const css = vitePlugin.api.codeElementCss();
    expect(css).toContain(".ferriki-style-fresh-only{color:indigo}");
    for (let index = 0; index < 70; index++) {
      expect(css).toContain(`.ferriki-style-block-${index}{color:indigo}`);
    }

    await vitePlugin.closeBundle();
  });

  it("does not let an earlier closeBundle clear superseded React CSS from a replacement session", async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const staleReactStarted = deferred();
    const staleReactRelease = deferred();
    const firstHighlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          firstStarted.resolve();
          return firstRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:coral}`,
      }),
    });
    const secondHighlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "python") {
          staleReactStarted.resolve();
          return staleReactRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:coral}`,
      }),
    });
    createHighlighterMock
      .mockResolvedValueOnce(firstHighlighter)
      .mockResolvedValueOnce(secondHighlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client" };

    // Start T1 on firstHighlighter and block before it completes.
    const t1 = vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("t1", { language: "rust" });',
      "/src/t1-react.ts",
    );
    await firstStarted.promise;

    const firstClose = vitePlugin.closeBundle.call({ environment: clientEnv });

    // Replacement session records a superseded React CSS payload while firstClose is pending.
    const staleReact = vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="replacement-stale" language="python" />;',
      "/src/replacement-react.tsx",
    );
    await staleReactStarted.promise;
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="replacement-new" language="ts" />;',
      "/src/replacement-react.tsx",
    );
    staleReactRelease.resolve();
    await staleReact;

    // Now finish T1 so firstClose completes its finally block.
    firstRelease.resolve();
    await t1;
    await firstClose;

    expect(vitePlugin.api.codeElementCss("client")).toContain(
      ".ferriki-style-replacement-stale{color:coral}",
    );
    expect(vitePlugin.api.codeElementCss("client")).toContain(
      ".ferriki-style-replacement-new{color:coral}",
    );

    // Subsequent closeBundle for the replacement session clears superseded React CSS cleanly.
    await vitePlugin.closeBundle.call({ environment: clientEnv });
    expect(vitePlugin.api.codeElementCss("client")).not.toContain(
      ".ferriki-style-replacement-stale",
    );
    expect(vitePlugin.api.codeElementCss("client")).toContain(
      ".ferriki-style-replacement-new{color:coral}",
    );
  });

  it("invalidates stale unknown-language warnings immediately on file edit before the replacement transform starts", async () => {
    const oldStarted = deferred();
    const oldRelease = deferred();
    const loadLanguage = vi.fn((language) => {
      if (language === "stale-unknown") {
        oldStarted.resolve();
        return oldRelease.promise;
      }
      return Promise.reject(Object.assign(new Error("unknown lang"), { code: "ERR_UNSUPPORTED" }));
    });
    const highlighter = makeFakeHighlighter({ loadLanguage });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const file = "/src/edit-warn.ts";
    const oldSource = `import { code } from "@ferriki/core/macro"; export const a = code("old", { language: "stale-unknown" });`;
    const newSource = `import { code } from "@ferriki/core/macro"; export const b = code("new", { language: "fresh-unknown" });`;

    const staleContext = context();
    const staleTransform = vitePlugin.transform.handler.call(staleContext, oldSource, file);
    await oldStarted.promise;

    // File edit happens before Vite starts the replacement transform.
    await vitePlugin.hotUpdate({ type: "update", file, read: () => newSource });

    // Stale transform rejects BEFORE the replacement transform even starts.
    oldRelease.reject(Object.assign(new Error("stale unknown"), { code: "ERR_UNSUPPORTED" }));
    await staleTransform;
    expect(staleContext.warn).not.toHaveBeenCalled();

    // Replacement transform starts afterward and must still warn once (not suppressed).
    const freshContext = context();
    await vitePlugin.transform.handler.call(freshContext, newSource, file);
    expect(freshContext.warn).toHaveBeenCalledTimes(1);
    expect(freshContext.warn.mock.calls[0][0]).toContain("fresh-unknown");

    await vitePlugin.closeBundle();
  });

  it("clears client and SSR macro state on watchChange update when server.hmr is false", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: ".ferriki-style-no-hmr{color:orange}",
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const tempDir = await mkdtemp(join(tmpdir(), "ferriki-vite-no-hmr-"));
    const filePath = join(tempDir, "block.tsx");
    const withMacro =
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="const x = 1;" language="ts" />;';
    await writeFile(filePath, withMacro, "utf8");

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };
    const send = vi.fn();
    vitePlugin.configureServer({
      config: { base: "/", server: { hmr: false } },
      middlewares: { use() {} },
      ws: { send },
    });

    try {
      await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        withMacro,
        filePath,
      );
      await vitePlugin.transform.handler.call(
        { ...context(), environment: ssrEnv },
        withMacro,
        filePath,
      );
      expect(Object.keys(vitePlugin.api.codeElementBlocks("client"))).toHaveLength(1);
      expect(Object.keys(vitePlugin.api.codeElementBlocks("ssr"))).toHaveLength(1);
      expect(vitePlugin.api.codeElementCss("ssr")).toContain(".ferriki-style-no-hmr");

      await writeFile(filePath, "export const block = <p>plain</p>;", "utf8");
      await vitePlugin.watchChange.call({ environment: clientEnv }, filePath, { event: "update" });

      expect(vitePlugin.api.codeElementBlocks("client")).toEqual({});
      expect(vitePlugin.api.codeElementBlocks("ssr")).toEqual({});
      expect(vitePlugin.api.codeElementCss("ssr")).toBe("");
    } finally {
      await vitePlugin.closeBundle();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prevents a slow hotUpdate read() from evicting state from a newer restored transform", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code.includes("v1") ? ".ferriki-style-v1{color:red}" : ".ferriki-style-v2{color:blue}",
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const id = "/src/toggle.tsx";
    const v1Source = `import { code } from "@ferriki/core/macro";
import { Code } from "@ferriki/core/react/macro";
export const snippet = code("v1", { language: "ts" });
export const block = <Code source="v1" language="ts" />;`;
    const v2Source = `import { code } from "@ferriki/core/macro";
import { Code } from "@ferriki/core/react/macro";
export const snippet = code("v2", { language: "ts" });
export const block = <Code source="v2" language="ts" />;`;

    await vitePlugin.transform.handler.call(context(), v1Source, id);

    // First hotUpdate starts reading a version that removed the macro, but pauses.
    const slowRead = deferred();
    const staleHotUpdate = vitePlugin.hotUpdate({
      type: "update",
      file: id,
      read: () => slowRead.promise,
    });

    // Meanwhile, a newer edit restores the macro and transforms v2.
    await vitePlugin.hotUpdate({
      type: "update",
      file: id,
      read: () => v2Source,
    });
    const v2Result = await vitePlugin.transform.handler.call(context(), v2Source, id);
    const v2CssId = /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(v2Result.code)?.[1];
    expect(v2CssId).toBeTruthy();

    // Now the stale hotUpdate's read() resolves with no macro; it must NOT evict v2.
    slowRead.resolve("export const block = <p>plain</p>;");
    await staleHotUpdate;

    expect(Object.values(vitePlugin.api.codeElementBlocks())).toHaveLength(1);
    expect(Object.values(vitePlugin.api.codeElementBlocks())[0]).toContain("v2");
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-v2");
    expect(vitePlugin.resolveId(v2CssId)).toBe(`\0${v2CssId}`);
    expect(vitePlugin.load(`\0${v2CssId}`)).toBe(".ferriki-style-v2{color:blue}");

    await vitePlugin.closeBundle();
  });

  it("surfaces disposal failures cleanly without emitting unhandled rejections", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const failingBuildHighlighter = makeFakeHighlighter();
      failingBuildHighlighter.dispose = vi.fn(() => {
        throw new Error("dispose failed");
      });
      const failingDevHighlighter = makeFakeHighlighter();
      const devDisposeAttempted = deferred();
      failingDevHighlighter.dispose = vi.fn(() => {
        devDisposeAttempted.resolve();
        throw new Error("server close dispose failed");
      });
      createHighlighterMock
        .mockResolvedValueOnce(failingBuildHighlighter)
        .mockResolvedValueOnce(failingDevHighlighter);

      const source = `import { code } from "@ferriki/core/macro"; export const block = code("x", { language: "ts" });`;

      const buildPlugin = ferriki({ theme: "nord" });
      await buildPlugin.transform.handler.call(context(), source, "/src/fail-close.ts");
      await expect(buildPlugin.closeBundle()).rejects.toThrow("dispose failed");
      // After rejection cleanup, a repeat closeBundle() resolves cleanly.
      await expect(buildPlugin.closeBundle()).resolves.toBeUndefined();

      const devPlugin = ferriki({ theme: "nord" });
      const httpServer = new EventEmitter();
      devPlugin.configureServer({
        config: { base: "/" },
        httpServer,
        middlewares: { use() {} },
        ws: { send() {} },
      });
      await devPlugin.transform.handler.call(context(), source, "/src/fail-dev.ts");
      httpServer.emit("close");
      await devDisposeAttempted.promise;

      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("cleans up spilled CSS and exit listeners when a middleware-mode server closes", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:sienna}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const originalClose = vi.fn(async () => {});
    const server = {
      config: { base: "/" },
      httpServer: null,
      middlewares: { use() {} },
      ws: { send() {} },
      close: originalClose,
    };
    vitePlugin.configureServer(server);
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    const first = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("mw0", { language: "ts" });',
      "/src/middleware.ts",
    );
    const loadedCssId = cssIdOf(first);
    expect(vitePlugin.resolveId(loadedCssId)).toBe(`\0${loadedCssId}`);

    const second = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("mw-abandoned", { language: "ts" });',
      "/src/middleware.ts",
    );
    const abandonedCssId = cssIdOf(second);
    expect(vitePlugin.resolveId(abandonedCssId)).toBe(`\0${abandonedCssId}`);

    for (let index = 1; index <= 70; index++) {
      const next = await vitePlugin.transform.handler.call(
        context(),
        `import { code } from "@ferriki/core/macro"; export const x = code("mw${index}", { language: "ts" });`,
        "/src/middleware.ts",
      );
      vitePlugin.load(`\0${cssIdOf(next)}`);
    }

    // Both spilled to disk and stay resolvable/reloadable until server.close() cleans up the spill dir.
    expect(vitePlugin.resolveId(loadedCssId)).toBe(`\0${loadedCssId}`);
    expect(vitePlugin.load(`\0${loadedCssId}`)).toBe(".ferriki-style-mw0{color:sienna}");
    expect(vitePlugin.load(`\0${loadedCssId}`)).toBe(".ferriki-style-mw0{color:sienna}");
    expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);

    await server.close();
    expect(originalClose).toHaveBeenCalledTimes(1);
    expect(highlighter.dispose).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
    expect(vitePlugin.resolveId(loadedCssId)).toBeNull();
    expect(vitePlugin.load(`\0${loadedCssId}`)).toBeNull();
    expect(vitePlugin.load(`\0${abandonedCssId}`)).toBeNull();
  });

  it("keeps a replacement middleware devServer active when old environments close during server.restart()", async () => {
    const firstHighlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    const secondHighlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock
      .mockResolvedValueOnce(firstHighlighter)
      .mockResolvedValueOnce(secondHighlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client" };
    const send1 = vi.fn();
    const close1 = vi.fn(async () => {});
    const server1 = {
      config: { base: "/" },
      httpServer: null,
      middlewares: { use() {} },
      ws: { send: send1 },
      close: close1,
    };
    vitePlugin.configureServer(server1);

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="before-restart" language="ts" />;',
      "/src/restart.tsx",
    );
    expect(send1).toHaveBeenCalledTimes(1);

    // Simulate Vite server.restart(): configure replacement server BEFORE closing old environment and server1.
    const send2 = vi.fn();
    const close2 = vi.fn(async () => {});
    const server2 = {
      config: { base: "/" },
      httpServer: null,
      middlewares: { use() {} },
      ws: { send: send2 },
      close: close2,
    };
    vitePlugin.configureServer(server2);

    await vitePlugin.closeBundle.call({ environment: clientEnv });
    await server1.close();
    expect(close1).toHaveBeenCalledTimes(1);

    send1.mockClear();
    send2.mockClear();
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="after-restart" language="ts" />;',
      "/src/restart.tsx",
    );
    expect(send1).not.toHaveBeenCalled();
    expect(send2).toHaveBeenCalledTimes(1);

    await server2.close();
    expect(close2).toHaveBeenCalledTimes(1);
    expect(secondHighlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves spilled CSS for SSR when client closeBundle runs in parallel", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:steelblue}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    const sharedSource =
      'import { code } from "@ferriki/core/macro"; export const x = code("shared-spill", { language: "ts" });';
    const clientRes = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      sharedSource,
      "/src/shared-spill.ts",
    );
    const ssrRes = await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      sharedSource,
      "/src/shared-spill.ts",
    );
    const sharedCssId = cssIdOf(clientRes);
    expect(sharedCssId).toBe(cssIdOf(ssrRes));

    // Both environments resolve sharedCssId before it is evicted from RAM.
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    expect(vitePlugin.resolveId.call({ environment: ssrEnv }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );

    // Supersede both environments and churn 70 loaded entries so sharedCssId spills to disk.
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("client-next", { language: "ts" });',
      "/src/shared-spill.ts",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("ssr-next", { language: "ts" });',
      "/src/shared-spill.ts",
    );
    for (let index = 0; index < 70; index++) {
      const next = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        `import { code } from "@ferriki/core/macro"; export const x = code("spill-churn-${index}", { language: "ts" });`,
        "/src/spill-churn.ts",
      );
      vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
    }

    expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);

    // Client closes first: client's claim is removed, while SSR's spilled file stays intact!
    await vitePlugin.closeBundle.call({ environment: clientEnv });
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBeNull();
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${sharedCssId}`)).toBeNull();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);

    // SSR loads and can reload the spilled CSS cleanly until SSR closeBundle() reclaims it.
    expect(vitePlugin.load.call({ environment: ssrEnv }, `\0${sharedCssId}`)).toBe(
      ".ferriki-style-shared-spill{color:steelblue}",
    );
    expect(vitePlugin.load.call({ environment: ssrEnv }, `\0${sharedCssId}`)).toBe(
      ".ferriki-style-shared-spill{color:steelblue}",
    );
    await vitePlugin.closeBundle.call({ environment: ssrEnv });
    expect(vitePlugin.load.call({ environment: ssrEnv }, `\0${sharedCssId}`)).toBeNull();
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
  });

  it("removes superseded React CSS rules when their source file is deleted or drops its last macro import", async () => {
    const oldStarted = deferred();
    const oldRelease = deferred();
    const secondOldStarted = deferred();
    const secondOldRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          oldStarted.resolve();
          return oldRelease.promise;
        }
        if (language === "python") {
          secondOldStarted.resolve();
          return secondOldRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:orchid}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const send = vi.fn();
    vitePlugin.configureServer({
      config: { base: "/" },
      httpServer: new EventEmitter(),
      middlewares: { use() {} },
      ws: { send },
    });

    // File 1: out-of-order React transform leaves superseded rules, then the file is deleted.
    const stale1 = vitePlugin.transform.handler.call(
      context(),
      'import { Code } from "@ferriki/core/react/macro"; export const a = <Code source="del-old" language="rust" />;',
      "/src/react-delete.tsx",
    );
    await oldStarted.promise;
    await vitePlugin.transform.handler.call(
      context(),
      'import { Code } from "@ferriki/core/react/macro"; export const a = <Code source="del-new" language="ts" />;',
      "/src/react-delete.tsx",
    );
    oldRelease.resolve();
    await stale1;
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-del-old");
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-del-new");

    send.mockClear();
    await vitePlugin.hotUpdate({ type: "delete", file: "/src/react-delete.tsx" });
    expect(vitePlugin.api.codeElementCss()).toBe("");
    expect(send).toHaveBeenCalledTimes(1);

    // File 2: out-of-order React transform leaves superseded rules, then its last macro import is removed.
    const stale2 = vitePlugin.transform.handler.call(
      context(),
      'import { Code } from "@ferriki/core/react/macro"; export const b = <Code source="rm-old" language="python" />;',
      "/src/react-remove-macro.tsx",
    );
    await secondOldStarted.promise;
    await vitePlugin.transform.handler.call(
      context(),
      'import { Code } from "@ferriki/core/react/macro"; export const b = <Code source="rm-new" language="ts" />;',
      "/src/react-remove-macro.tsx",
    );
    secondOldRelease.resolve();
    await stale2;
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-rm-old");
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-rm-new");

    send.mockClear();
    await vitePlugin.hotUpdate({
      type: "update",
      file: "/src/react-remove-macro.tsx",
      read: () => "export const b = <p>plain</p>;",
    });
    expect(vitePlugin.api.codeElementCss()).toBe("");
    expect(send).toHaveBeenCalledTimes(1);

    await vitePlugin.closeBundle();
  });

  it("keeps issued CSS in memory when spilling to disk fails", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:crimson}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    const first = await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const x = code("unspillable", { language: "ts" });',
      "/src/spill-fail.ts",
    );
    const issuedCssId = cssIdOf(first);
    expect(vitePlugin.resolveId(issuedCssId)).toBe(`\0${issuedCssId}`);

    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    const missingTempDir = join(tmpdir(), `ferriki-missing-${Date.now()}`, "nested");
    process.env.TMPDIR = missingTempDir;
    process.env.TEMP = missingTempDir;
    process.env.TMP = missingTempDir;
    try {
      for (let index = 1; index <= 70; index++) {
        const next = await vitePlugin.transform.handler.call(
          context(),
          `import { code } from "@ferriki/core/macro"; export const x = code("spillfail${index}", { language: "ts" });`,
          "/src/spill-fail.ts",
        );
        vitePlugin.load(`\0${cssIdOf(next)}`);
      }
      // Spilling failed, so issuedCssId stayed in memory and still loads cleanly without leaking exit listeners.
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(vitePlugin.load(`\0${issuedCssId}`)).toBe(".ferriki-style-unspillable{color:crimson}");
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // After load() cleared the issued claim, subsequent churn evicts it normally.
    for (let index = 71; index <= 140; index++) {
      const next = await vitePlugin.transform.handler.call(
        context(),
        `import { code } from "@ferriki/core/macro"; export const x = code("post-fail${index}", { language: "ts" });`,
        "/src/spill-fail.ts",
      );
      vitePlugin.load(`\0${cssIdOf(next)}`);
    }
    expect(vitePlugin.resolveId(issuedCssId)).toBeNull();
    expect(vitePlugin.load(`\0${issuedCssId}`)).toBeNull();
    await vitePlugin.closeBundle();
  });

  it("ignores unrelated non-macro file edits while invalidating in-flight macro transforms on their own edits", async () => {
    const macroStarted = deferred();
    const macroRelease = deferred();
    const loadLanguage = vi.fn((language) => {
      if (language === "slow-unknown") {
        macroStarted.resolve();
        return macroRelease.promise;
      }
      return Promise.reject(Object.assign(new Error("unknown lang"), { code: "ERR_UNSUPPORTED" }));
    });
    const highlighter = makeFakeHighlighter({ loadLanguage });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const unrelatedRead = vi.fn(() => "export const value = 1;");
    for (let index = 0; index < 100; index++) {
      await vitePlugin.hotUpdate({
        type: "update",
        file: `/src/unrelated-${index}.ts`,
        read: unrelatedRead,
      });
      await vitePlugin.watchChange(`/src/unrelated-${index}.ts`, { event: "update" });
    }
    expect(unrelatedRead).not.toHaveBeenCalled();

    const macroFile = "/src/active-macro.ts";
    const macroContext = context();
    const macroTransform = vitePlugin.transform.handler.call(
      macroContext,
      'import { code } from "@ferriki/core/macro"; export const a = code("x", { language: "slow-unknown" });',
      macroFile,
    );
    await macroStarted.promise;

    // Editing unrelated files while macroFile is in-flight must NOT invalidate macroFile's warning.
    await vitePlugin.hotUpdate({
      type: "update",
      file: "/src/unrelated-other.ts",
      read: unrelatedRead,
    });
    macroRelease.reject(Object.assign(new Error("still unknown"), { code: "ERR_UNSUPPORTED" }));
    await macroTransform;
    expect(macroContext.warn).toHaveBeenCalledTimes(1);

    await vitePlugin.closeBundle();
  });

  it("does not spill virtual CSS already cached in Vite's module graph on repeat resolveId", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:peru}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const moduleGraphEntries = new Map();
    const clientEnv = {
      name: "client",
      moduleGraph: {
        getModuleById: (id) => moduleGraphEntries.get(id),
      },
    };
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    const sharedSource =
      'import { code } from "@ferriki/core/macro"; export const x = code("cached-css", { language: "ts" });';
    const first = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      sharedSource,
      "/src/cached-a.ts",
    );
    const cssId = cssIdOf(first);
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssId)).toBe(`\0${cssId}`);
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssId}`)).toBe(
      ".ferriki-style-cached-css{color:peru}",
    );

    // Vite caches the virtual CSS module's transformResult in its environment moduleGraph.
    moduleGraphEntries.set(`\0${cssId}`, { transformResult: { code: "cached" } });

    // A second importer resolves the same CSS ID while cached in Vite (no second load() occurs).
    const second = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      sharedSource,
      "/src/cached-b.ts",
    );
    expect(cssIdOf(second)).toBe(cssId);
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssId)).toBe(`\0${cssId}`);

    // Supersede both importers and churn 70 loaded entries so cssId is evicted from RAM.
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("next-a", { language: "ts" });',
      "/src/cached-a.ts",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("next-b", { language: "ts" });',
      "/src/cached-b.ts",
    );
    for (let index = 0; index < 70; index++) {
      const next = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        `import { code } from "@ferriki/core/macro"; export const x = code("graph-churn-${index}", { language: "ts" });`,
        "/src/graph-churn.ts",
      );
      vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
    }

    // Evicted from RAM, yet stays resolvable/reloadable from spill across invalidations until closeBundle() cleans up.
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssId)).toBe(`\0${cssId}`);
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssId}`)).toBe(
      ".ferriki-style-cached-css{color:peru}",
    );

    await vitePlugin.closeBundle.call({ environment: clientEnv });
    expect(process.listenerCount("exit")).toBe(exitListenersBefore);
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssId)).toBeNull();
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssId}`)).toBeNull();
  });

  it("emits only one unknown-language warning per edit across watchChange and client/SSR hotUpdate", async () => {
    const highlighter = makeFakeHighlighter({
      loadLanguage: () =>
        Promise.reject(Object.assign(new Error("unknown lang"), { code: "ERR_UNSUPPORTED" })),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };
    const file = "/src/multi-env-warn.ts";
    const initialSource = `import { code } from "@ferriki/core/macro"; export const a = code("v1", { language: "unknown-lang" });`;
    const editedSource = `import { code } from "@ferriki/core/macro"; export const a = code("v2", { language: "unknown-lang" });`;
    const secondEditSource = `import { code } from "@ferriki/core/macro"; export const a = code("v3", { language: "unknown-lang" });`;

    // Initial load across both environments warns once.
    const initialClientCtx = { ...context(), environment: clientEnv };
    const initialSsrCtx = { ...context(), environment: ssrEnv };
    await vitePlugin.transform.handler.call(initialClientCtx, initialSource, file);
    await vitePlugin.transform.handler.call(initialSsrCtx, initialSource, file);
    expect(initialClientCtx.warn).toHaveBeenCalledTimes(1);
    expect(initialSsrCtx.warn).not.toHaveBeenCalled();

    // Vite edit sequence: watchChange -> client hotUpdate(T1) + client transform -> SSR hotUpdate(T1) + SSR transform.
    await vitePlugin.watchChange(file, { event: "update" });
    await vitePlugin.hotUpdate.call(
      { environment: clientEnv },
      { type: "update", file, timestamp: 123_456, read: () => editedSource },
    );
    const editClientCtx = { ...context(), environment: clientEnv };
    await vitePlugin.transform.handler.call(editClientCtx, editedSource, file);
    expect(editClientCtx.warn).toHaveBeenCalledTimes(1);

    await vitePlugin.hotUpdate.call(
      { environment: ssrEnv },
      { type: "update", file, timestamp: 123_456, read: () => editedSource },
    );
    const editSsrCtx = { ...context(), environment: ssrEnv };
    await vitePlugin.transform.handler.call(editSsrCtx, editedSource, file);
    expect(editSsrCtx.warn).not.toHaveBeenCalled();

    // A subsequent edit with a new timestamp resets and warns once again.
    await vitePlugin.watchChange(file, { event: "update" });
    await vitePlugin.hotUpdate.call(
      { environment: clientEnv },
      { type: "update", file, timestamp: 123_999, read: () => secondEditSource },
    );
    const secondEditCtx = { ...context(), environment: clientEnv };
    await vitePlugin.transform.handler.call(secondEditCtx, secondEditSource, file);
    expect(secondEditCtx.warn).toHaveBeenCalledTimes(1);

    await vitePlugin.closeBundle();
  });

  it("keeps pending spilled CSS exempt from the 16 MiB byte budget and LRU-evicts settled entries once loaded", async () => {
    const padding = "a:1;".repeat(256 * 1024); // 1 MiB per stylesheet
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code.startsWith("meg-")
          ? `.ferriki-style-${code}{${padding}}`
          : `.ferriki-style-${code}{color:maroon}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-budget-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const clientEnv = { name: "client" };
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    try {
      // Spill 20 x ~1 MiB pending (`awaitingLoad === true`) stylesheets (>16 MiB total) before loading any!
      const resolvedIds = [];
      for (let index = 0; index < 20; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("meg-${index}", { language: "ts" });`,
          "/src/spill-budget.ts",
        );
        const cssId = cssIdOf(next);
        expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssId)).toBe(`\0${cssId}`);
        resolvedIds.push(cssId);
      }
      for (let index = 0; index < 65; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("flush-a-${index}", { language: "ts" });`,
          "/src/spill-budget.ts",
        );
        vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
      }

      // ALL 20 pending stylesheets must still load cleanly (CSS #0 was NOT evicted while awaitingLoad === true)!
      for (let index = 0; index < 20; index++) {
        expect(
          vitePlugin.load.call({ environment: clientEnv }, `\0${resolvedIds[index]}`),
        ).toContain(`.ferriki-style-meg-${index}{`);
      }

      // Now all 20 are settled (`awaitingLoad === false`): settled LRU eviction keeps total spilled CSS <= 16 MiB,
      // evicting oldest settled entries (meg-0..meg-4) while keeping newest settled entries reloadable!
      const spillDirs = await readdir(spillParent);
      expect(spillDirs).toHaveLength(1);
      const spillDirPath = join(spillParent, spillDirs[0]);
      const remainingFiles = await readdir(spillDirPath);
      let totalSpilledBytes = 0;
      for (const file of remainingFiles) {
        if (file.endsWith(".css")) totalSpilledBytes += (await stat(join(spillDirPath, file))).size;
      }
      expect(totalSpilledBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${resolvedIds[0]}`)).toBeNull();
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${resolvedIds[19]}`)).toContain(
        ".ferriki-style-meg-19{",
      );
      // Reloading a retained settled entry works repeatedly.
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${resolvedIds[19]}`)).toContain(
        ".ferriki-style-meg-19{",
      );
    } finally {
      await vitePlugin.closeBundle.call({ environment: clientEnv });
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(await readdir(spillParent)).toEqual([]);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("does not re-inject React CSS into codeElementCss when an in-flight transform finishes after file deletion", async () => {
    const started = deferred();
    const release = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: () => {
        started.resolve();
        return release.promise;
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:crimson}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const send = vi.fn();
    vitePlugin.configureServer({
      config: { base: "/" },
      httpServer: new EventEmitter(),
      middlewares: { use() {} },
      ws: { send },
    });

    const staleTransform = vitePlugin.transform.handler.call(
      context(),
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="deleted-inflight" language="ts" />;',
      "/src/deleted-inflight.tsx",
    );
    await started.promise;

    await vitePlugin.hotUpdate({ type: "delete", file: "/src/deleted-inflight.tsx" });
    send.mockClear();

    release.resolve();
    await staleTransform;

    expect(vitePlugin.api.codeElementBlocks()).toEqual({});
    expect(vitePlugin.api.codeElementCss()).toBe("");
    expect(send).not.toHaveBeenCalled();

    await vitePlugin.closeBundle();
  });

  it("registers the last successful React transform blocks and CSS when a newer overlapping transform fails", async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          firstStarted.resolve();
          return firstRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const send = vi.fn();
    vitePlugin.configureServer({
      config: { base: "/" },
      httpServer: new EventEmitter(),
      middlewares: { use() {} },
      ws: { send },
    });

    const firstTransform = vitePlugin.transform.handler.call(
      context(),
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="first-valid" language="rust" />;',
      "/src/fail-overlap.tsx",
    );
    await firstStarted.promise;

    // A newer overlapping transform fails with a syntax error before firstTransform settles.
    await expect(
      vitePlugin.transform.handler.call(
        context(),
        'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="broken" language="ts"',
        "/src/fail-overlap.tsx",
      ),
    ).rejects.toThrow();

    send.mockClear();
    firstRelease.resolve();
    const firstResult = await firstTransform;
    expect(firstResult.code).toContain("first-valid");

    // Both the React block registry entry AND palette CSS must be registered so renderCodeElements succeeds.
    const blocks = vitePlugin.api.codeElementBlocks();
    const refs = Object.keys(blocks);
    expect(refs).toHaveLength(1);
    expect(blocks[refs[0]]).toContain("first-valid");
    expect(
      vitePlugin.api.renderCodeElements(`<ferriki-code code-ref="${refs[0]}"></ferriki-code>`),
    ).toContain("first-valid");
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-first-valid{color:teal}");
    expect(send).toHaveBeenCalledTimes(1);

    // Removing the macro import later still clears both blocks and palette cleanly.
    send.mockClear();
    await vitePlugin.hotUpdate({
      type: "update",
      file: "/src/fail-overlap.tsx",
      read: () => "export const block = <p>plain</p>;",
    });
    expect(vitePlugin.api.codeElementBlocks()).toEqual({});
    expect(vitePlugin.api.codeElementCss()).toBe("");
    expect(send).toHaveBeenCalledTimes(1);

    await vitePlugin.closeBundle();
  });

  it("prunes module indexes when superseded React CSS is retired on closeBundle", async () => {
    const slowStarted = deferred();
    const slowRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          slowStarted.resolve();
          return slowRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code === "slow-react" ? ".ferriki-style-slow-react{color:teal}" : "",
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const file = "/src/prune-superseded.tsx";
    const slowReactTransform = vitePlugin.transform.handler.call(
      context(),
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="slow-react" language="rust" />;',
      file,
    );
    await slowStarted.promise;

    // A newer transform replaces the React block with a macro call that produces no CSS.
    await vitePlugin.transform.handler.call(
      context(),
      'import { code } from "@ferriki/core/macro"; export const snippet = code("no-css", { language: "ts" });',
      file,
    );

    slowRelease.resolve();
    await slowReactTransform;
    expect(vitePlugin.api.codeElementBlocks()).toEqual({});
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-slow-react{color:teal}");

    // Retiring superseded React CSS on closeBundle prunes the now-unused module generation & file index.
    await vitePlugin.closeBundle();
    expect(vitePlugin.api.codeElementCss()).toBe("");

    const read = vi.fn(() => "export const plain = 1;");
    await vitePlugin.hotUpdate({ type: "update", file, read });
    expect(read).not.toHaveBeenCalled();
  });

  it("bounds in-memory fallback and backs off spill retries when the temp directory is unavailable", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:darkcyan}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-backoff-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    const missingTempDir = join(spillParent, "missing", "nested");
    process.env.TMPDIR = missingTempDir;
    process.env.TEMP = missingTempDir;
    process.env.TMP = missingTempDir;

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    vi.useFakeTimers();
    try {
      const resolvedIds = [];
      for (let index = 0; index < 200; index++) {
        const next = await vitePlugin.transform.handler.call(
          context(),
          `import { code } from "@ferriki/core/macro"; export const x = code("backoff-${index}", { language: "ts" });`,
          "/src/spill-backoff.ts",
        );
        const cssId = cssIdOf(next);
        expect(vitePlugin.resolveId(cssId)).toBe(`\0${cssId}`);
        resolvedIds.push(cssId);
      }
      await vitePlugin.transform.handler.call(
        context(),
        'import { code } from "@ferriki/core/macro"; export const x = code("backoff-final", { language: "ts" });',
        "/src/spill-backoff.ts",
      );

      // Retention is strictly bounded to newest 64 in RAM + newest 64 in fallback; oldest 72 evicted.
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(vitePlugin.load(`\0${resolvedIds[0]}`)).toBeNull();
      expect(vitePlugin.load(`\0${resolvedIds[71]}`)).toBeNull();
      expect(vitePlugin.load(`\0${resolvedIds[72]}`)).toBe(
        ".ferriki-style-backoff-72{color:darkcyan}",
      );
      expect(vitePlugin.load(`\0${resolvedIds[135]}`)).toBe(
        ".ferriki-style-backoff-135{color:darkcyan}",
      );
      expect(vitePlugin.load(`\0${resolvedIds[136]}`)).toBe(
        ".ferriki-style-backoff-136{color:darkcyan}",
      );
      expect(vitePlugin.load(`\0${resolvedIds[199]}`)).toBe(
        ".ferriki-style-backoff-199{color:darkcyan}",
      );

      // Restore a writable temp dir, but remain inside the 5s retry backoff window: no disk spill yet.
      process.env.TMPDIR = spillParent;
      process.env.TEMP = spillParent;
      process.env.TMP = spillParent;
      const suppressed = await vitePlugin.transform.handler.call(
        context(),
        'import { code } from "@ferriki/core/macro"; export const x = code("suppressed-retry", { language: "ts" });',
        "/src/spill-backoff.ts",
      );
      const suppressedCssId = cssIdOf(suppressed);
      expect(vitePlugin.resolveId(suppressedCssId)).toBe(`\0${suppressedCssId}`);
      for (let index = 0; index < 65; index++) {
        const next = await vitePlugin.transform.handler.call(
          context(),
          `import { code } from "@ferriki/core/macro"; export const x = code("within-backoff-${index}", { language: "ts" });`,
          "/src/spill-backoff.ts",
        );
        vitePlugin.load(`\0${cssIdOf(next)}`);
      }
      expect(await readdir(spillParent)).toEqual([]);
      expect(vitePlugin.load(`\0${suppressedCssId}`)).toBe(
        ".ferriki-style-suppressed-retry{color:darkcyan}",
      );

      // Once the backoff window elapses, disk spilling resumes cleanly.
      vi.advanceTimersByTime(5_000);
      const recovered = await vitePlugin.transform.handler.call(
        context(),
        'import { code } from "@ferriki/core/macro"; export const x = code("recovered-spill", { language: "ts" });',
        "/src/spill-backoff.ts",
      );
      const recoveredCssId = cssIdOf(recovered);
      expect(vitePlugin.resolveId(recoveredCssId)).toBe(`\0${recoveredCssId}`);
      for (let index = 0; index < 65; index++) {
        const next = await vitePlugin.transform.handler.call(
          context(),
          `import { code } from "@ferriki/core/macro"; export const x = code("after-backoff-${index}", { language: "ts" });`,
          "/src/spill-backoff.ts",
        );
        vitePlugin.load(`\0${cssIdOf(next)}`);
      }
      expect(await readdir(spillParent)).toHaveLength(1);
      expect(vitePlugin.load(`\0${recoveredCssId}`)).toBe(
        ".ferriki-style-recovered-spill{color:darkcyan}",
      );
    } finally {
      vi.useRealTimers();
      await vitePlugin.closeBundle();
      expect(await readdir(spillParent)).toEqual([]);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("ignores a delayed stale hotUpdate read() after a macro import is removed and restored while a transform is running", async () => {
    const started = deferred();
    const release = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: () => {
        started.resolve();
        return release.promise;
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const file = "/src/remove-restore-race.tsx";
    const withMacro =
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="still-valid" language="rust" />;';

    const inflightTransform = vitePlugin.transform.handler.call(context(), withMacro, file);
    await started.promise;

    // Edit 1 removes the macro import, but its async read() is delayed.
    const slowRemovalRead = deferred();
    const staleRemovalUpdate = vitePlugin.hotUpdate({
      type: "update",
      file,
      read: () => slowRemovalRead.promise,
    });

    // Edit 2 restores the macro import BEFORE a new transform starts and BEFORE Edit 1's read() settles.
    await vitePlugin.hotUpdate({
      type: "update",
      file,
      read: () => withMacro,
    });

    // The earlier transform finishes and publishes its React blocks and palette CSS.
    release.resolve();
    await inflightTransform;
    expect(Object.values(vitePlugin.api.codeElementBlocks())).toHaveLength(1);
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-still-valid{color:teal}");

    // Now Edit 1's delayed read() resolves without macro imports: it must NOT erase valid state!
    slowRemovalRead.resolve("export const block = <p>plain</p>;");
    await staleRemovalUpdate;

    expect(Object.values(vitePlugin.api.codeElementBlocks())).toHaveLength(1);
    expect(Object.values(vitePlugin.api.codeElementBlocks())[0]).toContain("still-valid");
    expect(vitePlugin.api.codeElementCss()).toContain(".ferriki-style-still-valid{color:teal}");

    await vitePlugin.closeBundle();
  });

  it("keeps CSS #1 loadable across 150 distinct macro edits in a real Vite dev server with preTransformRequests: false", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-vite-pretransform-spill-"));
    const root = await realpath(await mkdtemp(join(tmpdir(), "ferriki-vite-pretransform-root-")));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const srcDir = join(root, "src");
    const blockPath = join(srcDir, "block.ts");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      blockPath,
      'import { code } from "@ferriki/core/macro"; export const block = code("edit-0", { language: "ts" });',
      "utf8",
    );

    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [ferriki({ theme: "nord", styleMode: "classes" })],
      optimizeDeps: { noDiscovery: true },
      server: {
        middlewareMode: true,
        preTransformRequests: false,
        fs: { allow: [root] },
      },
      appType: "custom",
    });

    try {
      let firstCssUrl;
      for (let index = 0; index < 150; index++) {
        await writeFile(
          blockPath,
          `import { code } from "@ferriki/core/macro"; export const block = code("edit-${index}", { language: "ts" });`,
          "utf8",
        );
        const existingModule = await server.moduleGraph.getModuleByUrl("/src/block.ts");
        if (existingModule) server.moduleGraph.invalidateModule(existingModule);
        const transformed = await server.transformRequest("/src/block.ts");
        expect(transformed?.code).toBeTruthy();
        if (index === 0) {
          firstCssUrl = /import "([^"]*virtual:ferriki-vite\/[^"]+\.css)";/.exec(
            transformed.code,
          )?.[1];
          expect(firstCssUrl).toBeTruthy();
        }
      }

      // RAM stayed bounded (<= 64 unowned superseded entries), spilling older resolved CSS to disk.
      const spillDirs = await readdir(spillParent);
      expect(spillDirs).toHaveLength(1);
      const spilledFiles = await readdir(join(spillParent, spillDirs[0]));
      expect(spilledFiles.length).toBeGreaterThan(80);

      // Loading CSS #1 through Vite succeeds cleanly without ENOENT, and stays reloadable after invalidateAll()!
      const firstCssId = firstCssUrl.replace(/^\/@id\/__x00__/u, "\0");
      const loadedCss1 = await server.transformRequest(firstCssId);
      expect(loadedCss1?.code).toContain(".ferriki-style-edit-0{color:teal}");

      server.moduleGraph.invalidateAll();
      const reloadedCss1 = await server.transformRequest(firstCssId);
      expect(reloadedCss1?.code).toContain(".ferriki-style-edit-0{color:teal}");
    } finally {
      await server.close();
      expect(await readdir(spillParent)).toEqual([]);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears removed macros even when an overlapping old-source transform starts while hotUpdate read() is pending", async () => {
    const overlapStarted = deferred();
    const overlapRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          overlapStarted.resolve();
          return overlapRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const file = "/src/overlap-old-source.tsx";
    const oldSource =
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="old-v1" language="ts" />;';
    const slowOldSource =
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="old-v1-slow" language="rust" />;';

    await vitePlugin.transform.handler.call(context(), oldSource, file);
    expect(Object.keys(vitePlugin.api.codeElementBlocks())).toHaveLength(1);

    // File is edited to remove its macro import; hotUpdate begins awaiting read().
    const removalRead = deferred();
    const removalUpdate = vitePlugin.hotUpdate({
      type: "update",
      file,
      read: () => removalRead.promise,
    });

    // Case A: An overlapping old-source request completes BEFORE removalRead resolves (no newer file edit).
    await vitePlugin.transform.handler.call(context(), oldSource, file);

    // Case B: Another overlapping old-source request is STILL in flight when removalRead resolves.
    const inflightOldTransform = vitePlugin.transform.handler.call(context(), slowOldSource, file);
    await overlapStarted.promise;

    removalRead.resolve("export const block = <p>plain</p>;");
    await removalUpdate;

    // Both the already-completed overlapping transform and the still-in-flight one must be cleared/invalidated!
    expect(vitePlugin.api.codeElementBlocks()).toEqual({});
    expect(vitePlugin.api.codeElementCss()).toBe("");

    overlapRelease.resolve();
    await inflightOldTransform;
    expect(vitePlugin.api.codeElementBlocks()).toEqual({});
    expect(vitePlugin.api.codeElementCss()).toBe("");

    await vitePlugin.closeBundle();
  });

  it("keeps previously loaded virtual CSS reloadable after 70 edits and Vite invalidateAll()", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-vite-reload-spill-"));
    const root = await realpath(await mkdtemp(join(tmpdir(), "ferriki-vite-reload-root-")));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const srcDir = join(root, "src");
    const blockPath = join(srcDir, "block.ts");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      blockPath,
      'import { code } from "@ferriki/core/macro"; export const block = code("loaded-0", { language: "ts" });',
      "utf8",
    );

    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [ferriki({ theme: "nord", styleMode: "classes" })],
      optimizeDeps: { noDiscovery: true },
      server: {
        middlewareMode: true,
        fs: { allow: [root] },
      },
      appType: "custom",
    });

    try {
      // Load CSS #0 immediately while it is still in RAM.
      const firstTransformed = await server.transformRequest("/src/block.ts");
      const firstCssUrl = /import "([^"]*virtual:ferriki-vite\/[^"]+\.css)";/.exec(
        firstTransformed?.code ?? "",
      )?.[1];
      expect(firstCssUrl).toBeTruthy();
      const firstCssId = firstCssUrl.replace(/^\/@id\/__x00__/u, "\0");
      const firstLoaded = await server.transformRequest(firstCssId);
      expect(firstLoaded?.code).toContain(".ferriki-style-loaded-0{color:teal}");

      // Perform 70 more edits so CSS #0 is evicted from the 64-entry RAM cache.
      for (let index = 1; index <= 70; index++) {
        await writeFile(
          blockPath,
          `import { code } from "@ferriki/core/macro"; export const block = code("loaded-${index}", { language: "ts" });`,
          "utf8",
        );
        const existingModule = await server.moduleGraph.getModuleByUrl("/src/block.ts");
        if (existingModule) server.moduleGraph.invalidateModule(existingModule);
        const transformed = await server.transformRequest("/src/block.ts");
        const nextCssUrl = /import "([^"]*virtual:ferriki-vite\/[^"]+\.css)";/.exec(
          transformed?.code ?? "",
        )?.[1];
        expect(nextCssUrl).toBeTruthy();
        await server.transformRequest(nextCssUrl.replace(/^\/@id\/__x00__/u, "\0"));
      }

      // After Vite invalidates the module graph, reloading CSS #0 must still succeed!
      server.moduleGraph.invalidateAll();
      const reloaded = await server.transformRequest(firstCssId);
      expect(reloaded?.code).toContain(".ferriki-style-loaded-0{color:teal}");
    } finally {
      await server.close();
      expect(await readdir(spillParent)).toEqual([]);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prevents an in-flight transform from before file deletion from restoring stale React blocks after recreation", async () => {
    const oldStarted = deferred();
    const oldRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          oldStarted.resolve();
          return oldRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:crimson}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const file = "/src/delete-recreate.tsx";
    const send = vi.fn();
    vitePlugin.configureServer({
      config: { base: "/" },
      httpServer: new EventEmitter(),
      middlewares: { use() {} },
      ws: { send },
    });

    const oldTransform = vitePlugin.transform.handler.call(
      context(),
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="before-delete" language="rust" />;',
      file,
    );
    await oldStarted.promise;

    // Delete the file while oldTransform is still in flight.
    await vitePlugin.hotUpdate({ type: "delete", file });

    // Recreate the file at the same path with a replacement transform that fails.
    await expect(
      vitePlugin.transform.handler.call(
        context(),
        'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="broken" language="ts"',
        file,
      ),
    ).rejects.toThrow();

    // Now the pre-deletion oldTransform finishes: it must NOT restore stale blocks or CSS!
    send.mockClear();
    oldRelease.resolve();
    await oldTransform;

    expect(vitePlugin.api.codeElementBlocks()).toEqual({});
    expect(vitePlugin.api.codeElementCss()).toBe("");
    expect(send).not.toHaveBeenCalled();

    await vitePlugin.closeBundle();
  });

  it("reclaims only Ferriki-marked dead-PID spill directories and preserves unmarked, unexpected, live-PID, and symlink entries", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    let deadPid = 999_999;
    while (true) {
      try {
        process.kill(deadPid, 0);
        deadPid++;
      } catch (error) {
        if (error?.code === "ESRCH") break;
        deadPid++;
      }
    }

    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-reclaim-"));
    const abandonedDirName = `ferriki-vite-css-${deadPid}-abandoned`;
    const unmarkedDirName = `ferriki-vite-css-${deadPid}-unmarked`;
    const unexpectedDirName = `ferriki-vite-css-${deadPid}-unexpected`;
    const otherHostDirName = `ferriki-vite-css-${deadPid}-other-host`;
    const otherPidNsDirName = `ferriki-vite-css-${deadPid}-other-pidns`;
    const liveDirName = `ferriki-vite-css-${process.pid}-live-sibling`;
    const symlinkTargetName = "unrelated-target";
    const symlinkName = `ferriki-vite-css-${deadPid}-symlink`;
    const currentHostname = hostname();
    const currentPidNs =
      process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : undefined;
    const makeMarker = (pid, overrides = {}) =>
      JSON.stringify({
        app: "@ferriki/vite",
        pid,
        hostname: currentHostname,
        ...(currentPidNs !== undefined ? { pidNs: currentPidNs } : {}),
        version: 1,
        ...overrides,
      });
    const validMarker = makeMarker(deadPid);
    const validCssName = `${"a".repeat(64)}.css`;
    const validTmpName = `${"b".repeat(64)}.12345678-1234-4234-8234-123456789abc.tmp`;
    const symlinkPayloadDirName = `ferriki-vite-css-${deadPid}-symlink-payload`;
    const symlinkPayloadCssName = `${"c".repeat(64)}.css`;

    await mkdir(join(spillParent, abandonedDirName));
    await writeFile(
      join(spillParent, abandonedDirName, ".ferriki-vite-spill-v1"),
      validMarker,
      "utf8",
    );
    await writeFile(join(spillParent, abandonedDirName, validCssName), "body{}", "utf8");
    await writeFile(join(spillParent, abandonedDirName, validTmpName), "partial{}", "utf8");

    await mkdir(join(spillParent, unmarkedDirName));
    await writeFile(join(spillParent, unmarkedDirName, validCssName), "body{}", "utf8");

    await mkdir(join(spillParent, unexpectedDirName));
    await writeFile(
      join(spillParent, unexpectedDirName, ".ferriki-vite-spill-v1"),
      validMarker,
      "utf8",
    );
    await writeFile(join(spillParent, unexpectedDirName, "keep-me.txt"), "important", "utf8");

    await mkdir(join(spillParent, symlinkPayloadDirName));
    await writeFile(
      join(spillParent, symlinkPayloadDirName, ".ferriki-vite-spill-v1"),
      validMarker,
      "utf8",
    );
    await writeFile(join(spillParent, symlinkPayloadDirName, validCssName), "body{}", "utf8");
    await symlink(
      join(spillParent, symlinkTargetName),
      join(spillParent, symlinkPayloadDirName, symlinkPayloadCssName),
    );

    await mkdir(join(spillParent, otherHostDirName));
    await writeFile(
      join(spillParent, otherHostDirName, ".ferriki-vite-spill-v1"),
      makeMarker(deadPid, { hostname: `${currentHostname}-other-host` }),
      "utf8",
    );
    await writeFile(join(spillParent, otherHostDirName, validCssName), "body{}", "utf8");

    if (currentPidNs !== undefined) {
      await mkdir(join(spillParent, otherPidNsDirName));
      await writeFile(
        join(spillParent, otherPidNsDirName, ".ferriki-vite-spill-v1"),
        makeMarker(deadPid, { pidNs: "pid:[0]" }),
        "utf8",
      );
      await writeFile(join(spillParent, otherPidNsDirName, validCssName), "body{}", "utf8");
    }

    await mkdir(join(spillParent, liveDirName));
    await writeFile(
      join(spillParent, liveDirName, ".ferriki-vite-spill-v1"),
      makeMarker(process.pid),
      "utf8",
    );
    await mkdir(join(spillParent, symlinkTargetName));
    await symlink(join(spillParent, symlinkTargetName), join(spillParent, symlinkName), "dir");

    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    try {
      const first = await vitePlugin.transform.handler.call(
        context(),
        'import { code } from "@ferriki/core/macro"; export const x = code("reclaim0", { language: "ts" });',
        "/src/reclaim.ts",
      );
      const cssId = cssIdOf(first);
      expect(vitePlugin.resolveId(cssId)).toBe(`\0${cssId}`);
      for (let index = 1; index <= 70; index++) {
        const next = await vitePlugin.transform.handler.call(
          context(),
          `import { code } from "@ferriki/core/macro"; export const x = code("reclaim-${index}", { language: "ts" });`,
          "/src/reclaim.ts",
        );
        vitePlugin.load(`\0${cssIdOf(next)}`);
      }

      const entries = await readdir(spillParent);
      expect(entries).not.toContain(abandonedDirName);
      expect(entries).toContain(unmarkedDirName);
      expect(entries).toContain(unexpectedDirName);
      expect(await readdir(join(spillParent, unexpectedDirName))).toContain("keep-me.txt");
      expect(entries).toContain(symlinkPayloadDirName);
      const symlinkPayloadEntries = await readdir(join(spillParent, symlinkPayloadDirName));
      expect(symlinkPayloadEntries).toContain(".ferriki-vite-spill-v1");
      expect(symlinkPayloadEntries).toContain(validCssName);
      expect(symlinkPayloadEntries).toContain(symlinkPayloadCssName);
      expect(entries).toContain(otherHostDirName);
      if (currentPidNs !== undefined) expect(entries).toContain(otherPidNsDirName);
      expect(entries).toContain(liveDirName);
      expect(entries).toContain(symlinkName);
      expect(entries).toContain(symlinkTargetName);
      expect(
        entries.some(
          (entry) => entry.startsWith(`ferriki-vite-css-${process.pid}-`) && entry !== liveDirName,
        ),
      ).toBe(true);
    } finally {
      await vitePlugin.closeBundle();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("refuses to spill a single stylesheet larger than 16 MiB and keeps it in the in-memory fallback without triggering retry backoff", async () => {
    const oversizedCss = `.ferriki-style-huge{${"a".repeat(17 * 1024 * 1024)}}`;
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code === "huge" ? oversizedCss : `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-oversized-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    try {
      const hugeRes = await vitePlugin.transform.handler.call(
        context(),
        'import { code } from "@ferriki/core/macro"; export const x = code("huge", { language: "ts" });',
        "/src/oversized.ts",
      );
      const hugeCssId = cssIdOf(hugeRes);
      expect(vitePlugin.resolveId(hugeCssId)).toBe(`\0${hugeCssId}`);

      const normalRes = await vitePlugin.transform.handler.call(
        context(),
        'import { code } from "@ferriki/core/macro"; export const x = code("normal", { language: "ts" });',
        "/src/oversized.ts",
      );
      const normalCssId = cssIdOf(normalRes);
      expect(vitePlugin.resolveId(normalCssId)).toBe(`\0${normalCssId}`);

      for (let index = 0; index < 66; index++) {
        const next = await vitePlugin.transform.handler.call(
          context(),
          `import { code } from "@ferriki/core/macro"; export const x = code("flush-${index}", { language: "ts" });`,
          "/src/oversized.ts",
        );
        vitePlugin.load(`\0${cssIdOf(next)}`);
      }

      // The >16 MiB stylesheet was NOT written to disk, while normalCssId spilled cleanly right after it.
      const spillDirs = await readdir(spillParent);
      expect(spillDirs).toHaveLength(1);
      const spillDirPath = join(spillParent, spillDirs[0]);
      const spilledFiles = await readdir(spillDirPath);
      const hugeHash = /([0-9a-f]{64})\.css$/.exec(hugeCssId)?.[1];
      expect(spilledFiles).not.toContain(`${hugeHash}.css`);
      for (const file of spilledFiles) {
        expect((await stat(join(spillDirPath, file))).size).toBeLessThanOrEqual(16 * 1024 * 1024);
      }

      // Both stylesheets remain loadable (oversized from fallback, normal from disk spill).
      expect(vitePlugin.load(`\0${hugeCssId}`)).toBe(oversizedCss);
      expect(vitePlugin.load(`\0${normalCssId}`)).toBe(".ferriki-style-normal{color:teal}");
    } finally {
      await vitePlugin.closeBundle();
      expect(await readdir(spillParent)).toEqual([]);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("ignores an older HMR timestamp arriving while a newer environment hotUpdate is awaiting read()", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:teal}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };
    const send = vi.fn();
    vitePlugin.configureServer({
      config: { base: "/" },
      httpServer: new EventEmitter(),
      middlewares: { use() {} },
      ws: { send },
    });

    const file = "/src/out-of-order-ts.tsx";
    const withMacro =
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="ts-test" language="ts" />;';
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      withMacro,
      file,
    );
    await vitePlugin.transform.handler.call({ ...context(), environment: ssrEnv }, withMacro, file);
    expect(Object.keys(vitePlugin.api.codeElementBlocks("client"))).toHaveLength(1);
    expect(vitePlugin.api.codeElementCss("client")).toContain(".ferriki-style-ts-test");

    // Newer edit (timestamp 200) on client removes the macro import, but its read() is still pending.
    const edit2Read = deferred();
    const clientEdit2 = vitePlugin.hotUpdate.call(
      { environment: clientEnv },
      { type: "update", file, timestamp: 200, read: () => edit2Read.promise },
    );

    // An older edit's SSR hook (timestamp 100) arrives late: it must NOT advance fileEditRevision or run read().
    const olderRead = vi.fn(() => withMacro);
    await vitePlugin.hotUpdate.call(
      { environment: ssrEnv },
      { type: "update", file, timestamp: 100, read: olderRead },
    );
    expect(olderRead).not.toHaveBeenCalled();

    // Edit 2's read() now resolves without macro imports and must still clear the client registry and palette!
    send.mockClear();
    edit2Read.resolve("export const block = <p>plain</p>;");
    await clientEdit2;

    expect(vitePlugin.api.codeElementBlocks("client")).toEqual({});
    expect(vitePlugin.api.codeElementCss("client")).toBe("");

    await vitePlugin.closeBundle();
  });

  it("retires expired abandoned awaitingLoad spilled CSS back within the 16 MiB budget after 5 minutes", async () => {
    const padding = "a:1;".repeat(256 * 1024); // 1 MiB per stylesheet
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code.startsWith("ttl-")
          ? `.ferriki-style-${code}{${padding}}`
          : `.ferriki-style-${code}{color:maroon}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-ttl-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const invalidated = [];
    const clientEnv = {
      name: "client",
      moduleGraph: {
        getModuleById: (id) => ({ id, transformResult: null }),
        invalidateModule: (mod) => invalidated.push(mod.id),
      },
    };
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    vi.useFakeTimers();
    try {
      // Spill 18 x ~1 MiB pending stylesheets (>16 MiB) without loading any.
      const resolvedIds = [];
      for (let index = 0; index < 18; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("ttl-${index}", { language: "ts" });`,
          "/src/spill-ttl.ts",
        );
        const cssId = cssIdOf(next);
        expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssId)).toBe(`\0${cssId}`);
        resolvedIds.push(cssId);
      }
      for (let index = 0; index < 65; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("ttl-flush-${index}", { language: "ts" });`,
          "/src/spill-ttl.ts",
        );
        vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
      }

      // While fresh (< 5 minutes), all 18 pending entries stay protected (none invalidated)
      // and a single .unref()ed cleanup timer is armed for the earliest expiry.
      expect(invalidated).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);

      // Advance past ABANDONED_CSS_TTL_MS (5 minutes) on an idle server with zero further spills or loads:
      // the .unref()ed cleanup timer automatically retires expired pending entries back within 16 MiB!
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(vi.getTimerCount()).toBe(0);
      const spillDirs = await readdir(spillParent);
      expect(spillDirs).toHaveLength(1);
      const spillDirPath = join(spillParent, spillDirs[0]);
      let idleTotalBytes = 0;
      for (const file of await readdir(spillDirPath)) {
        if (file.endsWith(".css")) idleTotalBytes += (await stat(join(spillDirPath, file))).size;
      }
      expect(idleTotalBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      // Evicting spill files must never invalidate Vite's moduleGraph transformResult cache.
      expect(invalidated).toEqual([]);
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${resolvedIds[0]}`)).toBeNull();

      // Subsequent fresh stylesheets still spill and load cleanly after idle reclamation.
      const freshNext = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        'import { code } from "@ferriki/core/macro"; export const x = code("ttl-fresh", { language: "ts" });',
        "/src/spill-ttl.ts",
      );
      const freshCssId = cssIdOf(freshNext);
      expect(vitePlugin.resolveId.call({ environment: clientEnv }, freshCssId)).toBe(
        `\0${freshCssId}`,
      );
      for (let index = 0; index < 65; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("ttl-flush-after-${index}", { language: "ts" });`,
          "/src/spill-ttl.ts",
        );
        vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
      }

      let totalBytes = 0;
      for (const file of await readdir(spillDirPath)) {
        if (file.endsWith(".css")) totalBytes += (await stat(join(spillDirPath, file))).size;
      }
      expect(totalBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${freshCssId}`)).toContain(
        ".ferriki-style-ttl-fresh{",
      );
    } finally {
      vi.useRealTimers();
      await vitePlugin.closeBundle.call({ environment: clientEnv });
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(await readdir(spillParent)).toEqual([]);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("enforces the 64 MiB hard cap on unloaded pending spills via FIFO eviction and full-reload", async () => {
    const padding = "a:1;".repeat(256 * 1024); // ~1 MiB per stylesheet
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: code.startsWith("cap-")
          ? `.ferriki-style-${code}{${padding}}`
          : `.ferriki-style-${code}{color:olive}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-hard-cap-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const send = vi.fn();
    const clientEnv = { name: "client" };
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const server = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send },
      close: async () => {},
    };
    vitePlugin.configureServer(server);
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    try {
      // Create 70 x ~1 MiB unloaded pending stylesheets and flush them to disk without loading any.
      const resolvedIds = [];
      for (let index = 0; index < 70; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("cap-${index}", { language: "ts" });`,
          "/src/spill-hard-cap.ts",
        );
        const cssId = cssIdOf(next);
        expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssId)).toBe(`\0${cssId}`);
        resolvedIds.push(cssId);
      }
      for (let index = 0; index < 65; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("flush-${index}", { language: "ts" });`,
          "/src/spill-hard-cap.ts",
        );
        vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
      }

      const spillDirs = await readdir(spillParent);
      expect(spillDirs).toHaveLength(1);
      const spillDirPath = join(spillParent, spillDirs[0]);
      let totalBytes = 0;
      for (const file of await readdir(spillDirPath)) {
        if (file.endsWith(".css")) totalBytes += (await stat(join(spillDirPath, file))).size;
      }
      expect(totalBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(send).toHaveBeenCalledWith({ type: "full-reload" });
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${resolvedIds[0]}`)).toBeNull();
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${resolvedIds[69]}`)).toContain(
        ".ferriki-style-cap-69{",
      );
    } finally {
      await server.close();
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(await readdir(spillParent)).toEqual([]);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("keeps spilled CSS protected while another same-env transform has pendingResolves > 0 and uses net bytes when re-spilling", async () => {
    const padding = "a:1;".repeat(256 * 1024); // ~1 MiB per stylesheet
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css:
          code === "shared-dup" || code.startsWith("fill-")
            ? `.ferriki-style-${code}{${padding}}`
            : `.ferriki-style-${code}{color:navy}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-dup-pending-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const send = vi.fn();
    const clientEnv = { name: "client" };
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const server = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send },
      close: async () => {},
    };
    vitePlugin.configureServer(server);
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    try {
      // Two same-env transforms emit identical ~1 MiB CSS: first resolves, second has not resolved yet.
      const firstDup = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        'import { code } from "@ferriki/core/macro"; export const x = code("shared-dup", { language: "ts" });',
        "/src/dup-a.ts",
      );
      const sharedCssId = cssIdOf(firstDup);
      expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBe(
        `\0${sharedCssId}`,
      );

      const secondDup = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        'import { code } from "@ferriki/core/macro"; export const x = code("shared-dup", { language: "ts" });',
        "/src/dup-b.ts",
      );
      expect(cssIdOf(secondDup)).toBe(sharedCssId);

      // Push 62 additional ~1 MiB pending stylesheets (total ~63 MiB, >16 MiB and <=64 MiB) and flush all to disk.
      const fillIds = [];
      for (let index = 0; index < 62; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("fill-${index}", { language: "ts" });`,
          "/src/dup-a.ts",
        );
        const cssId = cssIdOf(next);
        expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssId)).toBe(`\0${cssId}`);
        fillIds.push(cssId);
      }
      // Also rewrite /src/dup-b.ts so sharedCssId loses all module owners and spills with pendingResolves === 1.
      const clearDupB = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        'import { code } from "@ferriki/core/macro"; export const x = code("clear-b", { language: "ts" });',
        "/src/dup-b.ts",
      );
      vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(clearDupB)}`);
      for (let index = 0; index < 65; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("flush-${index}", { language: "ts" });`,
          "/src/dup-a.ts",
        );
        vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
      }

      // First transform loads sharedCssId (clearing awaitingLoad), while second transform still has pendingResolves === 1.
      // Because pendingResolves > 0 is still fresh, sharedCssId must NOT be evicted under 16 MiB pressure!
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${sharedCssId}`)).toContain(
        ".ferriki-style-shared-dup{",
      );

      // Re-spilling an already-spilled ~1 MiB hash at ~63 MiB total has net delta 0 and must NOT evict
      // fillIds[0] or trigger full-reload.
      const thirdDup = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        'import { code } from "@ferriki/core/macro"; export const x = code("shared-dup", { language: "ts" });',
        "/src/dup-c.ts",
      );
      expect(cssIdOf(thirdDup)).toBe(sharedCssId);
      expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBe(
        `\0${sharedCssId}`,
      );
      for (let index = 0; index < 65; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("respan-${index}", { language: "ts" });`,
          "/src/dup-c.ts",
        );
        vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
      }
      expect(send).not.toHaveBeenCalled();

      // Second transform can still resolve and load sharedCssId, and fillIds[0] was never evicted!
      expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBe(
        `\0${sharedCssId}`,
      );
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${sharedCssId}`)).toContain(
        ".ferriki-style-shared-dup{",
      );
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${fillIds[0]}`)).toContain(
        ".ferriki-style-fill-0{",
      );
    } finally {
      await server.close();
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(await readdir(spillParent)).toEqual([]);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("does not block an unrelated environment closeBundle on another environment's in-flight language load", async () => {
    const ssrLoadStarted = deferred();
    const ssrLoadRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          ssrLoadStarted.resolve();
          return ssrLoadRelease.promise;
        }
        return Promise.resolve();
      },
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };

    // SSR starts a macro transform whose language load stays pending.
    const ssrTransform = vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      'import { code } from "@ferriki/core/macro"; export const block = code("fn main() {}", { language: "rust" });',
      "/src/ssr.ts",
    );
    await ssrLoadStarted.promise;

    // Client has NO Ferriki macros: its closeBundle() must finish immediately without waiting for SSR.
    await vitePlugin.closeBundle.call({ environment: clientEnv });
    expect(highlighter.dispose).not.toHaveBeenCalled();

    // Even if client later uses the shared highlighter and finishes before SSR, client closeBundle()
    // must still return immediately and keep SSR's session alive.
    const clientResult = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const block = code("const c = 1;", { language: "ts" });',
      "/src/client.ts",
    );
    expect(clientResult.code).toContain("const c = 1;");
    await vitePlugin.closeBundle.call({ environment: clientEnv });
    expect(highlighter.dispose).not.toHaveBeenCalled();
    expect(createHighlighterMock).toHaveBeenCalledTimes(1);

    // SSR finishes its language load and disposes the shared highlighter cleanly on its own closeBundle().
    ssrLoadRelease.resolve();
    const ssrResult = await ssrTransform;
    expect(ssrResult.code).toContain("fn main() {}");
    expect(highlighter.dispose).not.toHaveBeenCalled();

    await vitePlugin.closeBundle.call({ environment: ssrEnv });
    expect(highlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps spilled virtual CSS resolvable across repeated resolveId calls before load", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:crimson}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-reresolve-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const clientEnv = { name: "client" };
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    try {
      const first = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        'import { code } from "@ferriki/core/macro"; export const x = code("reresolve0", { language: "ts" });',
        "/src/reresolve.ts",
      );
      const targetCssId = cssIdOf(first);
      expect(vitePlugin.resolveId.call({ environment: clientEnv }, targetCssId)).toBe(
        `\0${targetCssId}`,
      );

      // Flush targetCssId out of RAM to disk spill without calling load() yet.
      for (let index = 1; index <= 70; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv },
          `import { code } from "@ferriki/core/macro"; export const x = code("reresolve-${index}", { language: "ts" });`,
          "/src/reresolve.ts",
        );
        vitePlugin.load.call({ environment: clientEnv }, `\0${cssIdOf(next)}`);
      }

      // Repeated resolveId() calls on the spilled entry before load() must continue resolving.
      expect(vitePlugin.resolveId.call({ environment: clientEnv }, targetCssId)).toBe(
        `\0${targetCssId}`,
      );
      expect(vitePlugin.resolveId.call({ environment: clientEnv }, targetCssId)).toBe(
        `\0${targetCssId}`,
      );
      expect(vitePlugin.load.call({ environment: clientEnv }, `\0${targetCssId}`)).toContain(
        ".ferriki-style-reresolve0{",
      );
    } finally {
      await vitePlugin.closeBundle.call({ environment: clientEnv });
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("cleans up spill directories and exit listeners created by in-flight transforms finishing during closeBundle", async () => {
    const loadStarted = deferred();
    const loadRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: () => {
        loadStarted.resolve();
        return loadRelease.promise;
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:indigo}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-closing-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const clientEnv = { name: "client" };
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });

    try {
      // Launch 260 overlapping transforms (> MAX_PENDING_CSS = 256) that finish while closeBundle() drains.
      const transforms = [];
      for (let index = 0; index < 260; index++) {
        transforms.push(
          vitePlugin.transform.handler.call(
            { ...context(), environment: clientEnv },
            `import { code } from "@ferriki/core/macro"; export const x = code("closing-${index}", { language: "rust" });`,
            "/src/closing-spill.ts",
          ),
        );
      }
      await loadStarted.promise;

      const closing = vitePlugin.closeBundle.call({ environment: clientEnv });
      loadRelease.resolve();
      await Promise.all(transforms);
      await closing;

      // All spills created by the closing session must be removed, leaving zero spill dirs and exit listeners.
      expect(await readdir(spillParent)).toEqual([]);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(highlighter.dispose).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("does not consume a newer edit's watchChange marker when a duplicate-timestamp HMR update arrives", async () => {
    const edit2LoadStarted = deferred();
    const edit2LoadRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "madeup-lang-2") {
          edit2LoadStarted.resolve();
          return edit2LoadRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtml: () => {
        const error = new Error("Unsupported language");
        error.code = "ERR_UNSUPPORTED";
        throw error;
      },
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };
    const file = "/src/dup-ts-watch.ts";
    const source1 =
      'import { code } from "@ferriki/core/macro"; export const x = code("hello", { language: "madeup-lang-1" });';
    const source2 =
      'import { code } from "@ferriki/core/macro"; export const x = code("hello", { language: "madeup-lang-2" });';

    // Edit 1: watchChange + client hotUpdate(100) + initial transform (1 warning).
    const warn1 = vi.fn();
    await vitePlugin.watchChange(file, { event: "update" });
    await vitePlugin.hotUpdate.call(
      { environment: clientEnv },
      { type: "update", file, timestamp: 100, read: async () => source1 },
    );
    await vitePlugin.transform.handler.call(
      { ...context(), warn: warn1, environment: clientEnv },
      source1,
      file,
    );
    expect(warn1).toHaveBeenCalledTimes(1);

    // Edit 2: watchChange marks edit 2, transform starts awaiting highlight().
    const warn2 = vi.fn();
    await vitePlugin.watchChange(file, { event: "update" });
    const edit2Transform = vitePlugin.transform.handler.call(
      { ...context(), warn: warn2, environment: clientEnv },
      source2,
      file,
    );
    await edit2LoadStarted.promise;

    // Delayed SSR hotUpdate from edit 1 (duplicate timestamp 100) must NOT consume edit 2's watchChange!
    await vitePlugin.hotUpdate.call(
      { environment: ssrEnv },
      { type: "update", file, timestamp: 100, read: async () => source1 },
    );
    // Edit 2's client hotUpdate(200) now consumes edit 2's watchChange without double-bumping fileEditGeneration.
    await vitePlugin.hotUpdate.call(
      { environment: clientEnv },
      { type: "update", file, timestamp: 200, read: async () => source2 },
    );

    edit2LoadRelease.resolve();
    await edit2Transform;
    expect(warn2).toHaveBeenCalledTimes(1);

    await vitePlugin.closeBundle.call({ environment: clientEnv });
  });

  it("preserves a replacement client's React CSS and virtual CSS when an old client closes while SSR keeps the shared highlighter open", async () => {
    const oldClientStarted = deferred();
    const oldClientRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          oldClientStarted.resolve();
          return oldClientRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:dodgerblue}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    // SSR keeps the shared highlighter session open.
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      'import { code } from "@ferriki/core/macro"; export const s = code("ssr-live", { language: "ts" });',
      "/src/ssr-live.ts",
    );

    // Old client starts an in-flight transform and then begins closeBundle().
    const oldClientTransform = vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const old = code("old-client", { language: "rust" });',
      "/src/old-client.ts",
    );
    await oldClientStarted.promise;
    const oldClientClosing = vitePlugin.closeBundle.call({ environment: clientEnv });

    // While old client is draining on the shared session, replacement client transforms
    // both a React macro and a virtual-CSS macro (and creates a superseded React rule too).
    const replacementCssResult = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const fresh = code("replacement-css", { language: "ts" });',
      "/src/replacement-css.ts",
    );
    const replacementCssId = cssIdOf(replacementCssResult);
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, replacementCssId)).toBe(
      `\0${replacementCssId}`,
    );

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { Code } from "@ferriki/core/react/macro"; export const block = <Code source="replacement-react" language="ts" />;',
      "/src/replacement-react.tsx",
    );

    // Old client finishes draining and its closeBundle() completes.
    oldClientRelease.resolve();
    const oldResult = await oldClientTransform;
    const oldCssId = cssIdOf(oldResult);
    await oldClientClosing;

    // Shared highlighter is still open (SSR + replacement client), old client CSS was retired,
    // and replacement client's virtual CSS and React CSS/blocks survive completely intact!
    expect(createHighlighterMock).toHaveBeenCalledTimes(1);
    expect(highlighter.dispose).not.toHaveBeenCalled();
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, replacementCssId)).toBe(
      `\0${replacementCssId}`,
    );
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${replacementCssId}`)).toBe(
      ".ferriki-style-replacement-css{color:dodgerblue}",
    );
    expect(vitePlugin.api.codeElementCss("client")).toContain("replacement-react");
    expect(Object.keys(vitePlugin.api.codeElementBlocks("client"))).toHaveLength(1);
    expect(oldCssId).toBeDefined();

    // Closing SSR then replacement client disposes the shared highlighter once.
    await vitePlugin.closeBundle.call({ environment: ssrEnv });
    expect(highlighter.dispose).not.toHaveBeenCalled();
    await vitePlugin.closeBundle.call({ environment: clientEnv });
    expect(highlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("cleans up spill directories and exit listeners created by in-flight transforms draining after httpServer close", async () => {
    const loadStarted = deferred();
    const loadRelease = deferred();
    const disposed = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: () => {
        loadStarted.resolve();
        return loadRelease.promise;
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:tomato}`,
      }),
    });
    highlighter.dispose.mockImplementation(() => {
      disposed.resolve();
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-http-close-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const httpServer = new EventEmitter();
    const clientEnv = { name: "client" };
    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    vitePlugin.configureServer({
      config: { base: "/" },
      httpServer,
      middlewares: { use() {} },
      ws: { send() {} },
    });

    try {
      const transforms = [];
      for (let index = 0; index < 260; index++) {
        transforms.push(
          vitePlugin.transform.handler.call(
            { ...context(), environment: clientEnv },
            `import { code } from "@ferriki/core/macro"; export const x = code("http-close-${index}", { language: "rust" });`,
            "/src/http-close-spill.ts",
          ),
        );
      }
      await loadStarted.promise;

      // Close httpServer directly while all 260 transforms are still in flight.
      httpServer.emit("close");
      loadRelease.resolve();
      await Promise.all(transforms);
      await disposed.promise;
      await new Promise((resolve) => setImmediate(resolve));

      expect(await readdir(spillParent)).toEqual([]);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(highlighter.dispose).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("emits the unsupported-language fallback warning when a newer transform of the same module fails to parse", async () => {
    const loadStarted = deferred();
    const loadRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: () => {
        loadStarted.resolve();
        return loadRelease.promise;
      },
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const file = "/src/parse-err-warn.ts";
    const warn1 = vi.fn();

    const firstTransform = vitePlugin.transform.handler.call(
      { ...context(), warn: warn1 },
      'import { code } from "@ferriki/core/macro"; export const x = code("fallback", { language: "unknown-parse-race" });',
      file,
    );
    await loadStarted.promise;

    // A newer transform of the same module fails to parse (bumping generation without succeeding).
    await expect(
      vitePlugin.transform.handler.call(
        context(),
        'import { code } from "@ferriki/core/macro"; export const broken = (',
        file,
      ),
    ).rejects.toThrow();

    // First transform returns its plain-code fallback and must still emit its once-per-module warning!
    loadRelease.reject(Object.assign(new Error("Unknown language"), { code: "ERR_UNSUPPORTED" }));
    const result = await firstTransform;
    expect(result.code).toContain("fallback");
    expect(warn1).toHaveBeenCalledTimes(1);
    expect(warn1.mock.calls[0][0]).toContain("unknown-parse-race");

    await vitePlugin.closeBundle();
  });

  it("does not block or dispose a replacement server's warmed client environment when the old client closes during server.restart()", async () => {
    const warmStarted = deferred();
    const warmRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          warmStarted.resolve();
          return warmRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:mediumseagreen}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv1 = { name: "client" };
    const clientEnvIdle = { name: "client" };
    const clientEnv2 = { name: "client" };
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    const server1 = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server1);

    // Old client runs a transform on clientEnv1.
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv1 },
      'import { code } from "@ferriki/core/macro"; export const old = code("old-restart", { language: "ts" });',
      "/src/old-restart.ts",
    );

    // Replacement server starts and immediately prewarms macros on its fresh clientEnv2 object
    // before old server closes clientEnv1.
    const server2 = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server2);

    const warmCssResult = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv2 },
      'import { code } from "@ferriki/core/macro"; export const warm = code("warm-css", { language: "ts" });',
      "/src/warm-css.ts",
    );
    const warmCssId = cssIdOf(warmCssResult);
    expect(vitePlugin.resolveId.call({ environment: clientEnv2 }, warmCssId)).toBe(
      `\0${warmCssId}`,
    );

    const warmTransform = vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv2 },
      'import { code } from "@ferriki/core/macro"; export const slow = code("warm-rust", { language: "rust" });',
      "/src/warm-rust.ts",
    );
    await warmStarted.promise;

    // Closing old clientEnv1 (and an unused clientEnvIdle) + server1 must finish immediately
    // without waiting on clientEnv2's pending load or disposing its warmed highlighter/CSS!
    await vitePlugin.closeBundle.call({ environment: clientEnv1 });
    await vitePlugin.closeBundle.call({ environment: clientEnvIdle });
    await server1.close();

    expect(highlighter.dispose).not.toHaveBeenCalled();
    expect(createHighlighterMock).toHaveBeenCalledTimes(1);
    expect(vitePlugin.resolveId.call({ environment: clientEnv2 }, warmCssId)).toBe(
      `\0${warmCssId}`,
    );
    expect(vitePlugin.load.call({ environment: clientEnv2 }, `\0${warmCssId}`)).toBe(
      ".ferriki-style-warm-css{color:mediumseagreen}",
    );

    // Replacement clientEnv2 finishes warming cleanly and server2 disposes the highlighter once.
    warmRelease.resolve();
    const warmed = await warmTransform;
    expect(warmed.code).toContain("warm-rust");
    await server2.close();
    expect(highlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("reclaims abandoned dead-PID spill directories on configureServer() startup even without spilling", async () => {
    let deadPid = 999_999;
    while (true) {
      try {
        process.kill(deadPid, 0);
        deadPid++;
      } catch (error) {
        if (error?.code === "ESRCH") break;
        deadPid++;
      }
    }

    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-startup-reclaim-"));
    const abandonedDirName = `ferriki-vite-css-${deadPid}-startup`;
    const currentHostname = hostname();
    const currentPidNs =
      process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : undefined;
    const validMarker = JSON.stringify({
      app: "@ferriki/vite",
      pid: deadPid,
      hostname: currentHostname,
      ...(currentPidNs !== undefined ? { pidNs: currentPidNs } : {}),
      version: 1,
    });
    const validCssName = `${"d".repeat(64)}.css`;

    await mkdir(join(spillParent, abandonedDirName));
    await writeFile(
      join(spillParent, abandonedDirName, ".ferriki-vite-spill-v1"),
      validMarker,
      "utf8",
    );
    await writeFile(join(spillParent, abandonedDirName, validCssName), "body{}", "utf8");

    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const server = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };

    try {
      vitePlugin.configureServer(server);
      expect(await readdir(spillParent)).toEqual([]);
    } finally {
      await server.close();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("isolates prepared React CSS build registries across overlapping SSR builds sharing one plugin instance", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:royalblue}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    vitePlugin.config.handler({ base: "/" });
    vitePlugin.configResolved({ command: "build", base: "/", build: { sourcemap: false } });

    const ssrEnv1 = { name: "ssr", config: { consumer: "server" } };
    const ssrEnv2 = { name: "ssr", config: { consumer: "server" } };

    // Build #1 starts and transforms a class-mode React macro.
    vitePlugin.buildStart.call({ environment: ssrEnv1 });
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv1 },
      'import { Code } from "@ferriki/core/react/macro"; export const Page = () => <Code source="build-one" language="ts" />;',
      "/src/page.tsx",
    );

    // Build #2 starts on a distinct ssrEnv2 object BEFORE Build #1 reaches buildEnd!
    vitePlugin.buildStart.call({ environment: ssrEnv2 });

    // Build #1 must still emit its prepared stylesheet in buildEnd, renderChunk, and generateBundle.
    const emitBuild1 = vi.fn(() => "ref-build-1");
    vitePlugin.buildEnd.call({ environment: ssrEnv1, emitFile: emitBuild1 });
    expect(emitBuild1).toHaveBeenCalledTimes(1);
    expect(emitBuild1.mock.calls[0][0].source).toContain("build-one");

    const renderedChunk = vitePlugin.renderChunk.call(
      {
        ...context(),
        environment: ssrEnv1,
        getFileName: () => "assets/ferriki-code-build1.css",
      },
      "export const url = import.meta.FERRIKI_CODE_STYLESHEET_URL;",
      { fileName: "entry.js" },
    );
    expect(renderedChunk.code).toContain("/assets/ferriki-code-build1.css");

    const emitBundle1 = vi.fn();
    vitePlugin.generateBundle.handler.call(
      {
        environment: ssrEnv1,
        getFileName: () => "assets/ferriki-code-build1.css",
        emitFile: emitBundle1,
      },
      {},
      {},
    );
    expect(emitBundle1).toHaveBeenCalledTimes(1);
    expect(emitBundle1.mock.calls[0][0].source).toContain("build-one");

    // Build #2 has no React macros of its own and must NOT inherit Build #1's stylesheet.
    const emitBuild2 = vi.fn(() => "ref-build-2");
    vitePlugin.buildEnd.call({ environment: ssrEnv2, emitFile: emitBuild2 });
    expect(emitBuild2).not.toHaveBeenCalled();

    await vitePlugin.closeBundle.call({ environment: ssrEnv1 });
    await vitePlugin.closeBundle.call({ environment: ssrEnv2 });
    expect(highlighter.dispose).toHaveBeenCalledTimes(1);
  });

  it("releases moduleCss owners and indexes on dev-server close while preserving active replacement server state", async () => {
    createHighlighterMock.mockImplementation(() =>
      Promise.resolve(
        makeFakeHighlighter({
          codeToHtmlWithCss: (code) => ({
            html: `<pre class="shiki"><code>${code}</code></pre>`,
            css: `.ferriki-style-${code}{color:coral}`,
          }),
        }),
      ),
    );

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    // Cycle 1: dev server #1 owns sharedCssId via /src/s1.ts, then closes.
    const clientEnv1 = { name: "client" };
    const server1 = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server1);
    const res1 = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv1 },
      'import { code } from "@ferriki/core/macro"; export const a = code("shared-owner", { language: "ts" });',
      "/src/s1.ts",
    );
    const sharedCssId = cssIdOf(res1);
    expect(vitePlugin.resolveId.call({ environment: clientEnv1 }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    await server1.close();

    // Closed server's owner and virtual CSS must be completely released, and /src/s1.ts unindexed.
    expect(vitePlugin.resolveId.call({ environment: clientEnv1 }, sharedCssId)).toBeNull();
    expect(vitePlugin.load.call({ environment: clientEnv1 }, `\0${sharedCssId}`)).toBeNull();
    const s1Read = vi.fn(async () => "export const plain = 1;");
    await vitePlugin.hotUpdate.call(
      { environment: clientEnv1 },
      { type: "update", file: "/src/s1.ts", timestamp: 10, read: s1Read },
    );
    expect(s1Read).not.toHaveBeenCalled();

    // Cycle 2 + 3 overlapping restart: server2 owns sharedCssId via /src/s2.ts, server3 starts
    // and also owns sharedCssId via /src/s3.ts before server2 closes its environment.
    const clientEnv2 = { name: "client" };
    const server2 = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server2);
    const res2 = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv2 },
      'import { code } from "@ferriki/core/macro"; export const b = code("shared-owner", { language: "ts" });',
      "/src/s2.ts",
    );
    expect(cssIdOf(res2)).toBe(sharedCssId);

    const clientEnv3 = { name: "client" };
    const server3 = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server3);
    const res3 = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv3 },
      'import { code } from "@ferriki/core/macro"; export const c = code("shared-owner", { language: "ts" });',
      "/src/s3.ts",
    );
    expect(cssIdOf(res3)).toBe(sharedCssId);

    // Closing server2's clientEnv2 releases /src/s2.ts without harming server3's /src/s3.ts!
    await vitePlugin.closeBundle.call({ environment: clientEnv2 });
    await server2.close();
    expect(vitePlugin.resolveId.call({ environment: clientEnv3 }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    expect(vitePlugin.load.call({ environment: clientEnv3 }, `\0${sharedCssId}`)).toBe(
      ".ferriki-style-shared-owner{color:coral}",
    );

    const s2Read = vi.fn(async () => "export const plain = 2;");
    await vitePlugin.hotUpdate.call(
      { environment: clientEnv2 },
      { type: "update", file: "/src/s2.ts", timestamp: 20, read: s2Read },
    );
    expect(s2Read).not.toHaveBeenCalled();

    // Closing server3 releases the final owner so sharedCssId is completely freed.
    await server3.close();
    expect(vitePlugin.resolveId.call({ environment: clientEnv3 }, sharedCssId)).toBeNull();
    expect(vitePlugin.load.call({ environment: clientEnv3 }, `\0${sharedCssId}`)).toBeNull();
  });

  it("does not let a draining old-lifetime React transform overwrite a replacement client's React blocks", async () => {
    const oldStarted = deferred();
    const oldRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "rust") {
          oldStarted.resolve();
          return oldRelease.promise;
        }
        return Promise.resolve();
      },
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:orchid}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const ssrEnv = { name: "ssr" };
    const clientEnv1 = { name: "client" };
    const clientEnv2 = { name: "client" };
    const sharedFile = "/src/shared-page.tsx";

    // SSR keeps the shared highlighter alive.
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      'import { code } from "@ferriki/core/macro"; export const s = code("ssr", { language: "ts" });',
      "/src/ssr.ts",
    );

    // Old client starts transforming sharedFile and begins closeBundle().
    const oldTransform = vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv1 },
      'import { Code } from "@ferriki/core/react/macro"; export const Page = () => <Code source="old-draining" language="rust" />;',
      sharedFile,
    );
    await oldStarted.promise;
    const oldClosing = vitePlugin.closeBundle.call({ environment: clientEnv1 });

    // Replacement client transforms the SAME sharedFile before oldTransform finishes.
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv2 },
      'import { Code } from "@ferriki/core/react/macro"; export const Page = () => <Code source="fresh-replacement" language="ts" />;',
      sharedFile,
    );

    // Old transform finishes draining afterward and must NOT overwrite replacement client's blocks or CSS!
    oldRelease.resolve();
    await oldTransform;
    await oldClosing;

    const blocks = Object.values(vitePlugin.api.codeElementBlocks("client"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("fresh-replacement");
    expect(blocks[0]).not.toContain("old-draining");
    expect(vitePlugin.api.codeElementCss("client")).toContain("fresh-replacement");
    expect(vitePlugin.api.codeElementCss("client")).not.toContain("old-draining");

    await vitePlugin.closeBundle.call({ environment: ssrEnv });
    await vitePlugin.closeBundle.call({ environment: clientEnv2 });
  });

  it("ignores a delayed HMR hotUpdate read from a closed server after a replacement server transforms the same file", async () => {
    createHighlighterMock.mockImplementation(() =>
      Promise.resolve(
        makeFakeHighlighter({
          codeToHtmlWithCss: (code) => ({
            html: `<pre class="shiki"><code>${code}</code></pre>`,
            css: `.ferriki-style-${code}{color:goldenrod}`,
          }),
        }),
      ),
    );

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const file = "/src/hmr-restart.tsx";
    const clientEnv1 = { name: "client" };
    const server1 = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server1);

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv1 },
      'import { Code } from "@ferriki/core/react/macro"; export const Page = () => <Code source="server1-block" language="ts" />;',
      file,
    );

    // Start an async HMR read on server1 that won't resolve until after server1 closes.
    const staleRead = deferred();
    const staleHotUpdate = vitePlugin.hotUpdate.call(
      { environment: clientEnv1 },
      { type: "update", file, timestamp: 100, read: () => staleRead.promise },
    );

    await server1.close();

    // Start server2 and transform the same file with a fresh React macro.
    const clientEnv2 = { name: "client" };
    const server2 = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server2);

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv2 },
      'import { Code } from "@ferriki/core/react/macro"; export const Page = () => <Code source="server2-block" language="ts" />;',
      file,
    );

    // Delayed read from closed server1 resolves without macro imports: must NOT clear server2's blocks/CSS!
    staleRead.resolve("export const plain = 1;");
    await staleHotUpdate;

    const blocks = Object.values(vitePlugin.api.codeElementBlocks("client"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("server2-block");
    expect(vitePlugin.api.codeElementCss("client")).toContain("server2-block");

    await server2.close();
  });

  it("retires dev-server React blocks and palettes on server close while preserving production build snapshots after closeBundle", async () => {
    createHighlighterMock.mockImplementation(() =>
      Promise.resolve(
        makeFakeHighlighter({
          codeToHtmlWithCss: (code) => ({
            html: `<pre class="shiki"><code>${code}</code></pre>`,
            css: `.ferriki-style-${code}{color:cadetblue}`,
          }),
        }),
      ),
    );

    // Part 1: Dev server closes -> its React blocks and palette are retired.
    const devPlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const devClient = { name: "client" };
    const devServer = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    devPlugin.configureServer(devServer);
    await devPlugin.transform.handler.call(
      { ...context(), environment: devClient },
      'import { Code } from "@ferriki/core/react/macro"; export const Page = () => <Code source="dev-only-block" language="ts" />;',
      "/src/dev-page.tsx",
    );
    expect(Object.keys(devPlugin.api.codeElementBlocks("client"))).toHaveLength(1);
    expect(devPlugin.api.codeElementCss("client")).toContain("dev-only-block");

    await devServer.close();
    expect(devPlugin.api.codeElementBlocks("client")).toEqual({});
    expect(devPlugin.api.codeElementCss("client")).toBe("");

    // Part 2: Production build closes -> prepared React blocks and palette remain available per ADR 0019.
    const buildPlugin = ferriki({ theme: "nord", styleMode: "classes" });
    buildPlugin.config.handler({ base: "/" });
    buildPlugin.configResolved({ command: "build", base: "/", build: { sourcemap: false } });
    const ssrEnv = { name: "ssr", config: { consumer: "server" } };
    buildPlugin.buildStart.call({ environment: ssrEnv });
    await buildPlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      'import { Code } from "@ferriki/core/react/macro"; export const Page = () => <Code source="prod-snapshot-block" language="ts" />;',
      "/src/prod-page.tsx",
    );
    buildPlugin.buildEnd.call({ environment: ssrEnv, emitFile: () => "ref-prod" });
    await buildPlugin.closeBundle.call({ environment: ssrEnv });

    const prodBlocks = Object.values(buildPlugin.api.codeElementBlocks("ssr"));
    expect(prodBlocks).toHaveLength(1);
    expect(prodBlocks[0]).toContain("prod-snapshot-block");
    expect(buildPlugin.api.codeElementCss("ssr")).toContain("prod-snapshot-block");
  });

  it("drops edited-away superseded virtual stylesheets when their owning dev server closes", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:plum}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client" };
    const server = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server);
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    // Transform, resolve, and load cssBefore, then edit the file away so cssBefore sits in supersededCss.
    const before = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("before-edit", { language: "ts" });',
      "/src/edit-away.ts",
    );
    const cssBefore = cssIdOf(before);
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssBefore)).toBe(`\0${cssBefore}`);
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssBefore}`)).toBe(
      ".ferriki-style-before-edit{color:plum}",
    );

    const after = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("after-edit", { language: "ts" });',
      "/src/edit-away.ts",
    );
    const cssAfter = cssIdOf(after);
    expect(cssAfter).not.toBe(cssBefore);

    // While server is running, edited-away cssBefore remains resolvable in the superseded queue.
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssBefore)).toBe(`\0${cssBefore}`);

    // After server.close(), both cssBefore (superseded) and cssAfter (owned) are completely removed!
    await server.close();
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssBefore)).toBeNull();
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssBefore}`)).toBeNull();
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, cssAfter)).toBeNull();
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${cssAfter}`)).toBeNull();
  });

  it("retires old dev server React registry entries on server.restart() so removing the last macro on server2 clears codeElementBlocks", async () => {
    createHighlighterMock.mockImplementation(() =>
      Promise.resolve(
        makeFakeHighlighter({
          codeToHtmlWithCss: (code) => ({
            html: `<pre class="shiki"><code>${code}</code></pre>`,
            css: `.ferriki-style-${code}{color:peru}`,
          }),
        }),
      ),
    );

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv1 = { name: "client" };
    const server1 = {
      config: { base: "/" },
      environments: { client: clientEnv1 },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server1);

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv1 },
      'import { Code } from "@ferriki/core/react/macro"; export const OldOnly = () => <Code source="old-only" language="ts" />;',
      "/src/old-only.tsx",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv1 },
      'import { Code } from "@ferriki/core/react/macro"; export const Shared = () => <Code source="shared-v1" language="ts" />;',
      "/src/shared.tsx",
    );

    // Simulate Vite server.restart(): configure replacement server2 BEFORE closing server1!
    const clientEnv2 = { name: "client" };
    const server2 = {
      config: { base: "/" },
      environments: { client: clientEnv2 },
      middlewares: { use() {} },
      ws: { send: vi.fn() },
      close: async () => {},
    };
    vitePlugin.configureServer(server2);

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv2 },
      'import { Code } from "@ferriki/core/react/macro"; export const Shared = () => <Code source="shared-v2" language="ts" />;',
      "/src/shared.tsx",
    );

    // Close server1 (even without calling closeBundle on clientEnv1 first): old-only must retire,
    // while server2's shared-v2 remains intact!
    await server1.close();
    const afterRestartBlocks = Object.values(vitePlugin.api.codeElementBlocks("client"));
    expect(afterRestartBlocks).toHaveLength(1);
    expect(afterRestartBlocks[0]).toContain("shared-v2");
    expect(vitePlugin.api.codeElementCss("client")).toContain("shared-v2");
    expect(vitePlugin.api.codeElementCss("client")).not.toContain("old-only");

    // Removing the last macro import on server2 must now clear codeElementBlocks completely to {}!
    await vitePlugin.hotUpdate.call(
      { environment: clientEnv2 },
      {
        type: "update",
        file: "/src/shared.tsx",
        timestamp: 200,
        read: async () => "export const Shared = () => null;",
      },
    );
    expect(vitePlugin.api.codeElementBlocks()).toEqual({});
    expect(vitePlugin.api.codeElementCss()).toBe("");

    await server2.close();
  });

  it("keeps a replacement client's outstanding issued/spilled virtual CSS claim alive when an old client resolves the same hash and then closes", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:seagreen}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-per-lifetime-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv1 = { name: "client" };
    const clientEnv2 = { name: "client" };
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    try {
      // 1. Replacement client resolves hash X (without loading yet).
      const replacementX = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv2 },
        'import { code } from "@ferriki/core/macro"; export const x = code("hash-x", { language: "ts" });',
        "/src/hash-x.ts",
      );
      const cssX = cssIdOf(replacementX);
      expect(vitePlugin.resolveId.call({ environment: clientEnv2 }, cssX)).toBe(`\0${cssX}`);

      // 2. Old client resolves the SAME hash X (must NOT overwrite replacement client's claim!).
      const oldX = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv1 },
        'import { code } from "@ferriki/core/macro"; export const x = code("hash-x", { language: "ts" });',
        "/src/hash-x.ts",
      );
      expect(cssIdOf(oldX)).toBe(cssX);
      expect(vitePlugin.resolveId.call({ environment: clientEnv1 }, cssX)).toBe(`\0${cssX}`);

      // 3. Old client moves off hash X and replacement client moves on to hash Y and churns 70 edits
      // so hash X spills to disk carrying both clients' issued claims.
      const oldMoved = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv1 },
        'import { code } from "@ferriki/core/macro"; export const x = code("old-other", { language: "ts" });',
        "/src/hash-x.ts",
      );
      vitePlugin.load.call({ environment: clientEnv1 }, `\0${cssIdOf(oldMoved)}`);
      for (let index = 0; index < 70; index++) {
        const next = await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv2 },
          `import { code } from "@ferriki/core/macro"; export const y = code("hash-y-${index}", { language: "ts" });`,
          "/src/hash-x.ts",
        );
        vitePlugin.load.call({ environment: clientEnv2 }, `\0${cssIdOf(next)}`);
      }

      // 4. Old client closes: only old client's claim is removed; replacement client still loads hash X!
      await vitePlugin.closeBundle.call({ environment: clientEnv1 });
      expect(vitePlugin.resolveId.call({ environment: clientEnv1 }, cssX)).toBeNull();
      expect(vitePlugin.load.call({ environment: clientEnv1 }, `\0${cssX}`)).toBeNull();
      expect(vitePlugin.resolveId.call({ environment: clientEnv2 }, cssX)).toBe(`\0${cssX}`);
      expect(vitePlugin.load.call({ environment: clientEnv2 }, `\0${cssX}`)).toBe(
        ".ferriki-style-hash-x{color:seagreen}",
      );
    } finally {
      await vitePlugin.closeBundle.call({ environment: clientEnv2 });
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(await readdir(spillParent)).toEqual([]);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("replaces the published React registry for an environment name when a sequential build finishes on a fresh environment object", async () => {
    createHighlighterMock.mockImplementation(() =>
      Promise.resolve(
        makeFakeHighlighter({
          codeToHtmlWithCss: (code) => ({
            html: `<pre class="shiki"><code>${code}</code></pre>`,
            css: `.ferriki-style-${code}{color:steelblue}`,
          }),
        }),
      ),
    );

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    vitePlugin.config.handler({ base: "/" });
    vitePlugin.configResolved({ command: "build", base: "/", build: { sourcemap: false } });

    // Build #1: client + ssr environments.
    const clientEnv1 = { name: "client", config: { consumer: "client" } };
    const ssrEnv1 = { name: "ssr", config: { consumer: "server" } };
    vitePlugin.buildStart.call({ environment: clientEnv1 });
    vitePlugin.buildStart.call({ environment: ssrEnv1 });
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv1 },
      'import { Code } from "@ferriki/core/react/macro"; export const C = () => <Code source="client-only" language="ts" />;',
      "/src/client-page.tsx",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv1 },
      'import { Code } from "@ferriki/core/react/macro"; export const B1 = () => <Code source="build1-only" language="ts" />;',
      "/src/only-in-build1.tsx",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv1 },
      'import { Code } from "@ferriki/core/react/macro"; export const S1 = () => <Code source="shared-b1" language="ts" />;',
      "/src/shared.tsx",
    );
    vitePlugin.buildEnd.call({ environment: clientEnv1, emitFile: () => "ref-client-1" });
    vitePlugin.buildEnd.call({ environment: ssrEnv1, emitFile: () => "ref-ssr-1" });
    await vitePlugin.closeBundle.call({ environment: clientEnv1 });
    await vitePlugin.closeBundle.call({ environment: ssrEnv1 });

    // Build #2: fresh ssrEnv2 object with a different module set replaces the published "ssr" snapshot.
    const ssrEnv2 = { name: "ssr", config: { consumer: "server" } };
    const emitSsr2 = vi.fn(() => "ref-ssr-2");
    vitePlugin.buildStart.call({ environment: ssrEnv2 });
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv2 },
      'import { Code } from "@ferriki/core/react/macro"; export const B2 = () => <Code source="build2-only" language="ts" />;',
      "/src/only-in-build2.tsx",
    );
    vitePlugin.buildEnd.call({ environment: ssrEnv2, emitFile: emitSsr2 });
    await vitePlugin.closeBundle.call({ environment: ssrEnv2 });

    expect(emitSsr2).toHaveBeenCalledTimes(1);
    const ssrBlocks = Object.values(vitePlugin.api.codeElementBlocks("ssr"));
    expect(ssrBlocks).toHaveLength(1);
    expect(ssrBlocks[0]).toContain("build2-only");
    expect(vitePlugin.api.codeElementCss("ssr")).toBe(emitSsr2.mock.calls[0][0].source);
    expect(vitePlugin.api.codeElementCss("ssr")).toContain("build2-only");
    expect(vitePlugin.api.codeElementCss("ssr")).not.toContain("build1-only");
    expect(vitePlugin.api.codeElementCss("ssr")).not.toContain("shared-b1");

    // Client snapshot from Build #1 remains untouched.
    const clientBlocks = Object.values(vitePlugin.api.codeElementBlocks("client"));
    expect(clientBlocks).toHaveLength(1);
    expect(clientBlocks[0]).toContain("client-only");

    // Build #3: fresh ssrEnv3 with zero React macros clears the "ssr" snapshot completely.
    const ssrEnv3 = { name: "ssr", config: { consumer: "server" } };
    const emitSsr3 = vi.fn(() => "ref-ssr-3");
    vitePlugin.buildStart.call({ environment: ssrEnv3 });
    vitePlugin.buildEnd.call({ environment: ssrEnv3, emitFile: emitSsr3 });
    await vitePlugin.closeBundle.call({ environment: ssrEnv3 });
    expect(emitSsr3).not.toHaveBeenCalled();
    expect(vitePlugin.api.codeElementBlocks("ssr")).toEqual({});
    expect(vitePlugin.api.codeElementCss("ssr")).toBe("");
  });

  it("does not let a repeat resolveId from an old client steal a replacement client's pending CSS claim", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:darkcyan}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const exitListenersBefore = process.listenerCount("exit");
    const spillParent = await mkdtemp(join(tmpdir(), "ferriki-spill-no-steal-"));
    const savedEnv = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = spillParent;
    process.env.TEMP = spillParent;
    process.env.TMP = spillParent;

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv1 = { name: "client" };
    const clientEnv2 = { name: "client" };
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    try {
      // Old client transforms & resolves hash H once (consuming its own pending claim).
      const oldRes = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv1 },
        'import { code } from "@ferriki/core/macro"; export const x = code("steal-guard", { language: "ts" });',
        "/src/dup-claim.ts",
      );
      const cssH = cssIdOf(oldRes);
      expect(vitePlugin.resolveId.call({ environment: clientEnv1 }, cssH)).toBe(`\0${cssH}`);

      // Replacement client transforms the SAME hash H (creating its own pending claim, not yet resolved).
      const newRes = await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv2 },
        'import { code } from "@ferriki/core/macro"; export const x = code("steal-guard", { language: "ts" });',
        "/src/dup-claim.ts",
      );
      expect(cssIdOf(newRes)).toBe(cssH);

      // Repeat resolveId from old client must NOT consume replacement client's pending claim!
      expect(vitePlugin.resolveId.call({ environment: clientEnv1 }, cssH)).toBe(`\0${cssH}`);

      // Both clients edit away from hash H, and 260 unowned pending transforms force hash H to spill.
      await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv1 },
        'import { code } from "@ferriki/core/macro"; export const x = code("old-away", { language: "ts" });',
        "/src/dup-claim.ts",
      );
      await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv2 },
        'import { code } from "@ferriki/core/macro"; export const x = code("new-away", { language: "ts" });',
        "/src/dup-claim.ts",
      );
      for (let index = 0; index < 260; index++) {
        await vitePlugin.transform.handler.call(
          { ...context(), environment: clientEnv2 },
          `import { code } from "@ferriki/core/macro"; export const x = code("churn-${index}", { language: "ts" });`,
          "/src/dup-claim.ts",
        );
      }

      // Closing old client drops only old client's spilled claim; replacement client's delayed resolve + load succeed!
      await vitePlugin.closeBundle.call({ environment: clientEnv1 });
      expect(vitePlugin.resolveId.call({ environment: clientEnv1 }, cssH)).toBeNull();
      expect(vitePlugin.resolveId.call({ environment: clientEnv2 }, cssH)).toBe(`\0${cssH}`);
      expect(vitePlugin.load.call({ environment: clientEnv2 }, `\0${cssH}`)).toBe(
        ".ferriki-style-steal-guard{color:darkcyan}",
      );
    } finally {
      await vitePlugin.closeBundle.call({ environment: clientEnv2 });
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(await readdir(spillParent)).toEqual([]);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(spillParent, { recursive: true, force: true });
    }
  });

  it("removes shared edited-away virtual CSS cleanly once both client and SSR environments close", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="shiki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:chocolate}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client" };
    const ssrEnv = { name: "ssr" };
    const cssIdOf = (result) =>
      /import "(virtual:ferriki-vite\/[^"]+\.css)";/.exec(result.code)?.[1];

    // Both client and SSR transform, resolve, and load the same shared virtual CSS.
    const clientInitial = await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("shared-v1", { language: "ts" });',
      "/src/shared-css.ts",
    );
    const ssrInitial = await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("shared-v1", { language: "ts" });',
      "/src/shared-css.ts",
    );
    const sharedCssId = cssIdOf(clientInitial);
    expect(cssIdOf(ssrInitial)).toBe(sharedCssId);
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${sharedCssId}`)).toBe(
      ".ferriki-style-shared-v1{color:chocolate}",
    );
    expect(vitePlugin.resolveId.call({ environment: ssrEnv }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    expect(vitePlugin.load.call({ environment: ssrEnv }, `\0${sharedCssId}`)).toBe(
      ".ferriki-style-shared-v1{color:chocolate}",
    );

    // SSR edits away first, then client edits away second (client is last owner -> supersededCss gets client).
    await vitePlugin.transform.handler.call(
      { ...context(), environment: ssrEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("shared-v2", { language: "ts" });',
      "/src/shared-css.ts",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      'import { code } from "@ferriki/core/macro"; export const x = code("shared-v2", { language: "ts" });',
      "/src/shared-css.ts",
    );

    // Close client first: SSR still holds an issued claim and can still resolve/load sharedCssId.
    await vitePlugin.closeBundle.call({ environment: clientEnv });
    expect(vitePlugin.resolveId.call({ environment: ssrEnv }, sharedCssId)).toBe(
      `\0${sharedCssId}`,
    );
    expect(vitePlugin.load.call({ environment: ssrEnv }, `\0${sharedCssId}`)).toBe(
      ".ferriki-style-shared-v1{color:chocolate}",
    );

    // Close SSR second: final claim closes -> sharedCssId is deleted from virtualCss and no longer resolves!
    await vitePlugin.closeBundle.call({ environment: ssrEnv });
    expect(vitePlugin.resolveId.call({ environment: clientEnv }, sharedCssId)).toBeNull();
    expect(vitePlugin.load.call({ environment: clientEnv }, `\0${sharedCssId}`)).toBeNull();
    expect(vitePlugin.resolveId.call({ environment: ssrEnv }, sharedCssId)).toBeNull();
    expect(vitePlugin.load.call({ environment: ssrEnv }, `\0${sharedCssId}`)).toBeNull();
  });

  it("loads distinct languages concurrently per transform without blocking unrelated transforms or duplicating unsupported retries", async () => {
    const loadCalls = [];
    const rustStarted = deferred();
    const rustRelease = deferred();
    const highlighter = makeFakeHighlighter({
      loadLanguage: async (language) => {
        loadCalls.push(language);
        if (language === "rust") {
          rustStarted.resolve();
          await rustRelease.promise;
          return;
        }
        if (language === "unknown-lang") {
          const error = new Error("Language `unknown-lang` not found");
          error.code = "ERR_UNSUPPORTED";
          throw error;
        }
      },
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const ctxA = context();
    const sourceA = `import { code } from "@ferriki/core/macro";
export const a = code("const a = 1", { language: "ts" });
export const b = code("fn main() {}", { language: "rust" });
export const c = code("const b = 2", { language: "ts" });
export const d = code("plain text", { language: "unknown-lang" });`;
    const sourceB = `import { code } from "@ferriki/core/macro";
export const fast = code("const fast = true", { language: "ts" });`;

    const transformA = vitePlugin.transform.handler.call(ctxA, sourceA, "/src/batched-fallback.ts");
    await rustStarted.promise;

    // A concurrent TypeScript-only transform must finish immediately without waiting for Module A's slow Rust load.
    const resultB = await vitePlugin.transform.handler.call(
      context(),
      sourceB,
      "/src/fast-ts-only.ts",
    );
    expect(resultB.code).toContain('"code":"const fast = true"');

    rustRelease.resolve();
    const resultA = await transformA;
    // Each distinct language is loaded once concurrently (no duplicate retries on unsupported languages).
    expect(loadCalls).toEqual(["ts", "rust", "unknown-lang"]);
    expect(ctxA.warn).toHaveBeenCalledTimes(1);
    expect(ctxA.warn.mock.calls[0][0]).toContain('"unknown-lang"');
    expect(resultA.code).toContain(
      '\\u003cpre class=\\"shiki\\">\\u003ccode class=\\"language-unknown-lang\\">plain text\\u003c/code>\\u003c/pre>',
    );
    expect(highlighter.codeToHtml).toHaveBeenCalledTimes(4);
    await vitePlugin.closeBundle();
  });

  it("maintains incremental CSS rule counts across many dev modules without redundant palette rebuilds", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="ferriki"><code>${code}</code></pre>`,
        css: ".ferriki-shared{color:red}",
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const wsSend = vi.fn();
    const server = {
      config: { base: "/" },
      middlewares: { use() {} },
      ws: { send: wsSend },
      httpServer: { once() {}, off() {} },
      close: async () => {},
    };
    vitePlugin.configResolved({ command: "serve", base: "/" });
    vitePlugin.configureServer(server);

    const clientEnv = { name: "client", config: { consumer: "client" } };
    for (let index = 0; index < 200; index++) {
      await vitePlugin.transform.handler.call(
        { ...context(), environment: clientEnv },
        `import { Code } from "@ferriki/core/react/macro";
export const M = () => <Code language="ts" source="mod-${index}" />;`,
        `/src/mod-${index}.tsx`,
      );
    }

    // Only the first module introduces `.ferriki-shared{color:red}`; the remaining 199 commits
    // keep refcount > 0 without marking the palette dirty or pushing duplicate WS updates.
    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(vitePlugin.api.codeElementCss("client")).toBe(".ferriki-shared{color:red}");

    // Deleting 199 modules keeps the shared rule alive until the final owner is removed.
    for (let index = 0; index < 199; index++) {
      await vitePlugin.hotUpdate.call(
        { environment: clientEnv },
        { type: "delete", file: `/src/mod-${index}.tsx` },
      );
    }
    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(vitePlugin.api.codeElementCss("client")).toBe(".ferriki-shared{color:red}");

    await vitePlugin.hotUpdate.call(
      { environment: clientEnv },
      { type: "delete", file: "/src/mod-199.tsx" },
    );
    expect(wsSend).toHaveBeenCalledTimes(2);
    expect(vitePlugin.api.codeElementCss("client")).toBe("");
    await server.close();
  });

  it("keeps newly added base style rules before retained theme-override rules during HMR", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="ferriki"><code>${code}</code></pre>`,
        css: [
          `:where(.ferriki-style-${code}){color:var(--ferriki-color)}`,
          ":where(.ferriki-themes-1){--ferriki-color:var(--shiki-light)}",
          "@media (prefers-color-scheme:dark){:where(.ferriki-themes-1){--ferriki-color:var(--shiki-dark)}}",
          ':where(.ferriki-themes-1[data-ferriki-theme="dark"],[data-ferriki-theme="dark"] .ferriki-themes-1:not([data-ferriki-theme])){--ferriki-color:var(--shiki-dark)}',
        ].join("\n"),
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const clientEnv = { name: "client", config: { consumer: "client" } };

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      `import { Code } from "@ferriki/core/react/macro";
export const A = () => <Code language="ts" source="first" />;`,
      "/src/a.tsx",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      `import { Code } from "@ferriki/core/react/macro";
export const B = () => <Code language="ts" source="second" />;`,
      "/src/b.tsx",
    );

    const css = vitePlugin.api.codeElementCss("client");
    const newStyleIndex = css.indexOf(":where(.ferriki-style-second)");
    const themeDefaultIndex = css.indexOf(":where(.ferriki-themes-1){");
    const mediaIndex = css.indexOf("@media (prefers-color-scheme:dark)");
    const explicitThemeIndex = css.indexOf('[data-ferriki-theme="dark"]');
    expect(newStyleIndex).toBeGreaterThanOrEqual(0);
    expect(newStyleIndex).toBeLessThan(themeDefaultIndex);
    expect(themeDefaultIndex).toBeLessThan(mediaIndex);
    expect(mediaIndex).toBeLessThan(explicitThemeIndex);
    await vitePlugin.closeBundle();
  });

  it("surfaces a fatal error on an earlier macro language immediately without waiting for a slow sibling load", async () => {
    const slowRustStarted = deferred();
    const slowRustRelease = deferred();
    const fatalError = Object.assign(new Error("network down"), { code: "ERR_ASSET" });
    const highlighter = makeFakeHighlighter({
      loadLanguage: (language) => {
        if (language === "ts") return Promise.reject(fatalError);
        if (language === "rust") {
          slowRustStarted.resolve();
          return slowRustRelease.promise;
        }
        return Promise.resolve();
      },
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord" });
    const source = `import { code } from "@ferriki/core/macro";
export const a = code("const a = 1", { language: "ts" });
export const b = code("fn main() {}", { language: "rust" });`;

    let rustStillPending = true;
    slowRustRelease.promise.then(() => {
      rustStillPending = false;
    });

    await expect(
      vitePlugin.transform.handler.call(context(), source, "/src/fatal-first.ts"),
    ).rejects.toBe(fatalError);
    await slowRustStarted.promise;
    // Transform rejected while rust was still pending.
    expect(rustStillPending).toBe(true);
    slowRustRelease.resolve();
    await vitePlugin.closeBundle();
  });

  it("caches prepared React blocks and deduplicated CSS snapshots and invalidates them on update, removal, and server close", async () => {
    const highlighter = makeFakeHighlighter({
      codeToHtmlWithCss: (code) => ({
        html: `<pre class="ferriki"><code>${code}</code></pre>`,
        css: `.ferriki-style-${code}{color:red}\n.ferriki-shared{font-weight:bold}`,
      }),
    });
    createHighlighterMock.mockResolvedValueOnce(highlighter);

    const vitePlugin = ferriki({ theme: "nord", styleMode: "classes" });
    const wsSend = vi.fn();
    let cssMiddleware;
    const closeListeners = new Set();
    const server = {
      config: { base: "/" },
      middlewares: {
        use: (fn) => {
          cssMiddleware = fn;
        },
      },
      ws: { send: wsSend },
      httpServer: {
        once: (event, fn) => {
          if (event === "close") closeListeners.add(fn);
        },
        off: (event, fn) => {
          if (event === "close") closeListeners.delete(fn);
        },
      },
      close: async () => {
        for (const fn of [...closeListeners]) fn();
      },
    };
    vitePlugin.configResolved({ command: "serve", base: "/" });
    vitePlugin.configureServer(server);

    const clientEnv = { name: "client", config: { consumer: "client" } };
    const sourceA = `import { Code } from "@ferriki/core/react/macro";
export const A = () => <Code language="ts" source="alpha" />;`;
    const sourceB = `import { Code } from "@ferriki/core/react/macro";
export const B = () => <Code language="ts" source="beta" />;`;

    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      sourceA,
      "/src/a.tsx",
    );
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      sourceB,
      "/src/b.tsx",
    );

    // Mutating the object returned by `codeElementBlocks()` must not corrupt the cached snapshot.
    const blocksSnapshot = vitePlugin.api.codeElementBlocks("client");
    expect(Object.keys(blocksSnapshot)).toHaveLength(2);
    blocksSnapshot.injected = "<pre>mutated</pre>";
    expect(vitePlugin.api.codeElementBlocks("client").injected).toBeUndefined();

    // Shared CSS rules are deduplicated once and served consistently via middleware.
    const initialCss = vitePlugin.api.codeElementCss("client");
    expect(initialCss.split(".ferriki-shared{font-weight:bold}")).toHaveLength(2);
    expect(initialCss).toContain(".ferriki-style-alpha{color:red}");
    expect(initialCss).toContain(".ferriki-style-beta{color:red}");
    expect(wsSend).toHaveBeenCalledTimes(2);
    const secondHref = wsSend.mock.calls[1][0].data.href;

    let servedCss = "";
    cssMiddleware(
      { url: "/@ferriki/code-elements.css" },
      { setHeader() {}, end: (body) => (servedCss = body) },
      () => {},
    );
    expect(servedCss).toBe(initialCss);

    // Re-transforming /src/a.tsx with the same content keeps the palette hash unchanged (no extra WS push).
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      sourceA,
      "/src/a.tsx",
    );
    expect(wsSend).toHaveBeenCalledTimes(2);

    // Updating /src/a.tsx invalidates both the blocks and CSS caches.
    await vitePlugin.transform.handler.call(
      { ...context(), environment: clientEnv },
      `import { Code } from "@ferriki/core/react/macro";
export const A = () => <Code language="ts" source="gamma" />;`,
      "/src/a.tsx",
    );
    const updatedCss = vitePlugin.api.codeElementCss("client");
    expect(updatedCss).not.toContain(".ferriki-style-alpha{color:red}");
    expect(updatedCss).toContain(".ferriki-style-gamma{color:red}");
    expect(updatedCss).toContain(".ferriki-style-beta{color:red}");
    expect(wsSend).toHaveBeenCalledTimes(3);
    expect(wsSend.mock.calls[2][0].data.href).not.toBe(secondHref);

    // Deleting /src/b.tsx invalidates both caches cleanly.
    await vitePlugin.hotUpdate.call(
      { environment: clientEnv },
      { type: "delete", file: "/src/b.tsx" },
    );
    expect(Object.keys(vitePlugin.api.codeElementBlocks("client"))).toHaveLength(1);
    expect(vitePlugin.api.codeElementCss("client")).not.toContain(".ferriki-style-beta{color:red}");
    expect(vitePlugin.api.codeElementCss("client")).toContain(".ferriki-style-gamma{color:red}");

    // Closing the server clears dev React caches cleanly.
    await server.close();
    expect(Object.keys(vitePlugin.api.codeElementBlocks("client"))).toHaveLength(0);
    expect(vitePlugin.api.codeElementCss("client")).toBe("");
  });
});
