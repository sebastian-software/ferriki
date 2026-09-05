import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const nodeRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const packageRoot = join(nodeRoot, 'ferriki')
const examplePath = join(nodeRoot, '..', 'docs', 'examples', 'ferromark-ardo.mjs')
const tempRoot = await mkdtemp(join(tmpdir(), 'ferriki-docs-consumer-'))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || packageRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: process.platform === 'win32' && command === 'npm.cmd',
    env: {
      ...process.env,
      npm_config_cache: join(tempRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
      ...options.env,
    },
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}\n${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`)
  }
  return result
}

try {
  const packed = run(npmCommand, ['pack', '--json', '--pack-destination', tempRoot])
  const metadata = JSON.parse(packed.stdout)[0]
  const files = new Set(metadata.files.map(file => file.path))
  for (const required of ['index.mjs', 'index.d.mts', 'native.mjs', 'assets/shiki/catalog.mjs'])
    assert(files.has(required), `packed Ferriki package is missing ${required}`)
  assert([...files].some(file => /^dist\/ferriki\..+\.node$/.test(file)), 'packed Ferriki package is missing its platform addon')
  const forbidden = [
    file => file.startsWith('dist/chunks/'),
    file => file.endsWith('.wasm'),
    file => file.includes('shiki-rust'),
    file => file.includes('createJavaScriptRegexEngine'),
  ]
  for (const file of files)
    assert(!forbidden.some(predicate => predicate(file)), `packed Ferriki package contains forbidden runtime file ${file}`)
  assert(metadata.unpackedSize < 20_000_000, `packed Ferriki package exceeds the 20 MB unpacked budget (${metadata.unpackedSize})`)

  const tarball = join(tempRoot, metadata.filename)
  const consumer = await mkdtemp(join(tempRoot, 'consumer-'))
  run(npmCommand, ['init', '--yes'], { cwd: consumer, stdio: 'ignore' })
  // Sidecars are published independently. The main-package smoke intentionally
  // omits them so this gate remains runnable before the first coordinated npm release.
  run(npmCommand, ['install', '--ignore-scripts', '--omit=optional', '--offline', '--no-audit', '--no-fund', tarball], { cwd: consumer, stdio: 'ignore' })
  const consumerExample = join(consumer, 'ferromark-ardo.mjs')
  await cp(examplePath, consumerExample)
  run(process.execPath, [consumerExample], { cwd: consumer, stdio: 'inherit' })

  const consumerProbe = join(consumer, 'packed-probe.mjs')
  await writeFile(consumerProbe, `
import { codeToHast, codeToHtml, codeToTokens, createHighlighter } from 'ferriki'
import { tryLoadFerrikiNativeBinding } from 'ferriki/native'

if (!tryLoadFerrikiNativeBinding()?.ferrikiVersion())
  throw new Error('the packed ferriki/native export did not load')

const highlighter = await createHighlighter({ themes: ['nord'] })
await highlighter.loadLanguage('javascript')
const options = { lang: 'javascript', theme: 'nord' }
const html = highlighter.codeToHtml('const answer = 42', options)
const hast = highlighter.codeToHast('const answer = 42', options)
const tokens = highlighter.codeToTokens('const answer = 42', options)
if (!html.includes('const') || hast.type !== 'root' || tokens.tokens.length === 0)
  throw new Error('the packed Ferriki HTML/HAST/tokens calls did not produce output')

try {
  await codeToHtml('const missing = true', { lang: 'not-a-real-ferriki-language', theme: 'nord' })
  throw new Error('missing language unexpectedly rendered')
}
catch (error) {
  if (error?.code !== 'ERR_UNSUPPORTED')
    throw error
}

const lazy = await createHighlighter({ themes: ['nord'] })
await lazy.loadLanguage('typescript')
if (!lazy.codeToTokens('const answer: number = 42', { lang: 'typescript', theme: 'nord' }).tokens.length)
  throw new Error('packed lazy language loading did not produce tokens')
`)
  run(process.execPath, [consumerProbe], { cwd: consumer, stdio: 'inherit' })

  const typecheck = join(consumer, 'packed-types.mts')
  await writeFile(typecheck, `
import { codeToHtml, createHighlighter } from 'ferriki'

const highlighter = await createHighlighter({ themes: ['nord'] })
const html: string = highlighter.codeToHtml('const answer = 42', { lang: 'javascript', theme: 'nord' })
const oneShot: Promise<string> = codeToHtml('const answer = 42', { lang: 'javascript', theme: 'nord' })
void html
void oneShot
`)
  const tsc = join(nodeRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  run(process.execPath, [tsc, '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', typecheck], {
    cwd: consumer,
  })

  const installedReadme = await readFile(join(consumer, 'node_modules', 'ferriki', 'README.md'), 'utf8')
  assert(installedReadme.includes('Ferriki is a Shiki-compatible syntax highlighter'), 'packed README was not installed')
  console.log(`Ferriki packed consumer verified (${metadata.filename}, ${metadata.unpackedSize} bytes unpacked, ${files.size} files)`)
}
finally {
  await rm(tempRoot, { recursive: true, force: true })
}
