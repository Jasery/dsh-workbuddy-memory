import assert from 'node:assert/strict'
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { ageInDays, probeEnvironment } from '../src/env.js'
import { contentRevision } from '../src/write/fslock.js'
import { createStore, localDateStamp } from '../src/write/store.js'
import { analyzeMemory } from '../src/layers.js'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'wbm-'))
  const cwd = join(root, 'repo')
  const memoryDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const home = join(root, 'home')
  mkdirSync(join(home, 'memory'), { recursive: true })
  return { root, cwd, memoryDir, home }
}

/**
 * A `YYYY-MM-DD` stamp `days` away from today on the local calendar.
 *
 * Prune fixtures used fixed dates, so "the old file" became "the file from two
 * months ago" and "yesterday" eventually crossed the 30-day line. Relative
 * local dates state the intent and stay true on any machine.
 */
function dayStamp(days = 0) {
  const today = new Date()
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

function setup(overrides = {}) {
  const space = workspace()
  const cfg = normalizeConfig(overrides)
  const env = { WORKBUDDY_CONFIG_DIR: space.home }
  const probe = probeEnvironment({ cfg, cwd: space.cwd, env, home: space.root, detail: true })
  const store = createStore({ cfg, stateDir: join(space.root, 'state') })
  // Tools resolve the workspace from the agent's session header, not from the
  // probe, so the tool-level tests need the same cwd the probe was built with.
  const agent = { session: { header: { cwd: space.cwd } } }
  return { ...space, cfg, probe, store, agent }
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
  // The post-write read is the revision the caller stores. An ordinary append
  // must return the whole file's revision, not a snapshot of a prefix.
  assert.equal(result.revision, contentRevision(readFileSync(file, 'utf8')))
})

/**
 * Replace one `node:fs` export for the duration of a test and push the patch to
 * the ESM bindings `src/fsx.js` already imported, so the window is deterministic.
 */
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

test('an append raced by an external writer is refused, not written over it', async () => {
  const s = setup({ write: { enabled: true, backupKeep: 2 } })
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '## Notes\n- original\n'
  writeFileSync(file, before, 'utf8')
  const expectedRevision = contentRevision(before)
  const realReadSync = fs.readSync

  // The write path fstats the file at 20 bytes, then this hook appends 30 bytes
  // before the first actual read starts. The read still asks for the old 20
  // bytes, so a helper that trusts the first stat hands the CAS the original
  // prefix and the stale revision "wins".
  let raced = false
  const restore = patchFs({
    readSync(fd, buffer, offset, length, position) {
      if (!raced) {
        raced = true
        appendFileSync(file, '- external-before-actual-read\n')
      }
      return realReadSync(fd, buffer, offset, length, position)
    },
  })

  try {
    const result = await s.store.append(
      { target: 'project-memory', section: 'Notes', text: 'own-write', expectedRevision },
      s.probe,
    )
    assert.equal(raced, true, 'the racing write happened before the first read')
    assert.equal(result.ok, false, 'a read that saw the file change must not pass CAS')
    assert.equal(result.error, 'changed')
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes('- external-before-actual-read'), 'the external append survives')
    assert.equal(text.includes('- own-write'), false, 'the stale append did not overwrite the file')
  } finally {
    restore()
  }
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
  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: 'one', mode: 'remove', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, true)
  // The row is spliced out, not blanked: a blanked row is the column of
  // whitespace that a few removals used to leave behind.
  assert.equal(readFileSync(file, 'utf8'), '## A\n- two\n')
})

test('ensureLayout false keeps a missing memory directory untouched', async () => {
  const s = setup({ write: { ensureLayout: false } })
  const empty = join(s.root, 'norepo')
  mkdirSync(empty, { recursive: true })
  const probe = probeEnvironment({ cfg: s.cfg, cwd: empty, env: { WORKBUDDY_CONFIG_DIR: s.home }, home: s.root })
  const result = await s.store.append({ target: 'project-memory', section: 'A', text: 'x' }, probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_store')
})

test('a valid first append creates a localized template with one core heading', async () => {
  const s = setup({ locale: 'en' })
  fs.rmSync(s.memoryDir, { recursive: true, force: true })
  const result = await s.store.append({ target: 'project-memory', section: 'Core Memory', text: 'remembered' }, s.probe)
  assert.equal(result.ok, true)
  const text = readFileSync(join(s.memoryDir, 'MEMORY.md'), 'utf8')
  assert.equal((text.match(/^## Core Memory$/gm) ?? []).length, 1)
  assert.match(text, /^# Memory\n\n## Core Memory\n/)
  assert.match(text, /- remembered/)

  const zh = setup({ locale: 'zh' })
  fs.rmSync(zh.memoryDir, { recursive: true, force: true })
  const localized = await zh.store.append({ target: 'project-memory', section: 'Core Memory', text: '一条' }, zh.probe)
  assert.equal(localized.ok, true)
  const localizedText = readFileSync(join(zh.memoryDir, 'MEMORY.md'), 'utf8')
  assert.equal((localizedText.match(/^## 常驻记忆$/gm) ?? []).length, 1)
  assert.doesNotMatch(localizedText, /^## Core Memory$/m)
})

test('invalid first writes do not create any part of the memory layout', async () => {
  const s = setup()
  fs.rmSync(s.memoryDir, { recursive: true, force: true })
  for (const input of [
    { target: 'project-memory', section: 'A', text: '  ' },
    { target: 'project-memory', section: 'A', text: 'one\n- two' },
    { target: 'project-memory', section: 'A\n## forged', text: 'one' },
    { target: 'project-memory', section: '   ', text: 'one' },
    { target: 'project-daily', date: '2026-02-31', text: 'one' },
  ]) assert.equal((await s.store.append(input, s.probe)).ok, false)
  assert.equal(existsSync(s.memoryDir), false)
})

test('ordinary append cannot silently turn a legacy document into layered format', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '# Old\n\n## Notes\n- existing\n'
  writeFileSync(file, before, 'utf8')
  const result = await s.store.append({ target: 'project-memory', section: 'Core Memory', text: 'new' }, s.probe)
  assert.equal(result.code, 'layering_confirmation_required')
  assert.equal(readFileSync(file, 'utf8'), before)
  const topic = await s.store.append({ target: 'project-memory', section: 'Notes', text: 'topic update' }, s.probe)
  assert.equal(topic.ok, true)
})

test('edit and replace-section resolve the localized core alias the prompt shows', async () => {
  // The injected heading is localized (`## 常驻记忆` under a zh locale) while the
  // file may carry the other spelling. Append already normalized the alias;
  // edit and replace-section did not, so a model copying the heading it read in
  // the prompt landed on `no_section`.
  const s = setup({ locale: 'zh' })
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '# Memory\n\n## Core Memory\n- 第一条\n'
  writeFileSync(file, before, 'utf8')

  const edited = await s.store.edit(
    { target: 'project-memory', section: '常驻记忆', match: '第一条', replacement: '改过', expectedRevision: contentRevision(before) },
    s.probe,
  )
  assert.equal(edited.ok, true, JSON.stringify(edited))
  const afterEdit = readFileSync(file, 'utf8')
  assert.match(afterEdit, /^- 改过$/m)
  assert.match(afterEdit, /^## Core Memory$/m, 'the file keeps its own heading spelling')

  const replaced = await s.store.replaceSection(
    { target: 'project-memory', section: '常驻记忆', body: '- 重写一条\n', expectedRevision: contentRevision(afterEdit) },
    s.probe,
  )
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  assert.equal(readFileSync(file, 'utf8'), '# Memory\n\n## Core Memory\n- 重写一条\n')
})

test('the alias never resolves to a heading the file does not have', async () => {
  // A legacy file has no core section, so the alias must not invent one: the
  // caller needs `no_section`, not a silent new section.
  const s = setup({ locale: 'zh' })
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '## Notes\n- one\n'
  writeFileSync(file, before, 'utf8')

  const result = await s.store.edit(
    { target: 'project-memory', section: '常驻记忆', match: 'one', replacement: 'two', expectedRevision: contentRevision(before) },
    s.probe,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_section')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a layering refusal tells the caller what to do next', async () => {
  // The refusal used to be a bare code: the model knew the write failed but not
  // that the decision belongs to a person in the panel.
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '# Old\n\n## Notes\n- existing\n', 'utf8')

  const result = await s.store.append({ target: 'project-memory', section: 'Core Memory', text: 'new' }, s.probe)
  assert.equal(result.code, 'layering_confirmation_required')
  assert.equal(typeof result.hint, 'string')
  assert.ok(result.hint.length > 0, 'the refusal carries a hint')
  assert.match(result.hint, /panel|confirm/i, 'the hint names where the decision happens')
  assert.doesNotMatch(result.hint, /shell|terminal|command line|write the file yourself/i, 'and does not suggest a bypass')
})

test('an empty legacy file is bootstrapped by an ordinary first append', async () => {
  const s = setup({ locale: 'zh' })
  const file = join(s.memoryDir, 'MEMORY.md')
  // An empty file is a legacy document by analysis, but it holds nothing whose
  // ownership a person could confirm, so the layering guard must not fire: the
  // first append is how the template gets written at all.
  writeFileSync(file, '', 'utf8')

  const result = await s.store.append({ target: 'project-memory', section: '常驻记忆', text: '第一条' }, s.probe)
  assert.equal(result.ok, true)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('# 记忆\n\n## 常驻记忆\n'), text)
  assert.ok(text.includes('- 第一条'), text)
  assert.equal((text.match(/^## 常驻记忆$/gm) ?? []).length, 1)
  assert.equal(analyzeMemory(text).mode, 'layered')
})

test('a legacy file holding only a title is bootstrapped too', async () => {
  const s = setup({ locale: 'zh' })
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '# 标题\n', 'utf8')

  const result = await s.store.append({ target: 'project-memory', section: '常驻记忆', text: '第一条' }, s.probe)
  assert.equal(result.ok, true)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('# 标题\n\n## 常驻记忆\n'), text)
  assert.ok(text.includes('- 第一条'), text)
  assert.equal(analyzeMemory(text).mode, 'layered')
})

test('a legacy file with entries still needs confirmation before becoming layered', async () => {
  const s = setup({ locale: 'zh' })
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '## 偏好\n- 用中文\n'
  writeFileSync(file, before, 'utf8')

  const result = await s.store.append({ target: 'project-memory', section: '常驻记忆', text: '第一条' }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'layering_confirmation_required')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('appending to an existing legacy section keeps the file legacy', async () => {
  const s = setup({ locale: 'zh' })
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '# 旧\n\n## 偏好\n- 用中文\n'
  writeFileSync(file, before, 'utf8')

  const result = await s.store.append({ target: 'project-memory', section: '偏好', text: '第二条' }, s.probe)
  assert.equal(result.ok, true)
  const text = readFileSync(file, 'utf8')
  assert.equal(text, `${before}- 第二条\n`)
  assert.equal(analyzeMemory(text).mode, 'legacy')
  assert.doesNotMatch(text, /^## 常驻记忆$/m)
})

test('trusted replaceDocument is the explicit legacy-to-layered migration path', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '# Old\n\n## Notes\n- legacy\n'
  writeFileSync(file, before, 'utf8')
  const migrated = '# Memory\n\n## Core Memory\n- curated\n\n## Notes\n- retained\n'
  const result = await s.store.replaceDocument({ target: 'project-memory', text: migrated, expectedRevision: contentRevision(before) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), migrated)
})

test('the daily file follows the local calendar day, not UTC', async () => {
  const s = setup()
  // Build a local 00:30 rather than an ISO instant with a fixed offset: the
  // assertion must mean the same thing under TZ=UTC and TZ=Asia/Shanghai.
  const now = new Date(2026, 10, 10, 0, 30, 0)
  assert.equal(localDateStamp(now), '2026-11-10')

  const result = await s.store.append({ target: 'project-daily', text: '凌晨一条' }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(basename(result.path), `${localDateStamp()}.md`)
})

test('edit without a replacement is refused, not turned into a delete', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n- two\n', 'utf8')

  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: 'one', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty_text')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n- two\n')
})

test('edit keeps the bullet marker when the client sends only the body', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n- two\n', 'utf8')

  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: 'one', replacement: 'ONE', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- ONE\n- two\n')
})

test('edit refuses prose instead of rewriting it', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '## A\n\n说明：one 是常用选项。\n- one\n'
  writeFileSync(file, before, 'utf8')

  // The bullet is still found when prose also contains the text.
  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: 'one', replacement: 'ONE', expectedRevision: contentRevision(before) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n\n说明：one 是常用选项。\n- ONE\n')

  writeFileSync(file, '## A\n\n说明：only prose here。\n', 'utf8')
  const proseOnly = await s.store.edit({ target: 'project-memory', section: 'A', match: 'only prose', replacement: 'x', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(proseOnly.ok, false)
  assert.equal(proseOnly.code, 'not_an_entry')
  assert.equal(readFileSync(file, 'utf8'), '## A\n\n说明：only prose here。\n')
})

test('deleting every entry does not leave a column of blank lines', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n\n- one\n- two\n- three\n', 'utf8')

  for (const match of ['two', 'three', 'one']) {
    const result = await s.store.edit({ target: 'project-memory', section: 'A', match, mode: 'remove', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
    assert.equal(result.ok, true, `removing ${match} failed: ${JSON.stringify(result)}`)
  }

  const text = readFileSync(file, 'utf8')
  assert.equal(text, '## A\n')
  assert.equal(/\n\n\n/.test(text), false, 'removals must not accumulate blank lines')
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
  const moved = await s.store.editAt({ target: 'project-memory', section: 'A', line: 9, replacement: '- x', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(moved.ok, false)
  assert.equal(moved.code, 'stale_line')
})

test('remove deletes exactly the named line', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n- two\n- three\n', 'utf8')
  const result = await s.store.remove({ target: 'project-memory', section: 'A', line: 2, expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n- three\n')
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

test('prune plans by age, then archives old dailies without touching MEMORY', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const old = dayStamp(-45)
  const recent = dayStamp(-1)
  const future = dayStamp(7)
  writeFileSync(file, '## 环境\n- Node 22\n', 'utf8')
  writeFileSync(join(s.memoryDir, `${old}.md`), '- 老的一\n- 老的二\n', 'utf8')
  writeFileSync(join(s.memoryDir, `${recent}.md`), '- 昨天的\n', 'utf8')
  writeFileSync(join(s.memoryDir, `${future}.md`), '- 未来的\n', 'utf8')

  const plan = await s.store.prune({ beforeDays: 30, dryRun: true }, s.probe)
  assert.equal(plan.ok, true)
  assert.equal(plan.dryRun, true)
  assert.deepEqual(plan.candidates.map((row) => row.date), [old])
  assert.equal(plan.entries, 2)
  assert.equal(typeof plan.planId, 'string')

  const done = await s.store.prune(
    { beforeDays: 30, dryRun: false, planId: plan.planId, dates: [old], operationId: 'op-store-prune' },
    s.probe,
  )
  assert.equal(done.ok, true)
  // MEMORY is untouched; the raw log is moved to archive/, the recent file and
  // the future-dated file stay.
  assert.equal(readFileSync(file, 'utf8'), '## 环境\n- Node 22\n')
  assert.equal(existsSync(join(s.memoryDir, `${old}.md`)), false)
  assert.match(readFileSync(join(s.memoryDir, 'archive', `${old}.md`), 'utf8'), /老的一/)
  assert.match(readFileSync(join(s.memoryDir, `${recent}.md`), 'utf8'), /昨天的/)
  assert.match(readFileSync(join(s.memoryDir, `${future}.md`), 'utf8'), /未来的/)
})

test('prune preview with nothing old enough lists no candidates', async () => {
  const s = setup()
  writeFileSync(join(s.memoryDir, `${dayStamp(7)}.md`), '- 未来的\n', 'utf8')
  const result = await s.store.prune({ beforeDays: 30, dryRun: true }, s.probe)
  assert.equal(result.ok, true)
  assert.deepEqual(result.candidates, [])
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

test('a lock timeout is a refusal, not a rejected promise', async () => {
  const s = setup({ write: { lockWaitMs: 40 } })
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')
  const daily = join(s.memoryDir, `${localDateStamp()}.md`)
  writeFileSync(daily, '- 今天的\n', 'utf8')

  // Hold the daily file's lock the way another process would, then write.
  const { pathKey } = await import('../src/write/fslock.js')
  const lock = join(s.root, 'state', 'locks', `${pathKey(daily)}.lock`)
  mkdirSync(lock, { recursive: true })

  const dailyResult = await s.store.append({ target: 'project-daily', text: '第二条' }, s.probe)
  assert.equal(dailyResult.ok, false)
  assert.equal(dailyResult.code, 'lock_timeout')

  const memoryLock = join(s.root, 'state', 'locks', `${pathKey(file)}.lock`)
  mkdirSync(memoryLock, { recursive: true })
  const memoryResult = await s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe)
  assert.equal(memoryResult.ok, false)
  assert.equal(memoryResult.code, 'lock_timeout')
})

test('a lock held by a live process is never stolen, however old it is', async () => {
  const s = setup({ write: { lockWaitMs: 30 } })
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')

  const { pathKey } = await import('../src/write/fslock.js')
  const lock = join(s.root, 'state', 'locks', `${pathKey(file)}.lock`)
  mkdirSync(lock, { recursive: true })
  // This process is alive, but the owner file claims a very old timestamp. Age
  // alone must not be read as "dead": stealing here would corrupt a live write.
  writeFileSync(
    join(lock, 'owner'),
    JSON.stringify({ pid: process.pid, at: Date.now() - 3600_000, host: process.env.COMPUTERNAME ?? '', token: 'other' }),
    'utf8',
  )

  const result = await s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'lock_timeout')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n', 'the file was not touched')
})

test('a failed backup refuses the write instead of replacing without one', async () => {
  const s = setup({ write: { backupKeep: 3 } })
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')

  // Make the backup directory unwritable by occupying its name with a file:
  // mkdir then fails, so no snapshot can be taken.
  const { pathKey } = await import('../src/write/fslock.js')
  const backupRoot = join(s.root, 'state', 'backups')
  mkdirSync(backupRoot, { recursive: true })
  writeFileSync(join(backupRoot, pathKey(file)), 'not a directory', 'utf8')

  const result = await s.store.editAt({ target: 'project-memory', section: 'A', line: 1, replacement: '- two', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'backup_failed')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n', 'the destructive step did not run')
})

test('replaceSection swaps one body and keeps every other byte', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '# T\n\n## 环境\n- Node 22\n- pnpm 9\n\n## 偏好\n- 简体中文\n', 'utf8')

  const result = await s.store.replaceSection({ target: 'project-memory', section: '环境', body: '- Node 22\n- pnpm 10\n', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '# T\n\n## 环境\n- Node 22\n- pnpm 10\n\n## 偏好\n- 简体中文\n')
})

test('replaceSection refuses a body that is not made of entries', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## 环境\n- Node 22\n', 'utf8')
  const before = readFileSync(file, 'utf8')

  const prose = await s.store.replaceSection({ target: 'project-memory', section: '环境', body: '就是一些说明\n', expectedRevision: contentRevision(before) }, s.probe)
  assert.equal(prose.ok, false)
  assert.equal(prose.code, 'invalid_body')

  const heading = await s.store.replaceSection({ target: 'project-memory', section: '环境', body: '## 别的节\n- x\n', expectedRevision: contentRevision(before) }, s.probe)
  assert.equal(heading.ok, false, 'a heading would split the section and shift every line number')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('replaceSection accepts a wrapped entry, the shape memory_edit writes', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## 环境\n- Node 22\n', 'utf8')

  // An indented line under a bullet is that entry's continuation, not prose.
  // Refusing it made the panel unable to save a file the tools had written.
  const result = await s.store.replaceSection({ target: 'project-memory', section: '环境', body: '- Node 22\n  用 corepack 管 pnpm\n', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## 环境\n- Node 22\n  用 corepack 管 pnpm\n')
})

test('removeSection drops one section and leaves the rest alone', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '# T\n\n## 甲\n- a\n\n## 乙\n- b\n', 'utf8')

  const result = await s.store.removeSection({ target: 'project-memory', section: '甲', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '# T\n\n## 乙\n- b\n')

  const missing = await s.store.removeSection({ target: 'project-memory', section: '不存在', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(missing.code, 'no_section')
})

test('a multi-line entry is replaced and removed as one span', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- head\n  续行一\n  续行二\n- next\n', 'utf8')

  const replaced = await s.store.edit({ target: 'project-memory', section: 'A', match: 'head', replacement: '改过', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(replaced.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- 改过\n- next\n', 'the continuation lines go with the entry they belonged to')

  const removed = await s.store.edit({ target: 'project-memory', section: 'A', match: '改过', mode: 'remove', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(removed.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- next\n', 'no orphaned continuation lines are left behind')
})

test('a match inside a continuation line resolves to its entry', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- head\n  续行里的关键词\n- next\n', 'utf8')

  const result = await s.store.edit({ target: 'project-memory', section: 'A', match: '关键词', replacement: '改过', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- 改过\n- next\n')
})

test('append refuses a multi-line text instead of writing several entries', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')

  const result = await s.store.append({ target: 'project-memory', section: 'A', text: '一条\n- 伪装成的第二条\n## 伪造的节' }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'multiline_text')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n', 'nothing was written')
})

test('append refuses a blank section name instead of creating an empty heading', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')

  const result = await s.store.append({ target: 'project-memory', section: '   ', text: 'x' }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty_heading')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n')
})

test('append reports the section it actually landed in', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')

  const explicit = await s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe)
  assert.equal(explicit.section, 'A')

  // No section named: the default is visible in the result rather than guessed.
  const fallback = await s.store.append({ target: 'project-memory', text: 'three' }, s.probe)
  assert.equal(fallback.section, 'Notes')
  assert.ok(readFileSync(file, 'utf8').includes('## Notes'))
})

test('a duplicate heading is refused rather than silently resolving to the first', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## 同名\n- A\n\n## 同名\n- B\n', 'utf8')
  const before = readFileSync(file, 'utf8')

  const edit = await s.store.edit({ target: 'project-memory', section: '同名', match: 'B', replacement: '改B', expectedRevision: contentRevision(before) }, s.probe)
  assert.equal(edit.ok, false)
  assert.equal(edit.code, 'ambiguous_section')
  assert.equal(edit.duplicates, 2)
  assert.equal(readFileSync(file, 'utf8'), before)

  // The line number is the escape hatch, and it reaches the second section.
  const at = await s.store.editAt({ target: 'project-memory', section: '同名', line: 4, replacement: '改B', expectedRevision: contentRevision(before) }, s.probe)
  assert.equal(at.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## 同名\n- A\n\n## 同名\n- 改B\n')
})

test('bullets above the first H2 are reachable as the top section', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '# 标题\n\n- 顶层条目\n\n## 节\n- 内层\n', 'utf8')

  const edited = await s.store.edit({ target: 'project-memory', section: '(top)', match: '顶层条目', replacement: '改过', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(edited.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '# 标题\n\n- 改过\n\n## 节\n- 内层\n')

  // The document title names the same region, so a person can type what they see.
  const viaTitle = await s.store.edit({ target: 'project-memory', section: '标题', match: '改过', replacement: '再改', expectedRevision: contentRevision(readFileSync(file, 'utf8')) }, s.probe)
  assert.equal(viaTitle.ok, true)
  assert.ok(readFileSync(file, 'utf8').includes('- 再改'))
})

test('replaceSection compresses a section through the store', async () => {
  // The tool that used to front this is gone (the panel owns bulk tidy-up now),
  // so the regression lives on the store method the panel calls.
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '# T\n\n## 环境\n- Node 22\n- pnpm 9\n- git 2.4\n\n## 偏好\n- 简体中文\n', 'utf8')

  const result = await s.store.replaceSection(
    { target: 'project-memory', section: '环境', body: '- Node 22 + pnpm 10\n- git 2.4\n', expectedRevision: contentRevision(readFileSync(file, 'utf8')) },
    s.probe,
  )
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '# T\n\n## 环境\n- Node 22 + pnpm 10\n- git 2.4\n\n## 偏好\n- 简体中文\n')
})

test('listRevisions and restore round-trip one backup through the store', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')

  await s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe)
  const list = s.store.listRevisions(file)
  assert.equal(list.length, 1)

  const revision = contentRevision(readFileSync(file, 'utf8'))
  const restored = await s.store.restore({ target: 'project-memory', name: list[0].name, expectedRevision: revision }, s.probe)
  assert.equal(restored.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n')
})

test('the management store methods return a result the host could snapshot', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')
  await s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe)

  const { lossless } = await import('../src/tools/index.js')
  const calls = [
    () => s.store.replaceSection({ target: 'project-memory', section: 'A', body: '- only\n' }, s.probe),
    () => s.store.listRevisions(file),
    () => s.store.restore({ target: 'project-memory', name: 'nope.md', expectedRevision: 'x' }, s.probe),
    () => s.store.prune({ dryRun: true }, s.probe),
  ]
  for (const call of calls) {
    const value = lossless(await call())
    assert.equal(JSON.stringify(value).includes('undefined'), false)
  }
})

test('ageInDays measures from local midnight, not UTC', () => {
  // 00:30 local in UTC+8 is still the previous day in UTC. Parsing the file date
  // as UTC made the "30 days old" boundary slide by the offset, so a 29-day-old
  // note could be archived by beforeDays: 30.
  const now = new Date(2026, 10, 13, 0, 30, 0).getTime()
  assert.equal(ageInDays('2026-11-13', now), 0, 'today is zero days old whatever the hour')
  assert.equal(ageInDays('2026-11-12', now), 1)
  assert.equal(ageInDays('2026-10-14', now), 30)
  assert.equal(ageInDays('2026-10-15', now), 29, '29 days must not round up to 30')
})

test('ageInDays refuses a date the calendar does not have', () => {
  assert.equal(ageInDays('2026-02-31'), null)
  assert.equal(ageInDays('not-a-date'), null)
  assert.equal(ageInDays(''), null)
})

test('backupKeep keeps a whole tidy-up session restorable', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- e0\n', 'utf8')
  for (let i = 1; i <= 9; i += 1) {
    const rev = contentRevision(readFileSync(file, 'utf8'))
    await s.store.edit({ target: 'project-memory', section: 'A', match: `e${i - 1}`, replacement: `e${i}`, expectedRevision: rev }, s.probe)
  }
  // Nine edits is an ordinary distillation pass. The default used to be 5, which
  // rotated away the state from before the first edit — the one worth restoring.
  const rows = s.store.listRevisions(file)
  assert.equal(rows.length, 9)
  const texts = rows.map((row) => s.store.readRevision(file, row.name).text)
  assert.ok(texts.some((text) => text.includes('- e0')), 'the pre-edit state is still there')
})
