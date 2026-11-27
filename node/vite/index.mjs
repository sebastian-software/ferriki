import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, posix } from "node:path";
import process from "node:process";
import { createHighlighter, ShikiError } from "@ferriki/core";
import { codeElementStyles } from "@ferriki/core/web-component";
import { renderCodeElementShadows } from "@ferriki/core/web-component/server";
import MagicString from "magic-string";
import { parseAst } from "vite";

import { createCodeElementColorTransformer } from "./code-element-colors.mjs";
import { MACRO_MODULE_SPECIFIERS, MacroDiagnostic, scanInlineCodeMacros } from "./macro-scan.mjs";

const VIRTUAL_CSS_PREFIX = "virtual:ferriki-vite/";
const CODE_STYLESHEET_MODULE = `${VIRTUAL_CSS_PREFIX}code-element-stylesheet-url`;
const CODE_STYLESHEET_META = "FERRIKI_CODE_STYLESHEET_URL";
const DEV_CODE_STYLESHEET_PATH = "@ferriki/code-elements.css";
const MAX_SUPERSEDED_CSS = 64;
const MAX_UNSPILLED_CSS = 64;
const MAX_SPILLED_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_SPILLED_BYTES = 64 * 1024 * 1024;
const ABANDONED_CSS_TTL_MS = 5 * 60_000;
const SPILL_RETRY_BACKOFF_MS = 5_000;
const MAX_PENDING_CSS = 256;
const MAX_PENDING_CLAIMS_PER_ENV = 64;
const VIRTUAL_CSS_ID_PATTERN = /^virtual:ferriki-vite\/([0-9a-f]{64})\.css$/;
const SPILL_DIR_PREFIX = "ferriki-vite-css-";
const SPILL_DIR_PATTERN = /^ferriki-vite-css-(\d+)-.+$/;
const SPILL_MARKER_FILE = ".ferriki-vite-spill-v1";
const SPILLED_CSS_FILENAME_PATTERN = /^[0-9a-f]{64}\.css$/u;
const SPILLED_TMP_FILENAME_PATTERN =
  /^[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
/** A JavaScript or TypeScript module ID; a query after the path is allowed. */
const SCRIPT_ID = /^[^?]*\.[cm]?[jt]sx?(?:\?|$)/;
const LINE_CSS = [
  ".ferriki-highlight-line[data-ln]::before{content:attr(data-ln);display:inline-block;min-width:2.5em;margin-right:1.5em;padding-right:.75em;text-align:right;opacity:.55}",
  ".ferriki-highlight-line.highlighted{background:color-mix(in srgb,currentColor 10%,transparent)}",
].join("\n");

const DEFAULT_THEME = "github-dark-default";

/**
 * Prepare Ferriki's inline highlighting macros before the framework lowers JSX.
 * Only modules that import `@ferriki/core/macro` or `@ferriki/core/react/macro`
 * reach the transform; they are parsed once with Vite's own parser.
 * @param {import("./index.d.mts").FerrikiViteOptions} options
 * @returns {import("./index.d.mts").FerrikiVitePlugin} A plugin that prepares code macros.
 */
export function ferriki(options = {}) {
  if (options.theme && options.themes)
    throw new TypeError("Pass either `theme` or `themes`, not both");
  if (options.transformers !== undefined && !Array.isArray(options.transformers))
    throw new ShikiError("`transformers` option must be an array", "ERR_USAGE");

  const theme = options.theme ?? (options.themes ? undefined : DEFAULT_THEME);
  const themes = options.themes;
  if (themes && Object.keys(themes).length === 0)
    throw new ShikiError("`themes` option must not be empty", "ERR_USAGE");
  const styleMode = options.styleMode ?? "inline";
  const lineNumbers = options.lineNumbers ?? false;
  const transformers = [...(options.transformers ?? [])];
  const themeNames = themes ? [...new Set(Object.values(themes))] : [theme];
  const include = options.include;
  let activeSession;
  let nextEnvLifetimeId = 0;
  let minActiveGlobalLifetimeId = 0;
  const currentEnvLifetimeByObject = new WeakMap();
  const currentEnvLifetimeByName = new Map();
  const serverLifetimes = new WeakMap();
  const serverEnvObjects = new WeakMap();
  const serverByEnvObject = new WeakMap();
  const pendingDisposals = new Map();
  const languageLoadsByHighlighter = new WeakMap();
  const virtualCss = new Map();
  const issuedVirtualCss = new Map();
  const spilledVirtualCss = new Map();
  let spilledVirtualCssBytes = 0;
  const unspilledIssuedCss = new Set();
  const moduleGraphsByEnvironment = new Map();
  const supersededCss = new Map();
  const unownedPendingCss = new Set();
  const pendingCssEnvs = new Map();
  let nextCssClaimGeneration = 0;
  let spillDir;
  let spillExitCleanup;
  let spillEvictionTimer;
  let spillRetryAfter = 0;
  const moduleCss = new Map();
  const virtualCssOwners = new Map();
  const moduleTransformGeneration = new Map();
  const lastSucceededGenerationByKey = new Map();
  const moduleInvalidationEpoch = new Map();
  let nextInvalidationEpoch = 0;
  const inFlightTransformsByKey = new Map();
  const moduleKeysByFile = new Map();
  let nextTransformGeneration = 0;
  const inFlightTransformsByFile = new Map();
  const fileEditGeneration = new Map();
  let nextFileEditGeneration = 0;
  const fileEditRevision = new Map();
  let nextFileEditRevision = 0;
  const inFlightReadsByFile = new Map();
  const pendingWatchChangeFiles = new Set();
  const lastHotUpdateTimestamp = new Map();
  const warnedFiles = new Set();
  const reactModulesByEnvironment = new Map();
  const supersededReactCssByEnvironment = new Map();
  const reactModulesByObject = new WeakMap();
  const supersededReactCssByObject = new WeakMap();
  const reactLifetimesByObject = new WeakMap();
  let resolvedConfig;
  let configuredBase;
  let activeServer;
  let devServer;
  let hmrDisabled = false;
  const buildStylesheets = new WeakMap();

  function environmentNameOf(context) {
    return context?.environment?.name ?? "default";
  }

  function reactModuleMaps(environmentName) {
    if (environmentName !== undefined) {
      const modules = reactModulesByEnvironment.get(environmentName);
      return modules ? [modules] : [];
    }
    return [...reactModulesByEnvironment.values()];
  }

  function preparedReactBlocks(environmentName) {
    return Object.fromEntries(
      reactModuleMaps(environmentName).flatMap((modules) =>
        [...modules.values()].flatMap(({ blocks }) =>
          [...blocks].map(([ref, block]) => [ref, block.html]),
        ),
      ),
    );
  }

  function preparedReactCss(environmentName) {
    if (styleMode !== "classes") return "";
    const css = new Set();
    for (const modules of reactModuleMaps(environmentName)) {
      for (const { blocks } of modules.values()) {
        for (const block of blocks.values())
          if (block.css) for (const rule of cssRules(block.css)) css.add(rule);
      }
    }
    const supersededCaches =
      environmentName !== undefined
        ? [supersededReactCssByEnvironment.get(environmentName)].filter(Boolean)
        : [...supersededReactCssByEnvironment.values()];
    for (const cache of supersededCaches) {
      for (const entry of cache.values()) {
        if (entry.css) for (const rule of cssRules(entry.css)) css.add(rule);
      }
    }
    return [...css].join("\n");
  }

  function hasPreparedReactBlocksForEnvironment(environment, environmentName) {
    if (environment && typeof environment === "object") {
      const modules = reactModulesByObject.get(environment);
      if (modules) {
        for (const { blocks } of modules.values()) {
          if (blocks.size > 0) return true;
        }
      }
      return false;
    }
    return Object.keys(preparedReactBlocks(environmentName)).length > 0;
  }

  function preparedReactCssForEnvironment(environment, environmentName) {
    if (styleMode !== "classes") return "";
    if (environment && typeof environment === "object") {
      const css = new Set();
      const modules = reactModulesByObject.get(environment);
      if (modules) {
        for (const { blocks } of modules.values()) {
          for (const block of blocks.values())
            if (block.css) for (const rule of cssRules(block.css)) css.add(rule);
        }
      }
      const superseded = supersededReactCssByObject.get(environment);
      if (superseded) {
        for (const entry of superseded.values()) {
          if (entry.css) for (const rule of cssRules(entry.css)) css.add(rule);
        }
      }
      return [...css].join("\n");
    }
    return preparedReactCss(environmentName);
  }

  function rememberReactLifetimeForObject(environment, lifetimeId) {
    if (!environment || typeof environment !== "object") return;
    let lifetimes = reactLifetimesByObject.get(environment);
    if (!lifetimes) {
      lifetimes = new Set();
      reactLifetimesByObject.set(environment, lifetimes);
    }
    lifetimes.add(lifetimeId);
  }

  function currentEnvLifetime(environment, environmentName) {
    if (environment && typeof environment === "object") {
      let lifetimeId = currentEnvLifetimeByObject.get(environment);
      if (lifetimeId === undefined || lifetimeId <= minActiveGlobalLifetimeId) {
        lifetimeId = ++nextEnvLifetimeId;
        currentEnvLifetimeByObject.set(environment, lifetimeId);
        const ownerServer = serverByEnvObject.get(environment) ?? activeServer;
        if (ownerServer) {
          serverLifetimes.get(ownerServer)?.add(lifetimeId);
          serverEnvObjects.get(ownerServer)?.add(environment);
        }
      }
      return lifetimeId;
    }
    let lifetimeId = currentEnvLifetimeByName.get(environmentName);
    if (lifetimeId === undefined || lifetimeId <= minActiveGlobalLifetimeId) {
      lifetimeId = ++nextEnvLifetimeId;
      currentEnvLifetimeByName.set(environmentName, lifetimeId);
      if (activeServer) serverLifetimes.get(activeServer)?.add(lifetimeId);
    }
    return lifetimeId;
  }

  function advanceEnvLifetime(environment, environmentName) {
    if (environment && typeof environment === "object") {
      const closingLifetimeId = currentEnvLifetimeByObject.get(environment);
      if (closingLifetimeId === undefined || closingLifetimeId <= minActiveGlobalLifetimeId)
        return { lifetimeIds: new Set(), maxLifetimeId: undefined };
      currentEnvLifetimeByObject.set(environment, ++nextEnvLifetimeId);
      return { lifetimeIds: new Set([closingLifetimeId]), maxLifetimeId: undefined };
    }
    if (environmentName !== undefined) {
      const closingLifetimeId = currentEnvLifetimeByName.get(environmentName);
      if (closingLifetimeId === undefined || closingLifetimeId <= minActiveGlobalLifetimeId)
        return { lifetimeIds: new Set(), maxLifetimeId: undefined };
      currentEnvLifetimeByName.set(environmentName, ++nextEnvLifetimeId);
      return { lifetimeIds: new Set([closingLifetimeId]), maxLifetimeId: undefined };
    }
    const maxLifetimeId = nextEnvLifetimeId;
    minActiveGlobalLifetimeId = maxLifetimeId;
    return { lifetimeIds: new Set(), maxLifetimeId };
  }

  function isEnvLifetimeActive(environment, environmentName, lifetimeId) {
    if (lifetimeId === undefined || lifetimeId <= minActiveGlobalLifetimeId) return false;
    if (environment && typeof environment === "object")
      return currentEnvLifetimeByObject.get(environment) === lifetimeId;
    return currentEnvLifetimeByName.get(environmentName) === lifetimeId;
  }

  function matchesClosingLifetime(lifetimeId, closingScope) {
    if (!closingScope) return true;
    const { lifetimeIds, maxLifetimeId } = closingScope;
    if (maxLifetimeId !== undefined && lifetimeId <= maxLifetimeId) return true;
    if (lifetimeIds?.has(lifetimeId)) return true;
    return false;
  }

  function shouldClearClaim(generation, lifetimeId, maxGeneration, closingScope) {
    if (maxGeneration === undefined && !closingScope) return true;
    if (lifetimeId !== undefined && closingScope)
      return matchesClosingLifetime(lifetimeId, closingScope);
    if (maxGeneration !== undefined && generation <= maxGeneration) return true;
    return false;
  }

  function recordSupersededReactCss(
    environment,
    environmentName,
    id,
    renderedReactCss,
    lifetimeId,
  ) {
    if (styleMode !== "classes" || renderedReactCss.size === 0) return;
    const deduplicated = new Set();
    for (const css of renderedReactCss.values()) {
      if (css) for (const rule of cssRules(css)) deduplicated.add(rule);
    }
    if (deduplicated.size === 0) return;
    const cssText = [...deduplicated].join("\n");
    const generation = ++nextCssClaimGeneration;
    let cache = supersededReactCssByEnvironment.get(environmentName);
    if (!cache) {
      cache = new Map();
      supersededReactCssByEnvironment.set(environmentName, cache);
    }
    cache.set(generation, { id, css: cssText, lifetimeId });
    while (cache.size > MAX_SUPERSEDED_CSS) {
      const oldestGeneration = cache.keys().next().value;
      const oldestEntry = cache.get(oldestGeneration);
      cache.delete(oldestGeneration);
      if (oldestEntry)
        pruneUnusedModuleKey(moduleCssKey(environmentName, oldestEntry.lifetimeId, oldestEntry.id));
    }
    if (environment && typeof environment === "object") {
      rememberReactLifetimeForObject(environment, lifetimeId);
      let objectCache = supersededReactCssByObject.get(environment);
      if (!objectCache) {
        objectCache = new Map();
        supersededReactCssByObject.set(environment, objectCache);
      }
      objectCache.set(generation, { id, css: cssText, lifetimeId });
      while (objectCache.size > MAX_SUPERSEDED_CSS)
        objectCache.delete(objectCache.keys().next().value);
    }
  }

  function hasReactModuleForKey(environmentName, id, lifetimeId) {
    const entry = reactModulesByEnvironment.get(environmentName)?.get(id);
    return entry !== undefined && entry.lifetimeId === lifetimeId;
  }

  function hasSupersededReactCssForKey(environmentName, id, lifetimeId) {
    const cache = supersededReactCssByEnvironment.get(environmentName);
    if (!cache) return false;
    for (const entry of cache.values()) {
      if (entry.id === id && entry.lifetimeId === lifetimeId) return true;
    }
    return false;
  }

  function removeSupersededReactCssForModule(environmentName, id, lifetimeId, environment) {
    const cache = supersededReactCssByEnvironment.get(environmentName);
    let removed = false;
    if (cache) {
      for (const [generation, entry] of [...cache.entries()]) {
        if (entry.id === id && (lifetimeId === undefined || entry.lifetimeId === lifetimeId)) {
          cache.delete(generation);
          removed = true;
        }
      }
      if (cache.size === 0) supersededReactCssByEnvironment.delete(environmentName);
    }
    if (environment && typeof environment === "object") {
      const objectCache = supersededReactCssByObject.get(environment);
      if (objectCache) {
        for (const [generation, entry] of [...objectCache.entries()]) {
          if (entry.id === id && (lifetimeId === undefined || entry.lifetimeId === lifetimeId))
            objectCache.delete(generation);
        }
        if (objectCache.size === 0) supersededReactCssByObject.delete(environment);
      }
    }
    return removed;
  }

  function removeSupersededReactCssForFile(file, environmentName, lifetimeId, environment) {
    const environments =
      environmentName !== undefined
        ? [[environmentName, supersededReactCssByEnvironment.get(environmentName)]]
        : [...supersededReactCssByEnvironment.entries()];
    let removed = false;
    for (const [env, cache] of environments) {
      if (!cache) continue;
      for (const [generation, entry] of [...cache.entries()]) {
        if (
          entry.id.split("?", 1)[0] === file &&
          (lifetimeId === undefined || entry.lifetimeId === lifetimeId)
        ) {
          cache.delete(generation);
          removed = true;
        }
      }
      if (cache.size === 0) supersededReactCssByEnvironment.delete(env);
    }
    if (environment && typeof environment === "object") {
      const objectCache = supersededReactCssByObject.get(environment);
      if (objectCache) {
        for (const [generation, entry] of [...objectCache.entries()]) {
          if (
            entry.id.split("?", 1)[0] === file &&
            (lifetimeId === undefined || entry.lifetimeId === lifetimeId)
          )
            objectCache.delete(generation);
        }
        if (objectCache.size === 0) supersededReactCssByObject.delete(environment);
      }
    }
    return removed;
  }

  function clearSupersededReactCss(environmentName, maxGeneration, closingScope) {
    const environments =
      environmentName !== undefined
        ? [[environmentName, supersededReactCssByEnvironment.get(environmentName)]]
        : [...supersededReactCssByEnvironment.entries()];
    for (const [env, cache] of environments) {
      if (!cache) continue;
      const retiredKeys = new Set();
      if (maxGeneration === undefined && !closingScope) {
        for (const entry of cache.values())
          retiredKeys.add(moduleCssKey(env, entry.lifetimeId, entry.id));
        supersededReactCssByEnvironment.delete(env);
      } else {
        for (const [generation, entry] of [...cache.entries()]) {
          if (shouldClearClaim(generation, entry.lifetimeId, maxGeneration, closingScope)) {
            cache.delete(generation);
            retiredKeys.add(moduleCssKey(env, entry.lifetimeId, entry.id));
          }
        }
        if (cache.size === 0) supersededReactCssByEnvironment.delete(env);
      }
      for (const key of retiredKeys) pruneUnusedModuleKey(key);
    }
  }

  function refreshReactCss(previousPalette) {
    if (!devServer) return;
    const palette = preparedReactCss();
    if (palette !== previousPalette)
      devServer.ws.send({
        type: "custom",
        event: "ferriki:code-element-css",
        data: {
          href: `${devStylesheetHref(devServer.config.base)}?v=${createHash("sha256").update(palette).digest("hex")}`,
        },
      });
  }

  function removeReactModules(entries, notify = true, environment) {
    if (!entries.length) return;
    const previousPalette = notify && devServer ? preparedReactCss() : undefined;
    for (const [environmentName, id, lifetimeId] of entries) {
      const modules = reactModulesByEnvironment.get(environmentName);
      if (modules) {
        const existing = modules.get(id);
        if (existing && (lifetimeId === undefined || existing.lifetimeId === lifetimeId)) {
          modules.delete(id);
          if (modules.size === 0) reactModulesByEnvironment.delete(environmentName);
        }
      }
      if (environment && typeof environment === "object") {
        const objectModules = reactModulesByObject.get(environment);
        if (objectModules) {
          objectModules.delete(id);
          if (objectModules.size === 0) reactModulesByObject.delete(environment);
        }
      }
      removeSupersededReactCssForModule(environmentName, id, lifetimeId, environment);
      if (lifetimeId !== undefined)
        pruneModuleKeyIndex(moduleCssKey(environmentName, lifetimeId, id));
    }
    if (notify) refreshReactCss(previousPalette);
  }

  function reactModuleEntriesForFile(file, environmentName, lifetimeId) {
    const entries = [];
    for (const key of moduleKeysForFile(file, environmentName, lifetimeId)) {
      const [env, id, keyLifetimeId] = splitModuleKey(key);
      if (hasReactModuleForKey(env, id, keyLifetimeId)) entries.push([env, id, keyLifetimeId]);
    }
    return entries;
  }

  function publishBuildReactRegistry(environment, environmentName) {
    if (!environment || typeof environment !== "object") return;
    const previousModules = reactModulesByEnvironment.get(environmentName);
    const removedKeys = [];
    const nextObjectModules = reactModulesByObject.get(environment);
    if (nextObjectModules?.size) {
      const published = new Map();
      for (const [id, entry] of nextObjectModules.entries()) {
        published.set(id, {
          blocks: entry.blocks,
          lifetimeId: entry.lifetimeId,
          isDevServer: false,
        });
      }
      if (previousModules) {
        for (const [id, entry] of previousModules.entries()) {
          if (!published.has(id) || published.get(id).lifetimeId !== entry.lifetimeId)
            removedKeys.push(moduleCssKey(environmentName, entry.lifetimeId, id));
        }
      }
      reactModulesByEnvironment.set(environmentName, published);
    } else if (previousModules) {
      for (const [id, entry] of previousModules.entries())
        removedKeys.push(moduleCssKey(environmentName, entry.lifetimeId, id));
      reactModulesByEnvironment.delete(environmentName);
    }
    const previousSuperseded = supersededReactCssByEnvironment.get(environmentName);
    const nextSuperseded = supersededReactCssByObject.get(environment);
    if (nextSuperseded?.size) {
      const publishedSuperseded = new Map(nextSuperseded);
      if (previousSuperseded) {
        for (const [generation, entry] of previousSuperseded.entries()) {
          if (!publishedSuperseded.has(generation))
            removedKeys.push(moduleCssKey(environmentName, entry.lifetimeId, entry.id));
        }
      }
      supersededReactCssByEnvironment.set(environmentName, publishedSuperseded);
    } else if (previousSuperseded) {
      for (const entry of previousSuperseded.values())
        removedKeys.push(moduleCssKey(environmentName, entry.lifetimeId, entry.id));
      supersededReactCssByEnvironment.delete(environmentName);
    }
    for (const key of removedKeys) pruneUnusedModuleKey(key);
  }

  function retireDevReactModules(closingScope, environmentName) {
    const environments =
      environmentName !== undefined
        ? [[environmentName, reactModulesByEnvironment.get(environmentName)]]
        : [...reactModulesByEnvironment.entries()];
    for (const [env, modules] of environments) {
      if (!modules) continue;
      const removedKeys = [];
      for (const [id, entry] of [...modules.entries()]) {
        if (entry.isDevServer && matchesClosingLifetime(entry.lifetimeId, closingScope)) {
          modules.delete(id);
          removedKeys.push(moduleCssKey(env, entry.lifetimeId, id));
        }
      }
      if (modules.size === 0) reactModulesByEnvironment.delete(env);
      for (const key of removedKeys) pruneModuleKeyIndex(key);
    }
  }

  function acquireHighlighterSession(environmentName, lifetimeId) {
    if (!activeSession) {
      const session = {
        promise: undefined,
        highlighter: undefined,
        activeUsers: 0,
        activeUsersByLifetime: new Map(),
        lifetimes: new Map(),
        lifetimeIdleWaiters: new Map(),
        disposing: false,
        disposed: false,
        disposeWaiters: [],
      };
      session.promise = Promise.resolve()
        .then(() => createHighlighter({ themes: themeNames, assets: options.assets }))
        .then((highlighter) => {
          session.highlighter = highlighter;
          return highlighter;
        });
      session.promise.catch(() => {
        if (activeSession === session) activeSession = undefined;
      });
      activeSession = session;
    }
    activeSession.activeUsers++;
    if (lifetimeId !== undefined) {
      activeSession.lifetimes.set(lifetimeId, environmentName);
      activeSession.activeUsersByLifetime.set(
        lifetimeId,
        (activeSession.activeUsersByLifetime.get(lifetimeId) ?? 0) + 1,
      );
    }
    return activeSession;
  }

  function finalizeSessionDisposal(session) {
    if (!session.disposing || session.activeUsers > 0 || session.disposed) return;
    session.disposed = true;
    const done = session.promise.then(
      (highlighter) => {
        highlighter?.dispose?.();
      },
      () => {},
    );
    const waiters = session.disposeWaiters.splice(0);
    for (const resolve of waiters) resolve(done);
  }

  function releaseHighlighterSession(session, lifetimeId) {
    session.activeUsers--;
    if (lifetimeId !== undefined) {
      const remaining = (session.activeUsersByLifetime.get(lifetimeId) ?? 1) - 1;
      if (remaining > 0) session.activeUsersByLifetime.set(lifetimeId, remaining);
      else {
        session.activeUsersByLifetime.delete(lifetimeId);
        const waiters = session.lifetimeIdleWaiters.get(lifetimeId);
        if (waiters) {
          session.lifetimeIdleWaiters.delete(lifetimeId);
          for (const resolve of waiters) resolve();
        }
      }
    }
    if (session.activeUsers === 0) finalizeSessionDisposal(session);
  }

  function trackDisposal(promise, environments, environment, lifetimeIds) {
    const tracked = promise.then(
      () => {
        pendingDisposals.delete(tracked);
      },
      (error) => {
        pendingDisposals.delete(tracked);
        throw error;
      },
    );
    pendingDisposals.set(tracked, { environments, environment, lifetimeIds });
    return tracked;
  }

  async function disposeHighlighter(environment, environmentName, closingScope) {
    const waitForLifetimeIdle = [];
    const session = activeSession;
    const isGlobalClose = environment === undefined && environmentName === undefined;
    if (session) {
      if (isGlobalClose) {
        const sessionLifetimes = new Set(session.lifetimes.keys());
        for (const lifetimeId of sessionLifetimes) closingScope?.lifetimeIds.add(lifetimeId);
        activeSession = undefined;
        session.disposing = true;
        let disposal;
        if (session.activeUsers === 0) {
          session.disposed = true;
          disposal = session.promise.then(
            (highlighter) => {
              highlighter?.dispose?.();
            },
            () => {},
          );
        } else {
          disposal = new Promise((resolve) => {
            session.disposeWaiters.push(resolve);
          });
        }
        trackDisposal(disposal, undefined, undefined, sessionLifetimes);
      } else {
        const matchedLifetimes = [];
        for (const [lifetimeId, env] of [...session.lifetimes.entries()]) {
          if (env === environmentName && matchesClosingLifetime(lifetimeId, closingScope))
            matchedLifetimes.push(lifetimeId);
        }
        if (matchedLifetimes.length > 0) {
          for (const lifetimeId of matchedLifetimes) {
            closingScope?.lifetimeIds.add(lifetimeId);
            session.lifetimes.delete(lifetimeId);
          }
          if (session.lifetimes.size === 0) {
            activeSession = undefined;
            session.disposing = true;
            let disposal;
            if (session.activeUsers === 0) {
              session.disposed = true;
              disposal = session.promise.then(
                (highlighter) => {
                  highlighter?.dispose?.();
                },
                () => {},
              );
            } else {
              disposal = new Promise((resolve) => {
                session.disposeWaiters.push(resolve);
              });
            }
            trackDisposal(
              disposal,
              new Set([environmentName]),
              environment,
              new Set(matchedLifetimes),
            );
          } else {
            for (const lifetimeId of matchedLifetimes) {
              if ((session.activeUsersByLifetime.get(lifetimeId) ?? 0) > 0) {
                waitForLifetimeIdle.push(
                  new Promise((resolve) => {
                    let waiters = session.lifetimeIdleWaiters.get(lifetimeId);
                    if (!waiters) {
                      waiters = [];
                      session.lifetimeIdleWaiters.set(lifetimeId, waiters);
                    }
                    waiters.push(resolve);
                  }),
                );
              }
            }
          }
        }
      }
    }
    const disposalsToAwait = [...waitForLifetimeIdle];
    for (const [
      tracked,
      { environments, environment: pendingEnv, lifetimeIds },
    ] of pendingDisposals) {
      const matchesPending =
        isGlobalClose ||
        environments === undefined ||
        (environment && typeof environment === "object"
          ? pendingEnv === environment
          : environments.has(environmentName));
      if (matchesPending) {
        if (lifetimeIds) {
          for (const lifetimeId of lifetimeIds) closingScope?.lifetimeIds.add(lifetimeId);
        }
        disposalsToAwait.push(tracked);
      }
    }
    if (disposalsToAwait.length === 0) return;
    await Promise.all(disposalsToAwait);
  }

  function languageLoadsFor(highlighter) {
    let loads = languageLoadsByHighlighter.get(highlighter);
    if (!loads) {
      loads = new Map();
      languageLoadsByHighlighter.set(highlighter, loads);
    }
    return loads;
  }

  function warnOnce(context, id, language, cause, isCurrent) {
    if (isCurrent && !isCurrent()) return;
    const key = id.split("?", 1)[0];
    if (warnedFiles.has(key)) return;
    warnedFiles.add(key);
    context.warn(
      `Ferriki could not highlight language "${language}" in ${id}; keeping the block as plain code (${cause?.message ?? "unknown language"}).`,
    );
  }

  async function highlight(
    session,
    context,
    id,
    code,
    language,
    meta,
    effectiveLineNumbers,
    codeElement,
    isCurrent,
  ) {
    const highlighter = session.highlighter ?? (await session.promise);
    const loads = languageLoadsFor(highlighter);
    let loading = loads.get(language);
    if (!loading) {
      loading = Promise.resolve().then(() => highlighter.loadLanguage(language));
      loads.set(language, loading);
    }
    try {
      await loading;
    } catch (error) {
      if (loads.get(language) === loading) loads.delete(language);
      if (error?.code === "ERR_UNSUPPORTED") {
        warnOnce(context, id, language, error, isCurrent);
        return { html: plainCodeHtml(code, language, meta, effectiveLineNumbers), css: "" };
      }
      throw error;
    }

    const transformer = createMetaTransformer(meta, effectiveLineNumbers);
    const highlightOptions = {
      lang: language,
      ...(themes ? { themes, defaultColor: Object.keys(themes)[0] } : { theme }),
      styleMode,
      ...(codeElement
        ? {
            includeExplanation: "scopeName",
            mergeWhitespaces: false,
            mergeSameStyleTokens: false,
          }
        : {}),
      transformers: [
        ...transformers,
        transformer,
        ...(codeElement ? [createCodeElementColorTransformer()] : []),
      ],
    };
    try {
      if (styleMode === "classes") return highlighter.codeToHtmlWithCss(code, highlightOptions);
      return { html: highlighter.codeToHtml(code, highlightOptions), css: "" };
    } catch (error) {
      if (error?.code === "ERR_UNSUPPORTED") {
        warnOnce(context, id, language, error, isCurrent);
        return { html: plainCodeHtml(code, language, meta, effectiveLineNumbers), css: "" };
      }
      throw error;
    }
  }

  function moduleCssKey(environmentName, lifetimeId, id) {
    return `${environmentName}\0${lifetimeId}\0${id}`;
  }

  function splitModuleKey(key) {
    const first = key.indexOf("\0");
    const second = key.indexOf("\0", first + 1);
    return [key.slice(0, first), key.slice(second + 1), Number(key.slice(first + 1, second))];
  }

  function cssModuleId(css) {
    return `${VIRTUAL_CSS_PREFIX}${createHash("sha256").update(css).digest("hex")}.css`;
  }

  function currentSpillHostIdentity() {
    const currentHostname = hostname();
    let pidNs;
    if (process.platform === "linux") {
      try {
        pidNs = readlinkSync("/proc/self/ns/pid");
      } catch {
        pidNs = undefined;
      }
    }
    return { hostname: currentHostname, pidNs };
  }

  function reclaimAbandonedSpillDirs(rootDir) {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const { hostname: currentHostname, pidNs: currentPidNs } = currentSpillHostIdentity();
    let entries;
    try {
      entries = readdirSync(rootDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const match = SPILL_DIR_PATTERN.exec(entry);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if (error?.code !== "ESRCH") continue;
      }
      const candidate = join(rootDir, entry);
      try {
        const info = lstatSync(candidate);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (currentUid !== undefined && info.uid !== currentUid) continue;

        const markerPath = join(candidate, SPILL_MARKER_FILE);
        const markerInfo = lstatSync(markerPath);
        if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) continue;
        if (currentUid !== undefined && markerInfo.uid !== currentUid) continue;
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        if (
          marker?.app !== "@ferriki/vite" ||
          marker?.version !== 1 ||
          marker?.pid !== pid ||
          marker?.hostname !== currentHostname ||
          (process.platform === "linux" &&
            (currentPidNs === undefined || marker?.pidNs !== currentPidNs))
        )
          continue;

        const children = readdirSync(candidate);
        if (
          children.some(
            (child) =>
              child !== SPILL_MARKER_FILE &&
              !SPILLED_CSS_FILENAME_PATTERN.test(child) &&
              !SPILLED_TMP_FILENAME_PATTERN.test(child),
          )
        )
          continue;

        const payloadPaths = [];
        let unexpected = false;
        for (const child of children) {
          const childPath = join(candidate, child);
          const childInfo = lstatSync(childPath);
          if (!childInfo.isFile() || childInfo.isSymbolicLink()) {
            unexpected = true;
            break;
          }
          if (currentUid !== undefined && childInfo.uid !== currentUid) {
            unexpected = true;
            break;
          }
          if (child !== SPILL_MARKER_FILE) payloadPaths.push(childPath);
        }
        if (unexpected) continue;
        for (const payloadPath of payloadPaths) unlinkSync(payloadPath);
        unlinkSync(markerPath);
        rmdirSync(candidate);
      } catch {
        // Ignore races or permission errors on sibling temp entries.
      }
    }
  }

  function ensureSpillDir() {
    if (spillDir) return spillDir;
    const rootDir = tmpdir();
    spillDir = mkdtempSync(join(rootDir, `${SPILL_DIR_PREFIX}${process.pid}-`));
    try {
      chmodSync(spillDir, 0o700);
    } catch {
      // Ignore platforms without POSIX chmod semantics.
    }
    try {
      const { hostname: currentHostname, pidNs } = currentSpillHostIdentity();
      writeFileSync(
        join(spillDir, SPILL_MARKER_FILE),
        JSON.stringify({
          app: "@ferriki/vite",
          pid: process.pid,
          hostname: currentHostname,
          ...(pidNs !== undefined ? { pidNs } : {}),
          version: 1,
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      const createdDir = spillDir;
      spillDir = undefined;
      try {
        rmSync(createdDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of half-initialized spill dir.
      }
      throw error;
    }
    spillExitCleanup = () => {
      cleanupSpillDir();
    };
    process.once("exit", spillExitCleanup);
    reclaimAbandonedSpillDirs(rootDir);
    return spillDir;
  }

  function clearSpillEvictionTimer() {
    if (!spillEvictionTimer) return;
    clearTimeout(spillEvictionTimer);
    spillEvictionTimer = undefined;
  }

  function cleanupSpillDir() {
    clearSpillEvictionTimer();
    spilledVirtualCss.clear();
    spilledVirtualCssBytes = 0;
    const dir = spillDir;
    spillDir = undefined;
    if (spillExitCleanup) {
      process.off("exit", spillExitCleanup);
      spillExitCleanup = undefined;
    }
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on teardown.
    }
  }

  function unlinkSpilledFile(cssId) {
    if (!spillDir) return;
    const match = VIRTUAL_CSS_ID_PATTERN.exec(cssId);
    if (!match) return;
    try {
      rmSync(join(spillDir, `${match[1]}.css`), { force: true });
    } catch {
      // Best-effort cleanup of individual spill files.
    }
  }

  function removeSpilledEntry(cssId) {
    const entry = spilledVirtualCss.get(cssId);
    if (!entry) return;
    spilledVirtualCss.delete(cssId);
    spilledVirtualCssBytes = Math.max(0, spilledVirtualCssBytes - entry.bytes);
    unlinkSpilledFile(cssId);
  }

  function isCachedInViteModuleGraph(cssId, environmentName) {
    const graph =
      moduleGraphsByEnvironment.get(environmentName) ??
      activeServer?.environments?.[environmentName]?.moduleGraph ??
      (environmentName === "client" || environmentName === "default"
        ? activeServer?.moduleGraph
        : undefined);
    return Boolean(graph?.getModuleById?.(`\0${cssId}`)?.transformResult);
  }

  function clearIssuedVirtualCssForEnvironment(environmentName, maxGeneration, closingScope) {
    for (const [cssId, issuedEnvs] of [...issuedVirtualCss.entries()]) {
      const targetEnvs =
        environmentName !== undefined
          ? [[environmentName, issuedEnvs.get(environmentName)]]
          : [...issuedEnvs.entries()];
      for (const [env, lifetimes] of targetEnvs) {
        if (!lifetimes) continue;
        for (const [claimKey, entry] of [...lifetimes.entries()]) {
          if (shouldClearClaim(entry.generation, entry.lifetimeId, maxGeneration, closingScope))
            lifetimes.delete(claimKey);
        }
        if (lifetimes.size === 0) issuedEnvs.delete(env);
      }
      if (issuedEnvs.size === 0) {
        issuedVirtualCss.delete(cssId);
        unspilledIssuedCss.delete(cssId);
        if (!virtualCssOwners.has(cssId) && !pendingCssEnvs.has(cssId) && !supersededCss.has(cssId))
          virtualCss.delete(cssId);
      }
    }
    for (const cssId of [...unspilledIssuedCss]) {
      if (!issuedVirtualCss.has(cssId)) {
        unspilledIssuedCss.delete(cssId);
        if (!virtualCssOwners.has(cssId) && !pendingCssEnvs.has(cssId) && !supersededCss.has(cssId))
          virtualCss.delete(cssId);
      }
    }
  }

  function spillVirtualCss(cssId, css) {
    const match = VIRTUAL_CSS_ID_PATTERN.exec(cssId);
    if (!match) return false;
    const byteLength = Buffer.byteLength(css, "utf8");
    if (byteLength > MAX_SPILLED_BYTES) return false;
    if (Date.now() < spillRetryAfter) return false;
    const existingBytes = spilledVirtualCss.get(cssId)?.bytes ?? 0;
    const netBytes = Math.max(0, byteLength - existingBytes);
    if (netBytes > 0 && spilledVirtualCssBytes + netBytes > MAX_PENDING_SPILLED_BYTES) {
      evictSpilledCss();
      if (spilledVirtualCssBytes + netBytes > MAX_PENDING_SPILLED_BYTES) {
        let evictedPending = false;
        for (const oldCssId of [...spilledVirtualCss.keys()]) {
          if (spilledVirtualCssBytes + netBytes <= MAX_PENDING_SPILLED_BYTES) break;
          if (oldCssId === cssId) continue;
          removeSpilledEntry(oldCssId);
          evictedPending = true;
        }
        if (evictedPending) activeServer?.ws?.send?.({ type: "full-reload" });
      }
    }
    let temporary;
    try {
      const dir = ensureSpillDir();
      const target = join(dir, `${match[1]}.css`);
      temporary = join(dir, `${match[1]}.${randomUUID()}.tmp`);
      writeFileSync(temporary, css, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
      spillRetryAfter = 0;
      return true;
    } catch {
      spillRetryAfter = Date.now() + SPILL_RETRY_BACKOFF_MS;
      if (temporary) {
        try {
          rmSync(temporary, { force: true });
        } catch {
          // Ignore temporary spill cleanup errors.
        }
      }
      evictSpilledCss();
      return false;
    }
  }

  function evictSpilledCss() {
    clearSpillEvictionTimer();
    if (spilledVirtualCssBytes <= MAX_SPILLED_BYTES) return;
    const now = Date.now();
    let earliestExpiry = Infinity;
    for (const [cssId, entry] of [...spilledVirtualCss.entries()]) {
      if (spilledVirtualCssBytes <= MAX_SPILLED_BYTES || spilledVirtualCss.size <= 1) break;
      let entryExpiry = -Infinity;
      for (const envLifetimes of entry.environments.values()) {
        for (const envEntry of envLifetimes.values()) {
          if (
            (envEntry.awaitingLoad || (envEntry.pendingResolves ?? 0) > 0) &&
            now - envEntry.issuedAt < ABANDONED_CSS_TTL_MS
          ) {
            const expiry = envEntry.issuedAt + ABANDONED_CSS_TTL_MS;
            if (expiry > entryExpiry) entryExpiry = expiry;
          }
        }
      }
      if (entryExpiry > -Infinity) {
        if (entryExpiry < earliestExpiry) earliestExpiry = entryExpiry;
        continue;
      }
      removeSpilledEntry(cssId);
    }
    if (spilledVirtualCssBytes > MAX_SPILLED_BYTES && Number.isFinite(earliestExpiry)) {
      const delay = Math.max(1, earliestExpiry - Date.now());
      spillEvictionTimer = setTimeout(() => {
        spillEvictionTimer = undefined;
        evictSpilledCss();
      }, delay);
      spillEvictionTimer.unref?.();
    }
  }

  function clearSpilledVirtualCssForEnvironment(environmentName, maxGeneration, closingScope) {
    for (const [cssId, entry] of [...spilledVirtualCss.entries()]) {
      const targetEnvs =
        environmentName !== undefined
          ? [[environmentName, entry.environments.get(environmentName)]]
          : [...entry.environments.entries()];
      for (const [env, lifetimes] of targetEnvs) {
        if (!lifetimes) continue;
        for (const [claimKey, envEntry] of [...lifetimes.entries()]) {
          if (
            shouldClearClaim(envEntry.generation, envEntry.lifetimeId, maxGeneration, closingScope)
          )
            lifetimes.delete(claimKey);
        }
        if (lifetimes.size === 0) entry.environments.delete(env);
      }
      if (entry.environments.size === 0) removeSpilledEntry(cssId);
    }
    if (spilledVirtualCss.size === 0 && spillDir) cleanupSpillDir();
    else evictSpilledCss();
    clearIssuedVirtualCssForEnvironment(environmentName, maxGeneration, closingScope);
  }

  function readSpilledVirtualCss(cssId, environmentName, lifetimeId) {
    if (!spillDir) return null;
    const entry = spilledVirtualCss.get(cssId);
    const envLifetimes = entry?.environments.get(environmentName);
    const envEntry = envLifetimes?.get(lifetimeId ?? 0);
    if (!envEntry) return null;
    const match = VIRTUAL_CSS_ID_PATTERN.exec(cssId);
    if (!match) return null;
    let css;
    try {
      css = readFileSync(join(spillDir, `${match[1]}.css`), "utf8");
      if (createHash("sha256").update(css).digest("hex") !== match[1]) return null;
    } catch {
      return null;
    }
    // Mark initial load settled and promote to MRU so it stays reloadable across
    // Vite invalidations while allowing older settled or abandoned entries to evict.
    envEntry.awaitingLoad = false;
    spilledVirtualCss.delete(cssId);
    spilledVirtualCss.set(cssId, entry);
    evictSpilledCss();
    return css;
  }

  function markIssuedVirtualCss(cssId, environmentName, awaitingLoad = true, lifetimeId) {
    let environments = issuedVirtualCss.get(cssId);
    if (!environments) {
      environments = new Map();
      issuedVirtualCss.set(cssId, environments);
    }
    let lifetimes = environments.get(environmentName);
    if (!lifetimes) {
      lifetimes = new Map();
      environments.set(environmentName, lifetimes);
    }
    const claimKey = lifetimeId ?? 0;
    const existing = lifetimes.get(claimKey);
    lifetimes.set(claimKey, {
      generation: ++nextCssClaimGeneration,
      awaitingLoad,
      pendingResolves: existing?.pendingResolves ?? 0,
      issuedAt: Date.now(),
      lifetimeId: lifetimeId ?? existing?.lifetimeId,
    });
  }

  function clearIssuedVirtualCss(cssId, environmentName, lifetimeId) {
    const environments = issuedVirtualCss.get(cssId);
    if (!environments) return false;
    if (environmentName !== undefined) {
      const lifetimes = environments.get(environmentName);
      if (!lifetimes) return false;
      const removed =
        lifetimeId !== undefined
          ? lifetimes.delete(lifetimeId)
          : environments.delete(environmentName);
      if (lifetimes.size === 0) environments.delete(environmentName);
      if (environments.size === 0) issuedVirtualCss.delete(cssId);
      return removed;
    }
    issuedVirtualCss.delete(cssId);
    return true;
  }

  function deleteVirtualCssEntry(cssId) {
    const css = virtualCss.get(cssId);
    if (css === undefined) {
      issuedVirtualCss.delete(cssId);
      unspilledIssuedCss.delete(cssId);
      return;
    }
    const issuedEnvs = issuedVirtualCss.get(cssId);
    if (issuedEnvs?.size) {
      if (spillVirtualCss(cssId, css)) {
        unspilledIssuedCss.delete(cssId);
        const bytes = Buffer.byteLength(css, "utf8");
        let entry = spilledVirtualCss.get(cssId);
        if (!entry) {
          entry = { bytes, environments: new Map() };
          spilledVirtualCssBytes += bytes;
        } else {
          spilledVirtualCss.delete(cssId);
        }
        for (const [env, issuedLifetimes] of issuedEnvs) {
          let spilledLifetimes = entry.environments.get(env);
          if (!spilledLifetimes) {
            spilledLifetimes = new Map();
            entry.environments.set(env, spilledLifetimes);
          }
          for (const [claimKey, issuedEntry] of issuedLifetimes) {
            const existing = spilledLifetimes.get(claimKey);
            if (!existing) {
              spilledLifetimes.set(claimKey, {
                generation: issuedEntry.generation,
                awaitingLoad: issuedEntry.awaitingLoad,
                pendingResolves: issuedEntry.pendingResolves ?? 0,
                issuedAt: issuedEntry.issuedAt,
                lifetimeId: issuedEntry.lifetimeId,
              });
            } else {
              if (issuedEntry.generation > existing.generation) {
                existing.generation = issuedEntry.generation;
                existing.lifetimeId = issuedEntry.lifetimeId;
              }
              if (issuedEntry.awaitingLoad) existing.awaitingLoad = true;
              existing.pendingResolves =
                (existing.pendingResolves ?? 0) + (issuedEntry.pendingResolves ?? 0);
              if (issuedEntry.issuedAt > existing.issuedAt)
                existing.issuedAt = issuedEntry.issuedAt;
            }
          }
        }
        spilledVirtualCss.set(cssId, entry);
        evictSpilledCss();
      } else {
        // Keep a bounded in-memory fallback when spilling fails without blocking O(1) eviction.
        unspilledIssuedCss.delete(cssId);
        unspilledIssuedCss.add(cssId);
        let evictedFallback = false;
        while (unspilledIssuedCss.size > MAX_UNSPILLED_CSS) {
          const oldest = unspilledIssuedCss.values().next().value;
          unspilledIssuedCss.delete(oldest);
          if (!virtualCssOwners.has(oldest) && !pendingCssEnvs.has(oldest)) {
            issuedVirtualCss.delete(oldest);
            virtualCss.delete(oldest);
            evictedFallback = true;
          }
        }
        if (evictedFallback) activeServer?.ws?.send?.({ type: "full-reload" });
        return;
      }
    }
    issuedVirtualCss.delete(cssId);
    unspilledIssuedCss.delete(cssId);
    virtualCss.delete(cssId);
  }

  function promotePendingClaimsForSpill(cssId) {
    const environments = pendingCssEnvs.get(cssId);
    pendingCssEnvs.delete(cssId);
    if (!environments) return;
    const now = Date.now();
    let issuedEnvs = issuedVirtualCss.get(cssId);
    for (const [env, queue] of environments) {
      const freshClaims = queue.filter((claim) => now - claim.issuedAt < ABANDONED_CSS_TTL_MS);
      if (freshClaims.length === 0) continue;
      if (!issuedEnvs) {
        issuedEnvs = new Map();
        issuedVirtualCss.set(cssId, issuedEnvs);
      }
      let issuedLifetimes = issuedEnvs.get(env);
      if (!issuedLifetimes) {
        issuedLifetimes = new Map();
        issuedEnvs.set(env, issuedLifetimes);
      }
      for (const claim of freshClaims) {
        const claimKey = claim.lifetimeId ?? 0;
        const existing = issuedLifetimes.get(claimKey);
        if (!existing) {
          issuedLifetimes.set(claimKey, {
            generation: claim.generation,
            awaitingLoad: true,
            pendingResolves: 1,
            issuedAt: claim.issuedAt,
            lifetimeId: claim.lifetimeId,
          });
        } else {
          if (claim.generation > existing.generation) {
            existing.generation = claim.generation;
            existing.lifetimeId = claim.lifetimeId;
          }
          existing.awaitingLoad = true;
          existing.pendingResolves = (existing.pendingResolves ?? 0) + 1;
          if (claim.issuedAt > existing.issuedAt) existing.issuedAt = claim.issuedAt;
        }
      }
    }
  }

  function removeFromUnownedQueues(cssId) {
    unownedPendingCss.delete(cssId);
    supersededCss.delete(cssId);
    unspilledIssuedCss.delete(cssId);
  }

  function evictUnownedQueue(queue, maxSize, clearClaims) {
    while (queue.size > maxSize) {
      const oldest = queue.keys().next().value;
      queue.delete(oldest);
      clearClaims?.(oldest);
      if (!virtualCssOwners.has(oldest) && !pendingCssEnvs.has(oldest))
        deleteVirtualCssEntry(oldest);
    }
  }

  function syncUnownedCss(cssId, environmentName, lifetimeId) {
    if (!virtualCss.has(cssId) || virtualCssOwners.has(cssId)) {
      removeFromUnownedQueues(cssId);
      return;
    }
    if (pendingCssEnvs.has(cssId)) {
      supersededCss.delete(cssId);
      unspilledIssuedCss.delete(cssId);
      unownedPendingCss.delete(cssId);
      unownedPendingCss.add(cssId);
      evictUnownedQueue(unownedPendingCss, MAX_PENDING_CSS, promotePendingClaimsForSpill);
      return;
    }
    unownedPendingCss.delete(cssId);
    if (unspilledIssuedCss.has(cssId)) return;
    const envLifetimes = supersededCss.get(cssId) ?? new Map();
    if (environmentName !== undefined && lifetimeId !== undefined) {
      let lifetimes = envLifetimes.get(environmentName);
      if (!lifetimes) {
        lifetimes = new Set();
        envLifetimes.set(environmentName, lifetimes);
      }
      lifetimes.add(lifetimeId);
    }
    supersededCss.delete(cssId);
    supersededCss.set(cssId, envLifetimes);
    evictUnownedQueue(supersededCss, MAX_SUPERSEDED_CSS);
  }

  function clearSupersededVirtualCss(environmentName, closingScope) {
    for (const [cssId, envLifetimes] of [...supersededCss.entries()]) {
      if (environmentName !== undefined) {
        const lifetimes = envLifetimes.get(environmentName);
        if (lifetimes) {
          for (const lifetimeId of [...lifetimes]) {
            if (matchesClosingLifetime(lifetimeId, closingScope)) lifetimes.delete(lifetimeId);
          }
          if (lifetimes.size === 0) envLifetimes.delete(environmentName);
        }
      } else {
        for (const [env, lifetimes] of [...envLifetimes.entries()]) {
          for (const lifetimeId of [...lifetimes]) {
            if (matchesClosingLifetime(lifetimeId, closingScope)) lifetimes.delete(lifetimeId);
          }
          if (lifetimes.size === 0) envLifetimes.delete(env);
        }
      }
      if (envLifetimes.size === 0) {
        supersededCss.delete(cssId);
        if (
          !virtualCssOwners.has(cssId) &&
          !pendingCssEnvs.has(cssId) &&
          !issuedVirtualCss.has(cssId)
        ) {
          virtualCss.delete(cssId);
        } else if (
          !virtualCssOwners.has(cssId) &&
          !pendingCssEnvs.has(cssId) &&
          issuedVirtualCss.has(cssId) &&
          !unspilledIssuedCss.has(cssId)
        ) {
          // Keep cssId inside the bounded supersededCss queue under surviving issued
          // lifetimes so RAM stays bounded and closing the final environment drops it.
          const surviving = new Map();
          for (const [env, lifetimes] of issuedVirtualCss.get(cssId)) {
            const ids = new Set();
            for (const entry of lifetimes.values()) {
              if (entry.lifetimeId !== undefined) ids.add(entry.lifetimeId);
            }
            if (ids.size > 0) surviving.set(env, ids);
          }
          if (surviving.size > 0) {
            supersededCss.set(cssId, surviving);
            evictUnownedQueue(supersededCss, MAX_SUPERSEDED_CSS);
          }
        }
      }
    }
  }

  function consumeOnePendingClaim(cssId, environmentName, lifetimeId) {
    const environments = pendingCssEnvs.get(cssId);
    if (!environments) return undefined;
    const queue = environments.get(environmentName);
    if (!queue?.length) return undefined;
    const index =
      lifetimeId !== undefined
        ? queue.findIndex((candidate) => candidate.lifetimeId === lifetimeId)
        : 0;
    if (index < 0) return undefined;
    const claim = queue.splice(index, 1)[0];
    if (queue.length === 0) environments.delete(environmentName);
    if (environments.size === 0) pendingCssEnvs.delete(cssId);
    return claim;
  }

  function clearPendingClaims(cssId, environmentName, maxGeneration, closingScope) {
    const environments = pendingCssEnvs.get(cssId);
    if (!environments) return false;
    if (environmentName !== undefined) {
      const queue = environments.get(environmentName);
      if (!queue?.length) return false;
      if (maxGeneration === undefined && !closingScope) {
        environments.delete(environmentName);
      } else {
        const remaining = queue.filter(
          (claim) =>
            !shouldClearClaim(claim.generation, claim.lifetimeId, maxGeneration, closingScope),
        );
        if (remaining.length === queue.length) return false;
        if (remaining.length > 0) environments.set(environmentName, remaining);
        else environments.delete(environmentName);
      }
      if (environments.size === 0) pendingCssEnvs.delete(cssId);
      return true;
    }
    if (maxGeneration !== undefined || closingScope) {
      let removed = false;
      for (const [env, queue] of [...environments]) {
        const remaining = queue.filter(
          (claim) =>
            !shouldClearClaim(claim.generation, claim.lifetimeId, maxGeneration, closingScope),
        );
        if (remaining.length === queue.length) continue;
        removed = true;
        if (remaining.length > 0) environments.set(env, remaining);
        else environments.delete(env);
      }
      if (!removed) return false;
      if (environments.size === 0) pendingCssEnvs.delete(cssId);
      return true;
    }
    pendingCssEnvs.delete(cssId);
    return true;
  }

  function markPendingCssLoad(cssId, css, environmentName, lifetimeId) {
    if (!virtualCss.has(cssId)) virtualCss.set(cssId, css);
    let environments = pendingCssEnvs.get(cssId);
    if (!environments) {
      environments = new Map();
      pendingCssEnvs.set(cssId, environments);
    }
    let queue = environments.get(environmentName);
    if (!queue) {
      queue = [];
      environments.set(environmentName, queue);
    }
    queue.push({ generation: ++nextCssClaimGeneration, issuedAt: Date.now(), lifetimeId });
    if (queue.length > MAX_PENDING_CLAIMS_PER_ENV)
      queue.splice(0, queue.length - MAX_PENDING_CLAIMS_PER_ENV);
    syncUnownedCss(cssId);
  }

  function clearPendingCssForEnvironment(environmentName, maxGeneration, closingScope) {
    for (const cssId of [...pendingCssEnvs.keys()]) {
      if (clearPendingClaims(cssId, environmentName, maxGeneration, closingScope)) {
        if (
          !virtualCssOwners.has(cssId) &&
          !pendingCssEnvs.has(cssId) &&
          !issuedVirtualCss.has(cssId) &&
          !supersededCss.has(cssId)
        ) {
          removeFromUnownedQueues(cssId);
          virtualCss.delete(cssId);
        } else {
          syncUnownedCss(cssId);
        }
      }
    }
  }

  function releaseCssOwner(cssId, key, deleteIfOrphaned = false) {
    const owners = virtualCssOwners.get(cssId);
    if (!owners) return;
    owners.delete(key);
    if (owners.size === 0) {
      virtualCssOwners.delete(cssId);
      if (deleteIfOrphaned && !pendingCssEnvs.has(cssId) && !issuedVirtualCss.has(cssId)) {
        removeFromUnownedQueues(cssId);
        virtualCss.delete(cssId);
      } else {
        const [env, , lifetimeId] = splitModuleKey(key);
        syncUnownedCss(cssId, env, lifetimeId);
      }
    }
  }

  function indexModuleKey(key) {
    const [, id] = splitModuleKey(key);
    const file = id.split("?", 1)[0];
    let keys = moduleKeysByFile.get(file);
    if (!keys) {
      keys = new Set();
      moduleKeysByFile.set(file, keys);
    }
    keys.add(key);
  }

  function pruneModuleKeyIndex(key) {
    const [environmentName, id, lifetimeId] = splitModuleKey(key);
    if (
      moduleCss.has(key) ||
      moduleTransformGeneration.has(key) ||
      hasReactModuleForKey(environmentName, id, lifetimeId)
    )
      return;
    const file = id.split("?", 1)[0];
    const keys = moduleKeysByFile.get(file);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) {
      moduleKeysByFile.delete(file);
      if (!inFlightReadsByFile.has(file)) fileEditRevision.delete(file);
    }
  }

  function deleteModuleGenerationKey(key) {
    lastSucceededGenerationByKey.delete(key);
    if (!moduleTransformGeneration.delete(key)) return;
    pruneModuleKeyIndex(key);
  }

  function invalidateModuleKey(key) {
    deleteModuleGenerationKey(key);
    if (inFlightTransformsByKey.has(key)) moduleInvalidationEpoch.set(key, ++nextInvalidationEpoch);
  }

  function pruneUnusedModuleKey(key) {
    const [environmentName, id, lifetimeId] = splitModuleKey(key);
    if (
      inFlightTransformsByKey.has(key) ||
      moduleCss.has(key) ||
      hasReactModuleForKey(environmentName, id, lifetimeId) ||
      hasSupersededReactCssForKey(environmentName, id, lifetimeId)
    )
      return;
    deleteModuleGenerationKey(key);
  }

  function setModuleCss(environmentName, id, css, lifetimeId) {
    const key = moduleCssKey(environmentName, lifetimeId, id);
    const previousId = moduleCss.get(key);
    const nextId = css ? cssModuleId(css) : undefined;
    if (nextId) {
      virtualCss.set(nextId, css);
      let owners = virtualCssOwners.get(nextId);
      if (!owners) {
        owners = new Set();
        virtualCssOwners.set(nextId, owners);
      }
      owners.add(key);
      moduleCss.set(key, nextId);
      indexModuleKey(key);
      markPendingCssLoad(nextId, css, environmentName, lifetimeId);
    } else {
      moduleCss.delete(key);
      pruneModuleKeyIndex(key);
    }
    if (previousId && previousId !== nextId) releaseCssOwner(previousId, key);
    return nextId;
  }

  function clearModuleCssForKey(key, deleteIfOrphaned = false) {
    const previousId = moduleCss.get(key);
    if (!previousId) return;
    moduleCss.delete(key);
    pruneModuleKeyIndex(key);
    releaseCssOwner(previousId, key, deleteIfOrphaned);
  }

  function clearModuleCssForFile(file, environmentName) {
    for (const key of moduleKeysForFile(file, environmentName)) clearModuleCssForKey(key);
  }

  function retireClosingLifetimeModules(environmentName, closingScope) {
    for (const key of [...moduleCss.keys()]) {
      const [env, , lifetimeId] = splitModuleKey(key);
      if (
        (environmentName === undefined || env === environmentName) &&
        matchesClosingLifetime(lifetimeId, closingScope)
      )
        clearModuleCssForKey(key, true);
    }
    for (const key of [...moduleTransformGeneration.keys()]) {
      if (inFlightTransformsByKey.has(key)) continue;
      const [env, , lifetimeId] = splitModuleKey(key);
      if (
        (environmentName === undefined || env === environmentName) &&
        matchesClosingLifetime(lifetimeId, closingScope)
      )
        deleteModuleGenerationKey(key);
    }
  }

  function startModuleGeneration(key) {
    const generation = ++nextTransformGeneration;
    moduleTransformGeneration.set(key, generation);
    indexModuleKey(key);
    return generation;
  }

  function canCommitModuleGeneration(key, generation, invalidationEpoch) {
    return (
      (moduleInvalidationEpoch.get(key) ?? 0) === invalidationEpoch &&
      moduleTransformGeneration.has(key) &&
      generation > (lastSucceededGenerationByKey.get(key) ?? 0)
    );
  }

  function moduleKeysForFile(file, environmentName, lifetimeId) {
    const indexed = moduleKeysByFile.get(file);
    if (!indexed) return [];
    if (environmentName === undefined && lifetimeId === undefined) return [...indexed];
    const prefix =
      environmentName !== undefined
        ? lifetimeId !== undefined
          ? `${environmentName}\0${lifetimeId}\0`
          : `${environmentName}\0`
        : undefined;
    const matched = [];
    for (const key of indexed) {
      if (prefix !== undefined) {
        if (key.startsWith(prefix)) matched.push(key);
      } else if (splitModuleKey(key)[2] === lifetimeId) {
        matched.push(key);
      }
    }
    return matched;
  }

  function clearModuleGenerationsForFile(file, environmentName) {
    for (const key of moduleKeysForFile(file, environmentName)) invalidateModuleKey(key);
  }

  function markFileEdited(file) {
    warnedFiles.delete(file);
    if (inFlightTransformsByFile.has(file)) fileEditGeneration.set(file, ++nextFileEditGeneration);
    if (inFlightReadsByFile.has(file) || moduleKeysByFile.has(file))
      fileEditRevision.set(file, ++nextFileEditRevision);
  }

  function rememberBoundedSet(set, key, maxSize) {
    set.delete(key);
    set.add(key);
    while (set.size > maxSize) set.delete(set.values().next().value);
  }

  function rememberBoundedMap(map, key, value, maxSize) {
    map.delete(key);
    map.set(key, value);
    while (map.size > maxSize) map.delete(map.keys().next().value);
  }

  function clearRemovedMacroFile(file, environmentName, lifetimeId, environment) {
    const previousPalette = devServer ? preparedReactCss() : undefined;
    const keys = moduleKeysForFile(file, environmentName, lifetimeId);
    for (const key of keys) {
      // Invalidating the key prevents any in-flight old-source transform from
      // publishing blocks or CSS even if the file is later recreated at the same path.
      invalidateModuleKey(key);
      clearModuleCssForKey(key);
    }
    removeReactModules(keys.map(splitModuleKey), false, environment);
    removeSupersededReactCssForFile(file, environmentName, lifetimeId, environment);
    refreshReactCss(previousPalette);
  }

  return {
    name: "@ferriki/vite",
    enforce: "pre",
    api: {
      codeElementBlocks(environmentName) {
        return preparedReactBlocks(environmentName);
      },
      renderCodeElements(markup, options = {}) {
        const { environment, ...renderOptions } = options;
        return renderCodeElementShadows(markup, {
          themeAliases: themes ? Object.keys(themes) : [],
          ...renderOptions,
          blocks: preparedReactBlocks(environment),
        });
      },
      codeElementCss(environmentName) {
        return preparedReactCss(environmentName);
      },
    },

    config: {
      order: "post",
      handler(config) {
        configuredBase = config.base;
      },
    },

    configResolved(config) {
      resolvedConfig = config;
    },

    configureServer(server) {
      hmrDisabled = server.config?.server?.hmr === false;
      activeServer = server;
      serverLifetimes.set(server, new Set());
      serverEnvObjects.set(server, new Set());
      if (server.environments && typeof server.environments === "object") {
        for (const env of Object.values(server.environments)) {
          if (env && typeof env === "object") {
            serverByEnvObject.set(env, server);
            serverEnvObjects.get(server)?.add(env);
          }
        }
      }
      reclaimAbandonedSpillDirs(tmpdir());
      let closePromise;
      const onServerClose = () => {
        if (!closePromise) {
          server.httpServer?.off?.("close", onServerClose);
          if (activeServer === server) {
            activeServer = undefined;
            if (devServer === server) devServer = undefined;
            moduleGraphsByEnvironment.clear();
            const closingThroughGeneration = nextCssClaimGeneration;
            const closingScope = advanceEnvLifetime();
            const cleanupClosedServerCss = () => {
              clearSpilledVirtualCssForEnvironment(
                undefined,
                closingThroughGeneration,
                closingScope,
              );
              clearPendingCssForEnvironment(undefined, closingThroughGeneration, closingScope);
              clearSupersededReactCss(undefined, closingThroughGeneration, closingScope);
              retireDevReactModules(closingScope);
              retireClosingLifetimeModules(undefined, closingScope);
              clearSupersededVirtualCss(undefined, closingScope);
            };
            const hasInFlightTransforms =
              (activeSession?.activeUsers ?? 0) > 0 || pendingDisposals.size > 0;
            if (!hasInFlightTransforms) cleanupClosedServerCss();
            closePromise = (async () => {
              try {
                await disposeHighlighter(undefined, undefined, closingScope);
              } catch {
                // Ignore disposal errors during server teardown.
              } finally {
                cleanupClosedServerCss();
              }
            })();
          } else {
            if (devServer === server) devServer = undefined;
            const oldLifetimes = new Set(serverLifetimes.get(server) ?? []);
            const oldEnvs = serverEnvObjects.get(server);
            if (oldEnvs) {
              for (const env of oldEnvs) {
                const envScope = advanceEnvLifetime(env, env?.name);
                for (const id of envScope.lifetimeIds) oldLifetimes.add(id);
              }
            }
            if (oldLifetimes.size > 0) {
              const oldScope = { lifetimeIds: oldLifetimes, maxLifetimeId: undefined };
              const previousPalette = devServer ? preparedReactCss() : undefined;
              clearSpilledVirtualCssForEnvironment(undefined, undefined, oldScope);
              clearPendingCssForEnvironment(undefined, undefined, oldScope);
              clearSupersededReactCss(undefined, undefined, oldScope);
              retireDevReactModules(oldScope);
              retireClosingLifetimeModules(undefined, oldScope);
              clearSupersededVirtualCss(undefined, oldScope);
              refreshReactCss(previousPalette);
            }
            closePromise = Promise.resolve();
          }
        }
        return closePromise;
      };
      server.httpServer?.once("close", onServerClose);
      if (typeof server.close === "function") {
        const originalClose = server.close;
        try {
          server.close = async function closeWithFerrikiCleanup(...args) {
            try {
              return await originalClose.apply(this, args);
            } finally {
              await onServerClose();
            }
          };
        } catch {
          // Ignore frozen or non-writable server objects.
        }
      }
      if (styleMode !== "classes") return;
      devServer = server;
      const pathname = devStylesheetPathname(server.config.base);
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? "").split("?", 1)[0] !== pathname) return next();
        response.setHeader("Content-Type", "text/css; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache");
        response.end(preparedReactCss());
      });
    },

    buildStart() {
      if (resolvedConfig?.command !== "build") return;
      const environment = this?.environment;
      const environmentName = environmentNameOf(this);
      if (environment && typeof environment === "object") {
        const previousScope = advanceEnvLifetime(environment, environmentName);
        const priorReactLifetimes = reactLifetimesByObject.get(environment);
        if (priorReactLifetimes) {
          for (const lifetimeId of priorReactLifetimes) previousScope.lifetimeIds.add(lifetimeId);
          reactLifetimesByObject.delete(environment);
        }
        reactModulesByObject.delete(environment);
        supersededReactCssByObject.delete(environment);
        buildStylesheets.delete(environment);
        if (previousScope.lifetimeIds.size > 0) {
          const modules = reactModulesByEnvironment.get(environmentName);
          if (modules) {
            const removedKeys = [];
            for (const [id, entry] of [...modules.entries()]) {
              if (matchesClosingLifetime(entry.lifetimeId, previousScope)) {
                modules.delete(id);
                removedKeys.push(moduleCssKey(environmentName, entry.lifetimeId, id));
              }
            }
            if (modules.size === 0) reactModulesByEnvironment.delete(environmentName);
            for (const key of removedKeys) pruneModuleKeyIndex(key);
          }
          clearSupersededReactCss(environmentName, undefined, previousScope);
          retireClosingLifetimeModules(environmentName, previousScope);
          clearSupersededVirtualCss(environmentName, previousScope);
        }
        return;
      }
      const previousScope = advanceEnvLifetime(undefined, environmentName);
      const modules = reactModulesByEnvironment.get(environmentName);
      const removedKeys = [];
      if (modules) {
        for (const [id, entry] of modules.entries())
          removedKeys.push(moduleCssKey(environmentName, entry.lifetimeId, id));
        reactModulesByEnvironment.delete(environmentName);
      }
      supersededReactCssByEnvironment.delete(environmentName);
      const effectiveScope = previousScope.lifetimeIds.size > 0 ? previousScope : undefined;
      retireClosingLifetimeModules(environmentName, effectiveScope);
      clearSupersededVirtualCss(environmentName, effectiveScope);
      for (const key of removedKeys) pruneModuleKeyIndex(key);
    },

    async hotUpdate({ type, file, read, timestamp }) {
      const environment = this?.environment;
      const environmentName = environment?.name;
      const envLifetimeId =
        environment !== undefined || environmentName !== undefined
          ? currentEnvLifetime(environment, environmentName)
          : undefined;
      const serverGenerationAtStart = minActiveGlobalLifetimeId;
      const serverAtStart = activeServer;
      if (type === "delete") {
        pendingWatchChangeFiles.delete(file);
        lastHotUpdateTimestamp.delete(file);
        markFileEdited(file);
      } else if (type === "update") {
        const lastTimestamp = lastHotUpdateTimestamp.get(file);
        if (
          typeof timestamp === "number" &&
          lastTimestamp !== undefined &&
          timestamp < lastTimestamp
        )
          return;
        const isDuplicateTimestamp =
          typeof timestamp === "number" &&
          lastTimestamp !== undefined &&
          timestamp === lastTimestamp;
        if (typeof timestamp === "number" && !isDuplicateTimestamp)
          rememberBoundedMap(lastHotUpdateTimestamp, file, timestamp, MAX_PENDING_CSS);
        if (!isDuplicateTimestamp) {
          const consumedWatchChange = pendingWatchChangeFiles.delete(file);
          if (!consumedWatchChange) markFileEdited(file);
        }
      }
      const keys = moduleKeysForFile(file, environmentName, envLifetimeId);
      // The host's code filter skips transforms after the last macro import is
      // removed, so clear its saved blocks here without parsing ordinary code.
      if (type === "delete") {
        const previousPalette = devServer ? preparedReactCss() : undefined;
        for (const key of keys) {
          invalidateModuleKey(key);
          clearModuleCssForKey(key);
        }
        removeReactModules(keys.map(splitModuleKey), false, environment);
        removeSupersededReactCssForFile(file, environmentName, envLifetimeId, environment);
        refreshReactCss(previousPalette);
        return;
      }
      if (!keys.length) return;
      if (type !== "update") return;
      // Snapshot the file edit revision before awaiting `read()` so a delayed read
      // from an older edit cannot evict state after a newer restore/edit, while still
      // clearing any overlapping old-source transform from the same edit revision.
      const revision = fileEditRevision.get(file) ?? 0;
      inFlightReadsByFile.set(file, (inFlightReadsByFile.get(file) ?? 0) + 1);
      let source;
      try {
        source = await read();
        if ((fileEditRevision.get(file) ?? 0) !== revision) return;
        if (
          envLifetimeId !== undefined
            ? !isEnvLifetimeActive(environment, environmentName, envLifetimeId)
            : minActiveGlobalLifetimeId !== serverGenerationAtStart ||
              activeServer !== serverAtStart
        )
          return;
        if (MACRO_MODULE_SPECIFIERS.some((specifier) => source.includes(specifier))) return;
        clearRemovedMacroFile(file, environmentName, envLifetimeId, environment);
      } finally {
        const remainingReads = (inFlightReadsByFile.get(file) ?? 1) - 1;
        if (remainingReads > 0) inFlightReadsByFile.set(file, remainingReads);
        else {
          inFlightReadsByFile.delete(file);
          if (!moduleKeysByFile.has(file)) fileEditRevision.delete(file);
        }
      }
    },

    async watchChange(file, { event }) {
      const serverGenerationAtStart = minActiveGlobalLifetimeId;
      const serverAtStart = activeServer;
      if (event === "delete") {
        pendingWatchChangeFiles.delete(file);
        lastHotUpdateTimestamp.delete(file);
        markFileEdited(file);
      } else if (event === "update") {
        markFileEdited(file);
        rememberBoundedSet(pendingWatchChangeFiles, file, MAX_PENDING_CSS);
      }
      if (event === "delete") {
        // A deleted file is gone on disk across all environments (including SSR
        // when HMR is disabled and Vite notifies only the client environment).
        const previousPalette = devServer ? preparedReactCss() : undefined;
        clearModuleGenerationsForFile(file);
        clearModuleCssForFile(file);
        removeReactModules(reactModuleEntriesForFile(file), false);
        removeSupersededReactCssForFile(file);
        refreshReactCss(previousPalette);
        return;
      }
      if (event !== "update" || !hmrDisabled) return;
      const keys = moduleKeysForFile(file);
      if (!keys.length) return;
      const revision = fileEditRevision.get(file) ?? 0;
      inFlightReadsByFile.set(file, (inFlightReadsByFile.get(file) ?? 0) + 1);
      try {
        let source;
        try {
          source = await readFile(file, "utf8");
        } catch (error) {
          if (
            error?.code === "ENOENT" &&
            (fileEditRevision.get(file) ?? 0) === revision &&
            minActiveGlobalLifetimeId === serverGenerationAtStart &&
            activeServer === serverAtStart
          )
            clearRemovedMacroFile(file);
          return;
        }
        if ((fileEditRevision.get(file) ?? 0) !== revision) return;
        if (minActiveGlobalLifetimeId !== serverGenerationAtStart || activeServer !== serverAtStart)
          return;
        if (MACRO_MODULE_SPECIFIERS.some((specifier) => source.includes(specifier))) return;
        clearRemovedMacroFile(file);
      } finally {
        const remainingReads = (inFlightReadsByFile.get(file) ?? 1) - 1;
        if (remainingReads > 0) inFlightReadsByFile.set(file, remainingReads);
        else {
          inFlightReadsByFile.delete(file);
          if (!moduleKeysByFile.has(file)) fileEditRevision.delete(file);
        }
      }
    },

    buildEnd(error) {
      const environment = this?.environment;
      const environmentName = environmentNameOf(this);
      if (error || resolvedConfig?.command !== "build") return;
      publishBuildReactRegistry(environment, environmentName);
      if (
        styleMode !== "classes" ||
        !hasPreparedReactBlocksForEnvironment(environment, environmentName)
      )
        return;
      const source = preparedReactCssForEnvironment(environment, environmentName);
      const reference = this.emitFile({ type: "asset", name: "ferriki-code.css", source });
      buildStylesheets.set(this.environment, { reference, source });
    },

    async closeBundle() {
      const environment = this?.environment;
      const environmentName = environment?.name;
      const closingThroughGeneration = nextCssClaimGeneration;
      const closingScope = advanceEnvLifetime(environment, environmentName);
      try {
        await disposeHighlighter(environment, environmentName, closingScope);
      } finally {
        const previousPalette = devServer ? preparedReactCss() : undefined;
        // Clear spilled and issued entries first so retiring pending claims below
        // does not re-spill CSS published by the closing environment lifetime.
        clearSpilledVirtualCssForEnvironment(
          environmentName,
          closingThroughGeneration,
          closingScope,
        );
        clearPendingCssForEnvironment(environmentName, closingThroughGeneration, closingScope);
        clearSupersededReactCss(environmentName, closingThroughGeneration, closingScope);
        retireDevReactModules(closingScope, environmentName);
        retireClosingLifetimeModules(environmentName, closingScope);
        clearSupersededVirtualCss(environmentName, closingScope);
        refreshReactCss(previousPalette);
        if (environmentName !== undefined) {
          if (
            (closingScope.lifetimeIds.size > 0 || closingScope.maxLifetimeId !== undefined) &&
            (!environment?.moduleGraph ||
              moduleGraphsByEnvironment.get(environmentName) === environment.moduleGraph)
          )
            moduleGraphsByEnvironment.delete(environmentName);
        } else {
          moduleGraphsByEnvironment.clear();
        }
        if (
          !activeSession &&
          pendingDisposals.size === 0 &&
          inFlightTransformsByFile.size === 0 &&
          inFlightReadsByFile.size === 0
        ) {
          fileEditGeneration.clear();
          fileEditRevision.clear();
          pendingWatchChangeFiles.clear();
          lastHotUpdateTimestamp.clear();
        }
      }
    },

    renderChunk(code, chunk) {
      const expression = `import.meta.${CODE_STYLESHEET_META}`;
      if (!code.includes(expression)) return null;
      const stylesheet = buildStylesheets.get(this.environment);
      if (!stylesheet) return this.error("Ferriki's prepared code stylesheet is missing");
      const base = resolvedConfig.base;
      if (
        (configuredBase === "./" || configuredBase === "") &&
        this.environment.config.consumer === "server"
      )
        return this.error("Ferriki React macro SSR requires an absolute Vite `base` path or URL");
      const filename = this.getFileName(stylesheet.reference)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const relativeBase = base === "./" || base === "";
      const relativeFilename = relativeBase
        ? posix.relative(posix.dirname(chunk.fileName), filename)
        : undefined;
      const stylesheetUrl = relativeBase
        ? `new URL(${safeJsLiteral(relativeFilename)}, import.meta.url).href`
        : safeJsLiteral(`${base.replace(/\/+$/u, "")}/${filename}`);
      const magic = new MagicString(code);
      magic.replaceAll(expression, stylesheetUrl);
      return {
        code: magic.toString(),
        map: resolvedConfig.build.sourcemap ? magic.generateMap({ hires: true }) : null,
      };
    },

    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const stylesheet = buildStylesheets.get(this.environment);
        if (!stylesheet) return;
        const filename = this.getFileName(stylesheet.reference);
        // Vite normally suppresses SSR assets. Preserve this required CSS file
        // without changing the application's asset policy for other imports.
        if (!bundle[filename])
          this.emitFile({ type: "asset", fileName: filename, source: stylesheet.source });
      },
    },

    resolveId(id) {
      if (id === CODE_STYLESHEET_MODULE) return `\0${id}`;
      if (id.startsWith(VIRTUAL_CSS_PREFIX)) {
        const environmentName = environmentNameOf(this);
        const callerLifetimeId = currentEnvLifetime(this?.environment, environmentName);
        if (this?.environment?.moduleGraph)
          moduleGraphsByEnvironment.set(environmentName, this.environment.moduleGraph);
        if (virtualCss.has(id)) {
          const alreadyCachedInVite = isCachedInViteModuleGraph(id, environmentName);
          const consumedClaim =
            resolvedConfig?.command !== "build"
              ? consumeOnePendingClaim(id, environmentName, callerLifetimeId)
              : undefined;
          if (!alreadyCachedInVite)
            markIssuedVirtualCss(id, environmentName, true, callerLifetimeId);
          if (consumedClaim) syncUnownedCss(id, environmentName, consumedClaim.lifetimeId);
          return `\0${id}`;
        }
        const spilledEntry = spilledVirtualCss.get(id);
        const spilledEnv = spilledEntry?.environments.get(environmentName)?.get(callerLifetimeId);
        if (spilledEnv) {
          if (spilledEnv.pendingResolves > 0) spilledEnv.pendingResolves--;
          if (!isCachedInViteModuleGraph(id, environmentName)) {
            spilledEnv.awaitingLoad = true;
            spilledEnv.issuedAt = Date.now();
          }
          spilledVirtualCss.delete(id);
          spilledVirtualCss.set(id, spilledEntry);
          evictSpilledCss();
          return `\0${id}`;
        }
      }
      return null;
    },

    load(id) {
      if (id === `\0${CODE_STYLESHEET_MODULE}`) {
        const devHref = devStylesheetHref(resolvedConfig?.base);
        return {
          code:
            resolvedConfig?.command === "build"
              ? `export default import.meta.${CODE_STYLESHEET_META};`
              : `import { defineCodeElement } from "@ferriki/core/web-component";\nlet stylesheetHref = ${safeJsLiteral(devHref)};\nexport { stylesheetHref as default };\nif (import.meta.hot) import.meta.hot.on("ferriki:code-element-css", ({ href }) => {\n  stylesheetHref = href;\n  if (globalThis.customElements?.get("ferriki-code")?.[Symbol.for("ferriki.code-element.definition.v1")] === true)\n    defineCodeElement({ stylesheetHref, themeAliases: ${safeJsLiteral(themes ? Object.keys(themes) : [])} });\n});`,
          moduleSideEffects: resolvedConfig?.command !== "build",
        };
      }
      if (id.startsWith("\0")) {
        const cssId = id.slice(1);
        const environmentName = environmentNameOf(this);
        const callerLifetimeId = currentEnvLifetime(this?.environment, environmentName);
        const cached = virtualCss.get(cssId);
        if (cached !== undefined) {
          const issuedEntry = issuedVirtualCss
            .get(cssId)
            ?.get(environmentName)
            ?.get(callerLifetimeId);
          const wasAwaitingLoad = Boolean(issuedEntry?.awaitingLoad);
          if (resolvedConfig?.command === "build") {
            clearIssuedVirtualCss(cssId, environmentName, callerLifetimeId);
            const wasUnspilled = unspilledIssuedCss.has(cssId);
            if (wasUnspilled && !issuedVirtualCss.has(cssId)) unspilledIssuedCss.delete(cssId);
            const consumedPending = consumeOnePendingClaim(
              cssId,
              environmentName,
              callerLifetimeId,
            );
            if (consumedPending || (wasUnspilled && !issuedVirtualCss.has(cssId)))
              syncUnownedCss(cssId, environmentName, consumedPending?.lifetimeId);
          } else {
            // Keep dev-mode CSS marked issued so it spills to the bounded LRU cache
            // on RAM eviction and remains reloadable after Vite `invalidateAll()`.
            const consumedPending = !wasAwaitingLoad
              ? consumeOnePendingClaim(cssId, environmentName, callerLifetimeId)
              : undefined;
            if (issuedEntry) issuedEntry.awaitingLoad = false;
            else markIssuedVirtualCss(cssId, environmentName, false, callerLifetimeId);
            if (consumedPending) syncUnownedCss(cssId, environmentName, consumedPending.lifetimeId);
          }
          return cached;
        }
        return readSpilledVirtualCss(cssId, environmentName, callerLifetimeId);
      }
      return null;
    },

    transform: {
      // Vite and Rolldown evaluate this before calling the handler, so a module
      // that does not spell out a macro specifier is never parsed. The code
      // filter is a substring test, not evidence: the parse decides. A
      // function `include` cannot be expressed as a host filter and is checked
      // in the handler instead.
      filter: include
        ? { code: MACRO_MODULE_SPECIFIERS }
        : { id: SCRIPT_ID, code: MACRO_MODULE_SPECIFIERS },

      async handler(source, id, meta) {
        const environment = this?.environment;
        const environmentName = environmentNameOf(this);
        const envLifetimeId = currentEnvLifetime(environment, environmentName);
        const isDevTransform = Boolean(activeServer) && resolvedConfig?.command !== "build";
        const path = id.split("?", 1)[0];
        const key = moduleCssKey(environmentName, envLifetimeId, id);
        const editGeneration = fileEditGeneration.get(path) ?? 0;
        const invalidationEpoch = moduleInvalidationEpoch.get(key) ?? 0;
        const generation = startModuleGeneration(key);
        inFlightTransformsByKey.set(key, (inFlightTransformsByKey.get(key) ?? 0) + 1);
        try {
          // Repeat the filter for hosts or callers that invoke the handler directly.
          if (
            !(SCRIPT_ID.test(id) || include?.(id)) ||
            !MACRO_MODULE_SPECIFIERS.some((specifier) => source.includes(specifier))
          ) {
            invalidateModuleKey(key);
            setModuleCss(environmentName, id, "", envLifetimeId);
            if (
              hasReactModuleForKey(environmentName, id, envLifetimeId) ||
              hasSupersededReactCssForKey(environmentName, id, envLifetimeId)
            )
              removeReactModules([[environmentName, id, envLifetimeId]], true, environment);
            return null;
          }

          const lang = parserLanguage(path);
          let program;
          try {
            program = parseAst(source, { lang, preserveParens: true }, id);
          } catch (error) {
            return this.error(error);
          }

          let scan;
          try {
            scan = scanInlineCodeMacros(program, source);
          } catch (error) {
            if (error instanceof MacroDiagnostic) return reportMacroError(this, id, source, error);
            throw error;
          }
          if (scan.calls.length === 0 && scan.imports.length === 0) {
            invalidateModuleKey(key);
            setModuleCss(environmentName, id, "", envLifetimeId);
            if (
              hasReactModuleForKey(environmentName, id, envLifetimeId) ||
              hasSupersededReactCssForKey(environmentName, id, envLifetimeId)
            )
              removeReactModules([[environmentName, id, envLifetimeId]], true, environment);
            return null;
          }

          const magic = new MagicString(source);
          const macroCss = new Set();
          const renderedReactCss = new Map();
          const reactBlocks = new Map();
          const customRendererRefs = new Set();
          const needsRenderHelper = scan.calls.some((call) => call.kind === "react");
          if (needsRenderHelper && themes) codeElementStyles(Object.keys(themes));
          const renderHelperName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiMacroRenderHelper")
            : undefined;
          const registrationName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiDefineCodeElement")
            : undefined;
          const sizingName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiCodeElementSizing")
            : undefined;
          const codeSizesName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiCodeSizes")
            : undefined;
          const codeElementConfigName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiCodeElementConfig")
            : undefined;
          const codeBlocksName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiCodeBlocks")
            : undefined;
          const codeElementRegisteredName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiCodeElementRegistered")
            : undefined;
          const stylesheetName =
            needsRenderHelper && styleMode === "classes"
              ? uniqueIdentifierName(scan.names, "FerrikiCodeStylesheetUrl")
              : undefined;
          const stylesheetHrefName =
            needsRenderHelper && styleMode === "classes"
              ? uniqueIdentifierName(scan.names, "FerrikiCodeStylesheetHref")
              : undefined;
          const serverHtmlName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiCodeServerHtml")
            : undefined;
          const serverStylesName = needsRenderHelper
            ? uniqueIdentifierName(scan.names, "FerrikiCodeServerStyles")
            : undefined;
          // Lower the innermost calls first; an enclosing React element only
          // rewrites the text around its presentation expressions.
          const calls = [...scan.calls].sort(
            (left, right) =>
              left.end - left.start - (right.end - right.start) || left.start - right.start,
          );
          const session =
            calls.length > 0
              ? acquireHighlighterSession(environmentName, envLifetimeId)
              : undefined;
          if (calls.length > 0)
            inFlightTransformsByFile.set(path, (inFlightTransformsByFile.get(path) ?? 0) + 1);
          try {
            for (const call of calls) {
              const parsedMeta = parseMeta(call.meta ?? "");
              // A call-level setting replaces the Vite default, while an explicit
              // showLineNumbers annotation remains an opt-in in its own right.
              const effectiveLineNumbers =
                parsedMeta.lineNumbers || (call.lineNumbers ?? lineNumbers);
              const rendered = await highlight(
                session,
                this,
                id,
                call.code,
                call.language,
                parsedMeta,
                effectiveLineNumbers,
                call.kind === "react",
                () =>
                  canCommitModuleGeneration(key, generation, invalidationEpoch) &&
                  (fileEditGeneration.get(path) ?? 0) === editGeneration,
              );
              const descriptorCss = [
                rendered.css,
                effectiveLineNumbers || parsedMeta.highlightedLines.size ? LINE_CSS : "",
              ]
                .filter(Boolean)
                .join("\n");
              const descriptor = createPreparedCodeBlock(
                call.code,
                call.language,
                rendered.html,
                descriptorCss,
                parsedMeta,
                effectiveLineNumbers,
              );
              const codeRef =
                call.kind === "react"
                  ? `ferriki-${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`
                  : undefined;
              if (codeRef) {
                reactBlocks.set(codeRef, descriptor);
                renderedReactCss.set(codeRef, rendered.css);
              }
              lowerMacroCall(magic, call, descriptor, renderHelperName, codeRef);
              const hasCustomRenderProp =
                call.kind === "react" && call.presentation.some((item) => item.name === "render");
              if (hasCustomRenderProp) customRendererRefs.add(codeRef);
              // Default React hosts share styles through the element definition.
              // Descriptor consumers and syntactic custom renderers keep ordinary CSS delivery.
              if (descriptorCss && (call.kind !== "react" || hasCustomRenderProp))
                macroCss.add(descriptorCss);
            }
          } finally {
            if (calls.length > 0) {
              const remaining = (inFlightTransformsByFile.get(path) ?? 1) - 1;
              if (remaining > 0) inFlightTransformsByFile.set(path, remaining);
              else {
                inFlightTransformsByFile.delete(path);
                fileEditGeneration.delete(path);
              }
            }
            if (session) releaseHighlighterSession(session, envLifetimeId);
          }
          const previousPalette = devServer ? preparedReactCss() : undefined;
          const isCurrentEpoch = (moduleInvalidationEpoch.get(key) ?? 0) === invalidationEpoch;
          const isLifetimeActive = isEnvLifetimeActive(environment, environmentName, envLifetimeId);
          const canCommitLatest = canCommitModuleGeneration(key, generation, invalidationEpoch);
          if (canCommitLatest && isLifetimeActive) {
            lastSucceededGenerationByKey.set(key, generation);
            if (reactBlocks.size > 0) {
              const blockEntries = new Map(
                [...reactBlocks].map(([ref, block]) => [
                  ref,
                  { html: block.html, css: renderedReactCss.get(ref) },
                ]),
              );
              let environmentModules = reactModulesByEnvironment.get(environmentName);
              if (!environmentModules) {
                environmentModules = new Map();
                reactModulesByEnvironment.set(environmentName, environmentModules);
              }
              const existingShared = environmentModules.get(id);
              if (!existingShared || envLifetimeId >= existingShared.lifetimeId) {
                environmentModules.set(id, {
                  blocks: blockEntries,
                  lifetimeId: envLifetimeId,
                  isDevServer: isDevTransform,
                });
              }
              if (!isDevTransform && environment && typeof environment === "object") {
                rememberReactLifetimeForObject(environment, envLifetimeId);
                let objectModules = reactModulesByObject.get(environment);
                if (!objectModules) {
                  objectModules = new Map();
                  reactModulesByObject.set(environment, objectModules);
                }
                objectModules.set(id, { blocks: blockEntries, lifetimeId: envLifetimeId });
              }
              indexModuleKey(key);
            } else {
              const environmentModules = reactModulesByEnvironment.get(environmentName);
              if (environmentModules?.get(id)?.lifetimeId === envLifetimeId) {
                environmentModules.delete(id);
                if (environmentModules.size === 0)
                  reactModulesByEnvironment.delete(environmentName);
              }
              if (environment && typeof environment === "object") {
                const objectModules = reactModulesByObject.get(environment);
                if (objectModules) {
                  objectModules.delete(id);
                  if (objectModules.size === 0) reactModulesByObject.delete(environment);
                }
              }
              removeSupersededReactCssForModule(environmentName, id, envLifetimeId, environment);
              pruneModuleKeyIndex(key);
            }
            refreshReactCss(previousPalette);
          } else if (
            isLifetimeActive &&
            reactBlocks.size > 0 &&
            isCurrentEpoch &&
            moduleTransformGeneration.has(key)
          ) {
            recordSupersededReactCss(
              environment,
              environmentName,
              id,
              renderedReactCss,
              envLifetimeId,
            );
            refreshReactCss(previousPalette);
          }

          for (const item of scan.imports) {
            if (item.replacement) magic.overwrite(item.start, item.end, item.replacement);
            else magic.remove(item.start, item.end);
          }
          if (needsRenderHelper) {
            // Initialize prepared content before authored code can eagerly render a
            // macro, while keeping framework directive prologues first.
            let helperOffset = shebangEndOffset(source);
            for (const statement of program.body) {
              if (typeof statement.directive !== "string") break;
              helperOffset = statement.end;
            }
            const registrySource = [...reactBlocks.keys()]
              .map(
                (ref) => `${JSON.stringify(ref)}: ${codeBlocksName}[${JSON.stringify(ref)}].html`,
              )
              .join(", ");
            const sizingSource = [...reactBlocks]
              .map(([ref, block]) => {
                const lineCount = block.code.split(/\r\n|\r|\n/u).length;
                return `${JSON.stringify(ref)}: { lineCount: ${lineCount}, style: ${sizingName}(${lineCount}) }`;
              })
              .join(", ");
            const preparedBlocks = Object.fromEntries(
              [...reactBlocks].map(([ref, block]) => [
                ref,
                customRendererRefs.has(ref) ? block : { ...block, css: "" },
              ]),
            );
            const aliases = themes ? Object.keys(themes) : [];
            const serverStyles = `<style data-ferriki-code-base>${codeElementStyles(aliases)}</style>`;
            const stylesheetImport = stylesheetName
              ? `import ${stylesheetName} from ${JSON.stringify(CODE_STYLESHEET_MODULE)};`
              : "";
            const stylesheetConfig = stylesheetName ? `, stylesheetHref: ${stylesheetName}` : "";
            const escapedStylesheetHref = stylesheetName
              ? `const ${stylesheetHrefName} = import.meta.env.SSR ? ${stylesheetName}.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") : undefined;`
              : "";
            const serverHtmlSource = [...reactBlocks.keys()]
              .map((ref) => {
                const marker = encodeURIComponent(ref).replaceAll("-", "%2D");
                const link = stylesheetName
                  ? ` + ${safeJsLiteral('<link rel="stylesheet" href="')} + ${stylesheetHrefName} + ${safeJsLiteral('" data-ferriki-code-css>')}`
                  : "";
                return `${JSON.stringify(ref)}: { __html: ${safeJsLiteral(`<template shadowrootmode="open"><!--ferriki-code:${marker}-->`)} + ${serverStylesName}${link} + ${codeBlocksName}[${JSON.stringify(ref)}].html + "</template>" }`;
              })
              .join(", ");
            magic.appendLeft(
              helperOffset,
              [
                `\nimport { defineCodeElement as ${registrationName} } from "@ferriki/core/web-component";`,
                `import { codeElementSizing as ${sizingName} } from "@ferriki/core/web-component";`,
                stylesheetImport,
                `const ${codeBlocksName} = ${safeJsLiteral(preparedBlocks)};`,
                `const ${codeSizesName} = { ${sizingSource} };`,
                `const ${codeElementConfigName} = { ...${safeJsLiteral({ themeAliases: aliases })}${stylesheetConfig}, blocks: { ${registrySource} } };`,
                escapedStylesheetHref,
                `const ${serverStylesName} = import.meta.env.SSR ? ${safeJsLiteral(serverStyles)} : undefined;`,
                `const ${serverHtmlName} = import.meta.env.SSR ? { ${serverHtmlSource} } : undefined;`,
                `let ${codeElementRegisteredName} = false;`,
                renderHelperSource(
                  renderHelperName,
                  registrationName,
                  codeElementConfigName,
                  codeBlocksName,
                  codeElementRegisteredName,
                  codeSizesName,
                  sizingName,
                  serverHtmlName,
                ),
                "",
              ].join("\n"),
            );
          }
          const css = [...macroCss].join("\n");
          if (css) {
            let cssId;
            if (canCommitLatest) {
              cssId = setModuleCss(environmentName, id, css, envLifetimeId);
            } else {
              cssId = cssModuleId(css);
              markPendingCssLoad(cssId, css, environmentName, envLifetimeId);
            }
            if (cssId) magic.append(`\nimport ${JSON.stringify(cssId)};\n`);
          } else if (canCommitLatest) {
            setModuleCss(environmentName, id, "", envLifetimeId);
          }

          const result = {
            code: magic.toString(),
            map: magic.generateMap({ hires: true, includeContent: true, source: id }),
          };
          // React elements lower to JSX. An included module ID without a JSX
          // extension would otherwise not be treated as JSX by Rolldown.
          if (
            scan.calls.some((call) => call.kind === "react") &&
            !/\.[jt]sx$/.test(path) &&
            meta?.moduleType !== "jsx" &&
            meta?.moduleType !== "tsx"
          )
            result.moduleType = lang === "jsx" ? "jsx" : "tsx";
          return result;
        } finally {
          const remainingForKey = (inFlightTransformsByKey.get(key) ?? 1) - 1;
          if (remainingForKey > 0) inFlightTransformsByKey.set(key, remainingForKey);
          else {
            inFlightTransformsByKey.delete(key);
            moduleInvalidationEpoch.delete(key);
            pruneUnusedModuleKey(key);
          }
        }
      },
    },
  };
}

/** Mirror the parser's file-type detection, with TSX for extensionless virtual modules. */
function parserLanguage(path) {
  if (/\.[cm]?ts$/.test(path)) return "ts";
  if (/\.tsx$/.test(path)) return "tsx";
  if (/\.[cm]?jsx?$/.test(path)) return "jsx";
  return "tsx";
}

function shebangEndOffset(source) {
  if (!source.startsWith("#!")) return 0;
  const lineEnd = /\r\n?|[\n\u2028\u2029]/u.exec(source);
  return lineEnd ? lineEnd.index + lineEnd[0].length : source.length;
}

function devStylesheetHref(base = "/") {
  const normalized = (base || "/").replace(/\/+$/u, "");
  return `${normalized}/${DEV_CODE_STYLESHEET_PATH}`;
}

function devStylesheetPathname(base = "/") {
  let basePath = base || "/";
  if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(basePath)) {
    try {
      basePath = new URL(basePath.startsWith("//") ? `http:${basePath}` : basePath).pathname;
    } catch {
      basePath = "/";
    }
  }
  if (!basePath || basePath === "./" || basePath === ".") basePath = "/";
  if (!basePath.startsWith("/")) basePath = `/${basePath}`;
  return `${basePath.replace(/\/+$/u, "")}/${DEV_CODE_STYLESHEET_PATH}`;
}

function reportMacroError(context, id, source, diagnostic) {
  const error = new Error(diagnostic.message);
  error.name = "FerrikiMacroError";
  error.code = "FERRIKI_MACRO";
  error.id = id;
  error.loc = { file: id, ...lineAndColumn(source, diagnostic.offset) };
  // The offset lets Vite and Rolldown draw the code frame from the text this
  // plugin received; `loc` uses Rollup's 1-based line and 0-based column.
  return context.error(error, diagnostic.offset);
}

function lineAndColumn(source, offset) {
  const before = source.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart };
}

function createMetaTransformer(meta, defaultLineNumbers) {
  // Ferriki's transformer nodes carry HTML attribute names, as Shiki's do.
  const addClass = (node, name) => {
    const existing = node.properties.class;
    const classes = Array.isArray(existing)
      ? existing
      : typeof existing === "string"
        ? existing.split(/\s+/)
        : [];
    node.properties.class = [...new Set([...classes.filter(Boolean), name])].join(" ");
  };
  return {
    name: "ferriki-vite-metadata",
    pre(node) {
      if (meta.title !== undefined) node.properties["data-title"] = meta.title;
      if (meta.label !== undefined) node.properties["data-label"] = meta.label;
    },
    line(node, line) {
      if (defaultLineNumbers || meta.lineNumbers) node.properties["data-ln"] = line;
      if (meta.highlightedLines.has(line)) addClass(node, "highlighted");
      if (defaultLineNumbers || meta.lineNumbers || meta.highlightedLines.size)
        addClass(node, "ferriki-highlight-line");
    },
  };
}

function parseMeta(raw = "") {
  const titleMatch = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)')/.exec(raw);
  const title = titleMatch?.[1] ?? titleMatch?.[2];
  const rest = titleMatch
    ? `${raw.slice(0, titleMatch.index)} ${raw.slice(titleMatch.index + titleMatch[0].length)}`
    : raw;
  const label = /\[([^\]]+)\]/.exec(rest)?.[1]?.trim();
  const selection = /(?:^|\s)\{([\d,-]+)\}(?=\s|$)/.exec(rest)?.[1];
  const highlightedLines = new Set();
  if (selection) {
    for (const part of selection.split(",")) {
      const [first, last = first] = part.split("-").map(Number);
      if (first < 1 || last < first || last > 10000) continue;
      for (let line = first; line <= last; line++) highlightedLines.add(line);
    }
  }
  return {
    title,
    label,
    highlightedLines,
    lineNumbers: /(?:^|\s)showLineNumbers(?:\s|$)/.test(rest),
  };
}

// Same escaping as Ferriki's native HTML renderer.
function escapeHtmlText(value) {
  return value.replaceAll("&", "&#x26;").replaceAll("<", "&#x3C;");
}

function escapeHtmlAttribute(value) {
  return escapeHtmlText(value).replaceAll('"', "&#x22;");
}

/** Escaped plain code with the same `pre`/`code` shape and line markup as highlighted output. */
function plainCodeHtml(code, language, meta, lineNumbers) {
  let preAttributes = ' class="shiki"';
  if (meta.title !== undefined) preAttributes += ` data-title="${escapeHtmlAttribute(meta.title)}"`;
  if (meta.label !== undefined) preAttributes += ` data-label="${escapeHtmlAttribute(meta.label)}"`;
  const annotated = lineNumbers || meta.highlightedLines.size > 0;
  const content = annotated
    ? code
        .split("\n")
        .map((line, index) => {
          const number = index + 1;
          const classes = meta.highlightedLines.has(number)
            ? "ferriki-highlight-line highlighted"
            : "ferriki-highlight-line";
          const lineNumber = lineNumbers ? ` data-ln="${number}"` : "";
          return `<span class="${classes}"${lineNumber}>${escapeHtmlText(line)}</span>`;
        })
        .join("\n")
    : escapeHtmlText(code);
  return `<pre${preAttributes}><code class="${escapeHtmlAttribute(`language-${language}`)}">${content}</code></pre>`;
}

function createPreparedCodeBlock(code, language, html, css, meta, lineNumbers) {
  const highlightedLines = [...meta.highlightedLines];
  const metadata = {
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    lineNumbers,
    highlightedLines,
  };
  return { code, language, html, css, metadata };
}

function safeJsLiteral(value) {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (character) => {
    if (character === "<") return "\\u003c";
    return character === "\u2028" ? "\\u2028" : "\\u2029";
  });
}

function lowerMacroCall(magic, call, descriptor, renderHelperName, codeRef) {
  const { start, end } = call;
  if (call.kind !== "react") {
    const literal = safeJsLiteral(descriptor);
    magic.overwrite(start, end, call.wrap ? `(${literal})` : literal);
    return;
  }

  const presentation = call.presentation.map((item) => ({
    ...item,
    isLiteral: item.literal !== undefined,
  }));
  if (presentation.length === 0) {
    magic.overwrite(start, end, `<${renderHelperName} codeRef=${JSON.stringify(codeRef)} />`);
    return;
  }

  const first = presentation[0];
  const attributeStart = (item) => `${item.name}${item.isLiteral ? "=" : "={"}`;
  magic.overwrite(
    start,
    first.start,
    `<${renderHelperName} codeRef=${JSON.stringify(codeRef)} ${attributeStart(first)}`,
  );

  for (let index = 1; index < presentation.length; index++) {
    const previous = presentation[index - 1];
    const current = presentation[index];
    magic.overwrite(
      previous.end,
      current.start,
      `${previous.isLiteral ? "" : "}"} ${attributeStart(current)}`,
    );
  }

  const last = presentation.at(-1);
  const suffix = `${last.isLiteral ? "" : "}"} />`;
  magic.overwrite(last.end, end, suffix);
}

function uniqueIdentifierName(used, base) {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) candidate = `${base}${suffix++}`;
  return candidate;
}

// Deduplicate complete generated rules, keeping nested at-rules and quoted
// declaration values intact. Splitting on lines would break media blocks.
function cssRules(css) {
  const rules = [];
  let start = 0;
  let braces = 0;
  let parentheses = 0;
  let quote;
  let comment = false;
  for (let index = 0; index < css.length; index++) {
    const character = css[index];
    if (comment) {
      if (character === "*" && css[index + 1] === "/") {
        comment = false;
        index++;
      }
      continue;
    }
    if (character === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "/" && css[index + 1] === "*") {
      comment = true;
      index++;
    } else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (parentheses === 0) {
      if (character === "{") braces++;
      else if (character === "}") braces--;
      if (braces === 0 && (character === "}" || character === ";")) {
        rules.push(css.slice(start, index + 1).trim());
        start = index + 1;
      }
    }
  }
  const trailing = css.slice(start).trim();
  if (trailing) rules.push(trailing);
  return rules;
}

function renderHelperSource(
  name,
  registrationName,
  codeElementConfigName,
  codeBlocksName,
  codeElementRegisteredName,
  codeSizesName,
  sizingName,
  serverHtmlName,
) {
  return `function ${name}(props) {
  const { codeRef, render, theme, maxLines, ...presentationProps } = props;
  if (render === undefined) {
    if (!import.meta.env.SSR && !${codeElementRegisteredName}) {
      ${registrationName}(${codeElementConfigName});
      ${codeElementRegisteredName} = true;
    }
    const sizing = ${codeSizesName}[codeRef];
    if (import.meta.env.SSR) {
      return <ferriki-code {...presentationProps} data-ferriki-theme={theme} code-ref={codeRef} max-lines={maxLines} style={maxLines === undefined ? sizing.style : ${sizingName}(sizing.lineCount, maxLines)} dangerouslySetInnerHTML={${serverHtmlName}[codeRef]} />;
    }
    return <ferriki-code {...presentationProps} data-ferriki-theme={theme} code-ref={codeRef} max-lines={maxLines} style={maxLines === undefined ? sizing.style : ${sizingName}(sizing.lineCount, maxLines)} />;
  }
  return render({ code: ${codeBlocksName}[codeRef], ...presentationProps, ...(theme === undefined ? {} : { theme }), ...(maxLines === undefined ? {} : { maxLines }) });
}`;
}
