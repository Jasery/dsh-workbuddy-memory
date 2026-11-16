/** The six memory tools, exercised through their real definitions. */

import assert from 'node:assert/strict'
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { probeEnvironment } from '../src/env.js'
import { createTranslator } from '../src/locale.js'
import { appendTool, editTool } from '../src/tools/write.js'
import { readTool } from '../src/tools/read.js'
import { searchTool } from '../src/tools/search.js'
import { statusTool } from '../src/tools/status.js'
import { createStore } from '../src/write/store.js'

const t = createTranslator('zh')

/** The five tools the model gets. Management (prune/restore/revisions) is the panel's. */
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
  const probe = () => probeEnvironment({ cfg, cwd, detail: true })

  return {
    root,
    home,
    cwd,
    dir,
    cfg,
    exec,
    store,
    probe,
    tools: {
      status: statusTool(deps),
      read: readTool(deps),
      search: searchTool(deps),
      append: appendTool(deps),
      edit: editTool(deps),
    },
  }
}

test('memory_status reports the stores and warnings', async () => {
  const { tools, exec, home, cwd } = fixture()
  const result = await tools.status.execute({}, exec)

  assert.equal(result.ok, true)
  assert.equal(result.status, 'ok')
  assert.equal(result.paths.source, 'config')
  assert.equal(result.paths.user, join(home, 'MEMORY.md'))
  assert.equal(result.mode, 'layered')
  assert.equal(result.writable, true)
  assert.equal(result.lastAssembly, null, 'status does not invent an assembly before one occurred')
  assert.deepEqual(result.warnings, [])
  assert.equal('config' in result, false, 'the model status stays concise')
  void cwd
})

test('memory_status surfaces an over-budget core, not just legacy reasons', async () => {
  // `compatibility` used to be filtered to `legacy:` prefixes, so a core that
  // lost five entries to the budget looked exactly like a healthy one.
  const f = fixture()
  const lastAssembly = () => ({
    blocks: [{ name: 'workbuddy-memory:project', chars: 1490, state: 'layered:core-over-budget(5)' }],
    totalChars: 1490,
    states: { project: 'layered:core-over-budget(5)', directory: 'directory-truncated(3)', rules: 'enabled' },
    mode: 'layered',
    measuredAs: 'plugin-contribution',
  })
  const result = await statusTool({ cfg: f.cfg, t, lastAssembly }).execute({}, f.exec)

  assert.deepEqual(result.compatibility, ['project:layered:core-over-budget(5)', 'directory:directory-truncated(3)'])
  assert.equal(result.lastAssembly.blocks[0].state, 'layered:core-over-budget(5)', 'the block state is not flattened to "layered"')
  assert.equal(result.compatibility.some((line) => /rules/.test(line)), false, 'a normal state is not reported')
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
  assert.equal(result.writable, false)
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
  assert.deepEqual(unknown.targets, ['project-memory', 'project-daily', 'user-memory', 'user-profile'])

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
  const before = await tools.read.execute({ target: 'project-memory' }, exec)
  const edited = await tools.edit.execute(
    { target: 'project-memory', section: '偏好', match: '避免人称代词', mode: 'remove', expectedRevision: before.revision },
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

  const before = await tools.read.execute({ target: 'project-memory' }, exec)
  const result = await tools.edit.execute({ target: 'project-memory', section: '偏好', match: '中文', replacement: 'x', expectedRevision: before.revision }, exec)
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

  const current = await tools.read.execute({ target: 'project-memory' }, exec)
  const noSection = await tools.edit.execute({ target: 'project-memory', section: '没有这节', match: '用简体中文', expectedRevision: current.revision }, exec)
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

test('memory_prune is not in the model catalog, and the store still plans then refuses an apply without planId', async () => {
  // The tool left the catalog (bulk archive is a panel action), but the store
  // contract it fronted is unchanged: a plan first, then an apply bound to it.
  const { tools, store, probe, dir } = fixture()
  assert.equal(tools.prune, undefined, 'the model has no prune tool')
  writeFileSync(join(dir, '2026-01-02.md'), '- 很久以前的一条\n', 'utf8')

  const plan = await store.prune({ beforeDays: 30 }, probe())
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)
  assert.deepEqual(plan.candidates.map((row) => row.date), ['2026-01-02'])
  assert.equal(typeof plan.planId, 'string')
  // A dry run must not move the file or touch MEMORY.
  assert.equal(readFileSync(join(dir, '2026-01-02.md'), 'utf8'), '- 很久以前的一条\n')
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('很久以前的一条'), false)

  // An apply that guesses the set is exactly the unsafe retry this contract
  // removes, so it is refused rather than re-enumerated.
  const done = await store.prune({ beforeDays: 30, dryRun: false, operationId: 'op-1' }, probe())
  assert.equal(done.ok, false)
  assert.equal(done.code, 'plan_required')
  assert.equal(existsSync(join(dir, '2026-01-02.md')), true)
  assert.equal(existsSync(join(dir, 'archive', '2026-01-02.md')), false)
  const memory = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.equal(memory.includes('很久以前的一条'), false)
  assert.equal(memory.includes('2026-01-02'), false)
})

test('the store archive accepts an explicit date list', async () => {
  const { store, probe, dir } = fixture()
  writeFileSync(join(dir, '2026-01-02.md'), '- 甲\n', 'utf8')
  writeFileSync(join(dir, '2026-01-03.md'), '- 乙\n', 'utf8')

  const plan = await store.prune({ dates: ['2026-01-03'], dryRun: true }, probe())
  assert.deepEqual(plan.candidates.map((row) => row.date), ['2026-01-03'])
})

test('memory_search reports search_disabled when the switch is off', async () => {
  const { tools, exec } = fixture({ search: { enabled: false } })
  const result = await tools.search.execute({ query: '用简体中文' }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'search_disabled')
})

test('memory_append bootstraps the memory directory only when ensureLayout is on', async () => {
  const off = fixture({ write: { ensureLayout: false } })
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

/** The host rejects a tool result with any undefined / non-finite / -0 field. */
function losslessViolations(value, path = 'root') {
  if (value === null) return []
  if (typeof value === 'string' || typeof value === 'boolean') return []
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? [] : [`${path}=${value}`]
  if (value === undefined) return [`${path} is undefined`]
  if (typeof value !== 'object') return [`${path} is ${typeof value}`]
  return Object.entries(value).flatMap(([key, child]) => losslessViolations(child, `${path}.${key}`))
}

test('every write tool returns a result the host can snapshot', async () => {
  // The host validates each tool result as lossless JSON and rejects it when a
  // single property is undefined — *after* the write already landed. The caller
  // then sees "value is not lossless JSON" for a successful write, and a retry
  // without the same idempotency key writes twice.
  const f = fixture()
  // A brand-new file has nothing to back up, which is exactly the case that
  // produced `backup: undefined` and the rejected snapshot.
  const fresh = join(f.root, 'fresh')
  mkdirSync(join(fresh, '.workbuddy', 'memory'), { recursive: true })
  const freshExec = { agent: { session: { header: { cwd: fresh } } } }

  const first = await f.tools.append.execute({ target: 'project-memory', section: 'A', text: '第一条' }, freshExec)
  assert.equal(first.ok, true)
  assert.deepEqual(losslessViolations(first), [], 'first write has no backup, and must still be lossless')
  assert.equal(first.backup, null, 'an absent backup is null, not a missing key')
  assert.equal(first.created, true)

  const second = await f.tools.append.execute({ target: 'project-memory', section: 'A', text: '第二条' }, freshExec)
  assert.deepEqual(losslessViolations(second), [])
  assert.equal(typeof second.backup, 'string')
  assert.equal(second.created, false)

  const edited = await f.tools.edit.execute({ target: 'project-memory', section: 'A', match: '第一条', replacement: '第一条改', expectedRevision: second.revision }, freshExec)
  assert.equal(edited.ok, true)
  assert.deepEqual(losslessViolations(edited), [], 'edit reports created only sometimes; it must not leak undefined')
  assert.equal(edited.created, false)

  const pruned = await f.store.prune({ dryRun: true }, f.probe())
  assert.deepEqual(losslessViolations(pruned), [])

  const status = await f.tools.status.execute({}, freshExec)
  assert.deepEqual(losslessViolations(status), [])

  const read = await f.tools.read.execute({ target: 'project-memory' }, freshExec)
  assert.deepEqual(losslessViolations(read), [])

  const search = await f.tools.search.execute({ query: '第一条' }, freshExec)
  assert.deepEqual(losslessViolations(search), [])
})

test('the lossless guard coerces what the host would reject', async () => {
  const { lossless } = await import('../src/tools/index.js')

  assert.equal(lossless(undefined), null)
  assert.equal(lossless(Number.NaN), null)
  assert.equal(lossless(Number.POSITIVE_INFINITY), null)
  assert.equal(lossless(-0), null)
  assert.equal(lossless(0), 0)
  assert.deepEqual(lossless({ a: undefined, b: 1 }), { a: null, b: 1 })
  assert.deepEqual(lossless([1, undefined, 3]), [1, null, 3])
  assert.deepEqual(lossless({ nested: { deep: undefined } }), { nested: { deep: null } })
  // A cycle would make JSON.stringify throw; it is cut rather than followed.
  const cyclic = { name: 'x' }
  cyclic.self = cyclic
  assert.deepEqual(lossless(cyclic), { name: 'x', self: null })
  // A bigint is not JSON at all; the string form keeps it readable.
  assert.equal(lossless(10n), '10')
})

test('memory_status never invents token or character estimates', async () => {
  const f = fixture()
  const result = await f.tools.status.execute({}, f.exec)
  assert.equal(result.lastAssembly, null)
  assert.equal('chars' in result, false)
  assert.equal('config' in result, false)
  assert.equal(typeof result.mode, 'string')
})

test('memory_search names the scope and hints when it scanned no files', async () => {
  const { tools, exec } = fixture()
  // Only the user-level memory exists in this fixture; the default scope is
  // project, so a hit here must not be reported as "not in memory".
  const result = await tools.search.execute({ query: '用简体中文' }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.scope, 'project')
  if (result.files === 0) assert.match(result.hint ?? '', /scope/)
})

test('memory_search reports a file it had to truncate', async () => {
  const { home, tools, exec } = fixture({ search: { indexMaxFileBytes: 1024 } })
  const big = '## 大文件\n\n' + '- filler line to pad the file out\n'.repeat(200) + '- NEEDLE_AT_END\n'
  writeFileSync(join(home, 'MEMORY.md'), big, 'utf8')

  const result = await tools.search.execute({ query: 'NEEDLE_AT_END', scope: 'user' }, exec)
  assert.equal(result.ok, true)
  assert.deepEqual(result.hits, [], 'the needle is past the cut')
  // Silence here read as "memory does not mention it"; now the cap is named.
  assert.equal(result.truncatedFiles.length, 1)
  assert.equal(result.truncatedFiles[0].limit, 1024)
})

test('memory_search distinguishes hit truncation from file truncation', async () => {
  const { home, tools, exec } = fixture()
  writeFileSync(join(home, 'MEMORY.md'), '## A\n' + '- hit line\n'.repeat(20), 'utf8')
  const result = await tools.search.execute({ query: 'hit line', scope: 'user', limit: 3 }, exec)
  assert.equal(result.hits.length, 3)
  assert.equal(result.hitsTruncated, true)
  assert.deepEqual(result.truncatedFiles, [])
})

test('memory_read respects limit in section mode', async () => {
  const { home, tools, exec } = fixture()
  const big = '## 大节\n\n' + ('- ' + 'y'.repeat(80) + '\n').repeat(100) + '\n## 小节\n\n- z\n'
  writeFileSync(join(home, 'MEMORY.md'), big, 'utf8')

  const section = await tools.read.execute({ target: 'user-memory', section: '大节', limit: 100 }, exec)
  assert.equal(section.ok, true)
  assert.equal(section.truncated, true)
  assert.ok(section.content.length < 200, `section mode returned ${section.content.length} chars despite limit 100`)
})

test('memory_read refuses an ambiguous section heading', async () => {
  const { home, tools, exec } = fixture()
  writeFileSync(join(home, 'MEMORY.md'), '## 同名\n- A\n\n## 同名\n- B\n', 'utf8')
  const result = await tools.read.execute({ target: 'user-memory', section: '同名' }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous_section')
  assert.deepEqual(result.lines, [1, 4])
})

/** Strip the human-facing truncation note so a page can be compared byte for byte. */
function pageBody(content) {
  const at = content.indexOf('\n\n…')
  return at >= 0 ? content.slice(0, at) : content
}

/** Whether a string starts or ends in the middle of a surrogate pair. */
function hasHalfPair(text) {
  if (!text) return false
  const first = text.charCodeAt(0)
  const last = text.charCodeAt(text.length - 1)
  return (first >= 0xdc00 && first <= 0xdfff) || (last >= 0xd800 && last <= 0xdbff)
}

test('memory_read pages by UTF-16 offset without splitting an emoji', async () => {
  const { home, tools, exec } = fixture()
  const full = `${'😀'.repeat(9)}收尾`
  writeFileSync(join(home, 'MEMORY.md'), full, 'utf8')

  let offset = 0
  let assembled = ''
  let pages = 0
  while (pages < 30) {
    const page = await tools.read.execute({ target: 'user-memory', offset, limit: 3 }, exec)
    assert.equal(page.ok, true)
    assert.equal(page.offset, offset, 'the tool echoed a different start than requested')

    const raw = pageBody(page.content)
    assert.equal(hasHalfPair(raw), false, `page ${pages} split a surrogate pair`)
    assert.equal(raw, full.slice(page.offset, page.nextOffset))
    assert.equal(page.nextOffset, page.offset + raw.length)
    assert.equal(page.offset <= page.nextOffset, true)

    assembled += raw
    pages += 1
    if (!page.truncated) break
    assert.ok(page.nextOffset > page.offset, 'a truncated page made no progress')
    offset = page.nextOffset
  }

  assert.equal(assembled, full, 'paging lost or duplicated a character')
  assert.ok(pages > 1)
})

test('memory_read rejects an offset that is not a real position', async () => {
  const { tools, exec } = fixture()
  // The host already refuses strings and non-finite numbers; the tool still has
  // to reject negative and fractional positions itself.
  for (const offset of [-1, 1.5, 2.0001]) {
    const result = await tools.read.execute({ target: 'project-memory', offset }, exec)
    assert.equal(result.ok, false, `offset ${String(offset)} was accepted`)
    assert.equal(result.code, 'bad_offset')
  }

  const full = await tools.read.execute({ target: 'project-memory' }, exec)
  const beyond = await tools.read.execute({ target: 'project-memory', offset: full.content.length + 1 }, exec)
  assert.equal(beyond.ok, false)
  assert.equal(beyond.code, 'bad_offset')

  const end = await tools.read.execute({ target: 'project-memory', offset: full.nextOffset }, exec)
  assert.equal(end.ok, true)
  assert.equal(end.content, '')
  assert.equal(end.truncated, false)
  assert.equal(end.nextOffset, full.nextOffset)
})

test('memory_read pages inside a chosen section, not the whole file', async () => {
  const { home, tools, exec } = fixture()
  const body = '- ' + 'z'.repeat(40)
  writeFileSync(join(home, 'MEMORY.md'), `## 大节\n${body}\n## 尾节\n- tail\n`, 'utf8')

  const page = await tools.read.execute({ target: 'user-memory', section: '大节', offset: 4, limit: 10 }, exec)
  assert.equal(page.ok, true)
  assert.equal(page.section, '大节')
  assert.equal(pageBody(page.content), `## 大节\n${body}`.slice(4, 14))
  assert.equal(page.nextOffset, 14)
  assert.equal(page.truncated, true)
})

test('memory_read refuses a 2 MiB target instead of hashing a fragment', async () => {
  const { home, tools, exec } = fixture()
  writeFileSync(join(home, 'MEMORY.md'), 'a'.repeat(2 * 1024 * 1024 + 1), 'utf8')

  const result = await tools.read.execute({ target: 'user-memory' }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'too_large')
  assert.equal(result.revision, null)
  assert.equal(result.writable, false)
  assert.equal(result.bytes, 2 * 1024 * 1024 + 1)
})

/** See tests/paths.test.mjs: patch `node:fs` so the race is not timing-based. */
function patchFs(overrides) {
  const saved = {}
  for (const [name, replacement] of Object.entries(overrides)) {
    saved[name] = fs[name]
    fs[name] = replacement
  }
  syncBuiltinESMExports()
  return () => {
    for (const [name, original] of Object.entries(saved)) fs[name] = original
    syncBuiltinESMExports()
  }
}

test('memory_read refuses a stale small stat instead of hashing a fragment', async () => {
  const { home, tools, exec } = fixture()
  const target = join(home, 'MEMORY.md')
  const grown = 2 * 1024 * 1024 + 16
  writeFileSync(target, 'a'.repeat(grown), 'utf8')

  const realStatSync = fs.statSync
  // The file is already large; the pre-check still sees the old 16 bytes. The
  // read itself must notice and refuse, not hash the first 2 MiB.
  const restore = patchFs({
    statSync(path, ...rest) {
      const real = realStatSync(path, ...rest)
      if (String(path) !== target) return real
      return { size: 16, mtimeMs: real.mtimeMs, isFile: () => true, isDirectory: () => false }
    },
  })

  try {
    const body = await tools.read.execute({ target: 'user-memory' }, exec)
    assert.equal(body.ok, false)
    assert.equal(body.code, 'too_large')
    assert.equal(body.revision, null)
    assert.equal(body.writable, false)
    assert.equal(body.bytes, grown)

    const only = await tools.read.execute({ target: 'user-memory', sectionsOnly: true }, exec)
    assert.equal(only.code, 'too_large')
    assert.equal(only.revision, null)
  } finally {
    restore()
  }
})

test('memory_read reports a conflict when the file changes during the read', async () => {
  const { home, tools, exec } = fixture()
  const target = join(home, 'MEMORY.md')
  writeFileSync(target, '- a\n', 'utf8')
  const realReadSync = fs.readSync

  let changedOnce = false
  const restore = patchFs({
    readSync(fd, buffer, offset, length, position) {
      if (!changedOnce) {
        changedOnce = true
        appendFileSync(target, '- b\n')
      }
      return realReadSync(fd, buffer, offset, length, position)
    },
  })

  try {
    const result = await tools.read.execute({ target: 'user-memory' }, exec)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'read_conflict')
    assert.equal(result.revision, null)
    assert.equal(result.writable, false)
  } finally {
    restore()
  }
})

test('memory_read refuses an offset inside a surrogate pair', async () => {
  const { home, tools, exec } = fixture()
  writeFileSync(join(home, 'MEMORY.md'), '😀😀', 'utf8')

  const result = await tools.read.execute({ target: 'user-memory', offset: 1 }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_offset')
})

test('memory_read returns a single user profile with the uid from its directory', async () => {
  const { home, tools, exec, cfg } = fixture()
  const personal = join(home, 'user-7f3a-personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'USER.md'), '# 用户\n- 名字\n', 'utf8')

  const probe = probeEnvironment({ cfg, cwd: exec.agent.session.header.cwd })
  assert.equal(probe.profile.source, 'single')
  assert.equal(probe.profile.uid, '7f3a', 'a single profile reported the file name instead of the account')

  const result = await tools.read.execute({ target: 'user-profile' }, exec)
  assert.equal(result.ok, true)
  assert.match(result.content, /名字/)
  assert.equal(result.revision !== null, true)
})

test('memory_read refuses an ambiguous profile instead of picking one', async () => {
  const { home, tools, exec } = fixture()
  for (const name of ['user-a-personal', 'user-b-personal']) {
    mkdirSync(join(home, name), { recursive: true })
    writeFileSync(join(home, name, 'USER.md'), `# ${name}\n`, 'utf8')
  }

  const result = await tools.read.execute({ target: 'user-profile' }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous_profile')
  assert.equal(result.revision, undefined)
})
