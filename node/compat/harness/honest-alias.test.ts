import { expect, it } from 'vitest'

it('routes every compatibility entry point through the Ferriki backend', async () => {
  const modules = await Promise.all([
    import('shiki'),
    import('shiki/core'),
    import('shiki/bundle/full'),
    import('@shikijs/engine-javascript'),
    import('@shikijs/engine-oniguruma'),
    import('@shikijs/engine-oniguruma/wasm-inlined'),
  ])

  expect(modules.every(module => (module as { __ferrikiBackend?: boolean }).__ferrikiBackend === true)).toBe(true)
})
