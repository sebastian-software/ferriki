import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const nodeRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const repoRoot = join(nodeRoot, '..')
const workflow = await readFile(join(repoRoot, '.github/workflows/publish.yml'), 'utf8')
const checklist = await readFile(join(repoRoot, 'docs/release-checklist.md'), 'utf8')
const releaseConfig = JSON.parse(await readFile(join(repoRoot, '.release-please-config.json'), 'utf8'))
const releasePackage = releaseConfig.packages?.['node/ferriki']
const extraFiles = releasePackage?.['extra-files'] ?? []

assert.match(
  workflow,
  /googleapis\/release-please-action@[0-9a-f]{40}/,
  'release workflow must pin release-please to an immutable commit',
)
assert.doesNotMatch(workflow, /uses: [^\n]+@(main|master|v\d)/, 'release workflow must not follow mutable action refs')
assert.equal(releaseConfig['release-type'], 'node', 'Ferriki release authority must remain the Node package')
assert.equal(releaseConfig['include-component-in-tag'], false, 'Ferriki must preserve the unscoped product tag format')
assert.equal(releasePackage?.['changelog-path'], 'CHANGELOG.md', 'release package must declare its changelog path')
assert(
  extraFiles.some(file => file.path === '/node/ferriki/package.json' && file.jsonpath === '$.optionalDependencies[*]'),
  'release config must update all platform dependency versions with the product version',
)
assert(
  extraFiles.some(file => file.path === '/node/platforms/*/package.json' && file.glob === true && file.jsonpath === '$.version'),
  'release config must update every platform package manifest with the product version',
)
assert(
  extraFiles.some(file => file.path === '/node/pnpm-lock.yaml' && file.type === 'yaml' && file.jsonpath === '$.importers.ferriki.optionalDependencies[*].specifier'),
  'release config must update the pnpm lockfile dependency specifiers',
)
assert.doesNotMatch(workflow, /sync:platform-versions/, 'release workflow must not patch generated release candidates')
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
