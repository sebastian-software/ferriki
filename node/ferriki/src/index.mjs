import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

import { languageCatalog, themeCatalog } from "../assets/standard/catalog.mjs";
import {
  isValidCssIdentifier,
  isValidCssVariablePrefix,
  isValidHtmlAttributeName,
  isValidHtmlTagName,
  isValidInlineCssVariablePrefix,
  isValidInlineThemeAlias,
  normalizeSafeCssColor,
} from "../classes.mjs";
import { loadFerrikiNativeBinding, tryLoadFerrikiNativeBinding } from "../native.mjs";
import {
  addClassToHast,
  applyTokenTransformers,
  classStylesByTree,
  decorationNative,
  renderTransformedHast,
  sortTransformers,
  splitTokensAtDecorations,
} from "../transformers.mjs";
import { createAssetDownloader, normalizeAssetBaseUrl } from "./asset-download.mjs";
import { alignThemeTokens, tokenStyle } from "./theme-tokens.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const standardAssetRoot = join(packageDir, "assets", "standard");
const NONE_THEME_BACKING = "nord";
const GRAMMAR_STATE_SOURCE_PREFIX = "\0ferriki-grammar-state-v1\0";
const MAX_GRAMMAR_STATE_JSON_BYTES = 1_048_576;
const MAX_REGISTRATION_UNWRAP_STEPS = 64;
const MAX_DEFAULT_UNWRAP_STEPS = 256;
const MAX_REGISTRATION_ARRAY_DEPTH = 10_000;
const MAX_REGISTRATION_ITEMS = 20_000;
const GRAMMAR_STATE_CONTINUATION = Symbol("ferriki.grammar-state-continuation");
const GRAMMAR_STATE_CAPTURE = Symbol("ferriki.grammar-state-capture");
const LOAD_ASSETS_BATCH = Symbol("ferriki.load-assets-batch");
let singleton;
const disposedHighlighters = new WeakSet();

export class ShikiError extends Error {
  constructor(message, code = "ERR_USAGE", options) {
    super(message, options);
    this.name = "ShikiError";
    this.code = code;
  }
}

export class FerrikiError extends ShikiError {
  constructor(message, code = "ERR_INTERNAL", options) {
    super(message, code, options);
    this.name = "FerrikiError";
  }
}

export function ferrikiVersion() {
  return tryLoadFerrikiNativeBinding()?.ferrikiVersion();
}

export async function createHighlighter(options = {}) {
  options = validateHighlighterOptions(options);
  const { langs = [], themes = [], ...coreOptions } = options;
  const highlighter = createHighlighterCoreSync(coreOptions);
  try {
    const [languages, resolvedThemes] = await Promise.all([
      resolveRegistrations(langs),
      resolveRegistrations(themes),
    ]);
    await highlighter[LOAD_ASSETS_BATCH](languages, resolvedThemes);
    return highlighter;
  } catch (error) {
    highlighter.dispose();
    throw error;
  }
}

export const createHighlighterCore = createHighlighter;
export const createShikiPrimitiveAsync = createHighlighter;

export function createHighlighterCoreSync(options = {}) {
  options = validateHighlighterOptions(options);
  let defaultTransformers = sortTransformers(options.transformers);
  const assets = resolveAssetOptions(options.assets);
  let native;
  try {
    native = loadFerrikiNativeBinding().createHighlighter({
      standardAssetRoot,
      assets,
      regexPrefilter: options.regexPrefilter,
      regexMode: options.regexMode,
    });
  } catch (cause) {
    if (cause instanceof FerrikiError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const missingBinary = detail.includes("No native binary");
    throw new FerrikiError(
      missingBinary
        ? `${detail}\nInstall a Ferriki platform binary for this target or choose a documented supported target.`
        : `${detail}\nVerify that the package contains assets/standard and reinstall it.`,
      missingBinary ? "ERR_NATIVE_LOAD" : "ERR_ASSET",
      { cause },
    );
  }
  const loadedLanguages = new Set();
  const loadedStandardLanguages = new Set();
  const missingSidecarLanguages = new Set();
  const loadedThemes = new Set();
  const loadedStandardThemes = new Set();
  let downloadStandardAssets = createAssetDownloader(native, assertActive);
  const languageAliases = new Map(Object.entries(options.langAlias || {}));
  const pendingPrefetchLangCounts = new Map();
  const pendingPrefetchThemeCounts = new Map();
  let disposed = false;

  function assertActive() {
    if (disposed) throw new ShikiError("Shiki instance has been disposed", "ERR_USAGE");
  }

  function resolveAlias(language) {
    assertActive();
    const visited = new Set();
    while (languageAliases.has(language)) {
      if (visited.has(language))
        throw new ShikiError(
          `Circular alias \`${[...visited, language].join(" -> ")}\``,
          "ERR_USAGE",
        );
      visited.add(language);
      language = languageAliases.get(language);
    }
    return language;
  }

  function loadLanguageSync(...inputs) {
    assertActive();
    for (const registration of resolveSyncRegistrations(inputs)) {
      validateLanguageRegistration(registration);
      const name = registrationName(registration);
      if (!name) continue;
      const resolved = resolveAlias(name);
      const custom = isCustomLanguageRegistration(registration);
      let scope;
      if (custom) {
        const serialized = callCustomRegistration(() => JSON.stringify(registration), "language");
        assertActive();
        scope = callCustomRegistration(() => native.loadCustomGrammar(serialized), "language");
      } else {
        assertActive();
        scope = callNativeOperation(`Ferriki could not load language \`${resolved}\``, () =>
          native.loadStandardGrammar(resolved),
        );
      }
      if (!scope)
        throw new ShikiError(
          `Language \`${resolved}\` not found, you may need to load it first`,
          "ERR_UNSUPPORTED",
        );
      loadedLanguages.add(resolved);
      if (custom) {
        for (const alias of registration.aliases || []) {
          if (!isStandardLanguageKey(alias)) {
            languageAliases.set(alias, resolved);
            loadedLanguages.add(alias);
          }
        }
      } else {
        const canonical = canonicalStandardLanguage(resolved);
        if (canonical) loadedStandardLanguages.add(canonical);
      }
    }
  }

  function languagePrefetchNames(registrations) {
    return registrations.flatMap((registration) =>
      isCustomLanguageRegistration(registration)
        ? (registration.embeddedLanguages ?? registration.embeddedLangs ?? [])
        : [resolveAlias(registrationName(registration))],
    );
  }

  function themePrefetchNames(registrations) {
    return registrations.map((registration) => {
      if (isCustomThemeRegistration(registration)) return registration.include;
      return registrationName(registration);
    });
  }

  function canBatchLanguagesWithThemes(languages) {
    for (const registration of languages) {
      try {
        if (typeof registration === "string") {
          if (!registration) continue;
          const resolved = resolveAlias(registration);
          if (!isStandardLanguageKey(resolved) && !loadedLanguages.has(resolved)) return false;
          continue;
        }
        if (!registration || typeof registration !== "object" || Array.isArray(registration))
          return false;
        if (isCustomLanguageRegistration(registration)) return false;
        const name = registrationName(registration);
        if (!name) return false;
        validateLanguageRegistration(registration);
        const resolved = resolveAlias(name);
        if (!isStandardLanguageKey(resolved) && !loadedLanguages.has(resolved)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  function isStandardLanguageReadyForSkip(canonical) {
    if (!loadedStandardLanguages.has(canonical) || missingSidecarLanguages.has(canonical))
      return false;
    if (typeof native.isStandardLanguageReady === "function")
      return native.isStandardLanguageReady(canonical);
    return true;
  }

  function retainPendingKeys(counts, keys) {
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  }

  function releasePendingKeys(counts, keys) {
    const releasable = [];
    for (const key of keys) {
      const next = (counts.get(key) || 0) - 1;
      if (next <= 0) {
        counts.delete(key);
        releasable.push(key);
      } else {
        counts.set(key, next);
      }
    }
    return releasable;
  }

  async function withPrefetchedAssets(languages, themes, register, options = {}) {
    assertActive();
    const standardLanguages = [
      ...new Set(
        languages.filter((name) => {
          if (!name || !isStandardLanguageKey(name)) return false;
          return !isStandardLanguageReadyForSkip(canonicalStandardLanguage(name));
        }),
      ),
    ];
    const standardThemes = [
      ...new Set(
        themes
          .map((name) => (name === "none" ? NONE_THEME_BACKING : name))
          .filter((name) => isStandardThemeKey(name) && !loadedStandardThemes.has(name)),
      ),
    ];
    if (standardLanguages.length === 0 && standardThemes.length === 0) {
      register();
      return;
    }
    const canonicalLanguages = [
      ...new Set(standardLanguages.map((name) => canonicalStandardLanguage(name))),
    ];
    const trackedLanguages = expandStandardLanguageClosure(canonicalLanguages);
    retainPendingKeys(pendingPrefetchLangCounts, trackedLanguages);
    retainPendingKeys(pendingPrefetchThemeCounts, standardThemes);
    try {
      const result = await callNativeOperationAsync("Ferriki could not download assets", () =>
        downloadStandardAssets(
          standardLanguages,
          standardThemes,
          options.onLanguagesReady ? { onLanguagesReady: options.onLanguagesReady } : undefined,
        ),
      );
      const failedSidecars = result?.failedSidecars;
      if (failedSidecars?.size > 0) {
        for (const id of failedSidecars) missingSidecarLanguages.add(id);
        for (const id of canonicalLanguages) {
          if (standardLanguageDependsOnAny(id, failedSidecars)) missingSidecarLanguages.add(id);
          else missingSidecarLanguages.delete(id);
        }
      } else {
        for (const id of canonicalLanguages) missingSidecarLanguages.delete(id);
      }
      register();
    } finally {
      const releasableLanguages = releasePendingKeys(pendingPrefetchLangCounts, trackedLanguages);
      const releasableThemes = releasePendingKeys(pendingPrefetchThemeCounts, standardThemes);
      if (
        !disposed &&
        (releasableLanguages.length > 0 || releasableThemes.length > 0) &&
        typeof native.evictVerifiedAssets === "function"
      ) {
        native.evictVerifiedAssets(releasableLanguages, releasableThemes);
      }
    }
  }

  async function loadLanguage(...inputs) {
    assertActive();
    const registrations = await resolveRegistrations(inputs);
    assertActive();
    await withPrefetchedAssets(languagePrefetchNames(registrations), [], () =>
      loadLanguageSync(...registrations),
    );
  }

  async function loadAssetsBatch(languages, themes) {
    assertActive();
    const languageNames = languagePrefetchNames(languages);
    let themeNames;
    let themePrefetchError;
    let hasThemePrefetchError = false;
    if (themes.length > 0 && canBatchLanguagesWithThemes(languages)) {
      try {
        themeNames = themePrefetchNames(themes);
      } catch (error) {
        themePrefetchError = error;
        hasThemePrefetchError = true;
      }
    }
    if (themes.length > 0 && themeNames === undefined) {
      await withPrefetchedAssets(languageNames, [], () => loadLanguageSync(...languages));
      if (hasThemePrefetchError) throw themePrefetchError;
      await withPrefetchedAssets([], themePrefetchNames(themes), () =>
        loadThemesAfterPrefetch(themes),
      );
      return;
    }
    let languagesRegistered = false;
    const registerLanguagesOnce = () => {
      if (languagesRegistered) return;
      loadLanguageSync(...languages);
      languagesRegistered = true;
    };
    await withPrefetchedAssets(
      languageNames,
      themeNames ?? [],
      () => {
        registerLanguagesOnce();
        loadThemesAfterPrefetch(themes);
      },
      languages.length > 0 && themes.length > 0
        ? { onLanguagesReady: registerLanguagesOnce }
        : undefined,
    );
  }

  function loadThemesAfterPrefetch(registrations) {
    loadThemeSync(...registrations);
    if (
      registrations.includes("none") &&
      !loadedStandardThemes.has(NONE_THEME_BACKING) &&
      !loadedThemes.has(NONE_THEME_BACKING)
    ) {
      const loaded = callNativeOperation(
        `Ferriki could not load theme \`${NONE_THEME_BACKING}\``,
        () => native.loadStandardTheme(NONE_THEME_BACKING),
      );
      if (loaded) loadedStandardThemes.add(NONE_THEME_BACKING);
    }
  }

  function loadThemeSync(...inputs) {
    assertActive();
    for (const registration of resolveSyncRegistrations(inputs)) {
      validateThemeRegistration(registration);
      const name = registrationName(registration);
      if (!name) continue;
      if (name !== "none") {
        const custom = isCustomThemeRegistration(registration);
        let loaded;
        if (custom) {
          const serialized = callCustomRegistration(() => JSON.stringify(registration), "theme");
          assertActive();
          loaded = callCustomRegistration(() => native.loadCustomTheme(serialized), "theme");
        } else {
          assertActive();
          loaded = callNativeOperation(`Ferriki could not load theme \`${name}\``, () =>
            native.loadStandardTheme(name),
          );
        }
        if (!loaded)
          throw new ShikiError(
            `Theme \`${name}\` not found, you may need to load it first`,
            "ERR_UNSUPPORTED",
          );
        if (!custom && isStandardThemeKey(name)) loadedStandardThemes.add(name);
      }
      loadedThemes.add(name);
    }
  }

  async function loadTheme(...inputs) {
    assertActive();
    const registrations = await resolveRegistrations(inputs);
    await withPrefetchedAssets([], themePrefetchNames(registrations), () =>
      loadThemesAfterPrefetch(registrations),
    );
  }

  function prepareOptions(options) {
    assertActive();
    const validated = validateHighlightOptions(options);
    const rawLang = validated.lang;
    const rawTheme = validated.theme;
    if (rawLang && typeof rawLang !== "string") loadLanguageSync(rawLang);
    if (rawTheme && typeof rawTheme !== "string") loadThemeSync(rawTheme);
    const language = resolveAlias(registrationName(rawLang) || "text");
    const requestedTheme =
      registrationName(rawTheme) || registrationName(selectDefaultTheme(validated));
    const theme = requestedTheme === "none" ? NONE_THEME_BACKING : requestedTheme;
    if (!theme)
      throw new ShikiError(
        "Invalid options, either `theme` or `themes` must be provided",
        "ERR_USAGE",
      );
    assertActive();
    if (!isSpecialLanguage(language)) {
      const canonical = canonicalStandardLanguage(language);
      if (
        !loadedLanguages.has(language) &&
        !(canonical && loadedStandardLanguages.has(canonical))
      ) {
        if (
          !callNativeOperation(`Ferriki could not load language \`${language}\``, () =>
            native.resolveGrammarScope(language),
          )
        )
          throw new ShikiError(
            `Language \`${language}\` not found, you may need to load it first`,
            "ERR_UNSUPPORTED",
          );
      }
      loadedLanguages.add(language);
    }
    if (!loadedThemes.has(theme) && !loadedStandardThemes.has(theme)) {
      if (
        !callNativeOperation(`Ferriki could not load theme \`${theme}\``, () =>
          native.loadStandardTheme(theme),
        )
      )
        throw new ShikiError(
          `Theme \`${theme}\` not found, you may need to load it first`,
          "ERR_UNSUPPORTED",
        );
    }
    loadedThemes.add(theme);
    const rawTabindex = validated.tabindex;
    // The typed native boundary receives normalized tabindex controls.
    const tabindex =
      rawTabindex === null
        ? false
        : typeof rawTabindex === "number"
          ? String(rawTabindex)
          : rawTabindex;
    // The build-time code element transformer needs scope identity in inline
    // output too. Keep this control private to the native presentation bridge.
    const preserveScopeBoundaries = options?.transformers?.some(
      (transformer) => transformer?.[Symbol.for("ferriki.preserve-scope-boundaries.v1")] === true,
    )
      ? true
      : undefined;
    assertActive();
    // Construct the native option shape explicitly with fixed properties so
    // V8 keeps a single monomorphic hidden class without dictionary transitions.
    return {
      lang: language,
      theme,
      includeExplanation: validated.includeExplanation,
      tokenizeTimeLimit: validated.tokenizeTimeLimit,
      tokenizeMaxLineLength: validated.tokenizeMaxLineLength,
      mergeWhitespaces: validated.mergeWhitespaces,
      mergeSameStyleTokens: validated.mergeSameStyleTokens,
      rootStyle: validated.rootStyle,
      tabindex,
      styleMode: validated.styleMode,
      preserveScopeBoundaries,
      themeEntries: undefined,
      continuationState: options?.[GRAMMAR_STATE_CONTINUATION],
      captureContinuationState: options?.[GRAMMAR_STATE_CAPTURE] ? true : undefined,
    };
  }

  function getHtmlRenderData(code, options = {}) {
    assertActive();
    assertAnsiInput(code, options);
    const result = callNativeOperation("Ferriki tokenization failed", () => {
      const prepared = prepareOptions(options);
      assertActive();
      return native.getHtmlRenderData(code, prepared);
    });
    if (registrationName(options.theme) === "none") return normalizeNoneThemeResult(result);
    return result;
  }

  function getHtmlRenderDataWithThemes(code, options, themes = resolveThemeEntries(options)) {
    assertActive();
    assertAnsiInput(code, options);
    loadThemeSync(...themes.map((theme) => theme.input));
    assertActive();
    if (
      typeof native.getHtmlRenderDataWithThemes === "function" &&
      !themes.some((theme) => theme.name === "none") &&
      !options?.grammarState &&
      options?.[GRAMMAR_STATE_CONTINUATION] === undefined &&
      !options?.[GRAMMAR_STATE_CAPTURE]
    ) {
      return combineNativeThemeResult(
        callNativeOperation("Ferriki multi-theme tokenization failed", () => {
          const prepared = prepareOptions({ ...options, theme: themes[0].name, themes: undefined });
          prepared.themeEntries = themes;
          assertActive();
          return native.getHtmlRenderDataWithThemes(code, prepared);
        }),
        options,
      );
    }
    const results = themes.map((theme) => ({
      ...theme,
      result:
        theme.name === "none"
          ? normalizeNoneThemeResult(getHtmlRenderDataForTheme(code, options, NONE_THEME_BACKING))
          : getHtmlRenderDataForTheme(code, options, theme.name),
    }));
    return combineThemeResults(results, options);
  }

  function getHtmlRenderDataForTheme(code, options, theme) {
    assertActive();
    assertAnsiInput(code, options);
    return callNativeOperation("Ferriki tokenization failed", () => {
      const prepared = prepareOptions({ ...options, theme, themes: undefined });
      assertActive();
      return native.getHtmlRenderData(code, prepared);
    });
  }

  function renderHtmlDataRaw(code, options) {
    assertActive();
    if (hasThemes(options)) return getHtmlRenderDataWithThemes(code, options);
    if (registrationName(options?.theme) === "none") return getHtmlRenderData(code, options);
    return callNativeOperation("Ferriki tokenization failed", () => {
      const prepared = prepareOptions(options);
      assertActive();
      return native.getHtmlRenderData(code, prepared);
    });
  }

  function grammarLanguage(options) {
    const requested = resolveAlias(registrationName(options?.lang) || "text");
    return standardLanguageEntry(requested)?.id || requested;
  }

  function grammarThemes(options, result) {
    if (hasThemes(options)) return resolveThemeEntries(options).map((theme) => theme.name);
    return [registrationName(options?.theme) || result.themeName];
  }

  function makeGrammarState(options, result) {
    const language = grammarLanguage(options);
    const themes = grammarThemes(options, result);
    const lastToken = result.tokens.flat().at(-1);
    const scopes = lastToken?.scopeNames?.length
      ? [...lastToken.scopeNames.slice(0, -1)].reverse()
      : [scopeNameForLanguage(language)];
    if (typeof result.continuationState !== "string")
      throw new FerrikiError("Native tokenization did not return grammar state", "ERR_INTERNAL");
    return {
      version: 1,
      stateFormat: "textmate-stack-v1",
      lang: language,
      theme: themes[0],
      themes,
      scopes,
      // Keep the stable v1 object shape while storing a portable native stack
      // in this opaque context. Legacy v1 raw-source states remain accepted.
      source: `${GRAMMAR_STATE_SOURCE_PREFIX}${result.continuationState}`,
    };
  }

  function decodeGrammarStateSource(state) {
    if (state.stateFormat === undefined) return undefined;
    if (
      state.stateFormat !== "textmate-stack-v1" ||
      !state.source.startsWith(GRAMMAR_STATE_SOURCE_PREFIX)
    )
      throw new ShikiError("Invalid grammar state", "ERR_USAGE");
    if (
      Buffer.byteLength(state.source, "utf8") >
      Buffer.byteLength(GRAMMAR_STATE_SOURCE_PREFIX, "utf8") + MAX_GRAMMAR_STATE_JSON_BYTES
    )
      throw new ShikiError("Invalid grammar state", "ERR_USAGE");
    const source = state.source;
    const serialized = source.slice(GRAMMAR_STATE_SOURCE_PREFIX.length);
    try {
      const value = JSON.parse(serialized);
      if (
        !value ||
        typeof value !== "object" ||
        value.version !== 1 ||
        typeof value.grammarFingerprint !== "string" ||
        typeof value.rootScope !== "string" ||
        !Array.isArray(value.frames)
      )
        throw new Error("invalid native state envelope");
      return serialized;
    } catch {
      throw new ShikiError("Invalid grammar state", "ERR_USAGE");
    }
  }

  function validateGrammarState(state, options) {
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      state.version !== 1 ||
      typeof state.lang !== "string" ||
      !Array.isArray(state.themes) ||
      state.themes.some((theme) => typeof theme !== "string") ||
      typeof state.source !== "string"
    ) {
      throw new ShikiError("Invalid grammar state", "ERR_USAGE");
    }
    if (state.stateFormat !== undefined && state.stateFormat !== "textmate-stack-v1")
      throw new ShikiError("Invalid grammar state", "ERR_USAGE");
    const language = grammarLanguage(options);
    if (state.lang !== language)
      throw new ShikiError(
        `Grammar state language "${state.lang}" does not match highlight language "${language}"`,
        "ERR_USAGE",
      );
    const requestedThemes = grammarThemes(options, { themeName: registrationName(options?.theme) });
    for (const theme of requestedThemes) {
      if (!state.themes.includes(theme))
        throw new ShikiError(
          `Grammar state themes "${state.themes.join(",")}" do not contain highlight theme "${theme}"`,
          "ERR_USAGE",
        );
    }
    return decodeGrammarStateSource(state);
  }

  function prepareGrammarInput(code, options) {
    const state = options?.grammarState;
    if (!state) return { source: code, prefixLength: 0, prefixLines: 0 };
    const continuationState = validateGrammarState(state, options);
    if (continuationState !== undefined)
      return { source: code, prefixLength: 0, prefixLines: 0, continuationState };
    const separator = state.source.endsWith("\n") ? "" : "\n";
    return {
      source: `${state.source}${separator}${code}`,
      prefixLength: state.source.length + separator.length,
      prefixLines: state.source.split("\n").length - (separator ? 0 : 1),
    };
  }

  function removeGrammarPrefix(result, prefixLength, prefixLines) {
    if (!prefixLength) return result;
    return {
      ...result,
      tokens: result.tokens.slice(prefixLines).map((line) =>
        line.map((token) => ({
          ...token,
          offset: token.offset - prefixLength,
        })),
      ),
    };
  }

  function collectGrammarState(code, options = {}) {
    const validated = validateHighlightOptions(options);
    const input = prepareGrammarInput(code, validated);
    const sourceOptions = input.prefixLength
      ? { ...validated, grammarState: undefined }
      : { ...validated };
    sourceOptions[GRAMMAR_STATE_CAPTURE] = true;
    if (input.continuationState !== undefined)
      sourceOptions[GRAMMAR_STATE_CONTINUATION] = input.continuationState;
    // Grammar state uses the final token scope path, so request scopes when no
    // callback metadata mode selected them.
    if (sourceOptions.includeExplanation === undefined)
      sourceOptions.includeExplanation = "scopeName";
    let result;
    if (
      sourceOptions?.transformers?.some(
        (transformer) => transformer?.preprocess || transformer?.tokens,
      )
    )
      result = highlightWithTransformers(input.source, sourceOptions);
    else result = renderHtmlDataRaw(input.source, sourceOptions);
    result = removeGrammarPrefix(result, input.prefixLength, input.prefixLines);
    return makeGrammarState(validated, result);
  }

  function getGrammarState(code, options) {
    assertActive();
    if (typeof code !== "string")
      throw new ShikiError("Grammar state source must be a string", "ERR_USAGE");
    const validated = validateHighlightOptions(options);
    const language = grammarLanguage(validated);
    if (isSpecialLanguage(language) || language === "ansi")
      throw new ShikiError("Plain language does not have grammar state", "ERR_USAGE");
    return collectGrammarState(code, validated);
  }

  function createTransformerContext(source, options, meta) {
    return {
      meta,
      options,
      source,
    };
  }

  function withTransformerDefaults(options) {
    if (options?.transformers !== undefined || defaultTransformers.length === 0) return options;
    return { ...validateHighlightOptions(options), transformers: defaultTransformers };
  }

  function getTransformers(options) {
    return sortTransformers(options?.transformers);
  }

  function highlightWithTransformers(code, options = {}) {
    const validated = validateHighlightOptions(options);
    const transformers = getTransformers(validated);
    const meta = {};
    const context = createTransformerContext(code, validated, meta);
    let source = code;
    for (const transformer of transformers)
      source = transformer?.preprocess?.call(context, source, validated) || source;
    assertActive();
    validateHighlightOptions(validated);
    context.source = source;
    const result = renderHtmlDataRaw(source, validated);
    result.tokens = applyTokenTransformers(
      sanitizeThemeTokenColors(result.tokens),
      transformers,
      context,
    );
    return result;
  }

  function buildHast(code, options = {}) {
    assertAnsiInput(code, options);
    const validated = validateHighlightOptions(options);
    const transformers = getTransformers(validated);
    const meta = {};
    const context = createTransformerContext(code, validated, meta);
    let source = code;
    for (const transformer of transformers)
      source = transformer?.preprocess?.call(context, source, validated) || source;
    assertActive();
    validateHighlightOptions(validated);
    context.source = source;
    assertAnsiInput(source, validated);
    const input = prepareGrammarInput(source, validated);
    const nativeOptions = { ...validated };
    if (input.continuationState !== undefined)
      nativeOptions[GRAMMAR_STATE_CONTINUATION] = input.continuationState;
    const result = removeGrammarPrefix(
      renderHtmlDataRaw(input.source, nativeOptions),
      input.prefixLength,
      input.prefixLines,
    );
    result.tokens = applyTokenTransformers(
      prepareRenderTokens(sanitizeThemeTokenColors(result.tokens), validated),
      transformers,
      context,
    );
    if (validated.decorations?.length)
      result.tokens = splitTokensAtDecorations(result.tokens, validated.decorations, source);
    const tree = renderTransformedHast(
      prepareHastRenderResult(result, validated),
      validated,
      transformers,
      context,
      source,
    );
    return tree;
  }

  function renderHtmlWithThemes(code, options) {
    options = validateHighlightOptions(options);
    const themes = resolveThemeEntries(options);
    const strings = [options.rootStyle, options.tabindex, options.cssVariablePrefix];
    assertActive();
    if (
      typeof native.codeToHtmlWithThemes === "function" &&
      !themes.some((theme) => theme.name === "none") &&
      strings.every((value) => typeof value !== "string" || value.isWellFormed())
    ) {
      loadThemeSync(...themes.map((theme) => theme.input));
      return callNativeOperation("Ferriki multi-theme HTML rendering failed", () => {
        const prepared = prepareOptions({ ...options, theme: themes[0].name, themes: undefined });
        prepared.themeEntries = themes;
        const themeOptions = {
          defaultColor: options.defaultColor,
          cssVariablePrefix: options.cssVariablePrefix,
        };
        assertActive();
        return native.codeToHtmlWithThemes(code, prepared, themeOptions);
      });
    }
    return hastToHtml(
      renderTokenResultHast(getHtmlRenderDataWithThemes(code, options, themes), options),
    );
  }

  function canUseNativeClassRender(code, options) {
    assertActive();
    if (typeof native.codeToHtmlWithCss !== "function") return false;
    if (typeof code !== "string" || !code.isWellFormed()) return false;
    const themeName = registrationName(options?.theme);
    const rootStyle = options?.rootStyle;
    const tabindex = options?.tabindex;
    const eligible =
      !hasThemes(options) &&
      !hasHastPipeline(options) &&
      !options?.grammarState &&
      themeName !== "none" &&
      (typeof themeName !== "string" || themeName.isWellFormed()) &&
      (typeof rootStyle !== "string" || rootStyle.isWellFormed()) &&
      (typeof tabindex !== "string" || tabindex.isWellFormed());
    assertActive();
    return eligible;
  }

  const highlighter = {
    codeToHtmlWithCss(code, options) {
      assertActive();
      options = withTransformerDefaults(options);
      const validated = validateHighlightOptions(options);
      assertActive();
      assertAnsiInput(code, validated);
      const classOptions = { ...validated, styleMode: "classes" };
      if (canUseNativeClassRender(code, classOptions)) {
        return callNativeOperation("Ferriki HTML rendering failed", () => {
          const prepared = prepareOptions(classOptions);
          assertActive();
          return native.codeToHtmlWithCss(code, prepared);
        });
      }
      const tree = buildHast(code, classOptions);
      return {
        html: applyPostprocess(hastToHtml(tree), classOptions, code),
        css: classStylesByTree.get(tree) || "",
      };
    },
    codeToHtml(code, options) {
      assertActive();
      options = withTransformerDefaults(options);
      assertAnsiInput(code, options);
      if (options?.styleMode === "classes") {
        if (canUseNativeClassRender(code, options)) {
          return callNativeOperation("Ferriki HTML rendering failed", () => {
            const prepared = prepareOptions(options);
            assertActive();
            return native.codeToHtml(code, prepared);
          });
        }
        return applyPostprocess(hastToHtml(buildHast(code, options)), options, code);
      }
      if (options?.grammarState)
        return applyPostprocess(hastToHtml(buildHast(code, options)), options, code);
      const decorations = nativeDecorationInputs(code, options);
      if (decorations) {
        const html = callNativeOperation("Ferriki HTML rendering failed", () =>
          decorationNative(() => {
            const prepared = prepareOptions(options);
            assertActive();
            return native.codeToHtmlWithDecorations(code, prepared, decorations);
          }),
        );
        if (html !== null && html !== undefined) return html;
      }
      if (hasHastPipeline(options)) {
        const validated = validateHighlightOptions(options);
        const html = hastToHtml(buildHast(code, validated));
        return applyPostprocess(html, validated, code);
      }
      if (hasThemes(options)) return renderHtmlWithThemes(code, options);
      if (registrationName(options?.theme) === "none")
        return hastToHtml(renderTokenResultHast(getHtmlRenderData(code, options), options));
      return callNativeOperation("Ferriki HTML rendering failed", () => {
        const prepared = prepareOptions(options);
        assertActive();
        return native.codeToHtml(code, prepared);
      });
    },
    getLoadedLanguages() {
      assertActive();
      const nativeLanguages = native.getLoadedLanguages();
      const configuredAliases = [...languageAliases.entries()]
        .filter(([, target]) => nativeLanguages.includes(resolveAlias(target)))
        .map(([alias]) => alias);
      return [...new Set([...nativeLanguages, ...configuredAliases])];
    },
    getRegexDiagnostics() {
      assertActive();
      return JSON.parse(native.getRegexDiagnosticsJson());
    },
    getLoadedThemes() {
      assertActive();
      return [...loadedThemes];
    },
    loadLanguage,
    loadLanguageSync,
    loadTheme,
    loadThemeSync,
    [LOAD_ASSETS_BATCH]: loadAssetsBatch,
    resolveLangAlias: resolveAlias,
    getLastGrammarState: getGrammarState,
    dispose() {
      if (!disposed) {
        disposed = true;
        disposedHighlighters.add(highlighter);
        loadedLanguages.clear();
        loadedStandardLanguages.clear();
        missingSidecarLanguages.clear();
        loadedThemes.clear();
        loadedStandardThemes.clear();
        pendingPrefetchLangCounts.clear();
        pendingPrefetchThemeCounts.clear();
        languageAliases.clear();
        defaultTransformers = [];
        const handle = native;
        native = undefined;
        downloadStandardAssets = undefined;
        handle?.dispose();
      }
    },
    [Symbol.dispose]() {
      this.dispose();
    },
  };

  try {
    loadLanguageSync(...(options.langs || []));
    loadThemeSync(...(options.themes || []));
    return highlighter;
  } catch (error) {
    highlighter.dispose();
    throw error;
  }
}

export function createShikiPrimitive(options = {}) {
  return createHighlighterCoreSync(options);
}

export async function getSingletonHighlighter(options = {}) {
  let highlighter;
  let created = false;
  do {
    created = !singleton;
    const pending = (singleton ||= createHighlighter(options));
    try {
      highlighter = await pending;
    } catch (error) {
      if (singleton === pending) singleton = undefined;
      throw error;
    }
    if (disposedHighlighters.has(highlighter) && singleton === pending) singleton = undefined;
  } while (disposedHighlighters.has(highlighter));
  if (!created) {
    if (options.langs?.length) await highlighter.loadLanguage(...options.langs);
    if (options.themes?.length) await highlighter.loadTheme(...options.themes);
  }
  return highlighter;
}

export const getSingletonHighlighterCore = getSingletonHighlighter;

export function codeToHtml(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, "codeToHtml"))
    return highlighterOrCode.codeToHtml(codeOrOptions, options);
  return getSingletonHighlighter(shorthandLoads(codeOrOptions)).then((highlighter) =>
    highlighter.codeToHtml(highlighterOrCode, codeOrOptions),
  );
}

export function codeToHtmlWithCss(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, "codeToHtmlWithCss"))
    return highlighterOrCode.codeToHtmlWithCss(codeOrOptions, options);
  return getSingletonHighlighter(shorthandLoads(codeOrOptions)).then((highlighter) =>
    highlighter.codeToHtmlWithCss(highlighterOrCode, codeOrOptions),
  );
}

export function getLastGrammarState(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, "getLastGrammarState"))
    return highlighterOrCode.getLastGrammarState(codeOrOptions, options);
  if (typeof highlighterOrCode !== "string")
    throw new ShikiError("Grammar state source must be a string", "ERR_USAGE");
  return getSingletonHighlighter(shorthandLoads(codeOrOptions)).then((highlighter) =>
    highlighter.getLastGrammarState(highlighterOrCode, codeOrOptions),
  );
}

export function createCssVariablesTheme(options = {}) {
  return {
    name: options.name || "css-variables",
    type: options.type || "dark",
    fg: options.variableDefaults?.foreground || "var(--shiki-foreground)",
    bg: options.variableDefaults?.background || "var(--shiki-background)",
    settings: [],
  };
}

function hastToHtml(tree) {
  const children = tree.children;
  if (!children || children.length === 0) return "";
  let html = "";
  for (let index = 0; index < children.length; index++) {
    if (!(index in children)) continue;
    html += nodeToHtml(children[index]);
  }
  return html;
}

export const bundledLanguages = createLanguageBundle(languageCatalog);
export const bundledThemes = createThemeBundle(themeCatalog);
export const bundledLanguagesAlias = createLanguageAliasBundle(languageCatalog);

const standardLanguageEntries = new Map();
for (const entry of languageCatalog) {
  if (!standardLanguageEntries.has(entry.id)) standardLanguageEntries.set(entry.id, entry);
  for (const alias of entry.aliases) {
    if (!standardLanguageEntries.has(alias)) standardLanguageEntries.set(alias, entry);
  }
}
function standardLanguageEntry(name) {
  return standardLanguageEntries.get(name);
}
const standardLanguageKeys = new Set(
  languageCatalog.flatMap((entry) => [entry.id, ...entry.aliases]),
);
const standardLanguageCanonicalIds = new Map(
  languageCatalog.flatMap((entry) => [
    [entry.id, entry.id],
    ...entry.aliases.map((alias) => [alias, entry.id]),
  ]),
);
function canonicalStandardLanguage(name) {
  return standardLanguageCanonicalIds.get(name);
}
const standardLanguageEmbeddedIds = new Map(
  languageCatalog.map((entry) => [entry.id, entry.embeddedLangs || []]),
);
function expandStandardLanguageClosure(canonicalIds) {
  const seen = new Set();
  const expanded = [];
  for (const id of canonicalIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      expanded.push(id);
    }
  }
  for (let i = 0; i < expanded.length; i++) {
    for (const embedded of standardLanguageEmbeddedIds.get(expanded[i]) || []) {
      const canonical = canonicalStandardLanguage(embedded) || embedded;
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        expanded.push(canonical);
      }
    }
  }
  return expanded;
}
function standardLanguageDependsOnAny(rootId, targets) {
  if (targets.size === 0) return false;
  const pending = [rootId];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (targets.has(current)) return true;
    for (const embedded of standardLanguageEmbeddedIds.get(current) || []) {
      pending.push(canonicalStandardLanguage(embedded) || embedded);
    }
  }
  return false;
}
const standardThemeKeys = new Set(themeCatalog.map((entry) => entry.id));

function createLanguageBundle(catalog) {
  const loaders = new Map();
  for (const entry of catalog) {
    const loader = createLanguageLoader(entry);
    loaders.set(entry.id, loader);
    for (const alias of entry.aliases) loaders.set(alias, loader);
  }
  return Object.freeze(
    Object.fromEntries([...loaders].sort(([left], [right]) => compareIds(left, right))),
  );
}

function createLanguageAliasBundle(catalog) {
  const aliases = new Map();
  for (const entry of catalog) {
    for (const alias of entry.aliases) aliases.set(alias, entry.id);
  }
  return Object.freeze(
    Object.fromEntries([...aliases].sort(([left], [right]) => compareIds(left, right))),
  );
}

function createLanguageLoader(entry) {
  return async () => [
    {
      name: entry.id,
      scopeName: entry.scopeName,
      displayName: entry.displayName || undefined,
      aliases: [...entry.aliases],
      embeddedLangs: [...entry.embeddedLangs],
      embeddedLangsLazy: [...entry.embeddedLangsLazy],
      injectTo: [...entry.injectTo],
    },
  ];
}

function createThemeBundle(catalog) {
  const loaders = Object.fromEntries(
    catalog.map((entry) => [
      entry.id,
      async () => ({
        name: entry.id,
        type: entry.themeType || undefined,
      }),
    ]),
  );
  return Object.freeze(loaders);
}

function validateHighlightOptions(options) {
  if (options == null) return {};
  if (typeof options !== "object" || Array.isArray(options))
    throw new ShikiError("Highlight options must be an object", "ERR_USAGE");

  if (options.styleMode !== undefined && !["inline", "classes"].includes(options.styleMode))
    throw new ShikiError("Highlight option `styleMode` must be inline or classes", "ERR_USAGE");
  const registrationFields = ["lang", "theme"];
  for (const field of registrationFields) {
    const value = options[field];
    if (
      value !== undefined &&
      typeof value !== "string" &&
      (!value || typeof value !== "object" || Array.isArray(value))
    )
      throw new ShikiError(
        `Highlight option \`${field}\` must be a name or registration object`,
        "ERR_USAGE",
      );
  }
  if (
    options.themes !== undefined &&
    (!options.themes || typeof options.themes !== "object" || Array.isArray(options.themes))
  )
    throw new ShikiError("Highlight option `themes` must be an object", "ERR_USAGE");
  if (
    options.defaultColor !== undefined &&
    options.defaultColor !== false &&
    typeof options.defaultColor !== "string"
  )
    throw new ShikiError("Highlight option `defaultColor` must be a string or false", "ERR_USAGE");
  if (options.cssVariablePrefix !== undefined && typeof options.cssVariablePrefix !== "string")
    throw new ShikiError("Highlight option `cssVariablePrefix` must be a string", "ERR_USAGE");
  if (options.themes) {
    const isClassesMode = options.styleMode === "classes";
    const effectivePrefix = options.cssVariablePrefix ?? "--shiki-";
    if (options.cssVariablePrefix !== undefined) {
      const validPrefix = isClassesMode
        ? isValidCssVariablePrefix(options.cssVariablePrefix)
        : isValidInlineCssVariablePrefix(options.cssVariablePrefix);
      if (!validPrefix)
        throw new ShikiError(
          "Highlight option `cssVariablePrefix` must be a CSS custom property prefix",
          "ERR_USAGE",
        );
    }
    for (const [key, value] of Object.entries(options.themes)) {
      if (value == null || value === false) continue;
      if (isClassesMode) {
        if (!isValidCssIdentifier(key))
          throw new ShikiError("Theme keys must be CSS identifiers", "ERR_USAGE");
      } else if (!isValidInlineThemeAlias(effectivePrefix, key)) {
        throw new ShikiError(
          "Theme keys must produce valid CSS custom property names",
          "ERR_USAGE",
        );
      }
    }
  }
  if (
    options.includeExplanation !== undefined &&
    typeof options.includeExplanation !== "boolean" &&
    !["scopeName", "tokenType"].includes(options.includeExplanation)
  ) {
    throw new ShikiError(
      "Highlight option `includeExplanation` has an unsupported value",
      "ERR_USAGE",
    );
  }
  if (
    options.grammarState !== undefined &&
    (!options.grammarState ||
      typeof options.grammarState !== "object" ||
      Array.isArray(options.grammarState))
  ) {
    throw new ShikiError("Highlight option `grammarState` must be an object", "ERR_USAGE");
  }
  for (const field of ["mergeWhitespaces", "mergeSameStyleTokens"]) {
    if (options[field] !== undefined && typeof options[field] !== "boolean")
      throw new ShikiError(`Highlight option \`${field}\` must be boolean`, "ERR_USAGE");
  }
  if (
    options.rootStyle !== undefined &&
    options.rootStyle !== false &&
    typeof options.rootStyle !== "string"
  )
    throw new ShikiError("Highlight option `rootStyle` must be a string or false", "ERR_USAGE");
  if (
    options.tabindex !== undefined &&
    options.tabindex !== null &&
    options.tabindex !== false &&
    typeof options.tabindex !== "string" &&
    (typeof options.tabindex !== "number" || !Number.isFinite(options.tabindex))
  ) {
    throw new ShikiError(
      "Highlight option `tabindex` must be a string, number, false, or null",
      "ERR_USAGE",
    );
  }
  for (const field of ["tokenizeMaxLineLength", "tokenizeTimeLimit"]) {
    if (
      options[field] !== undefined &&
      (typeof options[field] !== "number" || !Number.isFinite(options[field]) || options[field] < 0)
    ) {
      throw new ShikiError(
        `Highlight option \`${field}\` must be a non-negative number`,
        "ERR_USAGE",
      );
    }
  }
  if (options.transformers !== undefined && !Array.isArray(options.transformers))
    throw new ShikiError("Highlight option transformers must be an array", "ERR_USAGE");
  if (options.decorations !== undefined && !Array.isArray(options.decorations))
    throw new ShikiError("Highlight option decorations must be an array", "ERR_USAGE");
  if (
    options.structure !== undefined &&
    options.structure !== "classic" &&
    options.structure !== "inline"
  )
    throw new ShikiError("Highlight option structure must be classic or inline", "ERR_USAGE");
  for (const field of ["colorReplacements", "engine", "loadWasm", "wasmBinary"]) {
    if (options[field] !== undefined)
      throw new ShikiError(
        `Highlight option \`${field}\` is not supported by Ferriki`,
        "ERR_UNSUPPORTED",
      );
  }
  return options;
}

function validateHighlighterOptions(options) {
  if (options == null) return {};
  if (typeof options !== "object" || Array.isArray(options))
    throw new ShikiError("Highlighter options must be an object", "ERR_USAGE");
  if (options.regexPrefilter !== undefined && typeof options.regexPrefilter !== "boolean")
    throw new ShikiError("Highlighter option `regexPrefilter` must be a boolean", "ERR_USAGE");
  if (options.regexMode !== undefined) {
    if (!["off", "auto", "eager", "prepared"].includes(options.regexMode))
      throw new ShikiError(
        "Highlighter option `regexMode` must be off, auto, eager, or prepared",
        "ERR_USAGE",
      );
    if (options.regexPrefilter !== undefined)
      throw new ShikiError("Choose either `regexMode` or `regexPrefilter`, not both", "ERR_USAGE");
  }
  for (const field of ["langs", "themes", "transformers"]) {
    if (options[field] !== undefined && !Array.isArray(options[field]))
      throw new ShikiError(`Highlighter option \`${field}\` must be an array`, "ERR_USAGE");
  }
  if (
    options.langAlias !== undefined &&
    (!options.langAlias ||
      typeof options.langAlias !== "object" ||
      Array.isArray(options.langAlias))
  ) {
    throw new ShikiError("Highlighter option `langAlias` must be an object", "ERR_USAGE");
  }
  if (options.langAlias) {
    for (const [alias, target] of Object.entries(options.langAlias)) {
      if (!alias || typeof target !== "string" || !target)
        throw new ShikiError(
          "Highlighter option `langAlias` must map non-empty names to strings",
          "ERR_USAGE",
        );
    }
  }
  return options;
}

function validateLanguageRegistration(registration) {
  if (typeof registration === "string") return;
  if (!registration || typeof registration !== "object" || Array.isArray(registration))
    throw new ShikiError(
      "Language registrations must be names or registration objects",
      "ERR_USAGE",
    );
  const allowed = new Set([
    "name",
    "scopeName",
    "aliases",
    "patterns",
    "repository",
    "injections",
    "injectionSelector",
    "fileTypes",
    "firstLineMatch",
    "$vscodeTextmateLocation",
    "embeddedLangs",
    "embeddedLanguages",
    "embeddedLangsLazy",
    "injectTo",
    "balancedBracketSelectors",
    "unbalancedBracketSelectors",
    "displayName",
    "foldingStopMarker",
    "foldingStartMarker",
  ]);
  for (const key of Object.keys(registration)) {
    if (!allowed.has(key))
      throw new ShikiError(`Unsupported language registration field \`${key}\``, "ERR_USAGE");
  }
  if (typeof registration.name !== "string" || !registration.name)
    throw new ShikiError("Language registration requires a non-empty `name`", "ERR_USAGE");
  if (isCustomLanguageRegistration(registration)) {
    if (typeof registration.scopeName !== "string" || !registration.scopeName)
      throw new ShikiError(
        `Language registration \`${registration.name}\` requires a non-empty \`scopeName\``,
        "ERR_USAGE",
      );
    if (!hasLanguagePayload(registration))
      throw new ShikiError(
        `Language registration \`${registration.name}\` has no supported grammar payload`,
        "ERR_USAGE",
      );
  }
  for (const key of [
    "aliases",
    "embeddedLangs",
    "embeddedLanguages",
    "embeddedLangsLazy",
    "injectTo",
  ]) {
    if (
      registration[key] !== undefined &&
      (!Array.isArray(registration[key]) ||
        registration[key].some((value) => typeof value !== "string"))
    )
      throw new ShikiError(
        `Language registration \`${key}\` must be an array of strings`,
        "ERR_USAGE",
      );
  }
  if (registration.patterns !== undefined && !Array.isArray(registration.patterns))
    throw new ShikiError("Language registration `patterns` must be an array", "ERR_USAGE");
  if (
    registration.repository !== undefined &&
    (!registration.repository ||
      typeof registration.repository !== "object" ||
      Array.isArray(registration.repository))
  )
    throw new ShikiError("Language registration `repository` must be an object", "ERR_USAGE");
}

function validateThemeRegistration(registration) {
  if (typeof registration === "string") return;
  if (!registration || typeof registration !== "object" || Array.isArray(registration))
    throw new ShikiError("Theme registrations must be names or registration objects", "ERR_USAGE");
  const allowed = new Set([
    "name",
    "type",
    "fg",
    "bg",
    "settings",
    "tokenColors",
    "colors",
    "include",
    "displayName",
    "$schema",
    "semanticHighlighting",
    "semanticTokenColors",
  ]);
  for (const key of Object.keys(registration)) {
    if (!allowed.has(key))
      throw new ShikiError(`Unsupported theme registration field \`${key}\``, "ERR_USAGE");
  }
  if (typeof registration.name !== "string" || !registration.name)
    throw new ShikiError("Theme registration requires a non-empty `name`", "ERR_USAGE");
  if (registration.include !== undefined && typeof registration.include !== "string")
    throw new ShikiError("Theme registration `include` must be a theme name", "ERR_USAGE");
  if (
    isCustomThemeRegistration(registration) &&
    registration.settings !== undefined &&
    !Array.isArray(registration.settings) &&
    !Array.isArray(registration.tokenColors)
  )
    throw new ShikiError("Theme registration settings must be an array", "ERR_USAGE");
  if (!standardThemeKeys.has(registration.name) && !hasThemePayload(registration))
    throw new ShikiError(
      `Theme registration \`${registration.name}\` has no supported theme payload`,
      "ERR_USAGE",
    );
}

function hasLanguagePayload(registration) {
  return [
    "patterns",
    "repository",
    "injections",
    "injectionSelector",
    "fileTypes",
    "firstLineMatch",
  ].some((key) => Object.hasOwn(registration, key));
}

function isCustomLanguageRegistration(registration) {
  return (
    typeof registration === "object" &&
    registration !== null &&
    !standardLanguageKeys.has(registration.name)
  );
}

function hasThemePayload(registration) {
  return ["settings", "tokenColors", "colors", "fg", "bg", "include"].some((key) =>
    Object.hasOwn(registration, key),
  );
}

function isCustomThemeRegistration(registration) {
  return (
    typeof registration === "object" &&
    registration !== null &&
    !standardThemeKeys.has(registration.name)
  );
}

function isStandardLanguageKey(name) {
  return standardLanguageKeys.has(name);
}

function isStandardThemeKey(name) {
  return standardThemeKeys.has(name);
}

function callNativeOperation(message, operation) {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof ShikiError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (detail.includes("Invalid grammar state:"))
      throw new ShikiError("Invalid grammar state", "ERR_USAGE", { cause });
    const code = /time|line length|resource|limit/i.test(detail)
      ? "ERR_RESOURCE_LIMIT"
      : /asset|grammar|theme|catalog/i.test(detail)
        ? "ERR_ASSET"
        : "ERR_INTERNAL";
    throw new FerrikiError(`${message}: ${detail}`, code, { cause });
  }
}

async function callNativeOperationAsync(message, operation) {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof ShikiError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new FerrikiError(`${message}: ${detail}`, "ERR_ASSET", { cause });
  }
}

// The shorthands load what their options name, as Shiki's do.
function shorthandLoads(options) {
  if (!options || typeof options !== "object") return {};
  const langs =
    options.lang && !isSpecialLanguage(registrationName(options.lang)) ? [options.lang] : [];
  const themes = [options.theme, ...Object.values(options.themes || {})].filter(
    (theme) => theme != null && theme !== false,
  );
  return { langs, themes };
}

// `assets: { remote, baseUrl, cacheDir }` (ADR 0013). Unset fields fall back to
// FERRIKI_ASSETS_REMOTE, FERRIKI_ASSETS_BASE_URL and FERRIKI_CACHE_DIR in the
// native runtime. Without an explicit or environment cache directory, the cache
// follows the find-cache-dir convention: node_modules/.cache/ferriki of the
// nearest package root, then the platform cache directory.
function resolveAssetOptions(assets) {
  const resolved = {};
  if (assets !== undefined) {
    if (!assets || typeof assets !== "object" || Array.isArray(assets))
      throw new ShikiError("Highlighter option `assets` must be an object", "ERR_USAGE");
    for (const key of Object.keys(assets)) {
      if (!["remote", "baseUrl", "cacheDir"].includes(key))
        throw new ShikiError(`Unknown asset option \`${key}\``, "ERR_USAGE");
    }
    if (assets.remote !== undefined) {
      if (typeof assets.remote !== "boolean")
        throw new ShikiError("Asset option `remote` must be a boolean", "ERR_USAGE");
      resolved.remote = assets.remote;
    }
    if (assets.cacheDir !== undefined) {
      if (typeof assets.cacheDir !== "string" || !assets.cacheDir)
        throw new ShikiError("Asset option `cacheDir` must be a non-empty path", "ERR_USAGE");
      resolved.cacheDir = assets.cacheDir;
    }
  }
  const envRemote = process.env.FERRIKI_ASSETS_REMOTE?.trim().toLowerCase();
  const effectiveRemote = resolved.remote ?? (envRemote !== "0" && envRemote !== "false");
  if (assets !== undefined && assets.baseUrl !== undefined) {
    if (typeof assets.baseUrl !== "string")
      throw new ShikiError("Asset option `baseUrl` must be an http(s) URL", "ERR_USAGE");
    if (effectiveRemote) {
      const normalized = normalizeAssetBaseUrl(assets.baseUrl);
      if (!normalized)
        throw new ShikiError(
          "Asset option `baseUrl` must be an https:// URL (or loopback http:// URL) without credentials, query strings, or fragments",
          "ERR_USAGE",
        );
      resolved.baseUrl = normalized;
    } else {
      if (!/^https?:\/\//i.test(assets.baseUrl))
        throw new ShikiError("Asset option `baseUrl` must be an http(s) URL", "ERR_USAGE");
      resolved.baseUrl = assets.baseUrl;
    }
  } else if (effectiveRemote) {
    const envBaseUrl = process.env.FERRIKI_ASSETS_BASE_URL?.trim();
    if (envBaseUrl) resolved.baseUrl = normalizeAssetBaseUrl(envBaseUrl) ?? envBaseUrl;
  }
  if (resolved.cacheDir === undefined && !process.env.FERRIKI_CACHE_DIR) {
    const packageCache = findPackageCacheDir(process.cwd());
    if (packageCache) resolved.cacheDir = packageCache;
  }
  return resolved;
}

function findPackageCacheDir(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json")))
      return existsSync(join(dir, "node_modules"))
        ? join(dir, "node_modules", ".cache", "ferriki")
        : undefined;
    if (dirname(dir) === dir) return undefined;
  }
}

function callCustomRegistration(loader, kind) {
  try {
    return loader();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ShikiError(`Invalid custom ${kind} registration: ${detail}`, "ERR_ASSET", {
      cause: error,
    });
  }
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasThemes(options) {
  return options != null && Object.hasOwn(options, "themes");
}

function resolveThemeEntries(options) {
  const entries = Object.entries(options?.themes || {})
    .filter(([, theme]) => theme != null && theme !== false)
    .map(([color, theme]) => ({ color, input: theme, name: registrationName(theme) }));
  if (entries.length === 0) throw new ShikiError("`themes` option must not be empty", "ERR_USAGE");
  if (entries.some((entry) => !entry.name))
    throw new ShikiError("Theme registrations must provide a name", "ERR_USAGE");

  const defaultColor = options.defaultColor === undefined ? "light" : options.defaultColor;
  if (defaultColor && defaultColor !== "light-dark()") {
    const defaultEntry = entries.find((entry) => entry.color === defaultColor);
    if (!defaultEntry)
      throw new ShikiError(
        `\`themes\` option must contain the defaultColor key \`${defaultColor}\``,
        "ERR_USAGE",
      );
    return [defaultEntry, ...entries.filter((entry) => entry !== defaultEntry)];
  }
  if (
    defaultColor === "light-dark()" &&
    (!entries.some((entry) => entry.color === "light") ||
      !entries.some((entry) => entry.color === "dark"))
  ) {
    throw new ShikiError(
      'When using `defaultColor: "light-dark()"`, you must provide both `light` and `dark` themes',
      "ERR_USAGE",
    );
  }
  return entries;
}

function normalizeNoneThemeResult(result) {
  return {
    ...result,
    fg: "inherit",
    bg: "inherit",
    themeName: "none",
    tokens: result.tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        offset: token.offset,
        ...(token.type === undefined ? {} : { type: token.type }),
        ...(token.scopeNames ? { scopeNames: token.scopeNames } : {}),
      })),
    ),
  };
}

function sanitizeThemeTokenColors(tokens) {
  return tokens.map((line) =>
    line.map((token) => {
      let next = token;
      if (token.color !== undefined && token.color !== "") {
        const safeColor = normalizeSafeCssColor(token.color);
        if (safeColor !== token.color) {
          next = { ...next };
          if (safeColor) next.color = safeColor;
          else delete next.color;
        }
      }
      if (token.bgColor !== undefined && token.bgColor !== "") {
        const safeBg = normalizeSafeCssColor(token.bgColor);
        if (safeBg !== token.bgColor) {
          if (next === token) next = { ...next };
          if (safeBg) next.bgColor = safeBg;
          else delete next.bgColor;
        }
      }
      return next;
    }),
  );
}

function prepareHastRenderResult(result, options) {
  if (
    options.styleMode === "classes" ||
    result.themeName === "none" ||
    result.isMultiTheme === true
  )
    return result;

  return {
    ...result,
    hastClass: `shiki ${result.themeName}`,
    tokens: result.tokens.map((line) =>
      line.map((token) => {
        if (Object.hasOwn(token, "htmlStyle")) return token;
        const htmlStyle = Object.entries(tokenStyle(token, { sanitizeColor: false }))
          .map(([key, value]) => `${key}:${value}`)
          .join(";");
        return htmlStyle ? { ...token, htmlStyle } : token;
      }),
    ),
  };
}

function combineThemeResults(results, options) {
  const defaultColor = options.defaultColor === undefined ? "light" : options.defaultColor;
  const cssVariablePrefix = options.cssVariablePrefix || "--shiki-";
  const tokens = alignThemeTokens(results).map((line) =>
    line.map((token) => ({
      ...token,
      htmlStyle: tokenHtmlStyle(
        token.variants,
        results,
        defaultColor,
        cssVariablePrefix,
        options.styleMode === "classes",
      ),
    })),
  );
  const foreground = themePropertyStyle(
    results,
    "foreground",
    defaultColor,
    cssVariablePrefix,
    options.styleMode === "classes",
  );
  const background = themePropertyStyle(
    results,
    "background",
    defaultColor,
    cssVariablePrefix,
    options.styleMode === "classes",
  );
  return {
    tokens,
    fg: foreground,
    bg: background,
    themeName: `shiki-themes ${results.map((result) => result.name).join(" ")}`,
    isMultiTheme: true,
    ...(defaultColor ? {} : { rootStyle: `${foreground};${background}` }),
    ...(results[0]?.result.continuationState
      ? { continuationState: results[0].result.continuationState }
      : {}),
  };
}

function combineNativeThemeResult(result, options) {
  const results = result.themes.map((theme) => ({
    color: theme.color,
    name: theme.name,
    result: {
      fg: theme.foreground,
      bg: theme.background,
    },
  }));
  const defaultColor = options.defaultColor === undefined ? "light" : options.defaultColor;
  const cssVariablePrefix = options.cssVariablePrefix || "--shiki-";
  const tokens = result.tokens.map((line) =>
    line.map((token) => {
      const variants = Object.fromEntries(
        Object.entries(token.variants).map(([color, style]) => [
          color,
          tokenStyleFromNative(style),
        ]),
      );
      return {
        content: token.content,
        offset: token.offset,
        ...(token.type === undefined ? {} : { type: token.type }),
        ...(token.scopeNames ? { scopeNames: token.scopeNames } : {}),
        variants,
        htmlStyle: tokenHtmlStyle(
          variants,
          results,
          defaultColor,
          cssVariablePrefix,
          options.styleMode === "classes",
        ),
      };
    }),
  );
  const foreground = themePropertyStyle(
    results,
    "foreground",
    defaultColor,
    cssVariablePrefix,
    options.styleMode === "classes",
  );
  const background = themePropertyStyle(
    results,
    "background",
    defaultColor,
    cssVariablePrefix,
    options.styleMode === "classes",
  );
  return {
    tokens,
    fg: foreground,
    bg: background,
    themeName: `shiki-themes ${results.map((result) => result.name).join(" ")}`,
    isMultiTheme: true,
    ...(defaultColor ? {} : { rootStyle: `${foreground};${background}` }),
  };
}

function tokenStyleFromNative(style) {
  const output = {};
  const color = style.color ? normalizeSafeCssColor(style.color) : undefined;
  if (color) output.color = color;
  const fontStyle = style.fontStyle || 0;
  if (fontStyle & 1) output["font-style"] = "italic";
  if (fontStyle & 2) output["font-weight"] = "bold";
  const decorations = [];
  if (fontStyle & 4) decorations.push("underline");
  if (fontStyle & 8) decorations.push("line-through");
  if (decorations.length) output["text-decoration"] = decorations.join(" ");
  return output;
}

function tokenHtmlStyle(
  variants,
  results,
  defaultColor,
  cssVariablePrefix,
  includeDefaultVariant = false,
) {
  const styles = results.map((result) =>
    Object.hasOwn(variants, result.color) ? variants[result.color] : {},
  );
  const keys = new Set(styles.flatMap((style) => Object.keys(style)));
  const declarations = [];
  for (let index = 0; index < results.length; index++) {
    for (const key of keys) {
      const value = (Object.hasOwn(styles[index], key) && styles[index][key]) || "inherit";
      const color = results[index].color;
      const isColor = key === "color" || key === "background-color";
      if (index === 0 && defaultColor && isColor && !includeDefaultVariant) {
        if (defaultColor === "light-dark()" && (key === "color" || key === "background-color")) {
          const lightIndex = results.findIndex((result) => result.color === "light");
          const darkIndex = results.findIndex((result) => result.color === "dark");
          if (lightIndex !== -1 && darkIndex !== -1) {
            const light =
              (Object.hasOwn(styles[lightIndex], key) && styles[lightIndex][key]) || "inherit";
            const dark =
              (Object.hasOwn(styles[darkIndex], key) && styles[darkIndex][key]) || "inherit";
            declarations.push(`${key}:light-dark(${light}, ${dark})`);
          }
        } else {
          declarations.push(`${key}:${value}`);
        }
      }
      if (
        includeDefaultVariant ||
        index > 0 ||
        !defaultColor ||
        !isColor ||
        defaultColor === "light-dark()"
      ) {
        const suffix = key === "color" ? "" : key === "background-color" ? "-bg" : `-${key}`;
        declarations.push(`${cssVariablePrefix}${color}${suffix}:${value}`);
      }
    }
  }
  if (includeDefaultVariant)
    declarations.push(
      "color:var(--ferriki-color);font-style:var(--ferriki-font-style,normal);font-weight:var(--ferriki-font-weight,normal);text-decoration:var(--ferriki-text-decoration,none)",
    );
  return declarations.join(";");
}

function safeThemeColor(value) {
  return normalizeSafeCssColor(value) ?? "inherit";
}

function themePropertyStyle(
  results,
  property,
  defaultColor,
  cssVariablePrefix,
  includeDefaultVariant = false,
) {
  const declarations = [];
  const field = property === "foreground" ? "fg" : "bg";
  for (let index = 0; index < results.length; index++) {
    const value = safeThemeColor(results[index].result[field]);
    const color = results[index].color;
    if (index === 0 && defaultColor) {
      if (defaultColor === "light-dark()") {
        const light = safeThemeColor(
          results.find((result) => result.color === "light")?.result[field],
        );
        const dark = safeThemeColor(
          results.find((result) => result.color === "dark")?.result[field],
        );
        declarations.push(`light-dark(${light}, ${dark})`);
      } else {
        declarations.push(value);
      }
    }
    if (includeDefaultVariant || index > 0 || !defaultColor || defaultColor === "light-dark()")
      declarations.push(
        `${cssVariablePrefix}${color}${property === "background" ? "-bg" : ""}:${value}`,
      );
  }
  return declarations.join(";");
}

function hasSameMergeableStyle(previous, token) {
  if (previous.htmlStyle || token.htmlStyle) return previous.htmlStyle === token.htmlStyle;
  if (((previous.fontStyle || 0) & 3) !== ((token.fontStyle || 0) & 3)) return false;
  const previousColor = previous.color;
  const tokenColor = token.color;
  if (previousColor === tokenColor) return true;
  return (
    (previousColor ? normalizeSafeCssColor(previousColor) : undefined) ===
    (tokenColor ? normalizeSafeCssColor(tokenColor) : undefined)
  );
}

// Rendering normalization follows Shiki's HTML contract and applies before
// transformer token callbacks.
function prepareRenderTokens(tokens, options) {
  if (options.styleMode === "classes")
    return tokens.map((line) => line.map((token) => ({ ...token })));
  const merge = options.mergeWhitespaces ?? true;
  return tokens.map((line) => {
    let output = [];
    if (merge === true) {
      let pending = "";
      let offset;
      for (let index = 0; index < line.length; index++) {
        const token = line[index];
        const decorated = (token.fontStyle || 0) & 12;
        if (!decorated && /^\s+$/.test(token.content) && index + 1 < line.length) {
          offset ??= token.offset;
          pending += token.content;
          continue;
        }
        if (pending && decorated) output.push({ content: pending, offset });
        output.push(
          pending && !decorated ? { ...token, offset, content: pending + token.content } : token,
        );
        pending = "";
        offset = undefined;
      }
    } else {
      output = line;
    }
    if (!options.mergeSameStyleTokens) return output;
    const merged = [];
    for (const token of output) {
      const previous = merged.at(-1);
      if (
        previous &&
        !((previous.fontStyle || 0) & 12) &&
        !((token.fontStyle || 0) & 12) &&
        hasSameMergeableStyle(previous, token)
      )
        previous.content += token.content;
      else merged.push({ ...token });
    }
    return merged;
  });
}

function renderTokenResultHast(result, options = {}) {
  result = prepareHastRenderResult(result, options);
  const properties = {
    class:
      result.hastClass ||
      (result.isMultiTheme === true ? `shiki ${result.themeName}` : result.themeName),
  };
  if (options.rootStyle !== false) {
    let rootStyle = options.rootStyle || result.rootStyle;
    if (!rootStyle) {
      if (result.isMultiTheme === true) {
        rootStyle = `background-color:${result.bg};color:${result.fg}`;
      } else {
        const parts = [];
        const bg = normalizeSafeCssColor(result.bg);
        const fg = normalizeSafeCssColor(result.fg);
        if (bg) parts.push(`background-color:${bg}`);
        if (fg) parts.push(`color:${fg}`);
        rootStyle = parts.join(";");
      }
    }
    if (rootStyle) properties.style = rootStyle;
  }
  if (options.tabindex !== false && options.tabindex !== null)
    properties.tabindex = String(options.tabindex ?? 0);
  const tokens = prepareRenderTokens(result.tokens, options);
  const children = [];
  for (let lineIndex = 0; lineIndex < tokens.length; lineIndex++) {
    if (lineIndex > 0) children.push({ type: "text", value: "\n" });
    children.push({
      type: "element",
      tagName: "span",
      properties: { class: "line" },
      children: tokens[lineIndex].map((token) => ({
        type: "element",
        tagName: "span",
        properties: token.htmlStyle ? { style: token.htmlStyle } : {},
        children: [{ type: "text", value: token.content }],
      })),
    });
  }
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties,
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children,
          },
        ],
      },
    ],
  };
}

// Project plain declarative data only. Accessors, custom prototypes, callbacks,
// and opaque values keep their existing JS evaluation and identity semantics.
function nativeDecorationInputs(code, options) {
  if (!options || types.isProxy(options) || !Object.hasOwn(options, "decorations"))
    return undefined;
  const transformers = Object.getOwnPropertyDescriptor(options, "transformers");
  if (
    transformers &&
    (!Object.hasOwn(transformers, "value") ||
      types.isProxy(transformers.value) ||
      (Array.isArray(transformers.value) && transformers.value.length > 0))
  )
    return undefined;
  const record = (value) => {
    if (
      !value ||
      types.isProxy(value) ||
      typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value")))
      return undefined;
    return descriptors;
  };
  if (!record(options)) return undefined;
  if (
    !options?.decorations?.length ||
    options.transformers?.length ||
    options.styleMode === "classes" ||
    (options.structure && options.structure !== "classic") ||
    options.meta ||
    options.data ||
    options.grammarState ||
    options.themes ||
    typeof options.theme !== "string" ||
    options.theme === "none" ||
    (options.lang !== undefined && typeof options.lang !== "string") ||
    !code.isWellFormed() ||
    /[\u0085\uFEFF]/u.test(code) ||
    (typeof options.rootStyle === "string" && !options.rootStyle.isWellFormed()) ||
    (typeof options.tabindex === "string" && !options.tabindex.isWellFormed())
  )
    return undefined;
  if (
    !Array.isArray(options.decorations) ||
    types.isProxy(options.decorations) ||
    Object.getPrototypeOf(options.decorations) !== Array.prototype ||
    Object.values(Object.getOwnPropertyDescriptors(options.decorations)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return undefined;
  const position = (value) => {
    if (typeof value === "number") return value;
    const descriptors = record(value);
    if (!descriptors) return undefined;
    return { line: descriptors.line?.value, character: descriptors.character?.value };
  };
  const output = [];
  for (const item of options.decorations) {
    const descriptors = record(item);
    if (!descriptors || descriptors.transform?.value != null) return undefined;
    const start = position(descriptors.start?.value);
    const end = position(descriptors.end?.value);
    if (start === undefined || end === undefined) return undefined;
    const tagName = descriptors.tagName?.value;
    if (tagName !== undefined && (typeof tagName !== "string" || !tagName.isWellFormed()))
      return undefined;
    const properties = descriptors.properties?.value;
    const attributes = properties === undefined ? {} : record(properties);
    if (!attributes) return undefined;
    const projected = [];
    for (const [name, descriptor] of Object.entries(attributes)) {
      if (!descriptor.enumerable) continue;
      // JS orders integer property names before ordinary keys after merging.
      if (/^(?:0|[1-9]\d*)$/u.test(name)) return undefined;
      let value = descriptor.value;
      if (typeof value !== "string" || !value.isWellFormed() || !name.isWellFormed())
        return undefined;
      if (name === "class" && value) {
        const node = { properties: { class: value } };
        addClassToHast(node, value);
        value = node.properties.class;
      }
      projected.push({ name, value });
    }
    output.push({
      range: {
        ...(typeof start === "number"
          ? { startOffset: start }
          : { startLine: start.line, startCharacter: start.character }),
        ...(typeof end === "number"
          ? { endOffset: end }
          : { endLine: end.line, endCharacter: end.character }),
        alwaysWrap: !!descriptors.alwaysWrap?.value,
      },
      tagName: tagName || "span",
      properties: projected,
    });
  }
  return output;
}

function hasHastPipeline(options) {
  return Boolean(
    options?.decorations ||
    options?.structure ||
    options?.meta ||
    options?.data ||
    options?.transformers?.length,
  );
}

function applyPostprocess(html, options, source) {
  let output = html;
  const context = { meta: {}, options, source };
  for (const transformer of sortTransformers(options?.transformers))
    output = transformer?.postprocess?.call(context, output, options) || output;
  return output;
}

function selectDefaultTheme(options) {
  if (!options.themes) return undefined;
  if (
    options.defaultColor &&
    Object.hasOwn(options.themes, options.defaultColor) &&
    options.themes[options.defaultColor]
  )
    return options.themes[options.defaultColor];
  return (
    (Object.hasOwn(options.themes, "light") && options.themes.light) ||
    (Object.hasOwn(options.themes, "dark") && options.themes.dark) ||
    Object.values(options.themes)[0]
  );
}

function isHighlighter(value, method) {
  return value != null && typeof value[method] === "function";
}

function isSpecialLanguage(language) {
  return ["text", "txt", "plain", "plaintext", "ansi"].includes(language);
}

function scopeNameForLanguage(language) {
  return standardLanguageEntries.get(language)?.scopeName || `source.${language}`;
}

function assertAnsiInput(code, options) {
  if (
    !globalThis.__FERRIKI_COMPAT_LEGACY_ANSI &&
    registrationName(options?.lang) === "ansi" &&
    code.includes(String.fromCharCode(27))
  ) {
    throw new ShikiError(
      "ANSI control sequences are not supported by Ferriki; strip or parse them before highlighting",
      "ERR_UNSUPPORTED",
    );
  }
}

function registrationName(registration) {
  if (typeof registration === "string") return registration;
  return registration?.name || registration?.id;
}

function resolveSyncRegistrations(inputs) {
  return inputs.flat(Infinity).flatMap((input) => {
    if (typeof input === "function" || input?.then)
      throw new ShikiError("Async language/theme input requires the async loader", "ERR_USAGE");
    if (input?.default) return resolveSyncRegistrations([input.default]);
    return input == null ? [] : [input];
  });
}

function flattenRegistrationArrayTree(rootArray, active, baseDepth, budget) {
  const items = [];
  const length = rootArray.length;
  if (length > budget.remaining)
    throw new ShikiError("Language/theme registration limit exceeded", "ERR_USAGE");
  const localStack = [{ source: rootArray, index: 0, length }];

  try {
    while (localStack.length > 0) {
      const frame = localStack.at(-1);
      if (frame.index >= frame.length) {
        localStack.pop();
        if (frame.source !== rootArray) active.delete(frame.source);
        continue;
      }
      if (--budget.remaining < 0)
        throw new ShikiError("Language/theme registration limit exceeded", "ERR_USAGE");
      const value = frame.source[frame.index++];
      if (Array.isArray(value)) {
        if (active.has(value))
          throw new ShikiError("Cyclic language/theme registration input", "ERR_USAGE");
        if (baseDepth + localStack.length >= MAX_REGISTRATION_ARRAY_DEPTH)
          throw new ShikiError("Language/theme registration nesting limit exceeded", "ERR_USAGE");
        const childLength = value.length;
        if (childLength > budget.remaining)
          throw new ShikiError("Language/theme registration limit exceeded", "ERR_USAGE");
        active.add(value);
        localStack.push({ source: value, index: 0, length: childLength });
      } else if (value != null) {
        items.push(value);
      }
    }
  } finally {
    for (const frame of localStack) {
      if (frame.source !== rootArray) active.delete(frame.source);
    }
  }
  return items;
}

function awaitNonPromiseThenable(thenable, then) {
  return new Promise((resolve, reject) => {
    queueMicrotask(() => {
      try {
        Reflect.apply(then, thenable, [(value) => resolve({ value }), reject]);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function resolveRegistrations(inputs) {
  const output = [];
  const active = new Set([inputs]);
  const budget = { remaining: MAX_REGISTRATION_ITEMS };
  const stack = [
    {
      source: inputs,
      items: flattenRegistrationArrayTree(inputs, active, 0, budget),
      index: 0,
      wrappers: [],
    },
  ];
  let activeDynamicUnwraps = 0;
  let activeDefaultUnwraps = 0;

  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (frame.index >= frame.items.length) {
      stack.pop();
      active.delete(frame.source);
      for (const entry of frame.wrappers) {
        if (entry.trackedInActive) active.delete(entry.value);
        if (entry.dynamic) activeDynamicUnwraps -= 1;
        else activeDefaultUnwraps -= 1;
      }
      continue;
    }

    let input = frame.items[frame.index++];
    const unwrapped = [];
    let preferThenable = false;
    try {
      while (input != null) {
        // After invoking a loader `fn()`, treat its return value like `await fn()`:
        // check native Promise / `.then` before invoking it as another loader so
        // callable thenables resolve via `.then`.
        const isNativePromise = types.isPromise(input);
        const isFn = !isNativePromise && !preferThenable && typeof input === "function";
        const then = !isFn && !isNativePromise ? input.then : undefined;
        const isThenable = typeof then === "function";
        const isDeferredFn =
          !isFn && !isNativePromise && !isThenable && typeof input === "function";
        const nextDefault =
          !isFn && !isDeferredFn && !isNativePromise && !isThenable ? input.default : undefined;
        preferThenable = false;
        if (!isFn && !isDeferredFn && !isNativePromise && !isThenable && !nextDefault) break;

        const callFn = isFn || isDeferredFn;
        // Function loaders may be stateful (bounded by MAX_REGISTRATION_UNWRAP_STEPS);
        // non-function wrappers/thenables still receive identity cycle checks.
        if (!callFn && active.has(input))
          throw new ShikiError("Cyclic language/theme registration input", "ERR_USAGE");

        const dynamic = callFn || isNativePromise || isThenable;
        if (dynamic) {
          if (activeDynamicUnwraps >= MAX_REGISTRATION_UNWRAP_STEPS)
            throw new ShikiError("Language/theme registration nesting limit exceeded", "ERR_USAGE");
          activeDynamicUnwraps += 1;
        } else {
          if (activeDefaultUnwraps >= MAX_DEFAULT_UNWRAP_STEPS)
            throw new ShikiError("Language/theme registration nesting limit exceeded", "ERR_USAGE");
          activeDefaultUnwraps += 1;
        }
        if (!callFn) active.add(input);
        unwrapped.push({ value: input, dynamic, trackedInActive: !callFn });

        if (callFn) {
          input = input();
          preferThenable = true;
        } else if (isNativePromise) {
          input = await input;
          preferThenable = true;
        } else if (isThenable) {
          input = (await awaitNonPromiseThenable(input, then)).value;
          preferThenable = true;
        } else {
          input = nextDefault;
        }
      }
      if (Array.isArray(input)) {
        if (active.has(input))
          throw new ShikiError("Cyclic language/theme registration input", "ERR_USAGE");
        if (stack.length >= MAX_REGISTRATION_ARRAY_DEPTH)
          throw new ShikiError("Language/theme registration nesting limit exceeded", "ERR_USAGE");
        active.add(input);
        stack.push({
          source: input,
          items: flattenRegistrationArrayTree(input, active, stack.length, budget),
          index: 0,
          wrappers: unwrapped.splice(0),
        });
      } else if (input != null) {
        if (output.length >= MAX_REGISTRATION_ITEMS)
          throw new ShikiError("Language/theme registration limit exceeded", "ERR_USAGE");
        output.push(input);
      }
    } finally {
      for (const entry of unwrapped) {
        if (entry.trackedInActive) active.delete(entry.value);
        if (entry.dynamic) activeDynamicUnwraps -= 1;
        else activeDefaultUnwraps -= 1;
      }
    }
  }
  return output;
}

function nodeToHtml(node) {
  if (node.type === "text") return escapeHtml(node.value || "");
  const children = node.children;
  if (node.type !== "element") {
    if (!children || children.length === 0) return "";
    let content = "";
    for (let index = 0; index < children.length; index++) {
      if (!(index in children)) continue;
      content += nodeToHtml(children[index]);
    }
    return content;
  }
  if (!isValidHtmlTagName(node.tagName))
    throw new ShikiError(`Invalid HTML tag name ${JSON.stringify(node.tagName)}`, "ERR_USAGE");
  let html = `<${node.tagName}`;
  const props = node.properties;
  if (props) {
    for (const key in props) {
      if (!Object.hasOwn(props, key)) continue;
      if (!isValidHtmlAttributeName(key))
        throw new ShikiError(`Invalid HTML attribute name ${JSON.stringify(key)}`, "ERR_USAGE");
      html += ` ${key}="${escapeAttribute(propertyValue(props[key]))}"`;
    }
  }
  html += ">";
  if (children) {
    for (let index = 0; index < children.length; index++) {
      if (!(index in children)) continue;
      html += nodeToHtml(children[index]);
    }
  }
  html += `</${node.tagName}>`;
  return html;
}

function propertyValue(value) {
  if (Array.isArray(value)) return value.join(" ");
  if (value && typeof value === "object") {
    let result = "";
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (result) result += ";";
      result += `${key}:${value[key]}`;
    }
    return result;
  }
  return String(value);
}

function escapeHtml(value) {
  return value.replaceAll("&", "&#x26;").replaceAll("<", "&#x3C;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&#x22;");
}
