import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { languageCatalog, themeCatalog } from './assets/shiki/catalog.mjs'
import { loadFerrikiNativeBinding, tryLoadFerrikiNativeBinding } from './native.mjs'

const packageDir = dirname(fileURLToPath(import.meta.url))
const standardAssetRoot = join(packageDir, 'assets', 'shiki')
let singleton

export class ShikiError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ShikiError'
  }
}

export function ferrikiVersion() {
  return tryLoadFerrikiNativeBinding()?.ferrikiVersion()
}

export async function createHighlighter(options = {}) {
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
  const native = loadFerrikiNativeBinding().createHighlighter(JSON.stringify({
    standardAssetRoot,
  }))
  const loadedLanguages = new Set()
  const loadedThemes = new Set()
  const languageAliases = { ...(options.langAlias || {}) }
  let disposed = false

  function assertActive() {
    if (disposed)
      throw new ShikiError('Shiki instance has been disposed')
  }

  function resolveAlias(language) {
    const visited = new Set()
    while (languageAliases[language]) {
      if (visited.has(language))
        throw new ShikiError(`Circular alias \`${[...visited, language].join(' -> ')}\``)
      visited.add(language)
      language = languageAliases[language]
    }
    return language
  }

  function loadLanguageSync(...inputs) {
    assertActive()
    for (const registration of resolveSyncRegistrations(inputs)) {
      const name = registrationName(registration)
      if (!name)
        continue
      const resolved = resolveAlias(name)
      const scope = native.loadStandardGrammar(resolved)
      if (!scope)
        throw new ShikiError(`Language \`${resolved}\` not found, you may need to load it first`)
      loadedLanguages.add(resolved)
      for (const alias of registration?.aliases || []) {
        languageAliases[alias] = resolved
        loadedLanguages.add(alias)
      }
    }
  }

  async function loadLanguage(...inputs) {
    loadLanguageSync(...await resolveRegistrations(inputs))
  }

  function loadThemeSync(...inputs) {
    assertActive()
    for (const registration of resolveSyncRegistrations(inputs)) {
      const name = registrationName(registration)
      if (!name)
        continue
      if (!native.loadStandardTheme(name))
        throw new ShikiError(`Theme \`${name}\` not found, you may need to load it first`)
      loadedThemes.add(name)
    }
  }

  async function loadTheme(...inputs) {
    loadThemeSync(...await resolveRegistrations(inputs))
  }

  function prepareOptions(options) {
    assertActive()
    const prepared = { ...options }
    const language = resolveAlias(registrationName(prepared.lang) || 'text')
    const theme = registrationName(prepared.theme)
      || registrationName(selectDefaultTheme(prepared))
    if (!theme)
      throw new ShikiError('Invalid options, either `theme` or `themes` must be provided')
    if (!isSpecialLanguage(language) && !native.loadStandardGrammar(language))
      throw new ShikiError(`Language \`${language}\` not found, you may need to load it first`)
    if (!native.loadStandardTheme(theme))
      throw new ShikiError(`Theme \`${theme}\` not found, you may need to load it first`)
    if (!isSpecialLanguage(language))
      loadedLanguages.add(language)
    loadedThemes.add(theme)
    prepared.lang = language
    prepared.theme = theme
    delete prepared.themes
    return prepared
  }

  const highlighter = {
    codeToHtml(code, options) {
      return native.codeToHtml(code, JSON.stringify(prepareOptions(options)))
    },
    codeToHast(code, options) {
      return JSON.parse(native.codeToHast(code, JSON.stringify(prepareOptions(options))))
    },
    codeToTokens(code, options) {
      return JSON.parse(native.codeToTokens(code, JSON.stringify(prepareOptions(options))))
    },
    codeToTokensBase(code, options) {
      return this.codeToTokens(code, options).tokens
    },
    codeToTokensWithThemes(code, options) {
      return this.codeToTokens(code, options).tokens
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

export function getLastGrammarState() {
  return undefined
}

export function createJavaScriptRegexEngine() {
  return {}
}

export function createOnigurumaEngine() {
  return {}
}

export async function loadWasm() {}

export const wasmBinary = new Uint8Array()

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

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
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

function registrationName(registration) {
  if (typeof registration === 'string')
    return registration
  return registration?.name || registration?.id
}

function resolveSyncRegistrations(inputs) {
  return inputs.flat(Infinity).flatMap((input) => {
    if (typeof input === 'function' || input?.then)
      throw new ShikiError('Async language/theme input requires the async loader')
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
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
    .join('')
  return `<${node.tagName}${properties}>${(node.children || []).map(nodeToHtml).join('')}</${node.tagName}>`
}

function escapeHtml(value) {
  return value.replaceAll('&', '&#x26;').replaceAll('<', '&#x3C;')
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&#x22;')
}
