// Contract test for the decision record check. Each case breaks one rule of
// adr/README.md, so the checker must keep rejecting it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const checker = join(fileURLToPath(new URL('.', import.meta.url)), 'check-adrs.mjs')

function record(number, { status = 'Accepted', updated = '2026-09-30', history = '- 2026-09-30: Accepted.', title = `# ADR ${number}: Example` } = {}) {
  return `${title}\n\n## Status\n\n${status}\n\n${updated === null ? '' : `Last updated: ${updated}\n`}\n## Context\n\nWhy.\n\n## Decision\n\nWhat.\n\n## Consequences\n\nSo.\n${history === null ? '' : `\n## History\n\n${history}\n`}`
}

function index(rows) {
  return `# Architecture Decision Records\n\n| ADR | Decision | Status |\n| --- | --- | --- |\n${rows.map(([number, status]) => `| [${number}](${number}-example.md) | Example | ${status} |`).join('\n')}\n`
}

const valid = { '0001-example.md': record('0001'), 'README.md': index([['0001', 'Accepted']]) }

const cases = [
  { name: 'a complete record and index', files: valid, status: 0 },
  {
    name: 'a record missing from the index',
    files: { ...valid, '0002-example.md': record('0002') },
    status: 1,
    expect: 'missing from the index',
  },
  {
    name: 'an index status that disagrees with the record',
    files: { ...valid, 'README.md': index([['0001', 'Proposed']]) },
    status: 1,
    expect: 'is "Proposed" in the index',
  },
  {
    name: 'an index row without a record',
    files: { ...valid, 'README.md': index([['0001', 'Accepted'], ['0002', 'Accepted']]) },
    status: 1,
    expect: 'no adr/0002-*.md exists',
  },
  {
    name: 'a status outside the vocabulary',
    files: { '0001-example.md': record('0001', { status: 'Accepted | Superseded' }), 'README.md': index([['0001', 'Accepted | Superseded']]) },
    status: 1,
    expect: 'is not one of',
  },
  {
    name: 'a missing Last updated line',
    files: { ...valid, '0001-example.md': record('0001', { updated: null }) },
    status: 1,
    expect: 'Last updated',
  },
  {
    name: 'a missing History',
    files: { ...valid, '0001-example.md': record('0001', { history: null }) },
    status: 1,
    expect: 'History',
  },
  {
    name: 'a History entry newer than Last updated',
    files: { ...valid, '0001-example.md': record('0001', { updated: '2026-09-01', history: '- 2026-09-30: Changed.' }) },
    status: 1,
    expect: 'after "Last updated',
  },
  {
    name: 'a title with the wrong number',
    files: { ...valid, '0001-example.md': record('0001', { title: '# ADR 0002: Example' }) },
    status: 1,
    expect: 'title must start',
  },
  {
    name: 'a successor that does not exist',
    files: { '0001-example.md': record('0001', { status: 'Superseded by ADR 0009' }), 'README.md': index([['0001', 'Superseded by ADR 0009']]) },
    status: 1,
    expect: 'which does not exist',
  },
]

let failures = 0
for (const testCase of cases) {
  const dir = await mkdtemp(join(tmpdir(), 'ferriki-adrs-'))
  try {
    for (const [name, content] of Object.entries(testCase.files))
      await writeFile(join(dir, name), content)
    const result = spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' })
    assert.equal(result.status, testCase.status, `${testCase.name}: exit status\n${result.stdout}${result.stderr}`)
    if (testCase.expect)
      assert.match(result.stderr, new RegExp(testCase.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), testCase.name)
  }
  catch (error) {
    failures++
    console.error(error.message)
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (failures > 0)
  process.exit(1)
console.log(`Decision record check verified (${cases.length} cases)`)
