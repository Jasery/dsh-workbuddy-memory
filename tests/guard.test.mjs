/** The bare-write guard: which paths it protects, and when it stands down. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { createTranslator } from '../src/locale.js'
import { probeEnvironment } from '../src/env.js'
import { canon, isMemoryTarget, isUnder, protectedPaths, registerWriteGuard } from '../src/write/guard.js'

/** A real on-disk home + workspace, so realpath has something to resolve. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wbm-guard-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  mkdirSync(join(home, 'memory'), { recursive: true })
  mkdirSync(join(cwd, '.workbuddy', 'memory'), { recursive: true })
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), '## 偏好\n- 中文\n', 'utf8')
  writeFileSync(join(home, 'MEMORY.md'), '- 全局\n', 'utf8')
  writeFileSync(join(cwd, 'src', 'index.js'), 'export {}\n', 'utf8')

  const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(root, 'state') })
  const probe = probeEnvironment({ cfg, cwd, detail: false })
  return { root, home, cwd, cfg, probe }
}

/** Minimal context: capture the guard instead of mounting the tool service. */
function fakeCtx() {
  const captured = { guard: null }
  return {
    captured,
    ctx: {
      tools: {
        guard(fn) {
          captured.guard = fn
          return () => {
            captured.guard = null
          }
        },
      },
      effect(fn) {
        return fn()
      },
    },
  }
}

const t = createTranslator('zh')

test('canon resolves what exists and falls back to the absolute path', () => {
  const { cwd } = fixture()
  assert.equal(canon(join(cwd, 'src', 'index.js')).toLowerCase().endsWith('index.js'), true)
  const missing = join(cwd, 'nope', 'gone.md')
  assert.equal(canon(missing).toLowerCase().endsWith('gone.md'), true)
  assert.equal(canon(''), '')
})

test('isUnder is segment-aware', () => {
  const { cwd } = fixture()
  assert.equal(isUnder(join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), join(cwd, '.workbuddy', 'memory')), true)
  assert.equal(isUnder(join(cwd, '.workbuddy', 'memory'), join(cwd, '.workbuddy', 'memory')), true)
  // A sibling whose name starts with the same prefix must not match.
  assert.equal(isUnder(join(cwd, '.workbuddy', 'memory-2', 'x.md'), join(cwd, '.workbuddy', 'memory')), false)
  assert.equal(isUnder('', join(cwd, 'x')), false)
})

test('protected paths cover the memory files and the workspace memory dir', () => {
  const { probe, cwd } = fixture()
  const { files, dirs } = protectedPaths(probe)
  assert.equal(files.includes(probe.layout.userMemory), true)
  assert.equal(dirs.includes(probe.project.dir), true)
  assert.equal(dirs.includes(join(cwd, '.workbuddy', 'memory')), true)
})

test('isMemoryTarget protects memory, not the rest of the workspace', () => {
  const { probe, cwd, home } = fixture()
  assert.equal(isMemoryTarget(join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), probe), true)
  assert.equal(isMemoryTarget(join(cwd, '.workbuddy', 'memory', '2026-11-09.md'), probe), true)
  assert.equal(isMemoryTarget(join(home, 'MEMORY.md'), probe), true)

  // Ordinary project files, skill files and the plugin's own code stay writable.
  assert.equal(isMemoryTarget(join(cwd, 'src', 'index.js'), probe), false)
  assert.equal(isMemoryTarget(join(cwd, 'README.md'), probe), false)
  assert.equal(isMemoryTarget(join(home, 'skills', 'x', 'SKILL.md'), probe), false)
  assert.equal(isMemoryTarget(join(home, 'workbuddy.sqlite'), probe), false)
})

test('a guard refuses bare writes into memory files', () => {
  const { cfg, cwd } = fixture()
  const { ctx, captured } = fakeCtx()
  assert.equal(registerWriteGuard(ctx, { cfg, t }), true)
  assert.equal(typeof captured.guard, 'function')

  const agent = { session: { header: { cwd } } }
  const denied = captured.guard({ name: 'write', arguments: { file_path: join(cwd, '.workbuddy', 'memory', 'MEMORY.md') }, agent })
  assert.match(denied, /memory_append/)
  assert.match(denied, /MEMORY\.md/)

  const allowed = captured.guard({ name: 'write', arguments: { file_path: join(cwd, 'src', 'index.js') }, agent })
  assert.equal(allowed, undefined)
})

test('a relative path is resolved against the session working directory', () => {
  const { cfg, cwd } = fixture()
  const { ctx, captured } = fakeCtx()
  registerWriteGuard(ctx, { cfg, t })
  const agent = { session: { header: { cwd } } }

  const denied = captured.guard({ name: 'edit', arguments: { path: '.workbuddy/memory/MEMORY.md' }, agent })
  assert.match(denied, /memory_append/)
})

test('the guard only intercepts writers that take a path', () => {
  const { cfg, cwd } = fixture()
  const { ctx, captured } = fakeCtx()
  registerWriteGuard(ctx, { cfg, t })
  const agent = { session: { header: { cwd } } }
  const memory = join(cwd, '.workbuddy', 'memory', 'MEMORY.md')

  assert.equal(captured.guard({ name: 'read', arguments: { file_path: memory }, agent }), undefined)
  assert.equal(captured.guard({ name: 'memory_append', arguments: { target: 'project-memory' }, agent }), undefined)
  assert.equal(captured.guard({ name: 'write', arguments: {}, agent }), undefined)
  assert.equal(captured.guard({ name: 'write', agent }), undefined)
  assert.equal(captured.guard({ name: 'write', arguments: { file_path: '   ' }, agent }), undefined)
})

test('read-only and a disabled guard both stand down', () => {
  const { home, cwd } = fixture()
  const agent = { session: { header: { cwd } } }
  const memory = join(cwd, '.workbuddy', 'memory', 'MEMORY.md')

  const readOnlyCfg = normalizeConfig({ workbuddyHome: home, readOnly: true })
  const a = fakeCtx()
  assert.equal(registerWriteGuard(a.ctx, { cfg: readOnlyCfg, t }), true)
  assert.equal(a.captured.guard({ name: 'write', arguments: { file_path: memory }, agent }), undefined)

  const offCfg = normalizeConfig({ workbuddyHome: home, guard: { enabled: false } })
  const b = fakeCtx()
  assert.equal(registerWriteGuard(b.ctx, { cfg: offCfg, t }), false)
  assert.equal(b.captured.guard, null)
})

test('a host without tools.guard is left alone', () => {
  const { cfg } = fixture()
  const ctx = { effect: (fn) => fn() }
  assert.equal(registerWriteGuard(ctx, { cfg, t }), false)
})

test('apply_patch is refused for every file its patch touches', () => {
  const { cfg, cwd } = fixture()
  const { ctx, captured } = fakeCtx()
  registerWriteGuard(ctx, { cfg, t })
  const agent = { session: { header: { cwd } } }
  const memory = join(cwd, '.workbuddy', 'memory', 'MEMORY.md')

  // A patch names its targets inside the patch text, not in `file_path`; the
  // guard read only `file_path` before, so a patch walked straight past it.
  const denied = captured.guard({
    name: 'apply_patch',
    arguments: { input: `*** Begin Patch\n*** Update File: ${memory}\n@@\n-- 中文\n+- English\n*** End Patch` },
    agent,
  })
  assert.match(denied, /memory_append/)

  const allowed = captured.guard({
    name: 'apply_patch',
    arguments: { input: `*** Begin Patch\n*** Update File: ${join(cwd, 'src', 'index.js')}\n@@\n-export {}\n+export default {}\n*** End Patch` },
    agent,
  })
  assert.equal(allowed, undefined)

  // One memory target among several is enough to refuse the whole patch.
  const mixed = captured.guard({
    name: 'apply_patch',
    arguments: {
      input: [
        '*** Begin Patch',
        `*** Update File: ${join(cwd, 'src', 'index.js')}`,
        '@@',
        '-export {}',
        '+export default {}',
        `*** Add File: ${join(cwd, '.workbuddy', 'memory', 'NEW.md')}`,
        '+## A',
        '*** End Patch',
      ].join('\n'),
    },
    agent,
  })
  assert.match(mixed, /memory_append/)
})

test('a differently-cased memory path is still refused on Windows', () => {
  const { cfg, cwd } = fixture()
  const { ctx, captured } = fakeCtx()
  registerWriteGuard(ctx, { cfg, t })
  const agent = { session: { header: { cwd } } }

  // The memory directory itself does not exist under this spelling, so canon()
  // falls back to the caller's case. On Windows that is the same directory.
  const variant = join(cwd, '.WORKBUDDY', 'memory', 'NEW.md')
  const denied = captured.guard({ name: 'write', arguments: { file_path: variant }, agent })
  if (process.platform === 'win32') assert.match(denied ?? '', /memory_append/)
  else assert.equal(denied, undefined)
})
