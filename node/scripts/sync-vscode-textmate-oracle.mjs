import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const CONTROL_FILES = new Set(['.source.json'])

function fail(message) {
  console.error(`[sync-vscode-textmate-oracle] ${message}`)
  process.exit(1)
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: options.encoding === 'buffer' || options.encoding === undefined
      ? undefined
      : options.encoding,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr || '').trim()
    fail(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`)
  }

  return result.stdout
}

function parseArgs(argv) {
  const args = {
    sourceRepo: process.cwd(),
    targetDir: path.join(process.cwd(), 'compat/upstream/vscode-textmate'),
    pathsFile: path.join(process.cwd(), 'compat/vscode-textmate-paths.json'),
    check: false,
    dryRun: false,
    ref: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--source-repo')
      args.sourceRepo = path.resolve(argv[++index] || '')
    else if (arg === '--target-dir')
      args.targetDir = path.resolve(argv[++index] || '')
    else if (arg === '--paths-file')
      args.pathsFile = path.resolve(argv[++index] || '')
    else if (arg === '--ref')
      args.ref = argv[++index] || ''
    else if (arg === '--check')
      args.check = true
    else if (arg === '--dry-run')
      args.dryRun = true
    else if (arg === '--help')
      args.help = true
    else
      fail(`unknown argument: ${arg}`)
  }

  return args
}

function printHelp() {
  console.log(`Usage: node ./scripts/sync-vscode-textmate-oracle.mjs --ref <tag> [options]

Options:
  --source-repo <path>  Local vscode-textmate checkout to import from
  --target-dir <path>   Mirror destination
  --paths-file <path>   JSON file listing mirrored upstream paths
  --check               Verify the existing mirror matches the source ref
  --dry-run             Print the import plan without writing files
  --help                Show this help
`)
}

function loadMirrorPaths(pathsFile) {
  const raw = JSON.parse(readFileSync(pathsFile, 'utf8'))
  if (!Array.isArray(raw) || raw.length === 0)
    fail(`paths file must be a non-empty JSON array: ${pathsFile}`)

  return raw.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim())
      fail(`invalid path entry in ${pathsFile}`)
    return entry.replace(/\\/g, '/').replace(/\/+$/, '')
  })
}

function resolveRef(ref, metadataPath, checkMode) {
  if (ref)
    return ref

  if (!checkMode)
    fail('missing required --ref')

  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  if (typeof metadata.ref !== 'string' || !metadata.ref)
    fail(`mirror metadata does not contain a ref: ${metadataPath}`)
  return metadata.ref
}

function listFilesAtRef(sourceRepo, ref, mirrorPaths) {
  const files = new Set()

  for (const mirrorPath of mirrorPaths) {
    const stdout = runGit(
      sourceRepo,
      ['ls-tree', '-r', '--name-only', ref, '--', mirrorPath],
      { encoding: 'utf8' },
    )
    stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .forEach(file => files.add(file))
  }

  return [...files].sort()
}

function readFilesAtRef(sourceRepo, ref, relativePaths) {
  const input = `${relativePaths.map(file => `${ref}:${file}`).join('\n')}\n`
  const output = runGit(sourceRepo, ['cat-file', '--batch'], {
    encoding: 'buffer',
    input,
  })
  const files = new Map()
  let offset = 0

  for (const relativePath of relativePaths) {
    const headerEnd = output.indexOf(0x0A, offset)
    if (headerEnd === -1)
      fail(`invalid git cat-file response for ${relativePath}`)

    const header = output.subarray(offset, headerEnd).toString('utf8')
    if (header.endsWith(' missing'))
      fail(`missing ${relativePath} at ${ref}`)

    const size = Number(header.split(' ').at(-1))
    if (!Number.isSafeInteger(size) || size < 0)
      fail(`invalid git cat-file size for ${relativePath}: ${header}`)

    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (contentEnd >= output.length || output[contentEnd] !== 0x0A)
      fail(`truncated git cat-file response for ${relativePath}`)

    files.set(relativePath, output.subarray(contentStart, contentEnd))
    offset = contentEnd + 1
  }

  return files
}

function ensureParentDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true })
}

function walkFiles(rootDir) {
  if (!statExists(rootDir))
    return []

  const output = []
  const stack = ['']
  while (stack.length > 0) {
    const relativeDir = stack.pop()
    const absoluteDir = path.join(rootDir, relativeDir)

    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.posix.join(
        relativeDir.split(path.sep).join('/'),
        entry.name,
      )
      if (entry.isDirectory())
        stack.push(relativePath)
      else
        output.push(relativePath)
    }
  }

  return output.sort()
}

function statExists(filePath) {
  try {
    statSync(filePath)
    return true
  }
  catch {
    return false
  }
}

function syncMirror({ sourceRepo, targetDir, ref, mirrorPaths, dryRun }) {
  const commit = runGit(
    sourceRepo,
    ['rev-parse', `${ref}^{commit}`],
    { encoding: 'utf8' },
  ).trim()
  const files = listFilesAtRef(sourceRepo, ref, mirrorPaths)

  if (files.length === 0)
    fail(`no files found for ref ${ref}`)

  const contents = readFilesAtRef(sourceRepo, ref, files)
  const existingFiles = walkFiles(targetDir)
    .filter(file => !CONTROL_FILES.has(path.posix.basename(file)))
  const nextFiles = new Set(files)
  const removed = existingFiles.filter(file => !nextFiles.has(file))

  if (dryRun) {
    console.log(`[sync-vscode-textmate-oracle] ref=${ref} commit=${commit}`)
    console.log(`[sync-vscode-textmate-oracle] target=${targetDir}`)
    console.log(`[sync-vscode-textmate-oracle] files=${files.length} removed=${removed.length}`)
    return
  }

  mkdirSync(targetDir, { recursive: true })
  for (const relativePath of removed)
    rmSync(path.join(targetDir, relativePath), { force: true })

  for (const relativePath of files) {
    const destination = path.join(targetDir, relativePath)
    ensureParentDir(destination)
    writeFileSync(destination, contents.get(relativePath))
  }

  const metadata = {
    source: 'microsoft/vscode-textmate',
    ref,
    commit,
    importedAt: new Date().toISOString(),
    paths: mirrorPaths,
  }
  writeFileSync(
    path.join(targetDir, '.source.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  )

  console.log(`[sync-vscode-textmate-oracle] imported ${files.length} files from ${ref} (${commit})`)
}

function checkMirror({ sourceRepo, targetDir, ref, mirrorPaths }) {
  if (!statExists(targetDir))
    fail(`mirror directory does not exist: ${targetDir}`)

  const files = listFilesAtRef(sourceRepo, ref, mirrorPaths)
  const contents = readFilesAtRef(sourceRepo, ref, files)
  const expected = new Set(files)
  const existing = walkFiles(targetDir)
    .filter(file => !CONTROL_FILES.has(path.posix.basename(file)))
  const unexpected = existing.filter(file => !expected.has(file))
  const missing = files.filter(file => !existing.includes(file))

  if (unexpected.length > 0)
    fail(`mirror has unexpected files, first example: ${unexpected[0]}`)
  if (missing.length > 0)
    fail(`mirror is missing files, first example: ${missing[0]}`)

  for (const relativePath of files) {
    const actual = readFileSync(path.join(targetDir, relativePath))
    const expectedContent = contents.get(relativePath)
    if (!actual.equals(expectedContent))
      fail(`mirror drift detected in ${relativePath}`)
  }

  console.log(`[sync-vscode-textmate-oracle] mirror matches ${ref}`)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

const mirrorPaths = loadMirrorPaths(args.pathsFile)
const metadataPath = path.join(args.targetDir, '.source.json')
const ref = resolveRef(args.ref, metadataPath, args.check)

if (args.check)
  checkMirror({ ...args, ref, mirrorPaths })
else
  syncMirror({ ...args, ref, mirrorPaths })
