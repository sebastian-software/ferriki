import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const candidates = [
  `dist/ferriki.${process.platform}-${process.arch}.node`,
  'dist/ferriki.node',
  'ferriki.node',
]

export function loadFerrikiNativeBinding() {
  const require = createRequire(import.meta.url)
  const here = dirname(fileURLToPath(import.meta.url))
  const errors = []
  for (const candidate of candidates) {
    const absPath = join(here, candidate)
    try {
      return require(absPath)
    }
    catch (error) {
      errors.push(`${absPath}: ${String(error)}`)
    }
  }
  throw new Error([
    `[ferriki] No native binary for ${process.platform}-${process.arch}.`,
    'This placeholder release ships without a runtime; see the README.',
    'Tried:',
    ...errors.map(e => `- ${e}`),
  ].join('\n'))
}

export function tryLoadFerrikiNativeBinding() {
  try {
    return loadFerrikiNativeBinding()
  }
  catch {
    return undefined
  }
}
