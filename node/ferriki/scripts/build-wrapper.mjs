import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const nodeRoot = dirname(packageDir)
const generatedDir = join(nodeRoot, '.generated', 'ferriki')
const generatedTypes = join(generatedDir, 'api.d.mts')
const sourceTypes = join(packageDir, 'src', 'api.d.mts')

await mkdir(generatedDir, { recursive: true })

const typecheck = spawnSync('pnpm', [
  'exec',
  'tsc',
  '--project',
  join(nodeRoot, 'tsconfig.api.json'),
], {
  cwd: nodeRoot,
  shell: process.platform === 'win32',
  stdio: 'inherit',
})

if (typecheck.error)
  throw typecheck.error
if (typecheck.status !== 0)
  process.exit(typecheck.status ?? 1)

await writeFile(sourceTypes, await readFile(generatedTypes))
await writeFile(join(packageDir, 'index.mjs'), [
  '/* This file is generated from src/index.mjs. Run `pnpm run build` after changing the source. */',
  'export * from \'./src/index.mjs\'',
  '',
].join('\n'))
await writeFile(join(packageDir, 'index.d.mts'), [
  '/* This file is generated from src/api.mts. Run `pnpm run build` after changing the source. */',
  'export * from \'./src/api.mjs\'',
  '',
].join('\n'))

console.log('[ferriki] Generated public runtime wrapper and declarations')
