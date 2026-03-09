import { spawnSync } from 'node:child_process'
import { cp, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pkgDir, '..', '..')
const manifestPath = join(repoRoot, 'crates', 'ferriki-core', 'Cargo.toml')
const addonOut = join(pkgDir, 'shiki-rust.node')
const distAddonOut = join(pkgDir, 'dist', 'shiki-rust.node')

const cargo = spawnSync('cargo', ['build', '--release', '--manifest-path', manifestPath], {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (cargo.status !== 0)
  process.exit(cargo.status ?? 1)

const dylibName = process.platform === 'darwin'
  ? 'libferriki_core.dylib'
  : process.platform === 'linux'
    ? 'libferriki_core.so'
    : 'ferriki_core.dll'

const candidates = [
  join(repoRoot, 'target', 'release', dylibName),
]

let selectedInput = null
for (const candidate of candidates) {
  try {
    const info = await stat(candidate)
    if (info.isFile()) {
      selectedInput = candidate
      break
    }
  }
  catch (error) {
    void error
  }
}

if (!selectedInput) {
  throw new Error([
    '[ferriki] Could not locate compiled native artifact.',
    'Expected one of:',
    ...candidates.map(i => `- ${i}`),
  ].join('\n'))
}

await cp(selectedInput, addonOut)
await cp(selectedInput, distAddonOut)
console.log(`[ferriki] Native addon ready: ${addonOut}`)
console.log(`[ferriki] Bundled native addon ready: ${distAddonOut}`)
