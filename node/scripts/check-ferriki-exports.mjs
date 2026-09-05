import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const ferriki = await import('../ferriki/index.mjs')
for (const removed of [
  'createJavaScriptRegexEngine',
  'createOnigurumaEngine',
  'loadWasm',
  'wasmBinary',
  '__ferrikiBackend',
]) {
  assert.equal(Object.hasOwn(ferriki, removed), false, `${removed} must not be public Ferriki API`)
}

const packageJson = JSON.parse(await readFile(join(scriptDir, '../ferriki/package.json'), 'utf8'))
assert.deepEqual(Object.keys(packageJson.exports).sort(), ['.', './native', './package.json'])

console.log('Ferriki public export surface verified')
