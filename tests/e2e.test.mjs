/**
 * The panel's write chain, end to end: real HTTP, real files, temp dirs.
 *
 * The unit tests cover each piece; this one covers the seam between them — a
 * JSON body becomes a file change, a stale revision is refused instead of
 * overwriting, and a restore puts bytes back exactly as they were.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { registerRoutes } from '../src/host/routes.js'
import { createStore } from '../src/write/store.js'

/** A project with two daily files, one old enough to archive. */
async function server({ allowWriteActions = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wbm-e2e-'))
  const home = join(root, 'home')
  const proj = join(root, 'proj')
  const memDir = join(proj, '.workbuddy', 'memory')
  const stateDir = join(root, 'state')
  mkdirSync(home, { recursive: true })
  mkdirSync(memDir, { recursive: true })

  writeFileSync(join(home, 'MEMORY.md'), '# 长期记忆\n\n## 输出规范\n- 用简体中文\n- 报告只出 HTML\n', 'utf8')
  writeFileSync(join(memDir, 'MEMORY.md'), '# 项目记忆\n\n## 环境\n- Node 22\n- Windows\n', 'utf8')
  writeFileSync(join(memDir, '2026-09-01.md'), '# 2026-09-01\n\n- 旧条目一\n- 旧条目二\n', 'utf8')
  writeFileSync(join(memDir, '2026-11-09.md'), '# 2026-11-09\n\n- 昨天的条目\n', 'utf8')

  const cfg = normalizeConfig({ workbuddyHome: home, stateDir, ui: { allowWriteActions } })
  const store = createStore({ cfg, stateDir })
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect: (fn) => fn(),
    logger: { warn() {} },
  }
  registerRoutes(ctx, { cfg, recent: { cwd: proj }, stateDir, version: 'test', store })

  const http = createServer((req, res) => routes[0].handler(req, res))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${http.address().port}`

  return {
    cfg,
    base,
    memDir,
    projectMemory: join(memDir, 'MEMORY.md'),
    dailyOld: join(memDir, '2026-09-01.md'),
    dailyNew: join(memDir, '2026-11-09.md'),
    close: () => http.close(),
    get: async (path) => {
      const response = await fetch(`${base}${path}`)
      return { status: response.status, body: await response.json() }
    },
    post: async (payload) => {
      const response = await fetch(`${base}/workbuddy-memory/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, body: await response.json() }
    },
  }
}

test('the panel write chain: edit, conflict, add, remove, restore, prune', async () => {
  const s = await server()
  try {
    const state = await s.get('/workbuddy-memory/state')
    assert.equal(state.body.stores.project.entries, 2)
    assert.equal(state.body.stores.project.daily.length, 2)
    assert.equal(state.body.allowWriteActions, true)

    const content = await s.get('/workbuddy-memory/content?target=project-memory')
    const first = content.body.sections[0].entries[0]
    assert.equal(content.body.sections[0].heading, '环境')
    assert.equal(typeof first.line, 'number')

    // Edit one row; the sibling row must not move.
    const edited = await s.post({
      type: 'edit',
      target: 'project-memory',
      section: '环境',
      line: first.line,
      replacement: '- Node 24',
      expectedRevision: content.body.revision,
    })
    assert.equal(edited.body.ok, true)
    assert.match(readFileSync(s.projectMemory, 'utf8'), /- Node 24/)
    assert.match(readFileSync(s.projectMemory, 'utf8'), /- Windows/)
    assert.equal(existsSync(edited.body.backup), true)

    // The revision the panel started with is now stale, and the write is refused.
    const stale = await s.post({
      type: 'edit',
      target: 'project-memory',
      section: '环境',
      line: first.line,
      replacement: '- Node 99',
      expectedRevision: content.body.revision,
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'conflict')
    assert.doesNotMatch(readFileSync(s.projectMemory, 'utf8'), /Node 99/)

    // Add, then remove the same row by its line number.
    const added = await s.post({ type: 'add', target: 'project-memory', section: '环境', text: 'Docker 可用' })
    assert.equal(added.body.ok, true)
    assert.match(readFileSync(s.projectMemory, 'utf8'), /Docker 可用/)

    const withDocker = await s.get('/workbuddy-memory/content?target=project-memory')
    const docker = withDocker.body.sections[0].entries.find((entry) => entry.text.includes('Docker'))
    const removed = await s.post({
      type: 'remove',
      target: 'project-memory',
      section: '环境',
      line: docker.line,
      expectedRevision: withDocker.body.revision,
    })
    assert.equal(removed.body.ok, true)
    assert.doesNotMatch(readFileSync(s.projectMemory, 'utf8'), /Docker 可用/)

    // Restore: the newest backup is the file as it stood before the removal.
    const revisions = await s.get('/workbuddy-memory/revisions?target=project-memory')
    assert.ok(revisions.body.revisions.length >= 2)
    const name = revisions.body.revisions[0].name
    const snapshot = await s.get(`/workbuddy-memory/revision?target=project-memory&name=${encodeURIComponent(name)}`)
    assert.equal(snapshot.body.ok, true)
    assert.equal(typeof snapshot.body.current.text, 'string')

    const restored = await s.post({
      type: 'restore',
      target: 'project-memory',
      name,
      expectedRevision: snapshot.body.current.revision,
    })
    assert.equal(restored.body.ok, true)
    assert.equal(readFileSync(s.projectMemory, 'utf8'), snapshot.body.text)

    // Prune: only the old daily file is archived; MEMORY.md is never touched.
    const plan = await s.post({ type: 'prune', dryRun: true, beforeDays: 30 })
    assert.deepEqual(
      plan.body.candidates.map((row) => row.date),
      ['2026-09-01'],
    )
    const pruned = await s.post({ type: 'prune', dryRun: false, beforeDays: 30, dates: ['2026-09-01'] })
    assert.equal(pruned.body.ok, true)
    assert.equal(readFileSync(s.projectMemory, 'utf8'), snapshot.body.text)
    assert.equal(existsSync(s.dailyOld), false)
    assert.match(readFileSync(join(s.memDir, 'archive', '2026-09-01.md'), 'utf8'), /旧条目一/)
    assert.match(readFileSync(s.dailyNew, 'utf8'), /昨天的条目/)
  } finally {
    s.close()
  }
})

test('the write surface refuses what it did not open', async () => {
  const closed = await server({ allowWriteActions: false })
  try {
    const off = await closed.post({ type: 'remove', target: 'project-memory', section: '环境', line: 1 })
    assert.equal(off.status, 403)
    assert.equal(off.body.code, 'write_actions_disabled')
  } finally {
    closed.close()
  }

  const s = await server()
  try {
    // The profile is a distillation product; the panel may show it, not edit it.
    assert.equal((await s.post({ type: 'remove', target: 'profile', section: 'x', line: 1 })).body.code, 'read_only_target')
    assert.equal((await s.post({ type: 'drop-table' })).body.code, 'unknown_action')

    // A cross-site form post cannot set this header, so it cannot reach a write.
    const plain = await fetch(`${s.base}/workbuddy-memory/action`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'type=remove',
    })
    assert.equal(plain.status, 415)

    // A write that reaches the store while read-only is refused there too.
    s.cfg.readOnly = true
    const blocked = await s.post({ type: 'remove', target: 'project-memory', section: '环境', line: 1 })
    assert.equal(blocked.body.code, 'read_only')
  } finally {
    s.close()
  }
})

test('a retried action replays instead of writing twice', async () => {
  const s = await server()
  try {
    const content = await s.get('/workbuddy-memory/content?target=project-memory')
    const payload = {
      type: 'add',
      target: 'project-memory',
      section: '环境',
      text: '- 重试一次',
      expectedRevision: content.body.revision,
      operationId: 'click-7f3a',
    }

    const first = await s.post(payload)
    assert.equal(first.body.ok, true)
    const afterFirst = readFileSync(s.projectMemory, 'utf8')
    assert.equal(afterFirst.match(/重试一次/g).length, 1)

    // The same click sent again — a timeout retry — must not append a second
    // copy. The id is the client's, so the store recognises the replay.
    const again = await s.post(payload)
    assert.equal(again.body.ok, true)
    assert.equal(again.body.duplicate, true)
    assert.equal(readFileSync(s.projectMemory, 'utf8'), afterFirst)
  } finally {
    s.close()
  }
})

test('a document too large for the panel cannot be edited from it', async () => {
  const s = await server()
  try {
    // Past MAX_TEXT_CHARS the panel only holds a prefix. Writing that prefix
    // back would splice a truncated body into the full file and delete the
    // tail, so both document-level actions refuse instead.
    const filler = '- filler\n'.repeat(30000)
    writeFileSync(s.projectMemory, `# T\n\n## 环境\n${filler}`, 'utf8')
    const before = readFileSync(s.projectMemory, 'utf8')

    const content = await s.get('/workbuddy-memory/content?target=project-memory')
    assert.equal(content.body.truncated, true)
    assert.equal(content.body.revision, null, 'a truncated read has no revision to save with')

    const section = await s.post({
      type: 'replace-section',
      target: 'project-memory',
      section: '环境',
      body: '- only-one',
      expectedRevision: content.body.revision,
    })
    assert.equal(section.status, 413)
    assert.equal(section.body.code, 'too_large')

    const document = await s.post({
      type: 'replace-document',
      target: 'project-memory',
      text: '# T\n\n## 环境\n- only-one\n',
      expectedRevision: content.body.revision,
    })
    assert.equal(document.body.code, 'too_large')

    assert.equal(readFileSync(s.projectMemory, 'utf8'), before, 'the file is untouched')
  } finally {
    s.close()
  }
})
