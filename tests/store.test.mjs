import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { probeEnvironment } from '../src/env.js'
import { contentRevision } from '../src/write/fslock.js'
import { createStore } from '../src/write/store.js'

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
