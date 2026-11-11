/** The six memory tools, exercised through their real definitions. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { createTranslator } from '../src/locale.js'
import { appendTool, editTool, pruneTool } from '../src/tools/write.js'
import { readTool } from '../src/tools/read.js'
import { searchTool } from '../src/tools/search.js'
import { statusTool } from '../src/tools/status.js'
import { createStore } from '../src/write/store.js'

const t = createTranslator('zh')

/** A workspace with project memory, one daily note and a user file. */
function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wbm-tools-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  const dir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(join(home, 'memory'), { recursive: true })
  mkdirSync(dir, { recursive: true })

  writeFileSync(join(dir, 'MEMORY.md'), '## 偏好\n- 用简体中文\n- 避免人称代词\n', 'utf8')
  writeFileSync(join(dir, '2026-11-08.md'), '- 讨论过升级\n', 'utf8')
  writeFileSync(join(home, 'MEMORY.md'), '- 全局条目\n', 'utf8')

  const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(root, 'state'), ...config })
  const store = createStore({ cfg, stateDir: join(root, 'state') })
  const deps = { cfg, t, store }
  const exec = { agent: { session: { header: { cwd } } } }

  return {
    root,
    home,
    cwd,
    dir,
    cfg,
    exec,
    tools: {
      status: statusTool(deps),
      read: readTool(deps),
      search: searchTool(deps),
      append: appendTool(deps),
      edit: editTool(deps),
      prune: pruneTool(deps),
    },
  }
}

test('memory_status reports the stores and warnings', async () => {
  const { tools, exec, home, cwd } = fixture()
  const result = await tools.status.execute({}, exec)

  assert.equal(result.ok, true)
  assert.equal(result.status, 'ok')
  assert.equal(result.home.path, home)
  assert.equal(result.stores.project.exists, true)
  assert.equal(result.stores.project.memoryExists, true)
  assert.deepEqual(result.stores.project.dailyFiles, ['2026-11-08.md'])
  assert.equal(result.stores.user.memory, join(home, 'MEMORY.md'))
  assert.equal(result.readOnly, false)
  assert.deepEqual(result.warnings, [])
  void cwd
})

test('memory_status explains an empty machine instead of failing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wbm-empty-'))
  const cfg = normalizeConfig({ workbuddyHome: join(root, 'nohome'), stateDir: join(root, 'state') })
  const result = await statusTool({ cfg, t }).execute({}, { agent: { session: { header: { cwd: join(root, 'nowhere') } } } })

  assert.equal(result.status, 'no_store')
  assert.equal(result.ok, false)
  assert.equal(result.warnings.length > 0, true)
})

test('memory_status warns about read-only mode', async () => {
  const { tools, exec } = fixture({ readOnly: true })
  const result = await tools.status.execute({}, exec)
  assert.equal(result.readOnly, true)
  assert.equal(result.status, 'read_only')
  assert.equal(result.warnings.some((line) => /只读|read-only/.test(line)), true)
})

test('memory_read returns revision, sections and body', async () => {
  const { tools, exec } = fixture()
  const full = await tools.read.execute({ target: 'project-memory' }, exec)

  assert.equal(full.ok, true)
  assert.equal(typeof full.revision, 'string')
  assert.equal(full.sections.length, 1)
  assert.equal(full.sections[0].heading, '偏好')
  assert.equal(full.sections[0].entries, 2)
  assert.match(full.content, /用简体中文/)

  const only = await tools.read.execute({ target: 'project-memory', sectionsOnly: true }, exec)
  assert.equal(only.content, undefined)
  assert.equal(only.sections[0].line, 1)

  const one = await tools.read.execute({ target: 'project-memory', section: '偏好' }, exec)
  assert.match(one.content, /^## 偏好/)

  const daily = await tools.read.execute({ target: 'project-daily', date: '2026-11-08' }, exec)
  assert.match(daily.content, /讨论过升级/)
})

test('memory_read reports a missing file and an unknown target', async () => {
  const { tools, exec } = fixture()
  const missing = await tools.read.execute({ target: 'project-daily', date: '1999-01-01' }, exec)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'not_found')

  const unknown = await tools.read.execute({ target: 'memories' }, exec)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'unknown_target')
  assert.deepEqual(unknown.targets, ['project-memory', 'project-daily', 'user-memory'])

  const noSection = await tools.read.execute({ target: 'project-memory', section: '不存在' }, exec)
  assert.equal(noSection.ok, false)
  assert.equal(noSection.code, 'no_section')
})

test('memory_read truncates a long body', async () => {
  const { tools, exec } = fixture()
  const result = await tools.read.execute({ target: 'project-memory', limit: 10 }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.content.length < 60, true)
  assert.match(result.content, /…/)
})

test('memory_search finds a line and names its section', async () => {
  const { tools, exec } = fixture()
  const hit = await tools.search.execute({ query: '人称代词' }, exec)

  assert.equal(hit.ok, true)
  assert.equal(hit.hits.length, 1)
  assert.equal(hit.hits[0].section, '偏好')
  assert.equal(hit.hits[0].line, 3)
  assert.equal(hit.hits[0].file, 'project/MEMORY.md')
})

test('memory_search honours scope, daily exclusion and limits', async () => {
  const { tools, exec } = fixture()

  const all = await tools.search.execute({ query: '升级', scope: 'all' }, exec)
  assert.equal(all.hits.length, 1)

  const noDaily = await tools.search.execute({ query: '升级', includeDaily: false }, exec)
  assert.equal(noDaily.hits.length, 0)

  const user = await tools.search.execute({ query: '全局', scope: 'user' }, exec)
  assert.equal(user.hits.length, 1)
  assert.equal(user.hits[0].label ?? user.hits[0].file, 'user/MEMORY.md')

  const capped = await tools.search.execute({ query: 'e', limit: 1 }, exec)
  assert.equal(capped.hits.length <= 1, true)
  assert.equal(capped.truncated, capped.hits.length === 1)
})

test('memory_search refuses an empty query', async () => {
  const { tools, exec } = fixture()
  const result = await tools.search.execute({ query: '   ' }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty_query')
})

test('memory_append writes one entry and returns the new revision', async () => {
  const { tools, exec, dir } = fixture()
  const before = await tools.read.execute({ target: 'project-memory' }, exec)

  const written = await tools.append.execute(
    { target: 'project-memory', section: '偏好', text: '新加一条', expectedRevision: before.revision },
    exec,
  )
  assert.equal(written.ok, true)
  assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /新加一条/)

  // The other entries and their order survive untouched.
  const text = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.equal(text.indexOf('用简体中文') < text.indexOf('新加一条'), true)
})

test('memory_append creates the file when the section does not exist yet', async () => {
  const { tools, exec, dir } = fixture()
  const written = await tools.append.execute({ target: 'project-memory', section: '新小节', text: '第一条' }, exec)
  assert.equal(written.ok, true)
  const text = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.match(text, /## 新小节/)
  assert.match(text, /第一条/)
})

test('memory_append replays one operationId without writing twice', async () => {
  const { tools, exec, dir } = fixture()
  const first = await tools.append.execute({ target: 'project-memory', section: '偏好', text: '只写一次', operationId: 'op-1' }, exec)
  assert.equal(first.ok, true)

  const again = await tools.append.execute({ target: 'project-memory', section: '偏好', text: '只写一次', operationId: 'op-1' }, exec)
  assert.equal(again.ok, true)
  assert.equal(again.duplicate, true)

  const occurrences = readFileSync(join(dir, 'MEMORY.md'), 'utf8').split('只写一次').length - 1
  assert.equal(occurrences, 1)
})

test('memory_append refuses a stale revision', async () => {
  const { tools, exec } = fixture()
  const before = await tools.read.execute({ target: 'project-memory' }, exec)
  await tools.append.execute({ target: 'project-memory', section: '偏好', text: '先写一条' }, exec)

  const stale = await tools.append.execute(
    { target: 'project-memory', section: '偏好', text: '不该写入', expectedRevision: before.revision },
    exec,
  )
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'conflict')
})

test('memory_append appends to a daily note without rewriting it', async () => {
  const { tools, exec, dir } = fixture()
  const written = await tools.append.execute({ target: 'project-daily', date: '2026-11-08', text: '今日一条' }, exec)
  assert.equal(written.ok, true)
  const text = readFileSync(join(dir, '2026-11-08.md'), 'utf8')
  assert.match(text, /讨论过升级/)
  assert.match(text, /今日一条/)
  assert.equal(text.indexOf('讨论过升级') < text.indexOf('今日一条'), true)
})

test('memory_append reports read_only and write_disabled', async () => {
  const readOnly = fixture({ readOnly: true })
  const denied = await readOnly.tools.append.execute({ target: 'project-memory', section: '偏好', text: 'x' }, readOnly.exec)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'read_only')

  const noWrite = fixture({ write: { enabled: false } })
  const refused = await noWrite.tools.append.execute({ target: 'project-memory', section: '偏好', text: 'x' }, noWrite.exec)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'write_disabled')
})

test('memory_edit replaces one entry and keeps the rest byte-identical', async () => {
  const { tools, exec, dir } = fixture()
  const before = await tools.read.execute({ target: 'project-memory' }, exec)

  const edited = await tools.edit.execute(
    {
      target: 'project-memory',
      section: '偏好',
      match: '避免人称代词',
      replacement: '偶尔可以用第一人称',
      expectedRevision: before.revision,
    },
    exec,
  )
  assert.equal(edited.ok, true)

  const text = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.match(text, /偶尔可以用第一人称/)
  assert.match(text, /用简体中文/)
  assert.equal(text.includes('避免人称代词'), false)
})

test('memory_edit removes an entry', async () => {
  const { tools, exec, dir } = fixture()
  const edited = await tools.edit.execute(
    { target: 'project-memory', section: '偏好', match: '避免人称代词', mode: 'remove' },
    exec,
  )
  assert.equal(edited.ok, true)
  const text = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.equal(text.includes('避免人称代词'), false)
  assert.match(text, /用简体中文/)
})

test('memory_edit refuses an ambiguous match instead of guessing', async () => {
  const { tools, exec, dir } = fixture()
  writeFileSync(join(dir, 'MEMORY.md'), '## 偏好\n- 中文输入\n- 中文输出\n', 'utf8')

  const result = await tools.edit.execute({ target: 'project-memory', section: '偏好', match: '中文', replacement: 'x' }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous')

  const text = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.match(text, /中文输入/)
  assert.match(text, /中文输出/)
})

test('memory_edit refuses a stale revision and a missing section', async () => {
  const { tools, exec } = fixture()
  const before = await tools.read.execute({ target: 'project-memory' }, exec)
  await tools.append.execute({ target: 'project-memory', section: '偏好', text: '插一条' }, exec)

  const stale = await tools.edit.execute(
    { target: 'project-memory', section: '偏好', match: '用简体中文', replacement: 'x', expectedRevision: before.revision },
    exec,
  )
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'conflict')

  const noSection = await tools.edit.execute({ target: 'project-memory', section: '没有这节', match: '用简体中文' }, exec)
  assert.equal(noSection.ok, false)
  assert.equal(noSection.code, 'no_section')
})

test('a write survives a round trip through read', async () => {
  const { tools, exec, dir } = fixture()
  const written = await tools.append.execute({ target: 'project-memory', section: '偏好', text: '往返一条' }, exec)
  assert.equal(written.ok, true)

  const again = await tools.read.execute({ target: 'project-memory' }, exec)
  assert.equal(again.revision, written.revision, 'read must return the revision the write produced')

  const file = await tools.read.execute({ target: 'project-memory' }, exec)
  assert.equal(existsSync(join(dir, 'MEMORY.md')), true)
  assert.match(file.content, /往返一条/)
})

test('memory_prune plans first and only archives when told to', async () => {
  const { tools, exec, dir } = fixture()
  writeFileSync(join(dir, '2026-01-02.md'), '- 很久以前的一条\n', 'utf8')

  const plan = await tools.prune.execute({ beforeDays: 30 }, exec)
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)
  assert.deepEqual(plan.candidates.map((row) => row.date), ['2026-01-02'])
  // A dry run must not move the file or touch MEMORY.
  assert.equal(readFileSync(join(dir, '2026-01-02.md'), 'utf8'), '- 很久以前的一条\n')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('很久以前的一条'), false)

  const done = await tools.prune.execute({ beforeDays: 30, dryRun: false, operationId: 'op-1' }, exec)
  assert.equal(done.ok, true)
  assert.deepEqual(done.pruned.map((row) => row.date), ['2026-01-02'])
  // The raw log is archived, not folded into MEMORY.
  assert.equal(existsSync(join(dir, '2026-01-02.md')), false)
  assert.equal(existsSync(join(dir, 'archive', '2026-01-02.md')), true)
  const memory = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.equal(memory.includes('很久以前的一条'), false)
  assert.equal(memory.includes('2026-01-02'), false)
})

test('memory_prune accepts an explicit date list', async () => {
  const { tools, exec, dir } = fixture()
  writeFileSync(join(dir, '2026-01-02.md'), '- 甲\n', 'utf8')
  writeFileSync(join(dir, '2026-01-03.md'), '- 乙\n', 'utf8')

  const plan = await tools.prune.execute({ dates: '2026-01-03', dryRun: true }, exec)
  assert.deepEqual(plan.candidates.map((row) => row.date), ['2026-01-03'])
})

test('memory_search reports search_disabled when the switch is off', async () => {
  const { tools, exec } = fixture({ search: { enabled: false } })
  const result = await tools.search.execute({ query: '用简体中文' }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'search_disabled')
})

test('memory_append bootstraps the memory directory only when ensureLayout is on', async () => {
  const off = fixture()
  const emptyCwd = join(off.root, 'fresh')
  mkdirSync(emptyCwd, { recursive: true })
  const offExec = { agent: { session: { header: { cwd: emptyCwd } } } }
  const refused = await off.tools.append.execute({ target: 'project-memory', section: 'A', text: 'x' }, offExec)
  assert.equal(refused.code, 'no_store')
  assert.equal(existsSync(join(emptyCwd, '.workbuddy')), false, 'a refusal must not leave a directory behind')

  const on = fixture({ write: { ensureLayout: true } })
  const onCwd = join(on.root, 'fresh')
  mkdirSync(onCwd, { recursive: true })
  const onExec = { agent: { session: { header: { cwd: onCwd } } } }
  const created = await on.tools.append.execute({ target: 'project-memory', section: 'A', text: 'x' }, onExec)
  assert.equal(created.ok, true)
  assert.match(readFileSync(join(onCwd, '.workbuddy', 'memory', 'MEMORY.md'), 'utf8'), /- x/)
})
