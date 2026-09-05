import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { coreCompatDeferredTests, coreCompatSupportedTests } from '../compat/harness/core-compat-manifest.mjs'

const nodeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vitestArgs = [
  'exec',
  'vitest',
]
const testNamePattern = '^(should|langAlias|getSingletonHighlighter|vue-injections|injections-side-effects)'

const catalogCheck = spawnSync(process.execPath, ['./scripts/check-ferriki-catalog.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (catalogCheck.status !== 0)
  process.exit(catalogCheck.status || 1)

const exportCheck = spawnSync(process.execPath, ['./scripts/check-ferriki-exports.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (exportCheck.status !== 0)
  process.exit(exportCheck.status || 1)

const nativeBoundaryCheck = spawnSync(process.execPath, ['./scripts/check-native-boundary.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (nativeBoundaryCheck.status !== 0)
  process.exit(nativeBoundaryCheck.status || 1)

const releaseCheck = spawnSync(process.execPath, ['./scripts/check-release-workflow.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (releaseCheck.status !== 0)
  process.exit(releaseCheck.status || 1)

const docsCheck = spawnSync(process.execPath, ['./scripts/check-docs-drift.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (docsCheck.status !== 0)
  process.exit(docsCheck.status || 1)

const docsContractCheck = spawnSync(process.execPath, ['./scripts/check-docs-contract.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (docsContractCheck.status !== 0)
  process.exit(docsContractCheck.status || 1)

const packedConsumerCheck = spawnSync(process.execPath, ['./scripts/check-packed-consumer.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (packedConsumerCheck.status !== 0)
  process.exit(packedConsumerCheck.status || 1)

const errorCheck = spawnSync(process.execPath, ['./scripts/check-ferriki-errors.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (errorCheck.status !== 0)
  process.exit(errorCheck.status || 1)

const multiThemeCheck = spawnSync(process.execPath, ['./scripts/check-ferriki-multitheme.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (multiThemeCheck.status !== 0)
  process.exit(multiThemeCheck.status || 1)

const ansiCheck = spawnSync(process.execPath, ['./scripts/check-ferriki-ansi.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (ansiCheck.status !== 0)
  process.exit(ansiCheck.status || 1)

const registrationCheck = spawnSync(process.execPath, ['./scripts/check-ferriki-registrations.mjs'], {
  cwd: nodeRoot,
  env: {
    ...process.env,
    FERRIKI_BACKEND: 'rust',
    FERRIKI_HONEST_ALIAS: '1',
  },
  stdio: 'inherit',
})
if (registrationCheck.status !== 0)
  process.exit(registrationCheck.status || 1)

function run(args) {
  const result = spawnSync('pnpm', [...vitestArgs, ...args], {
    cwd: nodeRoot,
    env: {
      ...process.env,
      FERRIKI_BACKEND: 'rust',
      FERRIKI_HONEST_ALIAS: '1',
    },
    stdio: 'inherit',
  })

  if (result.status !== 0)
    process.exit(result.status || 1)
}

run([
  'run',
  'compat/harness/honest-alias.test.ts',
  '--maxWorkers',
  '1',
  '--no-file-parallelism',
])

run([
  'run',
  ...coreCompatSupportedTests,
  '--exclude',
  'compat/upstream/shiki/packages/shiki/test/bundle.test.ts',
  '-t',
  testNamePattern,
  '--maxWorkers',
  '1',
  '--no-file-parallelism',
])

console.log('\nFerriki core compatibility summary')
console.log(`- supported contracts: ${coreCompatSupportedTests.length} test files (mandatory)`)
console.log(`- deferred contracts: ${coreCompatDeferredTests.length} test files (all linked to #31)`)
for (const test of coreCompatDeferredTests)
  console.log(`  - ${test.path}: ${test.reason} (see #${test.issue})`)
