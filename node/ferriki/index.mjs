import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { languageCatalog, themeCatalog } from './assets/shiki/catalog.mjs'
import { loadFerrikiNativeBinding, tryLoadFerrikiNativeBinding } from './native.mjs'

const packageDir = dirname(fileURLToPath(import.meta.url))
const standardAssetRoot = join(packageDir, 'assets', 'shiki')
const NONE_THEME_BACKING = 'nord'
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
        throw new ShikiError(`Language \`${resolved}\` not found, you may need to load it first`)
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
          throw new ShikiError(`Theme \`${name}\` not found, you may need to load it first`)
      }
      loadedThemes.add(name)
    }
  }

  async function loadTheme(...inputs) {
    loadThemeSync(...await resolveRegistrations(inputs))
  }

  function prepareOptions(options) {
    assertActive()
    const prepared = { ...options }
    if (prepared.lang && typeof prepared.lang !== 'string')
      loadLanguageSync(prepared.lang)
    if (prepared.theme && typeof prepared.theme !== 'string')
      loadThemeSync(prepared.theme)
    const language = resolveAlias(registrationName(prepared.lang) || 'text')
    const requestedTheme = registrationName(prepared.theme)
      || registrationName(selectDefaultTheme(prepared))
    const theme = requestedTheme === 'none' ? NONE_THEME_BACKING : requestedTheme
    if (!theme)
      throw new ShikiError('Invalid options, either `theme` or `themes` must be provided')
    if (!isSpecialLanguage(language) && !native.resolveGrammarScope(language))
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

  function highlightSingleTheme(code, options = {}) {
    const result = JSON.parse(native.codeToTokens(code, JSON.stringify(prepareOptions(options))))
    if (registrationName(options.theme) === 'none')
      return normalizeNoneThemeResult(result)
    return result
  }

  function highlightMultiTheme(code, options) {
    const themes = resolveThemeEntries(options)
    loadThemeSync(...themes.map(theme => theme.input))
    if (
      typeof native.codeToTokensWithThemes === 'function'
      && !themes.some(theme => theme.name === 'none')
    ) {
      const prepared = prepareOptions({ ...options, theme: themes[0].name, themes: undefined })
      prepared.themeEntries = themes
      return combineNativeThemeResult(
        JSON.parse(native.codeToTokensWithThemes(code, JSON.stringify(prepared))),
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
    const prepared = prepareOptions({ ...options, theme, themes: undefined })
    return JSON.parse(native.codeToTokens(code, JSON.stringify(prepared)))
  }

  const highlighter = {
    codeToHtml(code, options) {
      if (hasThemes(options))
        return hastToHtml(renderTokenResultHast(highlightMultiTheme(code, options), options))
      if (registrationName(options?.theme) === 'none')
        return hastToHtml(renderTokenResultHast(highlightSingleTheme(code, options), options))
      return native.codeToHtml(code, JSON.stringify(prepareOptions(options)))
    },
    codeToHast(code, options) {
      if (hasThemes(options))
        return renderTokenResultHast(highlightMultiTheme(code, options), options)
      if (registrationName(options?.theme) === 'none')
        return renderTokenResultHast(highlightSingleTheme(code, options), options)
      return JSON.parse(native.codeToHast(code, JSON.stringify(prepareOptions(options))))
    },
    codeToTokens(code, options) {
      if (hasThemes(options))
        return highlightMultiTheme(code, options)
      if (registrationName(options?.theme) === 'none')
        return highlightSingleTheme(code, options)
      return JSON.parse(native.codeToTokens(code, JSON.stringify(prepareOptions(options))))
    },
    codeToTokensBase(code, options) {
      return this.codeToTokens(code, options).tokens
    },
    codeToTokensWithThemes(code, options) {
      return highlightMultiTheme(code, options).tokens
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

function validateLanguageRegistration(registration) {
  if (typeof registration === 'string')
    return
  if (!registration || typeof registration !== 'object' || Array.isArray(registration))
    throw new ShikiError('Language registrations must be names or registration objects')
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
      throw new ShikiError(`Unsupported language registration field \`${key}\``)
  }
  if (typeof registration.name !== 'string' || !registration.name)
    throw new ShikiError('Language registration requires a non-empty `name`')
  if (isCustomLanguageRegistration(registration)) {
    if (typeof registration.scopeName !== 'string' || !registration.scopeName)
      throw new ShikiError(`Language registration \`${registration.name}\` requires a non-empty \`scopeName\``)
    if (!hasLanguagePayload(registration))
      throw new ShikiError(`Language registration \`${registration.name}\` has no supported grammar payload`)
  }
  for (const key of ['aliases', 'embeddedLangs', 'embeddedLanguages', 'embeddedLangsLazy', 'injectTo']) {
    if (registration[key] !== undefined && (!Array.isArray(registration[key]) || registration[key].some(value => typeof value !== 'string')))
      throw new ShikiError(`Language registration \`${key}\` must be an array of strings`)
  }
  if (registration.patterns !== undefined && !Array.isArray(registration.patterns))
    throw new ShikiError('Language registration `patterns` must be an array')
  if (registration.repository !== undefined && (!registration.repository || typeof registration.repository !== 'object' || Array.isArray(registration.repository)))
    throw new ShikiError('Language registration `repository` must be an object')
}

function validateThemeRegistration(registration) {
  if (typeof registration === 'string')
    return
  if (!registration || typeof registration !== 'object' || Array.isArray(registration))
    throw new ShikiError('Theme registrations must be names or registration objects')
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
      throw new ShikiError(`Unsupported theme registration field \`${key}\``)
  }
  if (typeof registration.name !== 'string' || !registration.name)
    throw new ShikiError('Theme registration requires a non-empty `name`')
  if (registration.include !== undefined && typeof registration.include !== 'string')
    throw new ShikiError('Theme registration `include` must be a theme name')
  if (isCustomThemeRegistration(registration) && registration.settings !== undefined && !Array.isArray(registration.settings) && !Array.isArray(registration.tokenColors))
    throw new ShikiError('Theme registration settings must be an array')
  if (!standardThemeKeys.has(registration.name) && !hasThemePayload(registration))
    throw new ShikiError(`Theme registration \`${registration.name}\` has no supported theme payload`)
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

function callCustomRegistration(loader, kind) {
  try {
    return loader()
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ShikiError(`Invalid custom ${kind} registration: ${detail}`)
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
    throw new ShikiError('`themes` option must not be empty')
  if (entries.some(entry => !entry.name))
    throw new ShikiError('Theme registrations must provide a name')

  const defaultColor = options.defaultColor === undefined ? 'light' : options.defaultColor
  if (defaultColor && defaultColor !== 'light-dark()') {
    const defaultEntry = entries.find(entry => entry.color === defaultColor)
    if (!defaultEntry)
      throw new ShikiError(`\`themes\` option must contain the defaultColor key \`${defaultColor}\``)
    return [defaultEntry, ...entries.filter(entry => entry !== defaultEntry)]
  }
  if (defaultColor === 'light-dark()' && (
    !entries.some(entry => entry.color === 'light')
    || !entries.some(entry => entry.color === 'dark')
  )) {
    throw new ShikiError('When using `defaultColor: "light-dark()"`, you must provide both `light` and `dark` themes')
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
