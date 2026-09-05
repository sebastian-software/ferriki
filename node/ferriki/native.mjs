import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { formatFerrikiPlatformMatrix, resolveFerrikiPlatformTarget } from './platforms.mjs'

export function loadFerrikiNativeBinding() {
  const require = createRequire(import.meta.url)
  const here = dirname(fileURLToPath(import.meta.url))
  const target = resolveFerrikiPlatformTarget()
  const candidates = target
    ? [
        `${target.packageName}/ferriki.node`,
        join('dist', target.binaryName),
        'dist/ferriki.node',
        'ferriki.node',
      ]
    : []
  const errors = []
  for (const candidate of candidates) {
    const absPath = candidate.startsWith('@')
      ? candidate
      : join(here, candidate)
    try {
      return require(candidate.startsWith('@') ? require.resolve(candidate) : absPath)
    }
    catch (error) {
      errors.push(`${absPath}: ${String(error)}`)
    }
  }
  if (!target) {
    throw new Error([
      `[ferriki] Unsupported target ${process.platform}-${process.arch}${process.platform === 'linux' ? ' (musl or unknown libc)' : ''}.`,
      `Supported targets: ${formatFerrikiPlatformMatrix()}.`,
      'Ferriki currently supports GNU libc on Linux; musl/Alpine requires a separately tested target.',
    ].join('\n'))
  }
  throw new Error([
    `[ferriki] No native binary for ${target.id}.`,
    `Install the optional platform package ${target.packageName} or use a supported target.`,
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
