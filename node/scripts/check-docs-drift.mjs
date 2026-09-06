import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..')
const claudePointer = '@AGENTS.md'
const checks = [
  ['AGENTS.md', [
    'npm package is a placeholder',
    'Compat lanes are suspended',
    'currently a placeholder exposing only',
    'FERRIKI_BACKEND',
  ]],
  ['plans/ferriki-remaining-work.md', [
    'the backend switch is `FERRIKI_BACKEND`',
    'still back the JS engine path',
    'currently a placeholder exposing only',
  ]],
  ['plans/ferriki-asset-pipeline-implementation-plan.md', [
    'Phase 5 (removing the transitional',
    'reduce or remove `dist/chunks/*.mjs` once',
  ]],
]

const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8')
assert.equal(
  claude.trim(),
  claudePointer,
  `CLAUDE.md must be exactly the pointer line \`${claudePointer}\`; agent guidance belongs in AGENTS.md, which this script checks for stale phrases.`,
)

for (const [relative, stalePhrases] of checks) {
  const source = await readFile(join(root, relative), 'utf8')
  for (const phrase of stalePhrases)
    assert(!source.includes(phrase), `${relative} contains stale guidance: ${phrase}`)
}

// Positive contracts: prose facts that have exactly one machine-readable source.
const read = relative => readFile(join(root, relative), 'utf8')

const shikiSource = JSON.parse(await read('node/compat/upstream/shiki/.source.json'))
assert.match(
  shikiSource.ref,
  /^v\d+\.\d+\.\d+$/,
  'node/compat/upstream/shiki/.source.json must pin an exact Shiki release tag',
)

// Files that state the *current* baseline. Dated records under `plans/` and
// `adr/` keep the version that was pinned when they were written.
const shikiBaselineDocs = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/compatibility.md',
  'docs/migrations/shiki-to-ferriki.md',
  'node/ferriki/README.md',
]

for (const relative of shikiBaselineDocs) {
  const source = await read(relative)
  const mentioned = [...source.matchAll(/Shiki \*{0,2}(v\d+\.\d+\.\d+)/g)].map(match => match[1])
  assert(
    mentioned.length > 0,
    `${relative} must name the pinned Shiki baseline (${shikiSource.ref})`,
  )
  const stale = [...new Set(mentioned)].filter(version => version !== shikiSource.ref)
  assert.deepEqual(
    stale,
    [],
    `${relative} names a stale Shiki baseline (${stale.join(', ')}); the mirror pins ${shikiSource.ref}`,
  )
}

const ferrikiPackage = JSON.parse(await read('node/ferriki/package.json'))
const nodeFloor = ferrikiPackage.engines.node.replace(/^\D*/, '')
assert.match(
  nodeFloor,
  /^\d+\.\d+\.\d+$/,
  'node/ferriki/package.json must declare an exact Node floor in `engines.node`',
)

const nodeFloorDocs = [
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'docs/compatibility.md',
  'docs/ferriki-api.md',
  'docs/ferriki-1.0-api-contract.md',
  'node/ferriki/README.md',
]

for (const relative of nodeFloorDocs) {
  const source = await read(relative)
  const mentioned = [...source.matchAll(/Node(?:\.js)?\s*(?:>=\s*)?v?(\d+(?:\.\d+)*)/g)].map(match => match[1])
  assert(
    mentioned.includes(nodeFloor),
    `${relative} must state the Node floor ${nodeFloor} declared by node/ferriki/package.json`,
  )
  const stale = [...new Set(mentioned)].filter(version => version !== nodeFloor)
  assert.deepEqual(
    stale,
    [],
    `${relative} states a Node version other than the declared floor ${nodeFloor}: ${stale.join(', ')}`,
  )
}

console.log(
  `Ferriki contributor-doc guidance is current (Shiki ${shikiSource.ref} baseline, Node >= ${nodeFloor})`,
)
