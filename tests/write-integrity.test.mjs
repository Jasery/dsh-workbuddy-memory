/**
 * Deterministic regressions for write correctness, receipts and archive plans.
 *
 * Every fixture is its own temporary workspace and its own state directory.
 * Nothing here touches real memory, a profile, or the network.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../src/config.js'
import { probeEnvironment } from '../src/env.js'
import { contentRevision, pathKey } from '../src/write/fslock.js'
import { createStore } from '../src/write/store.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CHILD = join(HERE, 'helpers', 'append-once.mjs')

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'wbm-cas-'))
  const cwd = join(root, 'repo')
  const memoryDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const home = join(root, 'home')
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'MEMORY.md'), '- 全局条目\n', 'utf8')
  return { root, cwd, memoryDir, home }
}

function setup(overrides = {}, hooks = {}) {
  const space = workspace()
  const cfg = normalizeConfig({ workbuddyHome: space.home, stateDir: join(space.root, 'state'), ...overrides })
  const probe = probeEnvironment({ cfg, cwd: space.cwd, env: { WORKBUDDY_CONFIG_DIR: space.home }, home: space.root })
  const stateDir = join(space.root, 'state')
  const store = createStore({ cfg, stateDir, onCommit: hooks.onCommit })
  return { ...space, cfg, probe, stateDir, store }
}

function dayStamp(days = 0) {
  const today = new Date()
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child ${code}: ${err}`))
      try {
        resolve(JSON.parse(out.trim().split('\n').at(-1)))
      } catch (error) {
        reject(new Error(`bad child output: ${out}\n${error.message}`))
      }
    })
  })
}

test('two processes with one operationId commit exactly once', async () => {
  const s = setup()
  const args = [s.stateDir, s.cwd, s.home, s.root, 'op-cross-process', 'project-memory', '跨进程一次']
  const [a, b] = await Promise.all([runChild(args), runChild(args)])
  assert.ok(a.ok && b.ok, JSON.stringify([a, b]))
  assert.equal([a, b].filter((row) => row.duplicate === true).length, 1, JSON.stringify([a, b]))

  const file = join(s.memoryDir, 'MEMORY.md')
  const text = readFileSync(file, 'utf8')
  assert.equal(text.split('- 跨进程一次').length - 1, 1)
})

test('the same operationId on another target is refused', async () => {
  const s = setup()
  const first = await s.store.append({ target: 'project-memory', section: 'A', text: '项目侧', operationId: 'op-target' }, s.probe)
  assert.equal(first.ok, true)
  const second = await s.store.append({ target: 'user-memory', section: 'A', text: '用户侧', operationId: 'op-target' }, s.probe)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'operation_mismatch')
  assert.equal(readFileSync(join(s.memoryDir, 'MEMORY.md'), 'utf8').includes('用户侧'), false)
  assert.equal(readFileSync(join(s.home, 'memory', 'MEMORY.md'), 'utf8').includes('用户侧'), false)
})

test('a restore replay returns the original result without another backup', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')
  await s.store.append({ target: 'project-memory', section: 'A', text: 'two' }, s.probe)
  const rows = s.store.listRevisions(file)
  const input = {
    target: 'project-memory',
    name: rows[0].name,
    expectedRevision: contentRevision(readFileSync(file, 'utf8')),
    operationId: 'op-restore-replay',
  }
  const first = await s.store.restore(input, s.probe)
  assert.equal(first.ok, true)
  const count = s.store.listRevisions(file).length

  const replay = await s.store.restore(input, s.probe)
  assert.equal(replay.ok, true)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.revision, first.revision)
  assert.equal(s.store.listRevisions(file).length, count, 'a replay must not take another backup')
})

test('a destructive rewrite without expectedRevision is refused', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '# T\n\n## A\n- one\n'
  writeFileSync(file, before, 'utf8')

  const calls = [
    () => s.store.edit({ target: 'project-memory', section: 'A', match: 'one', replacement: 'x' }, s.probe),
    () => s.store.editAt({ target: 'project-memory', section: 'A', line: 1, replacement: '- x' }, s.probe),
    () => s.store.remove({ target: 'project-memory', section: 'A', line: 1 }, s.probe),
    () => s.store.replaceSection({ target: 'project-memory', section: 'A', body: '- x\n' }, s.probe),
    () => s.store.replaceDocument({ target: 'project-memory', text: '# T\n\n## A\n- x\n' }, s.probe),
    () => s.store.removeSection({ target: 'project-memory', section: 'A' }, s.probe),
  ]
  for (const call of calls) {
    const result = await call()
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'revision_required')
    assert.equal(readFileSync(file, 'utf8'), before)
  }
})

test('an unreadable post-write snapshot is outcome_unknown, not an empty revision', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')
  const expectedRevision = contentRevision('## A\n- one\n')

  const realFstatSync = fs.fstatSync
  let stats = 0
  fs.fstatSync = (fd) => {
    stats += 1
    // The post-write read makes the third and fourth fstat calls. Appending
    // just before the fourth makes that snapshot "changed", exactly like an
    // external writer landing between the read and its verification.
    if (stats === 4) appendFileSync(file, '- external-after-write\n')
    return realFstatSync(fd)
  }
  syncBuiltinESMExports()

  let result
  try {
    result = await s.store.edit(
      { target: 'project-memory', section: 'A', match: 'one', replacement: 'one-own', expectedRevision },
      s.probe,
    )
  } finally {
    fs.fstatSync = realFstatSync
    syncBuiltinESMExports()
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'outcome_unknown')
  assert.equal(result.committed, true)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /one-own/)
  assert.match(text, /external-after-write/)
})

test('two writers with the same CAS revision: one commits, one conflicts', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '## A\n- one\n'
  writeFileSync(file, before, 'utf8')
  const revision = contentRevision(before)
  const other = createStore({ cfg: s.cfg, stateDir: s.stateDir })

  const [a, b] = await Promise.all([
    s.store.edit({ target: 'project-memory', section: 'A', match: 'one', replacement: 'one-a', expectedRevision: revision, operationId: 'same-cas-a' }, s.probe),
    other.edit({ target: 'project-memory', section: 'A', match: 'one', replacement: 'one-b', expectedRevision: revision, operationId: 'same-cas-b' }, s.probe),
  ])
  const ok = [a, b].filter((row) => row.ok)
  const conflict = [a, b].filter((row) => !row.ok)
  assert.equal(ok.length, 1, JSON.stringify([a, b]))
  assert.equal(conflict.length, 1, JSON.stringify([a, b]))
  assert.equal(conflict[0].code, 'conflict')
  const text = readFileSync(file, 'utf8')
  assert.equal(text.includes('one-a') || text.includes('one-b'), true)
  assert.equal(text.includes('one-a') && text.includes('one-b'), false)
})

test('different operationIds still let both appends land', async () => {
  const s = setup()
  const results = await Promise.all([
    s.store.append({ target: 'project-memory', section: 'A', text: '一号', operationId: 'append-one' }, s.probe),
    s.store.append({ target: 'project-memory', section: 'A', text: '二号', operationId: 'append-two' }, s.probe),
  ])
  assert.ok(results.every((row) => row.ok), JSON.stringify(results))
  const text = readFileSync(join(s.memoryDir, 'MEMORY.md'), 'utf8')
  assert.ok(text.includes('- 一号'))
  assert.ok(text.includes('- 二号'))
})

test('operationLog:false still deduplicates through the receipt', async () => {
  const s = setup({ write: { operationLog: false } })
  const input = { target: 'project-memory', section: 'A', text: '只写一次', operationId: 'op-no-ledger' }
  const first = await s.store.append(input, s.probe)
  const second = await s.store.append(input, s.probe)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.duplicate, true)
  const text = readFileSync(join(s.memoryDir, 'MEMORY.md'), 'utf8')
  assert.equal(text.split('- 只写一次').length - 1, 1)
  assert.equal(existsSync(join(s.stateDir, 'receipts')), true, 'the receipt is independent of the ledger')
})

test('a receipt that cannot be created refuses the write before the source changes', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  const before = '## A\n- one\n'
  writeFileSync(file, before, 'utf8')
  mkdirSync(s.stateDir, { recursive: true })
  writeFileSync(join(s.stateDir, 'receipts'), 'not a directory', 'utf8')

  const result = await s.store.edit(
    { target: 'project-memory', section: 'A', match: 'one', replacement: 'two', expectedRevision: contentRevision(before), operationId: 'op-receipt-fail' },
    s.probe,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'receipt_capacity')
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('commits notify once, after locks are released, and listener failures are isolated', async () => {
  const seen = []
  let observedLock = 'unset'
  const s = setup({}, {
    onCommit(event) {
      seen.push({ ...event, call: 'onCommit' })
      const fileLock = join(s.stateDir, 'locks', `${pathKey(join(s.memoryDir, 'MEMORY.md'))}.lock`)
      const opLock = join(s.stateDir, 'locks', `op-${pathKey(`operation:${event.operationId}`)}.lock`)
      observedLock = existsSync(fileLock) || existsSync(opLock) ? 'held' : 'released'
    },
  })
  const listenerEvents = []
  const dispose = s.store.subscribe((event) => {
    listenerEvents.push(event)
    throw new Error('listener must not break a write')
  })
  s.store.subscribe(() => Promise.reject(new Error('async listener must not break a write')))

  const result = await s.store.append({ target: 'project-memory', section: 'A', text: '通知一次', operationId: 'op-notify' }, s.probe)
  assert.equal(result.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(listenerEvents.length, 1)
  assert.equal(observedLock, 'released')
  assert.equal(seen[0].target, 'project-memory')
  assert.equal(seen[0].operation, 'append')
  assert.equal(seen[0].revision, result.revision)
  assert.equal(seen[0].operationId, 'op-notify')

  const duplicate = await s.store.append({ target: 'project-memory', section: 'A', text: '通知一次', operationId: 'op-notify' }, s.probe)
  assert.equal(duplicate.duplicate, true)
  assert.equal(seen.length, 1, 'a duplicate is not a new commit')
  dispose()
  assert.equal(listenerEvents.length, 1)
})

test('two backups taken in the same millisecond never overwrite each other', async () => {
  const s = setup()
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- zero\n', 'utf8')
  const fixed = Date.now()
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed)
      else super(...args)
    }
    static now() {
      return fixed
    }
  }
  try {
    const first = await s.store.edit(
      { target: 'project-memory', section: 'A', match: 'zero', replacement: 'one', expectedRevision: contentRevision(readFileSync(file, 'utf8')) },
      s.probe,
    )
    assert.equal(first.ok, true)
    const second = await s.store.edit(
      { target: 'project-memory', section: 'A', match: 'one', replacement: 'two', expectedRevision: first.revision },
      s.probe,
    )
    assert.equal(second.ok, true)
  } finally {
    global.Date = RealDate
  }

  const rows = s.store.listRevisions(file)
  assert.equal(rows.length, 2, 'same-ms backups are two files')
  const texts = rows.map((row) => s.store.readRevision(file, row.name).text).sort()
  assert.deepEqual(texts, ['## A\n- one\n', '## A\n- zero\n'])
})

test('backupKeep:0 refuses a destructive write but permits append', async () => {
  const s = setup({ write: { backupKeep: 0 } })
  const file = join(s.memoryDir, 'MEMORY.md')
  writeFileSync(file, '## A\n- one\n', 'utf8')

  const edit = await s.store.edit(
    { target: 'project-memory', section: 'A', match: 'one', replacement: 'two', expectedRevision: contentRevision('## A\n- one\n') },
    s.probe,
  )
  assert.equal(edit.ok, false)
  assert.equal(edit.code, 'backup_required')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n')

  const document = await s.store.replaceDocument(
    { target: 'project-memory', text: '## A\n- only\n', expectedRevision: contentRevision('## A\n- one\n') },
    s.probe,
  )
  assert.equal(document.code, 'backup_required')
  assert.equal(readFileSync(file, 'utf8'), '## A\n- one\n')

  const appended = await s.store.append({ target: 'project-memory', section: 'A', text: '三条' }, s.probe)
  assert.equal(appended.ok, true, 'an ordinary append explicitly honours backupKeep:0')
  assert.equal(appended.backup, null)
  assert.match(readFileSync(file, 'utf8'), /- 三条/)
})

test('prune preview creates no state or archive directory', async () => {
  const s = setup()
  writeFileSync(join(s.memoryDir, `${dayStamp(-40)}.md`), '- 旧条目\n', 'utf8')
  const plan = await s.store.prune({ beforeDays: 30, dryRun: true }, s.probe)
  assert.equal(plan.ok, true)
  assert.equal(typeof plan.planId, 'string')
  assert.equal(existsSync(join(s.memoryDir, 'archive')), false)
  assert.equal(existsSync(join(s.stateDir, 'receipts')), false)
})

test('prune apply without a plan is refused', async () => {
  const s = setup()
  const old = dayStamp(-40)
  writeFileSync(join(s.memoryDir, `${old}.md`), '- 旧条目\n', 'utf8')
  const result = await s.store.prune({ dryRun: false, beforeDays: 30, dates: [old], operationId: 'op-no-plan' }, s.probe)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'plan_required')
  assert.equal(existsSync(join(s.memoryDir, `${old}.md`)), true)
})

test('a file changed after the preview is refused, and a new file is not moved', async () => {
  const s = setup()
  const old = dayStamp(-40)
  const fresh = dayStamp(-41)
  const source = join(s.memoryDir, `${old}.md`)
  writeFileSync(source, '- 预览时\n', 'utf8')
  const plan = await s.store.prune({ beforeDays: 30, dryRun: true }, s.probe)
  assert.deepEqual(plan.candidates.map((row) => row.date), [old])

  writeFileSync(join(s.memoryDir, `${fresh}.md`), '- 预览后新增\n', 'utf8')
  writeFileSync(source, '- 预览后被改\n', 'utf8')
  const changed = await s.store.prune(
    { dryRun: false, planId: plan.planId, dates: [old], operationId: 'op-plan-changed' },
    s.probe,
  )
  assert.equal(changed.ok, false)
  assert.equal(changed.code, 'plan_conflict')
  assert.equal(existsSync(source), true)
  assert.equal(existsSync(join(s.memoryDir, `${fresh}.md`)), true)
})

test('an apply waits on a held date lock and then refuses without moving', async () => {
  const s = setup({ write: { lockWaitMs: 40 } })
  const old = dayStamp(-40)
  const source = join(s.memoryDir, `${old}.md`)
  writeFileSync(source, '- 旧条目\n', 'utf8')
  const plan = await s.store.prune({ beforeDays: 30, dryRun: true }, s.probe)

  mkdirSync(join(s.stateDir, 'locks', `${pathKey(source)}.lock`), { recursive: true })
  const result = await s.store.prune(
    { dryRun: false, planId: plan.planId, dates: [old], operationId: 'op-locked-date' },
    s.probe,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'lock_timeout')
  assert.equal(existsSync(source), true)
})

test('a partial move is reported, then resumed and made idempotent', async () => {
  const committed = []
  const s = setup({}, { onCommit: (event) => committed.push(event) })
  const first = dayStamp(-40)
  const second = dayStamp(-41)
  writeFileSync(join(s.memoryDir, `${first}.md`), '- 甲\n', 'utf8')
  writeFileSync(join(s.memoryDir, `${second}.md`), '- 乙\n', 'utf8')

  const plan = await s.store.prune({ beforeDays: 30, dryRun: true }, s.probe)
  assert.deepEqual(plan.candidates.map((row) => row.date), [second, first])

  const realRename = fs.renameSync
  const restore = () => {
    fs.renameSync = realRename
    syncBuiltinESMExports()
  }
  fs.renameSync = (from, to) => {
    if (String(from).endsWith(`${second}.md`)) {
      const error = new Error('simulated rename failure')
      error.code = 'EACCES'
      throw error
    }
    return realRename(from, to)
  }
  syncBuiltinESMExports()

  let partial
  try {
    partial = await s.store.prune(
      { dryRun: false, planId: plan.planId, dates: [second, first], operationId: 'op-partial' },
      s.probe,
    )
  } finally {
    restore()
  }
  assert.equal(partial.ok, false)
  assert.equal(partial.code, 'partial')
  assert.deepEqual(partial.pruned.map((row) => row.date), [first])
  assert.deepEqual(partial.failed.map((row) => row.date), [second])
  assert.equal(existsSync(join(s.memoryDir, `${first}.md`)), false)
  assert.equal(existsSync(join(s.memoryDir, `${second}.md`)), true)
  assert.equal(existsSync(join(s.memoryDir, 'archive', `${first}.md`)), true)
  assert.deepEqual(committed.map((event) => event.operation), ['prune'], 'the moved item was notified even though the apply was partial')

  // A fresh store has no in-memory plan; the receipt manifest must be enough.
  const restarted = createStore({ cfg: s.cfg, stateDir: s.stateDir })
  const resumedEvents = []
  restarted.subscribe((event) => resumedEvents.push(event))
  const resumed = await restarted.prune(
    { dryRun: false, planId: plan.planId, dates: [second, first], operationId: 'op-partial' },
    s.probe,
  )
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.deepEqual(resumed.pruned.map((row) => row.date).sort(), [second, first].sort())
  assert.equal(existsSync(join(s.memoryDir, `${second}.md`)), false)
  assert.equal(existsSync(join(s.memoryDir, 'archive', `${second}.md`)), true)
  assert.equal(resumedEvents.length, 1, 'only the newly moved item is a new commit')
  assert.match(resumedEvents[0].path, new RegExp(`${second}\\.md$`))
  assert.match(resumedEvents[0].archivePath, new RegExp(`archive.*${second}\\.md$`))

  const beforeReplay = readdirSync(join(s.memoryDir, 'archive')).length
  const again = await restarted.prune(
    { dryRun: false, planId: plan.planId, dates: [second, first], operationId: 'op-partial' },
    s.probe,
  )
  assert.equal(again.ok, true)
  assert.equal(again.duplicate, true)
  assert.equal(readdirSync(join(s.memoryDir, 'archive')).length, beforeReplay)
  assert.equal(resumedEvents.length, 1, 'a duplicate is not a new commit')
})
