import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { FERRIKI_PLATFORM_TARGETS, resolveFerrikiPlatformTarget } from '../ferriki/platforms.mjs'

// The packed-consumer check installs ferriki without optional dependencies and
// therefore only ever exercises the bundled addon. This check does the
// opposite: it installs the matching sidecar package next to ferriki, strips
// every bundled addon out of the installed main package, and proves that the
// loader still comes up — which can only be true if it resolved the sidecar by
// package name. A negative control then removes the sidecar addon as well and
// expects the documented failure, so a green run cannot be a fallback in
// disguise.
const nodeRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const packageRoot = join(nodeRoot, 'ferriki')
const platformId = process.env.FERRIKI_PLATFORM_ID ?? resolveFerrikiPlatformTarget()?.id
assert(platformId, 'FERRIKI_PLATFORM_ID is required on a platform Ferriki does not support natively')
const target = FERRIKI_PLATFORM_TARGETS.find(entry => entry.id === platformId)
assert(target, `unknown Ferriki platform id ${platformId}`)
const sidecarRoot = join(nodeRoot, 'platforms', platformId)
const sidecarAddon = join(sidecarRoot, 'ferriki.node')
await stat(sidecarAddon).catch(() => {
  throw new Error(`${sidecarAddon} is missing; run build:native with FERRIKI_PLATFORM_ID=${platformId} first`)
})

const tempRoot = await mkdtemp(join(tmpdir(), 'ferriki-sidecar-consumer-'))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || packageRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: process.platform === 'win32' && command === 'npm.cmd',
    env: {
      ...process.env,
      npm_config_cache: join(tempRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
  })
  if (options.allowFailure)
    return result
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}\n${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`)
  return result
}

function pack(cwd) {
  const packed = run(npmCommand, ['pack', '--json', '--pack-destination', tempRoot], { cwd })
  return JSON.parse(packed.stdout)[0]
}

try {
  const main = pack(packageRoot)
  const sidecar = pack(sidecarRoot)
  assert.equal(sidecar.name, target.packageName, `sidecar tarball is ${sidecar.name}, expected ${target.packageName}`)

  const consumer = await mkdtemp(join(tempRoot, 'consumer-'))
  run(npmCommand, ['init', '--yes'], { cwd: consumer, stdio: 'ignore' })
  run(npmCommand, ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(tempRoot, main.filename), join(tempRoot, sidecar.filename)], { cwd: consumer, stdio: 'ignore' })

  const installedMain = join(consumer, 'node_modules', 'ferriki')
  const installedSidecarAddon = join(consumer, 'node_modules', ...target.packageName.split('/'), 'ferriki.node')
  await stat(installedSidecarAddon)

  // Leave the sidecar as the only addon the loader could possibly find.
  const bundled = []
  for (const directory of [installedMain, join(installedMain, 'dist')]) {
    for (const entry of await readdir(directory).catch(() => [])) {
      if (entry.endsWith('.node'))
        bundled.push(join(directory, entry))
    }
  }
  assert(bundled.length > 0, 'the packed main package carried no bundled addon to strip; the check would prove nothing')
  for (const file of bundled)
    await rm(file, { force: true })

  const probe = join(consumer, 'sidecar-probe.mjs')
  await writeFile(probe, `
import { loadFerrikiNativeBinding } from 'ferriki/native'

const version = loadFerrikiNativeBinding().ferrikiVersion()
if (!version)
  throw new Error('the sidecar-backed ferriki/native export did not load')
console.log(\`ferriki native core \${version} loaded from ${target.packageName}\`)
`)
  run(process.execPath, [probe], { cwd: consumer, stdio: 'inherit' })

  // Negative control: with the sidecar addon gone too, the loader must fail and
  // must name the sidecar in what it tried, so the recovery hint in the error
  // points at the package that actually fixes it.
  await rm(installedSidecarAddon, { force: true })
  const failure = run(process.execPath, [probe], { cwd: consumer, allowFailure: true })
  assert.notEqual(failure.status, 0, 'the loader still loaded an addon after every candidate was removed')
  assert.match(failure.stderr, new RegExp(`No native binary for ${platformId}`), `unexpected loader failure:\n${failure.stderr}`)
  assert(failure.stderr.includes(`${target.packageName}/ferriki.node`), `loader failure does not list the sidecar candidate:\n${failure.stderr}`)

  console.log(`Ferriki packed sidecar verified (${sidecar.filename} resolved by package name, ${main.filename} bundled addon ignored)`)
}
finally {
  await rm(tempRoot, { recursive: true, force: true })
}
