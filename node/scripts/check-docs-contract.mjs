import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const nodeRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const repoRoot = join(nodeRoot, '..')
const declarationPath = join(nodeRoot, 'ferriki', 'src', 'api.d.mts')
const apiPath = join(repoRoot, 'docs', 'ferriki-api.md')
const migrationPath = join(repoRoot, 'docs', 'migrations', 'shiki-to-ferriki.md')
const compatibilityPath = join(repoRoot, 'docs', 'compatibility.md')
const troubleshootingPath = join(repoRoot, 'docs', 'troubleshooting.md')
const rootReadmePath = join(repoRoot, 'README.md')
const packageReadmePath = join(nodeRoot, 'ferriki', 'README.md')
const sourcePath = join(nodeRoot, 'compat', 'upstream', 'shiki', '.source.json')

const declarations = await readFile(declarationPath, 'utf8')
const api = await readFile(apiPath, 'utf8')
const migration = await readFile(migrationPath, 'utf8')
const compatibility = await readFile(compatibilityPath, 'utf8')
const troubleshooting = await readFile(troubleshootingPath, 'utf8')
const rootReadme = await readFile(rootReadmePath, 'utf8')
const packageReadme = await readFile(packageReadmePath, 'utf8')
const source = JSON.parse(await readFile(sourcePath, 'utf8'))

const exportedNames = [...declarations.matchAll(/^export (?:declare )?(?:function|class|const|interface|type)\s+(\w+)/gm)]
  .map(match => match[1])

for (const name of exportedNames)
  assert(api.includes(name), `docs/ferriki-api.md is missing declared export: ${name}`)

assert.equal(source.ref, 'v4.4.3', 'the docs baseline must follow the pinned Shiki source')
assert(migration.includes(`Shiki **${source.ref}**`), 'migration guide must name the exact Shiki baseline')
assert(compatibility.includes(`Shiki ${source.ref}`), 'compatibility guide must name the exact Shiki baseline')
assert(rootReadme.includes('docs/ferriki-api.md'), 'root README must link the API reference')
assert(
  packageReadme.includes('https://github.com/sebastian-software/ferriki/blob/main/docs/ferriki-api.md'),
  'package README must link the API reference absolutely, because npmjs.com renders it outside the repository tree',
)
assert(troubleshooting.includes('No native binary for <platform>-<arch>'), 'troubleshooting must start from the actual loader error')

console.log(`Ferriki docs contract verified (${exportedNames.length} declared exports, ${source.ref} baseline)`)
