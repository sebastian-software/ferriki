import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..')
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

for (const [relative, stalePhrases] of checks) {
  const source = await readFile(join(root, relative), 'utf8')
  for (const phrase of stalePhrases)
    assert(!source.includes(phrase), `${relative} contains stale guidance: ${phrase}`)
}

console.log('Ferriki contributor-doc guidance is current')
