import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const CLAUDE_POINTER = '@AGENTS.md'

// Phrases that described states the repository has since left behind.
export const STALE_GUIDANCE = [
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

// Files that state the *current* Shiki baseline. Dated records under `plans/`
// and `adr/` keep the version that was pinned when they were written.
export const SHIKI_BASELINE_DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/compatibility.md',
  'docs/migrations/shiki-to-ferriki.md',
  'node/ferriki/README.md',
]

// Files that state the Node floor declared by `engines.node`.
export const NODE_FLOOR_DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'docs/compatibility.md',
  'docs/ferriki-api.md',
  'docs/ferriki-1.0-api-contract.md',
  'node/ferriki/README.md',
]

export const SHIKI_SOURCE = 'node/compat/upstream/shiki/.source.json'
export const FERRIKI_PACKAGE = 'node/ferriki/package.json'

const SHIKI_VERSION_PATTERN = /Shiki \*{0,2}(v\d+\.\d+\.\d+)/g
const NODE_VERSION_PATTERN = /Node(?:\.js)?\s*(?:>=\s*)?v?(\d+(?:\.\d+)*)/g

/**
 * Checks the contributor documents under `root` for stale guidance and for
 * prose facts that disagree with their single machine-readable source.
 * Throws an AssertionError on the first drift found.
 */
export async function checkDocsDrift(root) {
  const read = relative => readFile(join(root, relative), 'utf8')

  const claude = await read('CLAUDE.md')
  assert.equal(
    claude.trim(),
    CLAUDE_POINTER,
    `CLAUDE.md must be exactly the pointer line \`${CLAUDE_POINTER}\`; agent guidance belongs in AGENTS.md, which this script checks for stale phrases.`,
  )

  for (const [relative, stalePhrases] of STALE_GUIDANCE) {
    const source = await read(relative)
    for (const phrase of stalePhrases)
      assert(!source.includes(phrase), `${relative} contains stale guidance: ${phrase}`)
  }

  // Positive contracts: prose facts that have exactly one machine-readable source.
  const shikiSource = JSON.parse(await read(SHIKI_SOURCE))
  assert.match(
    shikiSource.ref,
    /^v\d+\.\d+\.\d+$/,
    `${SHIKI_SOURCE} must pin an exact Shiki release tag`,
  )

  for (const relative of SHIKI_BASELINE_DOCS) {
    const source = await read(relative)
    const mentioned = [...source.matchAll(SHIKI_VERSION_PATTERN)].map(match => match[1])
    assert(
      mentioned.length > 0,
      `${relative} must name the pinned Shiki baseline (${shikiSource.ref})`,
    )
    const stale = [...new Set(mentioned)].filter(version => version !== shikiSource.ref)
    assert(
      stale.length === 0,
      `${relative} names a stale Shiki baseline (${stale.join(', ')}); the mirror pins ${shikiSource.ref}`,
    )
  }

  const ferrikiPackage = JSON.parse(await read(FERRIKI_PACKAGE))
  const nodeFloor = String(ferrikiPackage.engines?.node ?? '').replace(/^\D*/, '')
  assert.match(
    nodeFloor,
    /^\d+\.\d+\.\d+$/,
    `${FERRIKI_PACKAGE} must declare an exact Node floor in \`engines.node\``,
  )

  for (const relative of NODE_FLOOR_DOCS) {
    const source = await read(relative)
    const mentioned = [...source.matchAll(NODE_VERSION_PATTERN)].map(match => match[1])
    assert(
      mentioned.includes(nodeFloor),
      `${relative} must state the Node floor ${nodeFloor} declared by ${FERRIKI_PACKAGE}`,
    )
    const stale = [...new Set(mentioned)].filter(version => version !== nodeFloor)
    assert(
      stale.length === 0,
      `${relative} states a Node version other than the declared floor ${nodeFloor}: ${stale.join(', ')}`,
    )
  }

  return { shikiRef: shikiSource.ref, nodeFloor }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..')
  const { shikiRef, nodeFloor } = await checkDocsDrift(root)
  console.log(`Ferriki contributor-doc guidance is current (Shiki ${shikiRef} baseline, Node >= ${nodeFloor})`)
}
