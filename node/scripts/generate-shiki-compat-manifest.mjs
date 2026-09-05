import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = new URL('../..', import.meta.url).pathname
const mirrorRoot = join(repoRoot, 'node', 'compat', 'upstream', 'shiki')
const metadataPath = join(mirrorRoot, '.source.json')
const manifestPath = join(mirrorRoot, '.manifest.sha256')

const result = spawnSync('git', ['-C', mirrorRoot, 'ls-files'], { encoding: 'utf8' })
if (result.status !== 0)
  throw new Error(result.stderr || 'Unable to list the Shiki compatibility mirror')

const paths = result.stdout
  .split('\n')
  .map(path => path.trim())
  .filter(path => path && path !== '.source.json' && path !== '.manifest.sha256')
  .sort()

const lines = []
for (const relativePath of paths) {
  const bytes = await readFile(join(mirrorRoot, relativePath))
  const digest = createHash('sha256').update(bytes).digest('hex')
  lines.push(`${digest}  ${relativePath}`)
}

const manifest = `${lines.join('\n')}\n`
await writeFile(manifestPath, manifest, 'utf8')

const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
metadata.manifest = '.manifest.sha256'
metadata.manifestSha256 = createHash('sha256').update(manifest).digest('hex')
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

console.log(`[generate-shiki-compat-manifest] wrote ${paths.length} file checksums`)
