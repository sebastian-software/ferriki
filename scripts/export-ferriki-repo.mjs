import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function fail(message) {
  console.error(`[export-ferriki-repo] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = {
    boundaryFile: path.join(process.cwd(), 'plans/ferriki-repo-export-boundary.json'),
    dryRun: false,
    targetDir: '',
    writeMetadata: true,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--boundary-file')
      args.boundaryFile = path.resolve(argv[++index] || '')
    else if (arg === '--target-dir')
      args.targetDir = path.resolve(argv[++index] || '')
    else if (arg === '--dry-run')
      args.dryRun = true
    else if (arg === '--no-metadata')
      args.writeMetadata = false
    else if (arg === '--help')
      args.help = true
    else
      fail(`unknown argument: ${arg}`)
  }

  if (!args.help && !args.targetDir && !args.dryRun)
    fail('missing required --target-dir')

  return args
}

function printHelp() {
  console.log(`Usage: node ./scripts/export-ferriki-repo.mjs --target-dir <path> [options]

Options:
  --boundary-file <path>  Export boundary manifest (default: plans/ferriki-repo-export-boundary.json)
  --dry-run               Print the export plan without writing files
  --no-metadata           Do not write .ferriki-export.json into the target
  --help                  Show this help
`)
}

function loadBoundary(boundaryFile) {
  if (!existsSync(boundaryFile))
    fail(`boundary file does not exist: ${boundaryFile}`)

  const boundary = JSON.parse(readFileSync(boundaryFile, 'utf8'))
  const requiredArrays = [
    'include_files',
    'include_dirs',
    'exclude_globs',
    'fresh_import_in_new_repo',
    'carry_filtered_history_for',
  ]

  for (const key of requiredArrays) {
    if (!Array.isArray(boundary[key]))
      fail(`boundary file key must be an array: ${key}`)
  }

  return boundary
}

function normalizeRelative(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function globToRegex(glob) {
  let pattern = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    const next = glob[index + 1]

    if (char === '*' && next === '*') {
      const nextNext = glob[index + 2]
      if (nextNext === '/') {
        pattern += '(?:.*/)?'
        index += 2
      }
      else {
        pattern += '.*'
        index += 1
      }
      continue
    }

    if (char === '*') {
      pattern += '[^/]*'
      continue
    }

    pattern += escapeRegex(char)
  }
  pattern += '$'
  return new RegExp(pattern)
}

function buildMatchers(globs) {
  return globs.map(glob => ({
    glob,
    regex: globToRegex(normalizeRelative(glob)),
  }))
}

function isExcluded(relativePath, matchers) {
  const normalized = normalizeRelative(relativePath)
  return matchers.some(({ regex }) => regex.test(normalized))
}

function walkFiles(rootDir, relativeDir = '') {
  const absoluteDir = path.join(rootDir, relativeDir)
  const entries = readdirSync(absoluteDir, { withFileTypes: true })
  const output = []

  for (const entry of entries) {
    const relativePath = normalizeRelative(path.posix.join(relativeDir.split(path.sep).join('/'), entry.name))
    const absolutePath = path.join(rootDir, relativePath)
    if (entry.isDirectory())
      output.push(...walkFiles(rootDir, relativePath))
    else if (entry.isFile())
      output.push({ absolutePath, relativePath })
  }

  return output
}

function collectExportFiles(boundary, repoRoot) {
  const excludeMatchers = buildMatchers(boundary.exclude_globs)
  const selected = new Map()

  for (const relativeFile of boundary.include_files) {
    const normalized = normalizeRelative(relativeFile)
    const absolutePath = path.join(repoRoot, normalized)
    if (!existsSync(absolutePath))
      fail(`include file does not exist: ${normalized}`)
    if (isExcluded(normalized, excludeMatchers))
      continue
    selected.set(normalized, absolutePath)
  }

  for (const relativeDir of boundary.include_dirs) {
    const normalizedDir = normalizeRelative(relativeDir)
    const absoluteDir = path.join(repoRoot, normalizedDir)
    if (!existsSync(absoluteDir))
      fail(`include dir does not exist: ${normalizedDir}`)
    if (!statSync(absoluteDir).isDirectory())
      fail(`include dir is not a directory: ${normalizedDir}`)

    for (const file of walkFiles(repoRoot, normalizedDir)) {
      if (isExcluded(file.relativePath, excludeMatchers))
        continue
      selected.set(file.relativePath, file.absolutePath)
    }
  }

  return [...selected.entries()]
    .map(([relativePath, absolutePath]) => ({ relativePath, absolutePath }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function ensureParentDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true })
}

function copyFiles(files, targetDir) {
  for (const file of files) {
    const destination = path.join(targetDir, file.relativePath)
    ensureParentDir(destination)
    cpSync(file.absolutePath, destination, { force: true })
  }
}

function getGitCommit(repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0)
    fail(`git rev-parse HEAD failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function writeMetadataFile(targetDir, boundary, boundaryFile, exportedFiles, repoRoot) {
  const metadata = {
    sourceRepo: repoRoot,
    sourceCommit: getGitCommit(repoRoot),
    boundaryFile: path.relative(repoRoot, boundaryFile),
    exportedAt: new Date().toISOString(),
    fileCount: exportedFiles.length,
    freshImportInNewRepo: boundary.fresh_import_in_new_repo,
    carryFilteredHistoryFor: boundary.carry_filtered_history_for,
  }

  writeFileSync(
    path.join(targetDir, '.ferriki-export.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  )
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

const repoRoot = process.cwd()
if (args.targetDir) {
  const relativeTarget = path.relative(repoRoot, args.targetDir)
  if (relativeTarget === '' || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget)))
    fail('target directory must be outside the current workbench repository')
}

const boundary = loadBoundary(args.boundaryFile)
const exportedFiles = collectExportFiles(boundary, repoRoot)

console.log(`[export-ferriki-repo] target=${args.targetDir || '<dry-run>'}`)
console.log(`[export-ferriki-repo] files=${exportedFiles.length}`)
console.log(`[export-ferriki-repo] fresh-import=${boundary.fresh_import_in_new_repo.length}`)

if (args.dryRun) {
  for (const file of exportedFiles)
    console.log(file.relativePath)
  process.exit(0)
}

mkdirSync(args.targetDir, { recursive: true })
copyFiles(exportedFiles, args.targetDir)

if (args.writeMetadata)
  writeMetadataFile(args.targetDir, boundary, args.boundaryFile, exportedFiles, repoRoot)

console.log('[export-ferriki-repo] export completed')
