import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const nodeRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const packageRoot = join(nodeRoot, 'ferriki')
const examplePath = join(nodeRoot, '..', 'docs', 'examples', 'ferromark-ardo.mjs')
const tempRoot = await mkdtemp(join(tmpdir(), 'ferriki-docs-consumer-'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || packageRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    env: {
      ...process.env,
      npm_config_cache: join(tempRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
      ...options.env,
    },
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}\n${result.stdout || ''}\n${result.stderr || ''}`)
  }
  return result
}

try {
  const packed = run('npm', ['pack', '--json', '--pack-destination', tempRoot])
  const metadata = JSON.parse(packed.stdout)[0]
  const files = new Set(metadata.files.map(file => file.path))
  for (const required of ['index.mjs', 'index.d.mts', 'native.mjs', 'assets/shiki/catalog.mjs'])
    assert(files.has(required), `packed Ferriki package is missing ${required}`)
  assert([...files].some(file => /^dist\/ferriki\..+\.node$/.test(file)), 'packed Ferriki package is missing its platform addon')
  assert(![...files].some(file => file.startsWith('dist/chunks/')), 'packed Ferriki package contains the removed dist/chunks runtime')

  const tarball = join(tempRoot, metadata.filename)
  const consumer = await mkdtemp(join(tempRoot, 'consumer-'))
  run('npm', ['init', '--yes'], { cwd: consumer, stdio: 'ignore' })
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: consumer, stdio: 'ignore' })
  const consumerExample = join(consumer, 'ferromark-ardo.mjs')
  await cp(examplePath, consumerExample)
  run(process.execPath, [consumerExample], { cwd: consumer, stdio: 'inherit' })

  const installedReadme = await readFile(join(consumer, 'node_modules', 'ferriki', 'README.md'), 'utf8')
  assert(installedReadme.includes('Ferriki is a Shiki-compatible syntax highlighter'), 'packed README was not installed')
  console.log(`Ferriki packed consumer verified (${metadata.filename}, ${metadata.unpackedSize} bytes unpacked)`)
}
finally {
  await rm(tempRoot, { recursive: true, force: true })
}
