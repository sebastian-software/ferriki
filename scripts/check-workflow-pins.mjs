// Every third-party action in .github/workflows must be pinned to a full
// 40-character commit SHA with the human-readable version in a trailing
// comment, so a moved tag cannot change what CI executes. Local (`./`) and
// container (`docker://`) references are exempt because they are not tags.
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const workflowDir = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, '.github', 'workflows')

const USES = /^\s*(?:-\s*)?uses:\s*(?<ref>\S+)(?<rest>.*)$/
const PINNED = /^[^\s@]+@[0-9a-f]{40}$/
const VERSION_COMMENT = /#\s*\S+/

const files = (await readdir(workflowDir)).filter(name => /\.ya?ml$/.test(name)).sort()
if (files.length === 0) {
  console.error(`No workflow files found in ${workflowDir}`)
  process.exit(2)
}

const problems = []
let checked = 0

for (const file of files) {
  const lines = (await readFile(join(workflowDir, file), 'utf8')).split('\n')
  for (const [index, line] of lines.entries()) {
    const match = USES.exec(line)
    if (!match)
      continue
    const location = `${file}:${index + 1}`
    const ref = match.groups.ref.replace(/^['"]|['"]$/g, '')
    if (ref.startsWith('./') || ref.startsWith('docker://'))
      continue
    checked += 1
    if (!PINNED.test(ref))
      problems.push(`${location}: "${ref}" is not pinned to a full 40-character commit SHA`)
    else if (!VERSION_COMMENT.test(match.groups.rest))
      problems.push(`${location}: "${ref}" is missing the trailing "# <version>" comment`)
  }
}

if (problems.length > 0) {
  console.error('Workflow action pins are not compliant:')
  for (const problem of problems)
    console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`Workflow action pins verified (${checked} references in ${files.length} workflow files)`)
