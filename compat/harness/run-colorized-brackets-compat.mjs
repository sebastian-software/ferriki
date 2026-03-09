import { spawnSync } from 'node:child_process'
import process from 'node:process'

const files = [
  'compat/upstream/shiki/packages/colorized-brackets/test/bracket-customization.test.ts',
  'compat/upstream/shiki/packages/colorized-brackets/test/dual-themes.test.ts',
  'compat/upstream/shiki/packages/colorized-brackets/test/explicit-trigger.test.ts',
]

let exitCode = 0

for (const file of files) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', file, '--run', '--pool', 'forks', '--poolOptions.forks.singleFork', '--no-file-parallelism', '--no-isolate'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        SHIKI_BACKEND: 'rust',
      },
    },
  )

  if ((result.status ?? 1) !== 0)
    exitCode = result.status ?? 1
}

process.exit(exitCode)
