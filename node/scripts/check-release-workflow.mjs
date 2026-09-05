import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const nodeRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const repoRoot = join(nodeRoot, '..')
const workflow = await readFile(join(repoRoot, '.github/workflows/publish.yml'), 'utf8')
const checklist = await readFile(join(repoRoot, 'docs/release-checklist.md'), 'utf8')

assert.match(
  workflow,
  /sebastian-software\/ferramenta\/\.github\/workflows\/release-node-native\.yml@[0-9a-f]{40}/,
  'publish workflow must pin the reusable release workflow to an immutable commit',
)
assert.doesNotMatch(workflow, /release-node-native\.yml@(main|master|v\d)/, 'publish workflow must not follow a mutable branch or tag')
for (const required of ['force-publish:', 'config-file:', 'manifest-file:', 'smoke-script:'])
  assert(workflow.includes(required), `publish workflow is missing ${required}`)

for (const required of ['npm provenance', 'GitHub release', 'tarball', 'rollback', 'deprecate', 'go/no-go'])
  assert(checklist.toLowerCase().includes(required.toLowerCase()), `release checklist is missing ${required}`)

console.log('Ferriki release workflow and checklist verified')
