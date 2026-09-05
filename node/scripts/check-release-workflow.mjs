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
  /googleapis\/release-please-action@[0-9a-f]{40}/,
  'release workflow must pin release-please to an immutable commit',
)
assert.doesNotMatch(workflow, /uses: [^\n]+@(main|master|v\d)/, 'release workflow must not follow mutable action refs')
for (const job of ['release-please:', 'build-native:', 'publish-npm:', 'verify-npm-publish:', 'release-summary:'])
  assert(workflow.includes(`  ${job}`), `release workflow is missing ${job}`)
for (const required of [
  'force-publish:',
  'dist-tag:',
  'timeout-minutes:',
  'actions/download-artifact@',
  'npm publish --access public --provenance',
  'NPM_PUBLISH_RESULT:',
  'write-release-summary.mjs',
])
  assert(workflow.includes(required), `release workflow is missing ${required}`)

for (const required of ['npm provenance', 'GitHub release', 'tarball', 'rollback', 'deprecate', 'go/no-go'])
  assert(checklist.toLowerCase().includes(required.toLowerCase()), `release checklist is missing ${required}`)

console.log('Ferriki release workflow and checklist verified')
