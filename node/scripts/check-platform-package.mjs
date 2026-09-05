import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const nodeRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const platformId = process.env.FERRIKI_PLATFORM_ID
assert(platformId, 'FERRIKI_PLATFORM_ID is required for a platform package check')

const packageDir = join(nodeRoot, 'platforms', platformId)
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const addon = join(packageDir, 'ferriki.node')
const info = await stat(addon)
const npmCache = await mkdtemp(join(tmpdir(), 'ferriki-sidecar-npm-'))

assert.equal(manifest.name, `@sebastian-software/ferriki-${platformId}`)
assert(manifest.files.includes('ferriki.node'), `${manifest.name} must publish ferriki.node`)
assert(info.size > 100_000, `${manifest.name} native addon is unexpectedly small (${info.size} bytes)`)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packed = spawnSync(npm, ['pack', '--dry-run', '--json'], {
  cwd: packageDir,
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
  },
  shell: process.platform === 'win32',
  stdio: 'pipe',
})
if (packed.status !== 0) {
  await rm(npmCache, { recursive: true, force: true })
  throw new Error(`${npm} pack failed for ${manifest.name}:\n${packed.stderr}`)
}

const files = JSON.parse(packed.stdout)[0].files.map(file => file.path)
assert(files.includes('ferriki.node'), `${manifest.name} dry-run package is missing ferriki.node`)
await rm(npmCache, { recursive: true, force: true })
console.log(`Ferriki platform package verified (${manifest.name}, ${info.size} bytes)`)
