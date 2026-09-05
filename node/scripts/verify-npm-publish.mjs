import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { FERRIKI_PLATFORM_TARGETS } from '../ferriki/platforms.mjs'

export const MAX_ATTEMPTS = 8
export const RETRY_DELAY_MS = 15_000
export const REQUEST_TIMEOUT_MS = 10_000

export function registryVersionUrl(packageName, version) {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export async function verifyNpmPublication({
  packageName,
  version,
  publishResult,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  const registryUrl = registryVersionUrl(packageName, version)
  let published = false
  let provenance = false
  let lastObservation = 'the registry did not return the expected package metadata'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(registryUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.ok) {
        const metadata = await response.json()
        published = metadata.name === packageName && metadata.version === version
        provenance = Boolean(metadata.dist?.attestations?.provenance)
        if (published && provenance) {
          console.log(`npm registry confirmed ${packageName}@${version} with provenance on attempt ${attempt}`)
          break
        }
        lastObservation = published
          ? 'registry metadata is public but has no provenance attestation'
          : `registry returned ${metadata.name ?? 'unknown'}@${metadata.version ?? 'unknown'}`
      }
      else {
        lastObservation = `registry returned HTTP ${response.status}`
      }
    }
    catch (error) {
      lastObservation = `registry request failed: ${error.message}`
    }

    console.log(`npm release verification attempt ${attempt}/${MAX_ATTEMPTS} for ${packageName}: ${lastObservation}`)
    if (attempt < MAX_ATTEMPTS)
      await sleepImpl(RETRY_DELAY_MS)
  }

  const failures = []
  if (publishResult !== 'success')
    failures.push(`publish-npm concluded ${publishResult}`)
  if (!published)
    failures.push(`expected ${packageName}@${version} at ${registryUrl}; ${lastObservation}`)
  if (!provenance)
    failures.push(`expected npm provenance for ${packageName}@${version}`)
  if (failures.length > 0)
    throw new Error(`npm release verification failed: ${failures.join('; ')}`)
}

async function verifyPublicInstall(packageName, version) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'ferriki-public-install-'))
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const run = (args, options = {}) => {
    const result = spawnSync(npm, args, {
      cwd: tempRoot,
      encoding: 'utf8',
      stdio: options.stdio ?? 'pipe',
      shell: process.platform === 'win32',
      ...options,
    })
    if (result.status !== 0)
      throw new Error(`npm ${args.join(' ')} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }

  try {
    run(['init', '--yes'], { stdio: 'ignore' })
    run(['install', '--ignore-scripts', '--no-audit', '--no-fund', `${packageName}@${version}`], { stdio: 'ignore' })
    const probe = join(tempRoot, 'probe.mjs')
    await writeFile(probe, `
      const ferriki = await import(${JSON.stringify(packageName)})
      if (typeof ferriki.ferrikiVersion !== 'function' || !ferriki.ferrikiVersion())
        throw new Error('public Ferriki install did not load its native binding')
    `)
    const nodeResult = spawnSync(process.execPath, [probe], { cwd: tempRoot, encoding: 'utf8', stdio: 'pipe' })
    if (nodeResult.status !== 0)
      throw new Error(`public Ferriki install probe failed:\n${nodeResult.stdout}\n${nodeResult.stderr}`)
    console.log(`public npm install verified for ${packageName}@${version}`)
  }
  finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function main() {
  const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url))
  const packagePath = join(scriptsDirectory, '..', 'ferriki', 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  assert(typeof packageJson.name === 'string' && typeof packageJson.version === 'string', 'invalid Ferriki package manifest')

  const packages = [
    { name: packageJson.name, version: packageJson.version },
    ...FERRIKI_PLATFORM_TARGETS.map(target => ({
      name: target.packageName,
      version: packageJson.optionalDependencies?.[target.packageName],
    })),
  ]
  for (const pkg of packages)
    assert.equal(pkg.version, packageJson.version, `${pkg.name} must use the Ferriki release version`)

  const publishResult = process.env.NPM_PUBLISH_RESULT ?? 'unknown'
  for (const pkg of packages) {
    await verifyNpmPublication({
      packageName: pkg.name,
      version: pkg.version,
      publishResult,
    })
  }
  await verifyPublicInstall(packageJson.name, packageJson.version)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
