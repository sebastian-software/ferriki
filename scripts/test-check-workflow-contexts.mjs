// Contract test for the workflow context check. Job-level env must reject
// contexts that GitHub Actions does not expose at that workflow key.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const checker = join(fileURLToPath(new URL('.', import.meta.url)), 'check-workflow-contexts.mjs')
const cases = [
  {
    name: 'runner is rejected in job-level env',
    workflow: 'jobs:\n  update:\n    env:\n      CANDIDATE: ${{ runner.temp }}\n    steps: []\n',
    status: 1,
    expect: 'jobs.update.env uses unavailable context "runner"',
  },
  {
    name: 'step context is rejected in job-level env',
    workflow: 'jobs:\n  update:\n    env: { VALUE: ${{ steps.prepare.outputs.changed }} }\n',
    status: 1,
    expect: 'uses unavailable context "steps"',
  },
  {
    name: 'allowed job-level contexts pass',
    workflow: 'jobs:\n  update:\n    env:\n      REF: ${{ github.ref }}\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}\n      OUTPUT: ${{ needs.prepare.outputs.value }}\n    steps: []\n',
    status: 0,
  },
  {
    name: 'runner is allowed in step-level env',
    workflow: 'jobs:\n  update:\n    steps:\n      - name: Prepare\n        env:\n          CANDIDATE: ${{ runner.temp }}\n        run: echo ready\n',
    status: 0,
  },
]

const root = await mkdtemp(join(tmpdir(), 'ferriki-workflow-contexts-'))
try {
  for (const testCase of cases) {
    const directory = await mkdtemp(join(root, 'workflows-'))
    await writeFile(join(directory, 'ci.yml'), testCase.workflow)
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })
    assert.equal(
      result.status,
      testCase.status,
      `${testCase.name}: expected exit ${testCase.status}, got ${result.status}\n${result.stdout}${result.stderr}`,
    )
    if (testCase.expect)
      assert.match(result.stderr, new RegExp(testCase.expect), `${testCase.name}: unexpected output\n${result.stderr}`)
  }
}
finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`Workflow context check contract verified (${cases.length} cases)`)
