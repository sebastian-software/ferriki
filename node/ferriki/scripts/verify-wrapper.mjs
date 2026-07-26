import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)))
const required = [
  join(pkgDir, 'index.mjs'),
  join(pkgDir, 'native.mjs'),
]

for (const file of required)
  await access(file)
