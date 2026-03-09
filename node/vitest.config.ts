import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

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
