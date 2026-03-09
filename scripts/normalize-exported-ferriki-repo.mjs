import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function fail(message) {
  console.error(`[normalize-exported-ferriki-repo] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = {
    targetDir: '',
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--target-dir')
      args.targetDir = path.resolve(argv[++index] || '')
    else if (arg === '--help')
      args.help = true
    else
      fail(`unknown argument: ${arg}`)
  }

  if (!args.help && !args.targetDir)
    fail('missing required --target-dir')

  return args
}

function printHelp() {
  console.log(`Usage: node ./scripts/normalize-exported-ferriki-repo.mjs --target-dir <path>

Normalizes a boundary-exported Ferriki probe so root configs no longer depend on
the old Shiki monorepo layout.`)
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function writeText(targetDir, relativePath, contents) {
  const destination = path.join(targetDir, relativePath)
  ensureDir(path.dirname(destination))
  writeFileSync(destination, contents)
}

function readJson(targetDir, relativePath) {
  const filePath = path.join(targetDir, relativePath)
  if (!existsSync(filePath))
    fail(`missing file: ${relativePath}`)
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeJson(targetDir, relativePath, value) {
  writeText(targetDir, relativePath, `${JSON.stringify(value, null, 2)}\n`)
}

function normalizePackageJson(targetDir) {
  const pkg = readJson(targetDir, 'package.json')
  pkg.name = 'ferriki-workbench'
  pkg.private = true
  pkg.scripts = {
    'lint': 'eslint . --cache',
    'typecheck': 'tsc --noEmit',
    'build': 'pnpm -C npm/ferriki build',
    'build:native': 'pnpm -C npm/ferriki build:native',
    'test:ferriki-compat': 'pnpm run test:ferriki-compat:core',
    'test:ferriki-compat:core': 'pnpm -C npm/ferriki build:native && SHIKI_BACKEND=rust vitest compat/upstream/shiki/packages/core/test compat/upstream/shiki/packages/shiki/test compat/upstream/shiki/packages/transformers/test compat/upstream/shiki/packages/twoslash/test --run --maxWorkers 1 --no-file-parallelism',
    'test:ferriki-compat:adapters': 'pnpm -C npm/ferriki build:native && SHIKI_BACKEND=rust vitest compat/upstream/shiki/packages/markdown-it/test compat/upstream/shiki/packages/rehype/test compat/upstream/shiki/packages/vitepress-twoslash/test --run --maxWorkers 1 --no-file-parallelism',
    'test:ferriki-compat:colorized-brackets': 'pnpm -C npm/ferriki build:native && node ./compat/harness/run-colorized-brackets-compat.mjs',
    'export:ferriki-repo': 'node ./scripts/export-ferriki-repo.mjs',
    'export:ferriki-repo:dry-run': 'node ./scripts/export-ferriki-repo.mjs --dry-run',
    'normalize:exported-ferriki-repo': 'node ./scripts/normalize-exported-ferriki-repo.mjs',
    'publish:ci': 'pnpm -C npm/ferriki publish --access public --no-git-checks',
  }
  pkg.devDependencies = {
    '@antfu/eslint-config': 'catalog:cli',
    '@types/node': 'catalog:types',
    'eslint': 'catalog:cli',
    'typescript': 'catalog:cli',
    'vite': 'catalog:bundling',
    'vite-tsconfig-paths': 'catalog:bundling',
    'vitest': 'catalog:testing',
  }
  pkg.resolutions = {
    typescript: 'catalog:cli',
    vite: 'catalog:bundling',
  }
  delete pkg['simple-git-hooks']
  delete pkg['lint-staged']
  writeJson(targetDir, 'package.json', pkg)
}

function normalizePnpmWorkspace(targetDir) {
  const contents = `catalogMode: prefer
shellEmulator: true
trustPolicy: no-downgrade

packages:
  - npm/*
catalogs:
  bundling:
    vite: ^7.3.1
    vite-tsconfig-paths: ^6.0.5
  cli:
    '@antfu/eslint-config': ^7.2.0
    eslint: ^9.39.2
    pnpm: ^10.28.2
    typescript: ^5.9.3
  testing:
    vitest: ^3.2.4
  types:
    '@types/node': ^24.10.9
onlyBuiltDependencies:
  - esbuild
`
  writeText(targetDir, 'pnpm-workspace.yaml', contents)
}

function normalizeCargoToml(targetDir) {
  const contents = `[workspace]
members = [
  "crates/ferriki-core",
]
resolver = "2"

[workspace.dependencies]
ferroni = "1.2.8"
napi = { version = "2", default-features = false, features = [ "napi8" ] }
napi-build = "2"
napi-derive = "2"
serde_json = "1"

[profile.release]
debug = true
`
  writeText(targetDir, 'Cargo.toml', contents)
}

function normalizeTsconfig(targetDir) {
  const contents = `{
  "compilerOptions": {
    "target": "esnext",
    "lib": ["esnext"],
    "rootDir": ".",
    "module": "esnext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "types": ["node"],
    "allowJs": true,
    "strict": true,
    "strictNullChecks": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipDefaultLibCheck": true,
    "skipLibCheck": true
  },
  "include": [
    "**/*.ts",
    "**/*.mjs",
    "eslint.config.js"
  ],
  "exclude": [
    "**/node_modules/**",
    "**/dist/**"
  ]
}
`
  writeText(targetDir, 'tsconfig.json', contents)
}

function normalizeVitestConfig(targetDir) {
  const contents = `import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    tsconfigPaths(),
  ],
  resolve: {
    alias: [
      {
        find: /^shiki$/,
        replacement: new URL('./compat/harness/shiki-backend-entry.ts', import.meta.url).pathname,
      },
      {
        find: /^@shikijs\\/primitive$/,
        replacement: new URL('./compat/harness/shiki-primitive-entry.ts', import.meta.url).pathname,
      },
      {
        find: /^ferriki$/,
        replacement: new URL('./npm/ferriki/index.mjs', import.meta.url).pathname,
      },
      {
        find: /^ferriki\\/native$/,
        replacement: new URL('./npm/ferriki/native.mjs', import.meta.url).pathname,
      },
    ],
  },
  test: {
    testTimeout: 30_000,
    reporters: 'dot',
    exclude: [
      '**/node_modules/**',
    ],
  },
})
`
  writeText(targetDir, 'vitest.config.ts', contents)
}

function normalizeEslintConfig(targetDir) {
  const contents = `// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
    pnpm: true,
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'compat/upstream/shiki/**',
    ],
  },
  {
    rules: {
      'no-restricted-syntax': 'off',
      'ts/no-invalid-this': 'off',
    },
  },
)
`
  writeText(targetDir, 'eslint.config.js', contents)
}

function normalizeHarness(targetDir) {
  const backendEntry = `export * from '../../npm/ferriki/index.mjs'
export {
  createHighlighterWithBackend as createHighlighter,
} from '../../npm/ferriki/index.mjs'
`

  const primitiveEntry = `import process from 'node:process'

function cloneToken(token) {
  return { ...token }
}

// Keep the upstream primitive helper local to the compat harness so the new
// repo does not depend on legacy packages/core source layout.
export function alignThemesTokenization(...themes) {
  if (themes.length === 0)
    return []

  const outThemes = themes.map(() => [])
  const count = themes.length

  for (let lineIndex = 0; lineIndex < themes[0].length; lineIndex += 1) {
    const lines = themes.map(theme => theme[lineIndex])
    const outLines = outThemes.map(() => [])
    outThemes.forEach((theme, index) => theme.push(outLines[index]))

    const indexes = lines.map(() => 0)
    const current = lines.map(line => line[0])

    while (current.every(Boolean)) {
      const minLength = Math.min(...current.map(token => token.content.length))

      for (let themeIndex = 0; themeIndex < count; themeIndex += 1) {
        const token = current[themeIndex]
        if (token.content.length === minLength) {
          outLines[themeIndex].push(cloneToken(token))
          indexes[themeIndex] += 1
          current[themeIndex] = lines[themeIndex][indexes[themeIndex]]
        }
        else {
          outLines[themeIndex].push({
            ...token,
            content: token.content.slice(0, minLength),
          })
          current[themeIndex] = {
            ...token,
            content: token.content.slice(minLength),
            offset: token.offset + minLength,
          }
        }
      }
    }
  }

  return outThemes
}

void process
`

  writeText(targetDir, 'compat/harness/shiki-backend-entry.ts', backendEntry)
  writeText(targetDir, 'compat/harness/shiki-primitive-entry.ts', primitiveEntry)
}

function normalizeFerrikiTypes(targetDir) {
  writeText(targetDir, 'npm/ferriki/index.d.mts', `export * from './index.mjs'\n`)
  writeText(targetDir, 'npm/ferriki/native.d.mts', `export * from './native.mjs'\n`)
}

function annotateExportMetadata(targetDir) {
  const metadataPath = path.join(targetDir, '.ferriki-export.json')
  if (!existsSync(metadataPath))
    return

  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  metadata.normalizedAt = new Date().toISOString()
  metadata.normalization = {
    rootConfigs: [
      'Cargo.toml',
      'package.json',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'vitest.config.ts',
      'eslint.config.js',
    ],
    harness: [
      'compat/harness/shiki-backend-entry.ts',
      'compat/harness/shiki-primitive-entry.ts',
    ],
    packageTypes: [
      'npm/ferriki/index.d.mts',
      'npm/ferriki/native.d.mts',
    ],
  }
  writeJson(targetDir, '.ferriki-export.json', metadata)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

normalizePackageJson(args.targetDir)
normalizePnpmWorkspace(args.targetDir)
normalizeCargoToml(args.targetDir)
normalizeTsconfig(args.targetDir)
normalizeVitestConfig(args.targetDir)
normalizeEslintConfig(args.targetDir)
normalizeHarness(args.targetDir)
normalizeFerrikiTypes(args.targetDir)
annotateExportMetadata(args.targetDir)

console.log(`[normalize-exported-ferriki-repo] normalized ${args.targetDir}`)
