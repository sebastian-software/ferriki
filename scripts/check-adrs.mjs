// Keeps the living decision records in adr/ discoverable and dated (see
// adr/README.md): every record has a status from the declared vocabulary, a
// `Last updated` date and a dated History, its title carries its own number,
// a superseding record exists, and the index table lists every record with the
// status the record itself states. The content of a decision is reviewed by
// people; this only catches the drift that makes a record hard to trust.
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const adrDir = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'adr')

const RECORD_FILE = /^(?<number>\d{4})-[a-z0-9.-]+\.md$/
const STATUS = /^(?:Proposed|Accepted|Deprecated|Superseded by ADR (?<successor>\d{4}))$/
const DATE = '\\d{4}-\\d{2}-\\d{2}'
const LAST_UPDATED = new RegExp(`^Last updated: (${DATE})$`, 'm')
const HISTORY_ENTRY = new RegExp(`^- (${DATE}):`, 'gm')
const INDEX_ROW = /^\|\s*\[(?<number>\d{4})\]\((?<file>[^)]+)\)\s*\|[^|]*\|\s*(?<status>[^|]+?)\s*\|\s*$/gm

function section(text, heading) {
  const match = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text)
  return match ? match[1] : null
}

const errors = []
const files = (await readdir(adrDir)).filter(name => RECORD_FILE.test(name)).sort()
const records = new Map()

for (const file of files) {
  const { number } = RECORD_FILE.exec(file).groups
  const text = await readFile(join(adrDir, file), 'utf8')
  const fail = message => errors.push(`${file}: ${message}`)

  if (records.has(number))
    fail(`duplicate record number ${number}`)
  if (!new RegExp(`^# ADR ${number}: \\S`).test(text))
    fail(`title must start with "# ADR ${number}: "`)

  const statusBlock = section(text, 'Status')
  const status = statusBlock?.split('\n').map(line => line.trim()).find(Boolean) ?? ''
  const statusMatch = STATUS.exec(status)
  if (!statusMatch)
    fail(`status "${status}" is not one of Proposed, Accepted, Deprecated, "Superseded by ADR NNNN"`)

  const lastUpdated = statusBlock && LAST_UPDATED.exec(statusBlock)?.[1]
  if (!lastUpdated)
    fail('the Status section needs a "Last updated: YYYY-MM-DD" line')

  const history = section(text, 'History')
  const dates = history ? [...history.matchAll(HISTORY_ENTRY)].map(match => match[1]) : []
  if (dates.length === 0)
    fail('needs a "## History" section with at least one "- YYYY-MM-DD: ..." entry')
  const latest = dates.toSorted().at(-1)
  if (lastUpdated && latest && latest > lastUpdated)
    fail(`History has an entry from ${latest}, after "Last updated: ${lastUpdated}"`)

  records.set(number, { file, status, successor: statusMatch?.groups.successor })
}

for (const [number, record] of records) {
  if (record.successor && !records.has(record.successor))
    errors.push(`${record.file}: superseded by ADR ${record.successor}, which does not exist`)
  if (record.successor === number)
    errors.push(`${record.file}: cannot supersede itself`)
}

const index = await readFile(join(adrDir, 'README.md'), 'utf8')
const listed = new Map()
for (const row of index.matchAll(INDEX_ROW)) {
  const { number, file, status } = row.groups
  listed.set(number, { file, status })
  const record = records.get(number)
  if (!record) {
    errors.push(`README.md: lists ADR ${number}, but no adr/${number}-*.md exists`)
    continue
  }
  if (file !== record.file)
    errors.push(`README.md: ADR ${number} links ${file} instead of ${record.file}`)
  if (status !== record.status)
    errors.push(`README.md: ADR ${number} is "${status}" in the index but "${record.status}" in ${record.file}`)
}
for (const [number, record] of records) {
  if (!listed.has(number))
    errors.push(`README.md: ${record.file} is missing from the index table`)
}

if (errors.length > 0) {
  console.error(`Decision records need attention:\n- ${errors.join('\n- ')}`)
  process.exit(1)
}
console.log(`Decision records verified (${records.size} records, index in sync)`)
