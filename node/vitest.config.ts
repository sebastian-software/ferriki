import { readFileSync } from 'node:fs'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

function compatPackage(entry: string) {
  return new URL(`./compat/upstream/shiki/packages/${entry}`, import.meta.url).pathname
}

function compatChunkAliases(packageName: string, packageJsonPath: string) {
  const pkg = JSON.parse(readFileSync(new URL(packageJsonPath, import.meta.url), 'utf8'))
  return Object.entries<string>(pkg.exports)
    .filter(([key, value]) => key !== '.' && key !== './package.json' && typeof value === 'string' && value.startsWith('./dist/'))
    .map(([key, value]) => ({
      find: new RegExp(`^${packageName}${key.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      replacement: new URL(`./ferriki/dist/chunks/${value.slice('./dist/'.length)}`, import.meta.url).pathname,
    }))
}

export default defineConfig({
  plugins: [
    tsconfigPaths(),
  ],
  resolve: {
    alias: [
      {
        find: /^shiki$/,
        replacement: new URL('./compat/harness/shiki-backend-entry.ts', import.meta.url).pathname,
      },
      {
        find: /^@shikijs\/primitive$/,
        replacement: new URL('./compat/harness/shiki-primitive-entry.ts', import.meta.url).pathname,
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
        find: /^@shikijs\/markdown-it$/,
        replacement: compatPackage('markdown-it/src/index.ts'),
      },
      {
        find: /^@shikijs\/rehype$/,
        replacement: compatPackage('rehype/src/index.ts'),
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
        find: /^@shikijs\/vitepress-twoslash$/,
        replacement: compatPackage('vitepress-twoslash/src/index.ts'),
      },
      {
        find: /^@shikijs\/langs\/js$/,
        replacement: new URL('./ferriki/dist/chunks/javascript.mjs', import.meta.url).pathname,
      },
      ...compatChunkAliases('@shikijs/langs', './compat/upstream/shiki/packages/langs/package.json'),
      ...compatChunkAliases('@shikijs/themes', './compat/upstream/shiki/packages/themes/package.json'),
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
