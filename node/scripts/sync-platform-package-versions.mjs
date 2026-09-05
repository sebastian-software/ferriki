import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FERRIKI_PLATFORM_TARGETS } from '../ferriki/platforms.mjs'

const nodeRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const mainPath = join(nodeRoot, 'ferriki', 'package.json')
const mainManifest = JSON.parse(await readFile(mainPath, 'utf8'))

for (const target of FERRIKI_PLATFORM_TARGETS) {
  const sidecarPath = join(nodeRoot, 'platforms', target.id, 'package.json')
  const sidecarManifest = JSON.parse(await readFile(sidecarPath, 'utf8'))
  sidecarManifest.version = mainManifest.version
  await writeFile(sidecarPath, `${JSON.stringify(sidecarManifest, null, 2)}\n`)
  mainManifest.optionalDependencies[target.packageName] = mainManifest.version
}

await writeFile(mainPath, `${JSON.stringify(mainManifest, null, 2)}\n`)
console.log(`Ferriki platform package versions synchronized to ${mainManifest.version}`)
