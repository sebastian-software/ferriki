import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

function compatPackage(entry: string) {
  return new URL(`./compat/upstream/shiki/packages/${entry}`, import.meta.url).pathname
}

const ferrikiEntry = new URL('./ferriki/index.mjs', import.meta.url).pathname
const virtualLangPrefix = '\0ferriki:lang:'
const virtualThemePrefix = '\0ferriki:theme:'

function defaultExportInteropExpression(source: string) {
  return [
    `${source}.default`,
    `Object.values(${source}).find(value => value && typeof value === 'object' && 'default' in value)?.default`,
    `Object.values(${source}).find(value => Array.isArray(value))`,
    `${source}`,
  ].join(' ?? ')
}

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    {
      name: 'ferriki-compat-subpath-loader',
      resolveId(id) {
        if (id.startsWith('@shikijs/langs/'))
          return `${virtualLangPrefix}${id.slice('@shikijs/langs/'.length)}`
        if (id.startsWith('@shikijs/themes/'))
          return `${virtualThemePrefix}${id.slice('@shikijs/themes/'.length)}`
      },
      load(id) {
        if (id.startsWith(virtualLangPrefix)) {
          const lang = id.slice(virtualLangPrefix.length)
          return `
import { bundledLanguages } from ${JSON.stringify(ferrikiEntry)}
const loader = bundledLanguages[${JSON.stringify(lang)}]
if (!loader)
  throw new Error(${JSON.stringify(`Unknown Ferriki bundled language: ${lang}`)})
const loaded = await loader()
export default ${defaultExportInteropExpression('loaded')}
`
        }
        if (id.startsWith(virtualThemePrefix)) {
          const theme = id.slice(virtualThemePrefix.length)
          return `
import { bundledThemes } from ${JSON.stringify(ferrikiEntry)}
const loader = bundledThemes[${JSON.stringify(theme)}]
if (!loader)
  throw new Error(${JSON.stringify(`Unknown Ferriki bundled theme: ${theme}`)})
const loaded = await loader()
export default ${defaultExportInteropExpression('loaded')}
`
        }
      },
    },
  ],
  resolve: {
    alias: [
      {
        find: /^shiki$/,
        replacement: new URL('./compat/harness/shiki-backend-entry.ts', import.meta.url).pathname,
      },
      {
        find: /^@shikijs\/primitive$/,
        replacement: compatPackage('primitive/src/index.ts'),
      },
      {
        find: /^@shikijs\/primitive\/textmate$/,
        replacement: compatPackage('primitive/src/textmate/index.ts'),
      },
      {
        find: /^@shikijs\/core$/,
        replacement: compatPackage('core/src/index.ts'),
      },
      {
        find: /^@shikijs\/core\/textmate$/,
        replacement: compatPackage('core/src/textmate.ts'),
      },
      {
        find: /^@shikijs\/engine-javascript$/,
        replacement: compatPackage('engine-javascript/src/index.ts'),
      },
      {
        find: /^@shikijs\/engine-oniguruma$/,
        replacement: compatPackage('engine-oniguruma/src/index.ts'),
      },
      {
        find: /^@shikijs\/transformers$/,
        replacement: compatPackage('transformers/src/index.ts'),
      },
      {
        find: /^@shikijs\/twoslash$/,
        replacement: compatPackage('twoslash/src/index.ts'),
      },
      {
        find: /^@shikijs\/types$/,
        replacement: compatPackage('types/src/index.ts'),
      },
      {
        find: /^ferriki$/,
        replacement: new URL('./ferriki/index.mjs', import.meta.url).pathname,
      },
      {
        find: /^ferriki\/native$/,
        replacement: new URL('./ferriki/native.mjs', import.meta.url).pathname,
      },
    ],
  },
  test: {
    testTimeout: 30_000,
    reporters: 'dot',
    exclude: [
      '**/node_modules/**',
    ],
  },
})
