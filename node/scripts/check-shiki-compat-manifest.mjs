import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = new URL('../..', import.meta.url).pathname
const mirrorRoot = join(repoRoot, 'node', 'compat', 'upstream', 'shiki')
const metadataPath = join(mirrorRoot, '.source.json')

function fail(message) {
  console.error(`[check-shiki-compat-manifest] ${message}`)
  process.exit(1)
}

const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
if (metadata.manifest !== '.manifest.sha256')
  fail('mirror metadata must point to .manifest.sha256')
if (!/^[a-f0-9]{64}$/.test(metadata.manifestSha256 || ''))
  fail('mirror metadata must contain a SHA-256 for the manifest')

const manifestPath = join(mirrorRoot, metadata.manifest)
const manifest = await readFile(manifestPath, 'utf8')
const actualManifestHash = createHash('sha256').update(manifest).digest('hex')
if (actualManifestHash !== metadata.manifestSha256)
  fail('manifest checksum does not match mirror metadata')

const entries = manifest
  .trimEnd()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/)
    if (!match)
      fail(`invalid manifest line: ${line}`)
    return { digest: match[1], path: match[2] }
  })

const listed = new Set()
for (const entry of entries) {
  if (listed.has(entry.path))
    fail(`duplicate manifest path: ${entry.path}`)
  listed.add(entry.path)
  const bytes = await readFile(join(mirrorRoot, entry.path))
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== entry.digest)
    fail(`checksum mismatch: ${entry.path}`)
}

const result = spawnSync('git', ['-C', mirrorRoot, 'ls-files'], { encoding: 'utf8' })
if (result.status !== 0)
  fail(result.stderr || 'Unable to list the Shiki compatibility mirror')
const tracked = result.stdout
  .split('\n')
  .map(path => path.trim())
  .filter(path => path && path !== '.source.json' && path !== '.manifest.sha256')
  .sort()
const expected = [...listed].sort()
if (tracked.length !== expected.length || tracked.some((path, index) => path !== expected[index]))
  fail('manifest paths do not match the tracked mirror files')

console.log(`[check-shiki-compat-manifest] verified ${entries.length} file checksums`)
