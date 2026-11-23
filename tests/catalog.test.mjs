/** The project catalog: how it reads, what it caches, and what it reports. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { readTextSafe } from '../src/fsx.js'
import { createProjectCatalog } from '../src/host/catalog.js'
import { ARCHIVE_AFTER_DAYS } from '../src/write/archive.js'

const LAYERED = { inject: { mode: 'layered' } }
const OVER_SHARE = `# M\n\n## 常驻记忆\n${Array.from({ length: 6 }, (_, index) => `- 核心条目 ${index} ${'重要'.repeat(140)}`).join('\n')}\n`

/** A topic section long enough to bring the whole file to `total` UTF-16 units. */
const padded = (head, total) => head + '- 资料条目，占位。\n'.repeat(Math.ceil((total - head.length) / 11))

/** A home with projects, and a catalog over it whose file reads are counted. */
function workspace(config = LAYERED) {
  const root = mkdtempSync(join(tmpdir(), 'wbm-catalog-'))
  const home = join(root, 'home')
  mkdirSync(join(home, 'memory'), { recursive: true })
  const seen = new Map()
  let clock = Date.now() - 3_600_000
  const add = (name, memory, daily = []) => {
    const cwd = join(root, name)
    const dir = join(cwd, '.workbuddy', 'memory')
    mkdirSync(dir, { recursive: true })
    const files = [join(dir, 'MEMORY.md'), ...daily.map((date) => join(dir, `${date}.md`))]
    if (memory !== undefined) writeFileSync(files[0], memory, 'utf8')
    daily.forEach((date, index) => writeFileSync(files[index + 1], '- 一天\n', 'utf8'))
    // A file written "now" would outrank the seen stamps below and make the
    // activity order depend on write timing; the stamps own the order here.
    const old = new Date(clock - 3_600_000)
    for (const file of files) if (existsSync(file)) utimesSync(file, old, old)
    clock += 1000
    seen.set(cwd, clock)
    return cwd
  }
  const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(root, 'state'), ...config })
  const open = (overrides = {}) => {
    const counts = { reads: 0, lists: 0 }
    const catalog = createProjectCatalog({
      cfg,
      recent: { cwd: null, seen },
      registry: () => [],
      read: (path, options) => {
        counts.reads += 1
        return readTextSafe(path, options)
      },
      ...overrides,
    })
    const list = (options = {}) => {
      counts.lists += 1
      return catalog.list({ home, dataFolderName: '.workbuddy', ...options })
    }
    return { catalog, counts, list }
  }
  return { root, home, cfg, add, seen, open }
}

test('a cold catalog reads each memory file once; a warm one reads nothing', () => {
  const ws = workspace()
  const a = ws.add('a', '# A\n\n## 常驻记忆\n- a\n')
  ws.add('b', '# B\n\n## 常驻记忆\n- b\n')
  ws.add('c')
  const { list, counts } = ws.open()

  assert.equal(list().rows.length, 3)
  assert.equal(counts.reads, 2, 'one read per memory file that exists')

  list()
  list()
  assert.equal(counts.reads, 2, 'an unchanged file is not read again')

  writeFileSync(join(a, '.workbuddy', 'memory', 'MEMORY.md'), '# A\n\n## 常驻记忆\n- a, changed\n', 'utf8')
  const [row] = list().rows
  assert.equal(counts.reads, 3, 'a changed file is read exactly once more')
  assert.equal(row.entries, 1)
})

test('the state follows the config on every call, without another read', () => {
  const ws = workspace()
  ws.add('a', padded('# M\n\n## 常驻记忆\n- core\n\n## 资料\n', 12000).slice(0, 12000))
  const { list, counts } = ws.open()

  assert.equal(list().rows[0].injection.status, 'complete')
  assert.equal(counts.reads, 1)

  // A volatile update deep-assigns into the one `cfg` object every closure holds.
  ws.cfg.inject.limits.project = 0
  assert.equal(list().rows[0].injection.status, 'disabled')

  ws.cfg.inject.limits.project = 10000
  ws.cfg.inject.project = false
  assert.equal(list().rows[0].injection.status, 'disabled')

  ws.cfg.inject.project = true
  ws.cfg.inject.mode = 'full'
  const whole = list().rows[0].injection
  assert.equal(whole.status, 'truncated', 'whole-file injection cuts a 12,000-unit file at 10,000')

  ws.cfg.inject.mode = 'layered'
  ws.cfg.inject.coreBudget = 4000
  assert.equal(list().rows[0].injection.status, 'complete')
  assert.equal(counts.reads, 1, 'no configuration change touched the disk')
})

test('a core past its share is reported from the renderer, with the count it dropped', () => {
  const ws = workspace()
  ws.add('a', OVER_SHARE)
  const { injection, overLimit, status } = ws.open().list().rows[0]

  assert.equal(injection.status, 'core-over-budget')
  assert.equal(injection.overLimit, true)
  assert.equal(injection.dropped > 0, true)
  assert.equal(injection.mode, 'layered')
  assert.equal(injection.fallback, null)
  assert.equal(injection.budget, 1400)
  assert.equal(injection.need > injection.budget, true)
  // `overLimit` and `status` stay as the projections older callers read.
  assert.equal(overLimit, true)
  assert.equal(status, 'over-limit')
})

test('a file past the read cap is unmeasurable, and no length is invented for it', () => {
  const ws = workspace()
  ws.add('a', `${'- 很长\n'.repeat(260000)}\n## 常驻记忆\n- core\n`)
  const row = ws.open().list().rows[0]

  assert.ok(row.bytes > 2 * 1024 * 1024, `fixture is ${row.bytes} bytes`)
  assert.equal(row.hasMemory, true, 'the file exists')
  assert.equal(row.injection.status, 'unmeasurable')
  assert.equal(row.injection.reason, 'too_large')
  assert.equal(row.injection.overLimit, false, 'an unmeasured file is not counted')
  assert.equal(row.chars, null)
  assert.equal(row.entries, null)
  assert.equal(row.overLimit, false)
  assert.equal(row.status, 'unreadable')
})

test('a large file inside the cap is judged by everything in it', () => {
  // The catalog used to parse only the first 256 KiB, so a core heading that
  // came later was never seen (the file read as "no core") and a second core
  // heading past the cap was never noticed (the file read as split).
  const filler = '- 资料条目，占位。\n'.repeat(40000)
  const ws = workspace()
  ws.add('late', `## 资料\n${filler}\n## 常驻记忆\n- core\n`)
  ws.add('twice', `## 常驻记忆\n- a\n\n## 资料\n${filler}\n## 常驻记忆\n- b\n`)
  const rows = ws.open().list().rows
  const late = rows.find((row) => row.name === 'late').injection
  const twice = rows.find((row) => row.name === 'twice').injection

  assert.equal(late.status, 'complete')
  assert.equal(late.mode, 'layered')
  assert.equal(late.fallback, null, 'the core heading past 256 KiB is found')

  assert.equal(twice.mode, 'whole')
  assert.equal(twice.fallback, 'legacy')
  assert.equal(twice.reason, 'ambiguous_core', 'the second core past 256 KiB is found')
})

test('entries include the bullets written above the first heading', () => {
  const ws = workspace()
  ws.add('a', '- 顶部一条\n\n## 小节\n- 小节一条\n')
  const row = ws.open().list().rows[0]
  assert.equal(row.entries, 2, 'the detail view counts both; so must the catalog')
})

test('no entry text leaves the catalog', () => {
  // `/state` is polled every few seconds: a row may carry counts, never content.
  const ws = workspace()
  const secret = 'SUPER-SECRET-ENTRY-TEXT'
  ws.add('a', `# M\n\n## 常驻记忆\n- ${secret}\n\n## 主题\n- 也提到 ${secret}\n`)
  const serialized = JSON.stringify(ws.open().list())
  assert.equal(serialized.includes(secret), false, 'entry text appears in the catalog output')
})

test('a missing, blank, and unreadable file are three different states', () => {
  const ws = workspace()
  ws.add('none')
  ws.add('blank', '  \n\n')
  ws.add('legacy', '## 偏好\n- 一条\n')
  const rows = ws.open().list().rows
  const byName = (name) => rows.find((row) => row.name === name)

  assert.equal(byName('none').injection.status, 'missing')
  assert.equal(byName('none').hasMemory, false)
  assert.equal(byName('blank').injection.status, 'empty')
  assert.equal(byName('blank').hasMemory, true, 'created, even though blank')
  assert.equal(byName('legacy').injection.fallback, 'legacy')
  assert.equal(byName('legacy').injection.status, 'complete')
  assert.equal(byName('legacy').injection.mode, 'whole')

  const { list } = ws.open({
    read: () => ({ ok: false, text: '', bytes: 0, mtimeMs: 0, truncated: false, error: 'EACCES' }),
  })
  const denied = list().rows.find((row) => row.name === 'legacy')
  assert.equal(denied.injection.status, 'unmeasurable')
  assert.equal(denied.injection.reason, 'unreadable')
  assert.equal(denied.chars, null)
})

test('a directory where MEMORY.md should be is not a file', () => {
  const ws = workspace()
  const cwd = ws.add('dir')
  mkdirSync(join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), { recursive: true })
  const row = ws.open().list().rows[0]
  assert.equal(row.injection.status, 'unmeasurable')
  assert.equal(row.injection.reason, 'not_a_file')
  assert.deepEqual(readdirSync(join(cwd, '.workbuddy', 'memory')), ['MEMORY.md'], 'nothing was written')
})

/** A calendar date `days` before today, as a daily file names it. */
const daysAgo = (days) => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

test('totals count every project, not only the rows returned', () => {
  // Acceptance 7: 60 projects, a display bound of 50, and the one project
  // that is over budget is the 51st by activity — past the bound.
  const ws = workspace()
  ws.cfg.ui.maxProjects = 50
  for (let index = 0; index < 60; index += 1) {
    const memory = index === 9 ? OVER_SHARE : '# M\n\n## 常驻记忆\n- one\n'
    ws.add(`p${String(index).padStart(2, '0')}`, memory, index === 9 ? [daysAgo(31)] : [])
  }
  const page = ws.open().list()

  assert.equal(page.rows.length, 50)
  assert.equal(page.total, 60)
  assert.equal(page.truncated, true)
  assert.equal(page.rows.some((row) => row.name === 'p09'), false, 'the 51st project is not in the list')

  assert.equal(page.totals.projects, 60, 'every project, not the 50 shown')
  assert.equal(page.totals.withMemory, 60)
  assert.equal(page.totals.entries, 59 + 6, 'every entry of every file')
  assert.equal(page.totals.overLimit, 1, 'counted once for the one project that lost core entries')
  assert.equal(page.totals.stale, 1)

  assert.equal(page.attentionTotal, 1)
  assert.equal(page.attention.length, 1)
  const [item] = page.attention
  assert.equal(item.name, 'p09')
  assert.equal(typeof item.key, 'string')
  assert.equal(item.hasMemory, true, 'the preview carries enough to open the project')
  assert.equal(item.latestDaily, daysAgo(31))
  assert.deepEqual(item.reasons, ['over-limit', 'stale'], 'one project, both reasons')
  assert.equal(item.injection.status, 'core-over-budget')
})

test('the attention preview is bounded and says how many more there are, by kind', () => {
  const ws = workspace()
  for (let index = 0; index < 12; index += 1) ws.add(`over${String(index).padStart(2, '0')}`, OVER_SHARE)
  for (let index = 0; index < 3; index += 1) ws.add(`stale${index}`, '# M\n\n## 常驻记忆\n- one\n', [daysAgo(40)])
  const page = ws.open().list()

  assert.equal(page.attentionTotal, 15)
  assert.ok(page.attention.length < 15, `the preview is bounded: ${page.attention.length}`)
  const previewed = new Set(page.attention.map((item) => item.key))
  const beyond = page.attentionMore
  assert.equal(beyond['over-limit'], 12 - page.attention.filter((item) => item.reasons.includes('over-limit')).length)
  assert.equal(beyond.stale, 3 - page.attention.filter((item) => item.reasons.includes('stale')).length)
  assert.equal(previewed.size, page.attention.length, 'a project with two reasons is listed once')

  // Asking for the whole list is the caller's decision, and it is honoured.
  const all = ws.open().list({ attention: 'all' })
  assert.equal(all.attention.length, 15)
  assert.deepEqual(all.attentionMore, { 'over-limit': 0, stale: 0, missing: 0, unmeasurable: 0 }, 'every kind is always present')
})

test('a project whose directory is gone is attention, and is counted on its own', () => {
  const ws = workspace()
  const gone = ws.add('gone', '# M\n\n## 常驻记忆\n- one\n')
  rmSync(gone, { recursive: true, force: true })
  const page = ws.open().list()
  assert.equal(page.totals.projects, 1)
  assert.equal(page.totals.missing, 1)
  assert.deepEqual(page.attention[0].reasons, ['missing'])
  assert.equal(page.attention[0].exists, false)
})
test('the archive warning and the default archive preview share one day boundary', () => {
  // Acceptance 8: a note exactly 30 days old is already in the default archive
  // preview, so it is already "to archive" — the warning used to wait for 31.
  const ws = workspace()
  ws.add('d29', '# M\n\n## 常驻记忆\n- one\n', [daysAgo(29)])
  ws.add('d30', '# M\n\n## 常驻记忆\n- one\n', [daysAgo(30)])
  ws.add('d31', '# M\n\n## 常驻记忆\n- one\n', [daysAgo(31)])
  const page = ws.open().list()
  const stale = (name) => page.rows.find((row) => row.name === name).stale

  assert.equal(stale('d29'), false)
  assert.equal(stale('d30'), true, 'exactly 30 days is a candidate, so it is flagged')
  assert.equal(stale('d31'), true)
  assert.equal(page.totals.stale, 2)
  assert.equal(ARCHIVE_AFTER_DAYS, 30)
})

test('the master injection switch reaches the catalog, and a file that is over budget is not flagged while it is off', () => {
  // Acceptance 4, through the real catalog: with `inject.enabled` off nothing
  // is injected, so nothing is over budget — whatever the file looks like.
  const ws = workspace()
  ws.add('over', OVER_SHARE)
  const { list } = ws.open()
  const flagged = list().rows[0]
  assert.equal(flagged.injection.status, 'core-over-budget')
  assert.equal(flagged.overLimit, true)
  assert.equal(list().totals.overLimit, 1)

  ws.cfg.inject.enabled = false
  const off = list()
  assert.equal(off.rows[0].injection.status, 'disabled')
  assert.equal(off.rows[0].overLimit, false)
  assert.equal(off.totals.overLimit, 0, 'the overview count follows the switch')
  assert.equal(off.attentionTotal, 0)

  ws.cfg.inject.enabled = true
  const back = list()
  assert.equal(back.rows[0].injection.status, 'core-over-budget', 'back on, judged from the current config')
  assert.equal(back.totals.overLimit, 1)
})
