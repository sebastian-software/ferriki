import { spawnSync } from 'node:child_process'

const result = spawnSync('git', [
  'diff',
  '--exit-code',
  '--',
  'ferriki/index.mjs',
  'ferriki/index.d.mts',
  'ferriki/src/api.d.mts',
], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
})

if (result.error)
  throw result.error

if (result.status !== 0) {
  throw new Error('Generated Ferriki API files are stale; run `pnpm run build` and commit the result.')
}

console.log('[ferriki] Generated API files match the checked-in source')
