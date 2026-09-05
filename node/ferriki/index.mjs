import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { languageCatalog, themeCatalog } from './assets/shiki/catalog.mjs'
import { loadFerrikiNativeBinding, tryLoadFerrikiNativeBinding } from './native.mjs'
import {
  applyTokenTransformers,
  renderTransformedHast,
  sortTransformers,
  splitTokensAtDecorations,
} from './transformers.mjs'

const packageDir = dirname(fileURLToPath(import.meta.url))
const standardAssetRoot = join(packageDir, 'assets', 'shiki')
const NONE_THEME_BACKING = 'nord'
const grammarStateByObject = new WeakMap()
let singleton

export class ShikiError extends Error {
  constructor(message, code = 'ERR_USAGE', options) {
    super(message, options)
    this.name = 'ShikiError'
    this.code = code
  }
}

export class FerrikiError extends ShikiError {
  constructor(message, code = 'ERR_INTERNAL', options) {
    super(message, code, options)
    this.name = 'FerrikiError'
  }
}

export function ferrikiVersion() {
  return tryLoadFerrikiNativeBinding()?.ferrikiVersion()
}

export async function createHighlighter(options = {}) {
  options = validateHighlighterOptions(options)
  const {
    langs = [],
    themes = [],
    ...coreOptions
  } = options
  const highlighter = createHighlighterCoreSync(coreOptions)
  await Promise.all([
    highlighter.loadLanguage(...langs),
    highlighter.loadTheme(...themes),
  ])
  return highlighter
}

export const createHighlighterCore = createHighlighter
export const createShikiPrimitiveAsync = createHighlighter

export function createHighlighterCoreSync(options = {}) {
  options = validateHighlighterOptions(options)
  let native
  try {
    native = loadFerrikiNativeBinding().createHighlighter(JSON.stringify({
      standardAssetRoot,
    }))
  }
  catch (cause) {
    if (cause instanceof FerrikiError)
      throw cause
    const detail = cause instanceof Error ? cause.message : String(cause)
    const missingBinary = detail.includes('No native binary')
    throw new FerrikiError(
      missingBinary
        ? `${detail}\nInstall a Ferriki platform binary for this target or choose a documented supported target.`
        : `${detail}\nVerify that the package contains assets/shiki and reinstall it.`,
      missingBinary ? 'ERR_NATIVE_LOAD' : 'ERR_ASSET',
      { cause },
    )
  }
  const loadedLanguages = new Set()
  const loadedThemes = new Set()
  const languageAliases = { ...(options.langAlias || {}) }
  let disposed = false

  function assertActive() {
    if (disposed)
      throw new ShikiError('Shiki instance has been disposed', 'ERR_USAGE')
  }

  function resolveAlias(language) {
    const visited = new Set()
    while (languageAliases[language]) {
      if (visited.has(language))
        throw new ShikiError(`Circular alias \`${[...visited, language].join(' -> ')}\``, 'ERR_USAGE')
      visited.add(language)
      language = languageAliases[language]
    }
    return language
  }

  function loadLanguageSync(...inputs) {
    assertActive()
    for (const registration of resolveSyncRegistrations(inputs)) {
      validateLanguageRegistration(registration)
      const name = registrationName(registration)
      if (!name)
        continue
      const resolved = resolveAlias(name)
      const custom = isCustomLanguageRegistration(registration)
      const scope = custom
        ? callCustomRegistration(() => native.loadCustomGrammar(JSON.stringify(registration)), 'language')
        : native.loadStandardGrammar(resolved)
      if (!scope)
        throw new ShikiError(`Language \`${resolved}\` not found, you may need to load it first`, 'ERR_UNSUPPORTED')
      loadedLanguages.add(resolved)
      if (custom) {
        for (const alias of registration.aliases || []) {
          if (!isStandardLanguageKey(alias)) {
            languageAliases[alias] = resolved
            loadedLanguages.add(alias)
          }
        }
      }
    }
  }

  async function loadLanguage(...inputs) {
    loadLanguageSync(...await resolveRegistrations(inputs))
  }

  function loadThemeSync(...inputs) {
    assertActive()
    for (const registration of resolveSyncRegistrations(inputs)) {
      validateThemeRegistration(registration)
      const name = registrationName(registration)
      if (!name)
        continue
      if (name !== 'none') {
        const loaded = isCustomThemeRegistration(registration)
          ? callCustomRegistration(() => native.loadCustomTheme(JSON.stringify(registration)), 'theme')
          : native.loadStandardTheme(name)
        if (!loaded)
          throw new ShikiError(`Theme \`${name}\` not found, you may need to load it first`, 'ERR_UNSUPPORTED')
      }
      loadedThemes.add(name)
    }
  }

  async function loadTheme(...inputs) {
    loadThemeSync(...await resolveRegistrations(inputs))
  }

  function prepareOptions(options) {
    assertActive()
    const prepared = { ...validateHighlightOptions(options) }
    if (prepared.lang && typeof prepared.lang !== 'string')
      loadLanguageSync(prepared.lang)
    if (prepared.theme && typeof prepared.theme !== 'string')
      loadThemeSync(prepared.theme)
    const language = resolveAlias(registrationName(prepared.lang) || 'text')
    const requestedTheme = registrationName(prepared.theme)
      || registrationName(selectDefaultTheme(prepared))
    const theme = requestedTheme === 'none' ? NONE_THEME_BACKING : requestedTheme
    if (!theme)
      throw new ShikiError('Invalid options, either `theme` or `themes` must be provided', 'ERR_USAGE')
    if (!isSpecialLanguage(language) && !native.resolveGrammarScope(language))
      throw new ShikiError(`Language \`${language}\` not found, you may need to load it first`, 'ERR_UNSUPPORTED')
    if (!native.loadStandardTheme(theme))
      throw new ShikiError(`Theme \`${theme}\` not found, you may need to load it first`, 'ERR_UNSUPPORTED')
    if (!isSpecialLanguage(language))
      loadedLanguages.add(language)
    loadedThemes.add(theme)
    prepared.lang = language
    prepared.theme = theme
    delete prepared.themes
    // Transformer callbacks and HAST-only options stay in the JS facade.
    delete prepared.transformers
    delete prepared.decorations
    delete prepared.structure
    delete prepared.meta
    delete prepared.data
    delete prepared.grammarState
    return prepared
  }

  function highlightSingleTheme(code, options = {}) {
    assertAnsiInput(code, options)
    const result = callNativeOperation(
      'Ferriki tokenization failed',
      () => JSON.parse(native.codeToTokens(code, JSON.stringify(prepareOptions(options)))),
    )
    if (registrationName(options.theme) === 'none')
      return normalizeNoneThemeResult(result)
    return result
  }

  function highlightMultiTheme(code, options) {
    assertAnsiInput(code, options)
    const themes = resolveThemeEntries(options)
    loadThemeSync(...themes.map(theme => theme.input))
    if (
      typeof native.codeToTokensWithThemes === 'function'
      && !themes.some(theme => theme.name === 'none')
    ) {
      const prepared = prepareOptions({ ...options, theme: themes[0].name, themes: undefined })
      prepared.themeEntries = themes
      return combineNativeThemeResult(
        callNativeOperation(
          'Ferriki multi-theme tokenization failed',
          () => JSON.parse(native.codeToTokensWithThemes(code, JSON.stringify(prepared))),
        ),
        options,
      )
    }
    const results = themes.map(theme => ({
      ...theme,
      result: theme.name === 'none'
        ? normalizeNoneThemeResult(highlightNativeTheme(code, options, NONE_THEME_BACKING))
        : highlightNativeTheme(code, options, theme.name),
    }))
    return combineThemeResults(results, options)
  }

  function highlightNativeTheme(code, options, theme) {
    assertAnsiInput(code, options)
    const prepared = prepareOptions({ ...options, theme, themes: undefined })
    return callNativeOperation(
      'Ferriki tokenization failed',
      () => JSON.parse(native.codeToTokens(code, JSON.stringify(prepared))),
    )
  }

  function highlightRaw(code, options) {
    if (hasThemes(options))
      return highlightMultiTheme(code, options)
    return registrationName(options?.theme) === 'none'
      ? highlightSingleTheme(code, options)
      : callNativeOperation(
          'Ferriki tokenization failed',
          () => JSON.parse(native.codeToTokens(code, JSON.stringify(prepareOptions(options)))),
        )
  }

  function grammarLanguage(options) {
    const requested = resolveAlias(registrationName(options?.lang) || 'text')
    return languageCatalog.find(entry => entry.id === requested || entry.aliases.includes(requested))?.id || requested
  }

  function grammarThemes(options, result) {
    if (hasThemes(options))
      return resolveThemeEntries(options).map(theme => theme.name)
    return [registrationName(options?.theme) || result.themeName]
  }

  function makeGrammarState(code, options, result) {
    const language = grammarLanguage(options)
    const themes = grammarThemes(options, result)
    const lastToken = result.tokens.flat().at(-1)
    const scopes = lastToken?.scopeNames?.length
      ? [...lastToken.scopeNames.slice(0, -1)].reverse()
      : [scopeNameForLanguage(language)]
    return {
      version: 1,
      lang: language,
      theme: themes[0],
      themes,
      scopes,
      // Ferriki keeps the context in the serializable state so a state can
      // cross a worker or process boundary without leaking native pointers.
      source: code,
    }
  }

  function validateGrammarState(state, options) {
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || state.version !== 1
      || typeof state.lang !== 'string'
      || !Array.isArray(state.themes)
      || state.themes.some(theme => typeof theme !== 'string')
      || typeof state.source !== 'string') {
      throw new ShikiError('Invalid grammar state', 'ERR_USAGE')
    }
    const language = grammarLanguage(options)
    if (state.lang !== language)
      throw new ShikiError(`Grammar state language "${state.lang}" does not match highlight language "${language}"`, 'ERR_USAGE')
    const requestedThemes = grammarThemes(options, { themeName: registrationName(options?.theme) })
    for (const theme of requestedThemes) {
      if (!state.themes.includes(theme))
        throw new ShikiError(`Grammar state themes "${state.themes.join(',')}" do not contain highlight theme "${theme}"`, 'ERR_USAGE')
    }
    return state
  }

  function prepareGrammarInput(code, options) {
    const state = options?.grammarState
    if (!state)
      return { source: code, prefixLength: 0, prefixLines: 0 }
    validateGrammarState(state, options)
    const separator = state.source.endsWith('\n') ? '' : '\n'
    return {
      source: `${state.source}${separator}${code}`,
      prefixLength: state.source.length + separator.length,
      prefixLines: state.source.split('\n').length - (separator ? 0 : 1),
    }
  }

  function removeGrammarPrefix(result, prefixLength, prefixLines) {
    if (!prefixLength)
      return result
    return {
      ...result,
      tokens: result.tokens.slice(prefixLines).map(line => line.map(token => ({
        ...token,
        offset: token.offset - prefixLength,
      }))),
    }
  }

  function addTokenMetadata(result, options) {
    const language = grammarLanguage(options)
    const includeScopes = options?.includeExplanation === true || options?.includeExplanation === 'scopeName'
    const tokens = result.tokens.map(line => line.map((token) => {
      const scopeNames = token.scopeNames?.length ? token.scopeNames : [scopeNameForLanguage(language)]
      const output = { ...token }
      delete output.scopeNames
      if (includeScopes) {
        output.explanation = [{
          content: token.content,
          scopes: scopeNames.map(scopeName => ({ scopeName })),
        }]
      }
      return output
    }))
    return { ...result, tokens }
  }

  function highlightTokensPublic(code, options = {}) {
    const validated = validateHighlightOptions(options)
    const input = prepareGrammarInput(code, validated)
    const sourceOptions = input.prefixLength
      ? { ...validated, grammarState: undefined }
      : { ...validated }
    // Capture scope paths for the serializable grammar state even when the
    // caller did not request explanation metadata in the returned tokens.
    if (sourceOptions.includeExplanation === undefined)
      sourceOptions.includeExplanation = 'scopeName'
    let result
    if (sourceOptions?.transformers?.some(transformer => transformer?.preprocess || transformer?.tokens))
      result = highlightWithTransformers(input.source, sourceOptions)
    else if (hasThemes(sourceOptions))
      result = highlightMultiTheme(input.source, sourceOptions)
    else if (registrationName(sourceOptions?.theme) === 'none')
      result = highlightSingleTheme(input.source, sourceOptions)
    else
      result = highlightSingleTheme(input.source, sourceOptions)
    result = removeGrammarPrefix(result, input.prefixLength, input.prefixLines)
    const grammarState = makeGrammarState(input.source, validated, result)
    result = addTokenMetadata(result, validated)
    result.grammarState = grammarState
    grammarStateByObject.set(result.tokens, grammarState)
    return result
  }

  function getGrammarState(codeOrElement, options) {
    if (typeof codeOrElement !== 'string')
      return grammarStateByObject.get(codeOrElement)
    const validated = validateHighlightOptions(options)
    const language = grammarLanguage(validated)
    if (isSpecialLanguage(language) || language === 'ansi')
      throw new ShikiError('Plain language does not have grammar state', 'ERR_USAGE')
    return highlightTokensPublic(codeOrElement, validated).grammarState
  }

  function createTransformerContext(source, options, meta) {
    return {
      meta,
      options,
      source,
      codeToHast: (nestedCode, nestedOptions) => buildHast(nestedCode, nestedOptions),
      codeToTokens: (nestedCode, nestedOptions) => highlightWithTransformers(nestedCode, nestedOptions),
    }
  }

  function getTransformers(options) {
    return sortTransformers(options?.transformers)
  }

  function highlightWithTransformers(code, options = {}) {
    const validated = validateHighlightOptions(options)
    const transformers = getTransformers(validated)
    const meta = {}
    const context = createTransformerContext(code, validated, meta)
    let source = code
    for (const transformer of transformers)
      source = transformer?.preprocess?.call(context, source, validated) || source
    context.source = source
    const result = highlightRaw(source, validated)
    result.tokens = applyTokenTransformers(result.tokens, transformers, context)
    return result
  }

  function buildHast(code, options = {}) {
    const validated = validateHighlightOptions(options)
    const transformers = getTransformers(validated)
    const meta = {}
    const context = createTransformerContext(code, validated, meta)
    let source = code
    for (const transformer of transformers)
      source = transformer?.preprocess?.call(context, source, validated) || source
    context.source = source
    const result = highlightRaw(source, validated)
    result.tokens = applyTokenTransformers(result.tokens, transformers, context)
    if (validated.decorations?.length)
      result.tokens = splitTokensAtDecorations(result.tokens, validated.decorations, source)
    return renderTransformedHast(result, validated, transformers, context, source)
  }

  const highlighter = {
    codeToHtml(code, options) {
      assertAnsiInput(code, options)
      if (options?.grammarState) {
        const result = highlightTokensPublic(code, options)
        return applyPostprocess(hastToHtml(renderTokenResultHast(result, options)), options, code)
      }
      if (hasHastPipeline(options)) {
        const validated = validateHighlightOptions(options)
        const html = hastToHtml(buildHast(code, validated))
        return applyPostprocess(html, validated, code)
      }
      if (hasThemes(options))
        return hastToHtml(renderTokenResultHast(highlightMultiTheme(code, options), options))
      if (registrationName(options?.theme) === 'none')
        return hastToHtml(renderTokenResultHast(highlightSingleTheme(code, options), options))
      return callNativeOperation(
        'Ferriki HTML rendering failed',
        () => native.codeToHtml(code, JSON.stringify(prepareOptions(options))),
      )
    },
    codeToHast(code, options) {
      assertAnsiInput(code, options)
      if (options?.grammarState) {
        const result = highlightTokensPublic(code, options)
        const tree = renderTokenResultHast(result, options)
        grammarStateByObject.set(tree, result.grammarState)
        return tree
      }
      if (hasHastPipeline(options))
        return buildHast(code, options)
      if (hasThemes(options) || registrationName(options?.theme) === 'none') {
        const result = hasThemes(options)
          ? highlightMultiTheme(code, options)
          : highlightSingleTheme(code, options)
        const tree = renderTokenResultHast(result, options)
        if (!isSpecialLanguage(grammarLanguage(options)))
          grammarStateByObject.set(tree, getGrammarState(code, options))
        return tree
      }
      const tree = callNativeOperation(
        'Ferriki HAST rendering failed',
        () => JSON.parse(native.codeToHast(code, JSON.stringify(prepareOptions(options)))),
      )
      if (!isSpecialLanguage(grammarLanguage(options)))
        grammarStateByObject.set(tree, getGrammarState(code, options))
      return tree
    },
    codeToTokens(code, options) {
      assertAnsiInput(code, options)
      return highlightTokensPublic(code, options)
    },
    codeToTokensBase(code, options) {
      return this.codeToTokens(code, options).tokens
    },
    codeToTokensWithThemes(code, options) {
      return highlightTokensPublic(code, options).tokens
    },
    getLoadedLanguages() {
      const nativeLanguages = native.getLoadedLanguages()
      const configuredAliases = Object.entries(languageAliases)
        .filter(([, target]) => nativeLanguages.includes(resolveAlias(target)))
        .map(([alias]) => alias)
      return [...new Set([...nativeLanguages, ...configuredAliases])]
    },
    getLoadedThemes() {
      return [...loadedThemes]
    },
    loadLanguage,
    loadLanguageSync,
    loadTheme,
    loadThemeSync,
    resolveLangAlias: resolveAlias,
    getLastGrammarState: getGrammarState,
    dispose() {
      if (!disposed) {
        disposed = true
        native.dispose()
      }
    },
    [Symbol.dispose]() {
      this.dispose()
    },
  }

  loadLanguageSync(...(options.langs || []))
  loadThemeSync(...(options.themes || []))
  return highlighter
}

export function createShikiPrimitive(options = {}) {
  return createHighlighterCoreSync(options)
}

export async function getSingletonHighlighter(options = {}) {
  singleton ||= createHighlighter(options)
  const highlighter = await singleton
  if (options.langs?.length)
    await highlighter.loadLanguage(...options.langs)
  if (options.themes?.length)
    await highlighter.loadTheme(...options.themes)
  return highlighter
}

export const getSingletonHighlighterCore = getSingletonHighlighter

export function codeToHtml(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, 'codeToHtml'))
    return highlighterOrCode.codeToHtml(codeOrOptions, options)
  return getSingletonHighlighter()
    .then(highlighter => highlighter.codeToHtml(highlighterOrCode, codeOrOptions))
}

export function codeToHast(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, 'codeToHast'))
    return highlighterOrCode.codeToHast(codeOrOptions, options)
  return getSingletonHighlighter()
    .then(highlighter => highlighter.codeToHast(highlighterOrCode, codeOrOptions))
}

export function codeToTokens(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, 'codeToTokens'))
    return highlighterOrCode.codeToTokens(codeOrOptions, options)
  return getSingletonHighlighter()
    .then(highlighter => highlighter.codeToTokens(highlighterOrCode, codeOrOptions))
}

export function codeToTokensBase(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, 'codeToTokensBase'))
    return highlighterOrCode.codeToTokensBase(codeOrOptions, options)
  return codeToTokens(highlighterOrCode, codeOrOptions)
    .then(result => result.tokens)
}

export function codeToTokensWithThemes(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, 'codeToTokensWithThemes'))
    return highlighterOrCode.codeToTokensWithThemes(codeOrOptions, options)
  return codeToTokens(highlighterOrCode, codeOrOptions)
    .then(result => result.tokens)
}

export function getLastGrammarState(highlighterOrCode, codeOrOptions, options) {
  if (isHighlighter(highlighterOrCode, 'getLastGrammarState'))
    return highlighterOrCode.getLastGrammarState(codeOrOptions, options)
  if (typeof highlighterOrCode === 'string') {
    return getSingletonHighlighter()
      .then(highlighter => highlighter.getLastGrammarState(highlighterOrCode, codeOrOptions))
  }
  return undefined
}

export function createCssVariablesTheme(options = {}) {
  return {
    name: options.name || 'css-variables',
    type: options.type || 'dark',
    fg: options.variableDefaults?.foreground || 'var(--shiki-foreground)',
    bg: options.variableDefaults?.background || 'var(--shiki-background)',
    settings: [],
  }
}

export function hastToHtml(tree) {
  return (tree.children || []).map(nodeToHtml).join('')
}

// Harness-only marker used by the honest compatibility resolver sentinel.
export const __ferrikiBackend = true

export const bundledLanguages = createLanguageBundle(languageCatalog)
export const bundledThemes = createThemeBundle(themeCatalog)
export const bundledLanguagesAlias = createLanguageAliasBundle(languageCatalog)

const standardLanguageKeys = new Set(languageCatalog.flatMap(entry => [entry.id, ...entry.aliases]))
const standardThemeKeys = new Set(themeCatalog.map(entry => entry.id))

function createLanguageBundle(catalog) {
  const loaders = new Map()
  for (const entry of catalog) {
    const loader = createLanguageLoader(entry)
    loaders.set(entry.id, loader)
    for (const alias of entry.aliases)
      loaders.set(alias, loader)
  }
  return Object.freeze(Object.fromEntries([...loaders].sort(([left], [right]) => compareIds(left, right))))
}

function createLanguageAliasBundle(catalog) {
  const aliases = new Map()
  for (const entry of catalog) {
    for (const alias of entry.aliases)
      aliases.set(alias, entry.id)
  }
  return Object.freeze(Object.fromEntries([...aliases].sort(([left], [right]) => compareIds(left, right))))
}

function createLanguageLoader(entry) {
  return async () => [{
    name: entry.id,
    scopeName: entry.scopeName,
    displayName: entry.displayName || undefined,
    aliases: [...entry.aliases],
    embeddedLangs: [...entry.embeddedLangs],
    embeddedLangsLazy: [...entry.embeddedLangsLazy],
    injectTo: [...entry.injectTo],
  }]
}

function createThemeBundle(catalog) {
  const loaders = Object.fromEntries(catalog.map(entry => [
    entry.id,
    async () => ({
      name: entry.id,
      type: entry.themeType || undefined,
    }),
  ]))
  return Object.freeze(loaders)
}

function validateHighlightOptions(options) {
  if (options == null)
    return {}
  if (typeof options !== 'object' || Array.isArray(options))
    throw new ShikiError('Highlight options must be an object', 'ERR_USAGE')

  const registrationFields = ['lang', 'theme']
  for (const field of registrationFields) {
    const value = options[field]
    if (value !== undefined && (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value))))
      throw new ShikiError(`Highlight option \`${field}\` must be a name or registration object`, 'ERR_USAGE')
  }
  if (options.themes !== undefined && (!options.themes || typeof options.themes !== 'object' || Array.isArray(options.themes)))
    throw new ShikiError('Highlight option `themes` must be an object', 'ERR_USAGE')
  if (options.defaultColor !== undefined && options.defaultColor !== false && typeof options.defaultColor !== 'string')
    throw new ShikiError('Highlight option `defaultColor` must be a string or false', 'ERR_USAGE')
  if (options.cssVariablePrefix !== undefined && typeof options.cssVariablePrefix !== 'string')
    throw new ShikiError('Highlight option `cssVariablePrefix` must be a string', 'ERR_USAGE')
  if (options.includeExplanation !== undefined
    && typeof options.includeExplanation !== 'boolean'
    && !['scopeName', 'tokenType'].includes(options.includeExplanation)) {
    throw new ShikiError('Highlight option `includeExplanation` has an unsupported value', 'ERR_USAGE')
  }
  if (options.grammarState !== undefined
    && (!options.grammarState || typeof options.grammarState !== 'object' || Array.isArray(options.grammarState))) {
    throw new ShikiError('Highlight option `grammarState` must be an object', 'ERR_USAGE')
  }
  for (const field of ['mergeWhitespaces', 'mergeSameStyleTokens']) {
    if (options[field] !== undefined && typeof options[field] !== 'boolean')
      throw new ShikiError(`Highlight option \`${field}\` must be boolean`, 'ERR_USAGE')
  }
  if (options.rootStyle !== undefined && options.rootStyle !== false && typeof options.rootStyle !== 'string')
    throw new ShikiError('Highlight option `rootStyle` must be a string or false', 'ERR_USAGE')
  if (options.tabindex !== undefined
    && options.tabindex !== null
    && options.tabindex !== false
    && typeof options.tabindex !== 'string'
    && (typeof options.tabindex !== 'number' || !Number.isFinite(options.tabindex))) {
    throw new ShikiError('Highlight option `tabindex` must be a string, number, false, or null', 'ERR_USAGE')
  }
  for (const field of ['tokenizeMaxLineLength', 'tokenizeTimeLimit']) {
    if (options[field] !== undefined
      && (typeof options[field] !== 'number' || !Number.isFinite(options[field]) || options[field] < 0)) {
      throw new ShikiError(`Highlight option \`${field}\` must be a non-negative number`, 'ERR_USAGE')
    }
  }
  if (options.transformers !== undefined && !Array.isArray(options.transformers))
    throw new ShikiError('Highlight option transformers must be an array', 'ERR_USAGE')
  if (options.decorations !== undefined && !Array.isArray(options.decorations))
    throw new ShikiError('Highlight option decorations must be an array', 'ERR_USAGE')
  if (options.structure !== undefined && options.structure !== 'classic' && options.structure !== 'inline')
    throw new ShikiError('Highlight option structure must be classic or inline', 'ERR_USAGE')
  for (const field of ['engine', 'loadWasm', 'wasmBinary']) {
    if (options[field] !== undefined)
      throw new ShikiError(`Highlight option \`${field}\` is not supported by Ferriki`, 'ERR_UNSUPPORTED')
  }
  return options
}

function validateHighlighterOptions(options) {
  if (options == null)
    return {}
  if (typeof options !== 'object' || Array.isArray(options))
    throw new ShikiError('Highlighter options must be an object', 'ERR_USAGE')
  for (const field of ['langs', 'themes']) {
    if (options[field] !== undefined && !Array.isArray(options[field]))
      throw new ShikiError(`Highlighter option \`${field}\` must be an array`, 'ERR_USAGE')
  }
  if (options.langAlias !== undefined
    && (!options.langAlias || typeof options.langAlias !== 'object' || Array.isArray(options.langAlias))) {
    throw new ShikiError('Highlighter option `langAlias` must be an object', 'ERR_USAGE')
  }
  if (options.langAlias) {
    for (const [alias, target] of Object.entries(options.langAlias)) {
      if (!alias || typeof target !== 'string' || !target)
        throw new ShikiError('Highlighter option `langAlias` must map non-empty names to strings', 'ERR_USAGE')
    }
  }
  return options
}

function validateLanguageRegistration(registration) {
  if (typeof registration === 'string')
    return
  if (!registration || typeof registration !== 'object' || Array.isArray(registration))
    throw new ShikiError('Language registrations must be names or registration objects', 'ERR_USAGE')
  const allowed = new Set([
    'name',
    'scopeName',
    'aliases',
    'patterns',
    'repository',
    'injections',
    'injectionSelector',
    'fileTypes',
    'firstLineMatch',
    '$vscodeTextmateLocation',
    'embeddedLangs',
    'embeddedLanguages',
    'embeddedLangsLazy',
    'injectTo',
    'balancedBracketSelectors',
    'unbalancedBracketSelectors',
    'displayName',
    'foldingStopMarker',
    'foldingStartMarker',
  ])
  for (const key of Object.keys(registration)) {
    if (!allowed.has(key))
      throw new ShikiError(`Unsupported language registration field \`${key}\``, 'ERR_USAGE')
  }
  if (typeof registration.name !== 'string' || !registration.name)
    throw new ShikiError('Language registration requires a non-empty `name`', 'ERR_USAGE')
  if (isCustomLanguageRegistration(registration)) {
    if (typeof registration.scopeName !== 'string' || !registration.scopeName)
      throw new ShikiError(`Language registration \`${registration.name}\` requires a non-empty \`scopeName\``, 'ERR_USAGE')
    if (!hasLanguagePayload(registration))
      throw new ShikiError(`Language registration \`${registration.name}\` has no supported grammar payload`, 'ERR_USAGE')
  }
  for (const key of ['aliases', 'embeddedLangs', 'embeddedLanguages', 'embeddedLangsLazy', 'injectTo']) {
    if (registration[key] !== undefined && (!Array.isArray(registration[key]) || registration[key].some(value => typeof value !== 'string')))
      throw new ShikiError(`Language registration \`${key}\` must be an array of strings`, 'ERR_USAGE')
  }
  if (registration.patterns !== undefined && !Array.isArray(registration.patterns))
    throw new ShikiError('Language registration `patterns` must be an array', 'ERR_USAGE')
  if (registration.repository !== undefined && (!registration.repository || typeof registration.repository !== 'object' || Array.isArray(registration.repository)))
    throw new ShikiError('Language registration `repository` must be an object', 'ERR_USAGE')
}

function validateThemeRegistration(registration) {
  if (typeof registration === 'string')
    return
  if (!registration || typeof registration !== 'object' || Array.isArray(registration))
    throw new ShikiError('Theme registrations must be names or registration objects', 'ERR_USAGE')
  const allowed = new Set([
    'name',
    'type',
    'fg',
    'bg',
    'settings',
    'tokenColors',
    'colors',
    'include',
    'displayName',
    '$schema',
    'semanticHighlighting',
    'semanticTokenColors',
  ])
  for (const key of Object.keys(registration)) {
    if (!allowed.has(key))
      throw new ShikiError(`Unsupported theme registration field \`${key}\``, 'ERR_USAGE')
  }
  if (typeof registration.name !== 'string' || !registration.name)
    throw new ShikiError('Theme registration requires a non-empty `name`', 'ERR_USAGE')
  if (registration.include !== undefined && typeof registration.include !== 'string')
    throw new ShikiError('Theme registration `include` must be a theme name', 'ERR_USAGE')
  if (isCustomThemeRegistration(registration) && registration.settings !== undefined && !Array.isArray(registration.settings) && !Array.isArray(registration.tokenColors))
    throw new ShikiError('Theme registration settings must be an array', 'ERR_USAGE')
  if (!standardThemeKeys.has(registration.name) && !hasThemePayload(registration))
    throw new ShikiError(`Theme registration \`${registration.name}\` has no supported theme payload`, 'ERR_USAGE')
}

function hasLanguagePayload(registration) {
  return ['patterns', 'repository', 'injections', 'injectionSelector', 'fileTypes', 'firstLineMatch'].some(key => Object.hasOwn(registration, key))
}

function isCustomLanguageRegistration(registration) {
  return typeof registration === 'object'
    && registration !== null
    && !standardLanguageKeys.has(registration.name)
}

function hasThemePayload(registration) {
  return ['settings', 'tokenColors', 'colors', 'fg', 'bg', 'include'].some(key => Object.hasOwn(registration, key))
}

function isCustomThemeRegistration(registration) {
  return typeof registration === 'object'
    && registration !== null
    && !standardThemeKeys.has(registration.name)
}

function isStandardLanguageKey(name) {
  return standardLanguageKeys.has(name)
}

function callNativeOperation(message, operation) {
  try {
    return operation()
  }
  catch (cause) {
    if (cause instanceof ShikiError)
      throw cause
    const detail = cause instanceof Error ? cause.message : String(cause)
    const code = /time|line length|resource|limit/i.test(detail)
      ? 'ERR_RESOURCE_LIMIT'
      : /asset|grammar|theme|catalog/i.test(detail)
        ? 'ERR_ASSET'
        : 'ERR_INTERNAL'
    throw new FerrikiError(`${message}: ${detail}`, code, { cause })
  }
}

function callCustomRegistration(loader, kind) {
  try {
    return loader()
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ShikiError(`Invalid custom ${kind} registration: ${detail}`, 'ERR_ASSET', { cause: error })
  }
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasThemes(options) {
  return options != null && Object.hasOwn(options, 'themes')
}

function resolveThemeEntries(options) {
  const entries = Object.entries(options?.themes || {})
    .filter(([, theme]) => theme != null && theme !== false)
    .map(([color, theme]) => ({ color, input: theme, name: registrationName(theme) }))
  if (entries.length === 0)
    throw new ShikiError('`themes` option must not be empty', 'ERR_USAGE')
  if (entries.some(entry => !entry.name))
    throw new ShikiError('Theme registrations must provide a name', 'ERR_USAGE')

  const defaultColor = options.defaultColor === undefined ? 'light' : options.defaultColor
  if (defaultColor && defaultColor !== 'light-dark()') {
    const defaultEntry = entries.find(entry => entry.color === defaultColor)
    if (!defaultEntry)
      throw new ShikiError(`\`themes\` option must contain the defaultColor key \`${defaultColor}\``, 'ERR_USAGE')
    return [defaultEntry, ...entries.filter(entry => entry !== defaultEntry)]
  }
  if (defaultColor === 'light-dark()' && (
    !entries.some(entry => entry.color === 'light')
    || !entries.some(entry => entry.color === 'dark')
  )) {
    throw new ShikiError('When using `defaultColor: "light-dark()"`, you must provide both `light` and `dark` themes', 'ERR_USAGE')
  }
  return entries
}

function normalizeNoneThemeResult(result) {
  return {
    ...result,
    fg: 'inherit',
    bg: 'inherit',
    themeName: 'none',
    tokens: result.tokens.map(line => line.map(token => ({
      content: token.content,
      offset: token.offset,
      ...(token.type === undefined ? {} : { type: token.type }),
      ...(token.scopeNames ? { scopeNames: token.scopeNames } : {}),
    }))),
  }
}

function combineThemeResults(results, options) {
  const defaultColor = options.defaultColor === undefined ? 'light' : options.defaultColor
  const cssVariablePrefix = options.cssVariablePrefix || '--shiki-'
  const tokens = alignThemeTokens(results).map(line => line.map(token => ({
    ...token,
    htmlStyle: tokenHtmlStyle(token.variants, results, defaultColor, cssVariablePrefix),
  })))
  const foreground = themePropertyStyle(results, 'foreground', defaultColor, cssVariablePrefix)
  const background = themePropertyStyle(results, 'background', defaultColor, cssVariablePrefix)
  return {
    tokens,
    fg: foreground,
    bg: background,
    themeName: `shiki-themes ${results.map(result => result.name).join(' ')}`,
    ...(defaultColor ? {} : { rootStyle: `${foreground};${background}` }),
  }
}

function combineNativeThemeResult(result, options) {
  const results = result.themes.map(theme => ({
    color: theme.color,
    name: theme.name,
    result: {
      fg: theme.foreground,
      bg: theme.background,
    },
  }))
  const defaultColor = options.defaultColor === undefined ? 'light' : options.defaultColor
  const cssVariablePrefix = options.cssVariablePrefix || '--shiki-'
  const tokens = result.tokens.map(line => line.map((token) => {
    const variants = Object.fromEntries(Object.entries(token.variants).map(([color, style]) => [
      color,
      tokenStyleFromNative(style),
    ]))
    return {
      content: token.content,
      offset: token.offset,
      ...(token.type === undefined ? {} : { type: token.type }),
      ...(token.scopeNames ? { scopeNames: token.scopeNames } : {}),
      variants,
      htmlStyle: tokenHtmlStyle(variants, results, defaultColor, cssVariablePrefix),
    }
  }))
  const foreground = themePropertyStyle(results, 'foreground', defaultColor, cssVariablePrefix)
  const background = themePropertyStyle(results, 'background', defaultColor, cssVariablePrefix)
  return {
    tokens,
    fg: foreground,
    bg: background,
    themeName: `shiki-themes ${results.map(result => result.name).join(' ')}`,
    ...(defaultColor ? {} : { rootStyle: `${foreground};${background}` }),
  }
}

function tokenStyleFromNative(style) {
  const output = {}
  if (style.color)
    output.color = style.color
  const fontStyle = style.fontStyle || 0
  if (fontStyle & 1)
    output['font-style'] = 'italic'
  if (fontStyle & 2)
    output['font-weight'] = 'bold'
  const decorations = []
  if (fontStyle & 4)
    decorations.push('underline')
  if (fontStyle & 8)
    decorations.push('line-through')
  if (decorations.length)
    output['text-decoration'] = decorations.join(' ')
  return output
}

function alignThemeTokens(results) {
  const lineCount = Math.max(...results.map(result => result.result.tokens.length))
  return Array.from({ length: lineCount }, (_, lineIndex) => {
    const lines = results.map(result => result.result.tokens[lineIndex] || [])
    const boundaries = new Set()
    for (const line of lines) {
      for (const token of line) {
        boundaries.add(token.offset)
        boundaries.add(token.offset + token.content.length)
      }
    }
    const sorted = [...boundaries].sort((left, right) => left - right)
    const output = []
    for (let index = 0; index < sorted.length - 1; index++) {
      const start = sorted[index]
      const end = sorted[index + 1]
      if (start === end)
        continue
      const variants = {}
      let baseToken
      for (const result of results) {
        const token = tokenAt(lines[results.indexOf(result)], start)
        if (token && !baseToken)
          baseToken = token
        variants[result.color] = tokenStyle(token)
      }
      if (!baseToken)
        continue
      output.push({
        content: baseToken.content.slice(start - baseToken.offset, end - baseToken.offset),
        offset: start,
        ...(baseToken.type === undefined ? {} : { type: baseToken.type }),
        ...(baseToken.scopeNames ? { scopeNames: baseToken.scopeNames } : {}),
        variants,
      })
    }
    return output
  })
}

function tokenAt(line, offset) {
  return line.find(token => offset >= token.offset && offset < token.offset + token.content.length)
}

function tokenStyle(token) {
  if (!token)
    return {}
  const style = {}
  if (token.color)
    style.color = token.color
  const fontStyle = token.fontStyle || 0
  if (fontStyle & 1)
    style['font-style'] = 'italic'
  if (fontStyle & 2)
    style['font-weight'] = 'bold'
  const decorations = []
  if (fontStyle & 4)
    decorations.push('underline')
  if (fontStyle & 8)
    decorations.push('line-through')
  if (decorations.length)
    style['text-decoration'] = decorations.join(' ')
  return style
}

function tokenHtmlStyle(variants, results, defaultColor, cssVariablePrefix) {
  const styles = results.map(result => variants[result.color] || {})
  const keys = new Set(styles.flatMap(style => Object.keys(style)))
  const declarations = []
  for (const key of keys) {
    for (let index = 0; index < results.length; index++) {
      const value = styles[index][key] || 'inherit'
      const color = results[index].color
      if (index === 0 && defaultColor) {
        if (defaultColor === 'light-dark()' && (key === 'color' || key === 'background-color')) {
          const lightIndex = results.findIndex(result => result.color === 'light')
          const darkIndex = results.findIndex(result => result.color === 'dark')
          if (lightIndex !== -1 && darkIndex !== -1) {
            const light = styles[lightIndex][key] || 'inherit'
            const dark = styles[darkIndex][key] || 'inherit'
            declarations.push(`${key}:light-dark(${light}, ${dark})`)
          }
        }
        else {
          declarations.push(`${key}:${value}`)
        }
      }
      if (index > 0 || !defaultColor || defaultColor === 'light-dark()') {
        const suffix = key === 'color' ? '' : key === 'background-color' ? '-bg' : `-${key}`
        declarations.push(`${cssVariablePrefix}${color}${suffix}:${value}`)
      }
    }
  }
  return declarations.join(';')
}

function themePropertyStyle(results, property, defaultColor, cssVariablePrefix) {
  const declarations = []
  for (let index = 0; index < results.length; index++) {
    const value = results[index].result[property === 'foreground' ? 'fg' : 'bg'] || 'inherit'
    const color = results[index].color
    if (index === 0 && defaultColor) {
      if (defaultColor === 'light-dark()') {
        const light = results.find(result => result.color === 'light')?.result[property === 'foreground' ? 'fg' : 'bg'] || 'inherit'
        const dark = results.find(result => result.color === 'dark')?.result[property === 'foreground' ? 'fg' : 'bg'] || 'inherit'
        declarations.push(`light-dark(${light}, ${dark})`)
      }
      else {
        declarations.push(value)
      }
    }
    if (index > 0 || !defaultColor || defaultColor === 'light-dark()')
      declarations.push(`${cssVariablePrefix}${color}${property === 'background' ? '-bg' : ''}:${value}`)
  }
  return declarations.join(';')
}

function renderTokenResultHast(result, options = {}) {
  const properties = {
    class: result.themeName,
  }
  if (options.rootStyle !== false) {
    properties.style = options.rootStyle || result.rootStyle || `background-color:${result.bg};color:${result.fg}`
  }
  if (options.tabindex !== false && options.tabindex !== null)
    properties.tabindex = String(options.tabindex ?? 0)
  const children = []
  for (let lineIndex = 0; lineIndex < result.tokens.length; lineIndex++) {
    if (lineIndex > 0)
      children.push({ type: 'text', value: '\n' })
    children.push({
      type: 'element',
      tagName: 'span',
      properties: { class: 'line' },
      children: result.tokens[lineIndex].map(token => ({
        type: 'element',
        tagName: 'span',
        properties: token.htmlStyle ? { style: token.htmlStyle } : {},
        children: [{ type: 'text', value: token.content }],
      })),
    })
  }
  return {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'pre',
      properties,
      children: [{
        type: 'element',
        tagName: 'code',
        properties: {},
        children,
      }],
    }],
  }
}

function hasHastPipeline(options) {
  return Boolean(
    options?.decorations
    || options?.structure
    || options?.meta
    || options?.data
    || options?.transformers?.length,
  )
}

function applyPostprocess(html, options, source) {
  let output = html
  const context = { meta: {}, options, source }
  for (const transformer of sortTransformers(options?.transformers))
    output = transformer?.postprocess?.call(context, output, options) || output
  return output
}

function selectDefaultTheme(options) {
  if (!options.themes)
    return undefined
  if (options.defaultColor && options.themes[options.defaultColor])
    return options.themes[options.defaultColor]
  return options.themes.light || options.themes.dark || Object.values(options.themes)[0]
}

function isHighlighter(value, method) {
  return value != null && typeof value[method] === 'function'
}

function isSpecialLanguage(language) {
  return ['text', 'txt', 'plain', 'plaintext', 'ansi'].includes(language)
}

function scopeNameForLanguage(language) {
  return languageCatalog.find(entry => entry.id === language || entry.aliases.includes(language))?.scopeName
    || `source.${language}`
}

function assertAnsiInput(code, options) {
  if (!globalThis.__FERRIKI_COMPAT_LEGACY_ANSI
    && registrationName(options?.lang) === 'ansi'
    && code.includes(String.fromCharCode(27))) {
    throw new ShikiError('ANSI control sequences are not supported by Ferriki; strip or parse them before highlighting', 'ERR_UNSUPPORTED')
  }
}

function registrationName(registration) {
  if (typeof registration === 'string')
    return registration
  return registration?.name || registration?.id
}

function resolveSyncRegistrations(inputs) {
  return inputs.flat(Infinity).flatMap((input) => {
    if (typeof input === 'function' || input?.then)
      throw new ShikiError('Async language/theme input requires the async loader', 'ERR_USAGE')
    if (input?.default)
      return resolveSyncRegistrations([input.default])
    return input == null ? [] : [input]
  })
}

async function resolveRegistrations(inputs) {
  const output = []
  for (let input of inputs.flat(Infinity)) {
    if (typeof input === 'function')
      input = input()
    input = await input
    if (input?.default)
      input = input.default
    if (Array.isArray(input))
      output.push(...await resolveRegistrations(input))
    else if (input != null)
      output.push(input)
  }
  return output
}

function nodeToHtml(node) {
  if (node.type === 'text')
    return escapeHtml(node.value || '')
  if (node.type !== 'element')
    return (node.children || []).map(nodeToHtml).join('')
  const properties = Object.entries(node.properties || {})
    .map(([key, value]) => ` ${key}="${escapeAttribute(propertyValue(value))}"`)
    .join('')
  return `<${node.tagName}${properties}>${(node.children || []).map(nodeToHtml).join('')}</${node.tagName}>`
}

function propertyValue(value) {
  if (Array.isArray(value))
    return value.join(' ')
  if (value && typeof value === 'object')
    return Object.entries(value).map(([key, entry]) => `${key}:${entry}`).join(';')
  return String(value)
}

function escapeHtml(value) {
  return value.replaceAll('&', '&#x26;').replaceAll('<', '&#x3C;')
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&#x22;')
}
