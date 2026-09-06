// The Ferramenta family block in both READMEs is rendered from the family
// registry in sebastian-software/ferramenta, so a new member, a renamed tool
// or a reworded job reaches this repository by bumping one pin and rerunning
// this script — not by hand-editing two tables that then drift apart.
//
// Without an argument (or with `--write`) the script writes the block. With
// `--check` it fails when a README has drifted; the generator compares
// content, not whitespace, so a Markdown formatter padding table cells and
// adding blank lines around HTML comments is not drift.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// The single pin for this repository. Bump it to adopt a registry change,
// then rerun the script without `--check` and commit the regenerated block.
const REGISTRY_PIN = 'd63a0b163ef3e5e68cd1c77e5c8871ac72c36b60'

// The `&path:` part is required: without it pnpm installs the site instead of
// the package and there is no `ferramenta-readme` binary to run.
const GENERATOR = `github:sebastian-software/ferramenta#${REGISTRY_PIN}&path:/packages/ardo-config`
const TOOL = 'ferriki'

// The root README carries the full grouped block. `node/ferriki/README.md` is
// what npmjs.com renders, and npm strips the HTML the `github` variant uses,
// so it carries the two-line `registry` variant. The platform sidecar packages
// under `node/platforms/` are install-time artifacts, not a product surface,
// and deliberately carry no block.
const TARGETS = [
  { readme: 'README.md', variant: 'github' },
  { readme: 'node/ferriki/README.md', variant: 'registry' },
]

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const args = process.argv.slice(2)
const unknown = args.filter(arg => arg !== '--check' && arg !== '--write')
if (unknown.length > 0) {
  console.error(`[sync-readme-family] unknown argument: ${unknown.join(' ')}`)
  console.error('usage: node scripts/sync-readme-family.mjs [--check | --write]')
  process.exit(2)
}

const mode = args.includes('--check') ? '--check' : '--write'

// Windows cannot spawn `pnpm.cmd` without a shell, and a shell would read the
// `&` in the generator reference as a command separator, so quote it there.
const shell = process.platform === 'win32'
const generator = shell ? `"${GENERATOR}"` : GENERATOR

let failed = false
for (const target of TARGETS) {
  const result = spawnSync(
    'pnpm',
    ['dlx', generator, '--current', TOOL, '--variant', target.variant, mode, target.readme],
    { cwd: repoRoot, shell, stdio: 'inherit' },
  )

  if (result.error) {
    console.error(`[sync-readme-family] could not run pnpm: ${result.error.message}`)
    process.exit(2)
  }

  if (result.status !== 0) {
    failed = true
    if (mode === '--check')
      console.error(`[sync-readme-family] ${target.readme} is out of date — rerun \`node scripts/sync-readme-family.mjs\``)
  }
}

if (failed)
  process.exit(1)

console.log(`[sync-readme-family] ${mode === '--check' ? 'verified' : 'wrote'} ${TARGETS.length} README family blocks from registry pin ${REGISTRY_PIN.slice(0, 7)}`)
