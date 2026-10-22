// GitHub Actions exposes different contexts at each workflow key. The job-level
// env key does not allow job, jobs, steps, runner, or env; keep that scope
// explicit here so a misplaced context cannot make a whole workflow invalid.
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const workflowDir = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, '.github', 'workflows')
const knownContexts = ['github', 'env', 'vars', 'job', 'jobs', 'steps', 'runner', 'secrets', 'strategy', 'matrix', 'needs', 'inputs']
const jobEnvContexts = new Set(['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs'])
const contextPattern = new RegExp(`(?<![\\w.])(${knownContexts.join('|')})(?![\\w-])`, 'g')

function withoutYamlComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (quote === '"' && character === '\\') {
      index++
      continue
    }
    if (quote === "'" && character === "'" && line[index + 1] === "'") {
      index++
      continue
    }
    if ((character === '"' || character === "'") && (quote === null || quote === character)) {
      quote = quote === null ? character : null
      continue
    }
    if (character === '#' && quote === null && (index === 0 || /\s/.test(line[index - 1])))
      return line.slice(0, index)
  }
  return line
}

function contextsInExpression(expression) {
  const withoutStrings = expression.replace(/'(?:[^']|'')*'|"(?:\\.|[^"\\])*"/g, '')
  return [...withoutStrings.matchAll(contextPattern)].map(match => match[1])
}

function jobEnvironmentProblems(source, file) {
  const problems = []
  const lines = source.split('\n')
  let inJobs = false
  let jobId = null
  let jobIndent = null
  let envIndent = null

  for (const [index, originalLine] of lines.entries()) {
    const line = withoutYamlComment(originalLine)
    const trimmed = line.trim()
    if (!trimmed)
      continue

    const indentation = line.match(/^ */)[0].length
    if (indentation === 0) {
      inJobs = /^jobs\s*:/.test(trimmed)
      jobId = null
      jobIndent = null
      envIndent = null
      continue
    }
    if (!inJobs)
      continue

    if (jobIndent !== null && indentation <= jobIndent) {
      jobId = null
      jobIndent = null
      envIndent = null
    }

    if (jobIndent === null && indentation === 2) {
      const job = /^([^:#\s][^:]*):/.exec(trimmed)
      if (job) {
        jobId = job[1].replace(/^['"]|['"]$/g, '')
        jobIndent = indentation
      }
      continue
    }

    if (envIndent !== null && indentation <= envIndent)
      envIndent = null

    const env = indentation === jobIndent + 2 && /^env\s*:(.*)$/.exec(trimmed)
    if (env)
      envIndent = indentation
    if (envIndent === null || indentation < envIndent)
      continue

    const expressions = [...line.matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
    for (const expression of expressions) {
      for (const context of contextsInExpression(expression[1])) {
        if (!jobEnvContexts.has(context)) {
          problems.push(`${file}:${index + 1}: jobs.${jobId}.env uses unavailable context "${context}"`)
        }
      }
    }
  }

  return problems
}

const files = (await readdir(workflowDir)).filter(name => /\.ya?ml$/.test(name)).sort()
if (files.length === 0) {
  console.error(`No workflow files found in ${workflowDir}`)
  process.exit(2)
}

const problems = []
for (const file of files) {
  problems.push(...jobEnvironmentProblems(await readFile(join(workflowDir, file), 'utf8'), file))
}

if (problems.length > 0) {
  console.error('Workflow expression contexts are not available at these keys:')
  for (const problem of problems)
    console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`Workflow job-level env contexts verified (${files.length} workflow files)`)
