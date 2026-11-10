import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { probeEnvironment } from '../src/env.js'
import { contentRevision } from '../src/write/fslock.js'
import { createStore, localDateStamp } from '../src/write/store.js'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'wbm-'))
  const cwd = join(root, 'repo')
  const memoryDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const home = join(root, 'home')
  mkdirSync(join(home, 'memory'), { recursive: true })
  return { root, cwd, memoryDir, home }
}

function setup(overrides = {}) {
  const space = workspace()
  const cfg = normalizeConfig(overrides)
  const env = { WORKBUDDY_CONFIG_DIR: space.home }
  const probe = probeEnvironment({ cfg, cwd: space.cwd, env, home: space.root, detail: true })
  const store = createStore({ cfg, stateDir: join(space.root, 'state') })
  return { ...space, cfg, probe, store }
}

test('append creates the file and a section when nothing exists', async () => {
  const s = setup()
  const result = await s.store.append({ target: 'project-memory', section: '偏好', text: '用简体中文' }, s.probe)
  assert.equal(result.ok, true)
  const text = readFileSync(join(s.memoryDir, 'MEMORY.md'), 'utf8')
  assert.ok(text.includes('## 偏好'))
  assert.ok(text.includes('- 用简体中文'))
  assert.equal(result.revision, contentRevision(text))
})

test('append adds one line and preserves the rest', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '# Memory\n\n## 偏好\n- 用简体中文\n\n## 项目\n- A\n'
  writeFileSync(file, before, 'utf8')

  const result = await s.store.append({ target: 'project-memory', section: '偏好', text: '不用人称代词' }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), before.replace('- 用简体中文\n', '- 用简体中文\n- 不用人称代词\n'))
})

test('a stale revision is refused instead of overwriting', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')

  const stale = contentRevision('something the caller saw earlier')
  const result = await s.store.append(
    { target: 'project-memory', section: 'A', text: 'two', expectedRevision: stale },
    s.probe,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n')
})

test('the current revision is accepted', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '## A\n- one\n'
  writeFileSync(file, before, 'utf8')

  const result = await s.store.append(
    { target: 'project-memory', section: 'A', text: 'two', expectedRevision: contentRevision(before) },
    s.probe,
  )
  assert.equal(result.ok, true)
  assert.ok(readFileSync(file, 'utf8').includes('- two'))
})

test('read-only refuses before touching anything', async () => {
  const s = setup({ readOnly: true })
  const result = await s.store.append({ target: 'project-memory', section: 'A', text: 'x' }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'read_only')
})

test('replaying an operationId does not write twice', async () => {
  const s = setup()
  const first = await s.store.append({ target: 'project-memory', section: 'A', text: 'x', operationId: 'op-1' }, s.probe)
  const second = await s.store.append({ target: 'project-memory', section: 'A', text: 'x', operationId: 'op-1' }, s.probe)
  assert.equal(first.ok, true)
  assert.equal(second.duplicate, true)
  const text = readFileSync(join(s.memoryDir, 'MEMORY.md'), 'utf8')
  assert.equal(text.split('- x').length - 1, 1)
})

test('daily append keeps what was already in the file', async () => {
  const s = setup()
  const file = join(s.memoryDir, '2026-11-09.md')
  writeFileSync(file, '# 2026-11-09\n\n- 上午：写代码', 'utf8')

  const result = await s.store.append({ target: 'project-daily', date: '2026-11-09', text: '下午：测试' }, s.probe)
  assert.equal(result.ok, true)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('# 2026-11-09\n\n- 上午：写代码'))
  assert.ok(text.includes('- 下午：测试'))
})

test('two concurrent appends both land', async () => {
  const s = setup()
  const results = await Promise.all([
    s.store.append({ target: 'project-memory', section: 'A', text: 'one' }, s.probe),
    s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe),
  ])
  assert.ok(results.every((result) => result.ok), JSON.stringify(results))
  const text = readFileSync(join(s.memoryDir, 'MEMORY.md'), 'utf8')
  assert.ok(text.includes('- one'))
  assert.ok(text.includes('- two'))
})

test('edit removes exactly one entry', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n- two\n', 'utf8')
  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: 'one', mode: 'remove' }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n\n- two\n')
})

test('a missing memory directory is reported, not created', async () => {
  const s = setup()
  const empty = join(s.root, 'norepo')
  mkdirSync(empty, { recursive: true })
  const probe = probeEnvironment({ cfg: s.cfg, cwd: empty, env: { WORKBUDDY_CONFIG_DIR: s.home }, home: s.root })
  const result = await s.store.append({ target: 'project-memory', section: 'A', text: 'x' }, probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_store')
})

test('the daily file follows the local calendar day, not UTC', async () => {
  const s = setup()
  // 00:30 in a UTC+8 zone is still the previous day in UTC; the note a person
  // writes at half past midnight must land in today's file.
  const now = new Date('2026-11-10T00:30:00+08:00')
  assert.equal(localDateStamp(now), '2026-11-10')

  const result = await s.store.append({ target: 'project-daily', text: '凌晨一条' }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(basename(result.path), `${localDateStamp()}.md`)
})

test('edit without a replacement is refused, not turned into a delete', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n- two\n', 'utf8')

  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: 'one' }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty_text')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n- two\n')
})

test('edit keeps the bullet marker when the client sends only the body', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n- two\n', 'utf8')

  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: 'one', replacement: 'ONE' }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- ONE\n- two\n')
})

test('edit refuses prose instead of rewriting it', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '## A\n\n说明：one 是常用选项。\n- one\n'
  writeFileSync(file, before, 'utf8')

  // The bullet is still found when prose also contains the text.
  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: 'one', replacement: 'ONE' }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n\n说明：one 是常用选项。\n- ONE\n')

  writeFileSync(file, '## A\n\n说明：only prose here。\n', 'utf8')
  const proseOnly = await s.store.edit({ target: 'project-memory', section: 'A', match: 'only prose', replacement: 'x' }, s.probe)
  assert.equal(proseOnly.ok, false)
  assert.equal(proseOnly.code, 'not_an_entry')
  assert.equal(readFileSync(file, 'utf8'), '## A\n\n说明：only prose here。\n')
})

test('editAt rewrites one row by line and refuses a stale line', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n- two\n', 'utf8')

  const before = readFileSync(file, 'utf8')
  const result = await s.store.editAt({ target: 'project-memory', section: 'A', line: 1, replacement: '- ONE', expectedRevision: contentRevision(before) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- ONE\n- two\n')

  // The heading still exists but the line index no longer holds an entry.
  const moved = await s.store.editAt({ target: 'project-memory', section: 'A', line: 9, replacement: '- x' }, s.probe)
  assert.equal(moved.ok, false)
  assert.equal(moved.code, 'stale_line')
})

test('remove deletes exactly the named line', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n- two\n- three\n', 'utf8')
  const result = await s.store.remove({ target: 'project-memory', section: 'A', line: 2 }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n\n- three\n')
})

test('revisions are listed per file and read back verbatim', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')
  const first = await s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe)
  assert.equal(first.ok, true)

  const rows = s.store.listRevisions(file)
  assert.equal(rows.length, 1)
  const snapshot = s.store.readRevision(file, rows[0].name)
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.text, '## A\n- one\n')

  // An unknown name is refused rather than turned into a path.
  assert.equal(s.store.readRevision(file, '../../../etc/passwd').ok, false)
})

test('restore puts the snapshot back and backs up what it replaced', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')
  await s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe)
  const rows = s.store.listRevisions(file)
  const current = readFileSync(file, 'utf8')

  const result = await s.store.restore({ target: 'project-memory', name: rows[0].name, expectedRevision: contentRevision(current) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n')
  assert.equal(s.store.listRevisions(file).length, 2, 'the replaced version became a backup too')

  const missing = await s.store.restore({ target: 'project-memory', name: 'nope.md', expectedRevision: contentRevision('## A\n- one\n') }, s.probe)
  assert.equal(missing.code, 'no_revision')
})

test('consolidate plans by age, then moves entries instead of copying them', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## 环境\n- Node 22\n', 'utf8')
  writeFileSync(join(s.memoryDir, '2026-01-02.md'), '- 老的一\n- 老的二\n', 'utf8')
  writeFileSync(join(s.memoryDir, '2099-01-01.md'), '- 未来的\n', 'utf8')

  const plan = await s.store.consolidate({ beforeDays: 30, dryRun: true }, s.probe)
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)
  assert.deepEqual(plan.candidates.map((row) => row.date), ['2026-01-02'])
  assert.equal(plan.entries, 2)

  const merged = await s.store.consolidate({ beforeDays: 30, dryRun: false, dates: ['2026-01-02'] }, s.probe)
  assert.equal(merged.ok, true)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /## 2026-01-02/)
  assert.match(text, /- 老的一/)
  assert.match(text, /- 老的二/)
  assert.doesNotMatch(readFileSync(join(s.memoryDir, '2026-01-02.md'), 'utf8'), /老的一/)
  assert.match(readFileSync(join(s.memoryDir, '2099-01-01.md'), 'utf8'), /未来的/)
})

test('consolidate with nothing old enough says so instead of writing', async () => {
  const s = setup()
  writeFileSync(join(s.memoryDir, '2099-01-01.md'), '- 未来的\n', 'utf8')
  const result = await s.store.consolidate({ beforeDays: 30, dryRun: false }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'nothing_to_consolidate')
})

test('the ledger counts conflicts, not just commits', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')
  await s.store.editAt({ target: 'project-memory', section: 'A', line: 1, replacement: '- two', expectedRevision: contentRevision('## A\n- one\n') }, s.probe)
  await s.store.editAt({ target: 'project-memory', section: 'A', line: 1, replacement: '- three', expectedRevision: 'stale' }, s.probe)

  const stats = s.store.operationStats()
  assert.equal(stats.conflicts, 1)
  assert.equal(typeof stats.lastConflictAt, 'number')
  assert.equal(typeof stats.lastCommitAt, 'number')
})
