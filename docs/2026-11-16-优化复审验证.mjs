/** Isolated read-only audit of the existing implementation, not product fixes.
 * Run: node docs/2026-11-16-优化复审验证.mjs
 * Only creates and removes a checked temporary directory; never reads real memory.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { appendToSection } from '../src/markdown.js'
import { Config, normalizeConfig } from '../src/config.js'
import { probeEnvironment } from '../src/env.js'
import { createTranslator } from '../src/locale.js'
import { registerSections } from '../src/inject.js'
import { renderSections } from '../src/render.js'
import { readTool } from '../src/tools/read.js'
import { describe } from '../src/tools/status.js'
import { createStore } from '../src/write/store.js'
import { contentRevision, pathKey, withLock } from '../src/write/fslock.js'

const tempParent = realpathSync(tmpdir())
const root = mkdtempSync(join(tempParent, 'wbm-plan-recheck-'))
const t = createTranslator('zh')
const results = []
let sequence = 0
function record(id, detail) { results.push({ id, reproduced: true, ...detail }) }
function fixture(raw = {}) {
  const dir = join(root, `case-${++sequence}`)
  const home = join(dir, 'home')
  const cwd = join(dir, 'repo')
  const memoryDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(home, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(dir, 'state'), ...raw })
  const file = join(memoryDir, 'MEMORY.md')
  const exec = { agent: { session: { id: 'fixture', header: { cwd } } } }
  const probe = () => probeEnvironment({ cfg, cwd, detail: true })
  return { dir, home, cwd, memoryDir, cfg, file, exec, probe }
}
try {
  {
    const original = '# Memory\n\n## Core\n- old preference\n\n## Logs\n' + '- historical detail\n'.repeat(40)
    const after = appendToSection(original, 'Core', 'NEWEST-PREFERENCE').text
    assert(after.includes('NEWEST-PREFERENCE'))
    assert(!after.slice(-120).includes('NEWEST-PREFERENCE'))
    record('O01-section-append-not-eof', { offset: after.indexOf('NEWEST-PREFERENCE'), length: after.length, newestInTail120: false })
  }
  {
    const f = fixture({ inject: { limits: { project: 20 } } })
    writeFileSync(f.file, '## A\n- ' + '😀'.repeat(30) + '\n')
    const block = renderSections({ cfg: f.cfg, probe: f.probe(), t }).find(x => x.name.endsWith(':project'))
    assert(block.text.length > 20)
    record('O01-budget-units-and-wrapper', { configured: 20, actualUtf16: block.text.length })
  }
  {
    const f = fixture({ inject: { limits: { project: 0 } } })
    writeFileSync(f.file, '## A\n- should be disabled\n')
    const block = renderSections({ cfg: f.cfg, probe: f.probe(), t }).find(x => x.name.endsWith(':project'))
    assert(block?.text.length > 0)
    record('O04-zero-limit-still-renders-wrapper', { configured: 0, actualUtf16: block.text.length })
  }
  {
    const f = fixture()
    writeFileSync(f.file, '- ' + '😀'.repeat(5) + '\n')
    const out = await readTool({ cfg: f.cfg, t }).execute({ target: 'project-memory', limit: 3 }, f.exec)
    const broken = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out.content)
    assert(broken)
    record('O01-memory-read-surrogate-cut', { loneHighSurrogate: broken })
  }
  {
    const f = fixture()
    const complete = '## A\n- ' + 'x'.repeat(2 * 1024 * 1024 + 32) + '\n'
    writeFileSync(f.file, complete)
    const out = await readTool({ cfg: f.cfg, t }).execute({ target: 'project-memory', sectionsOnly: true }, f.exec)
    assert.notEqual(out.revision, contentRevision(complete))
    assert.equal(out.truncated, undefined)
    record('O01-byte-capped-revision-not-full-file', { reportedBytes: out.bytes, revisionMatchesFull: false, byteTruncationExposed: false })
  }
  {
    const f = fixture({ inject: { enabled: false } })
    writeFileSync(join(f.home, 'MEMORY.md'), '- visible in status only\n')
    const out = describe(f.probe(), f.cfg, t)
    assert(out.stores.user.injected > 0)
    record('O06-estimated-injected-while-disabled', { enabled: false, statusInjected: out.stores.user.injected })
  }
  {
    const f = fixture({ inject: { refresh: 'first-turn' } })
    writeFileSync(f.file, '## A\n- v1\n')
    const definitions = new Map()
    const ctx = { systemPrompt: { section(d) { definitions.set(d.name, d); return () => {} } }, effect(fn) { return fn() }, logger: { warn() {} } }
    const controller = registerSections(ctx, { cfg: f.cfg, t })
    const provider = definitions.get('workbuddy-memory:project')
    const context = id => ({ agent: { session: { id, header: { cwd: f.cwd } } }, scope: {} })
    assert(provider.text(context('A')).includes('v1'))
    writeFileSync(f.file, '## A\n- v2\n')
    const bBefore = provider.text(context('B'))
    assert(bBefore.includes('v1'))
    controller.invalidate()
    assert(provider.text(context('B')).includes('v2'))
    record('O05-same-cwd-shares-frozen-state', { freshSessionBSeesOldText: true, globalInvalidationChangesB: true })
  }
  {
    const f = fixture()
    const personal = join(f.home, 'user-abc-personal')
    mkdirSync(personal)
    writeFileSync(join(personal, 'USER.md'), '# User\n')
    const profile = f.probe().profile
    assert.equal(profile.source, 'single')
    assert.equal(profile.uid, '')
    record('O04-single-profile-uid-empty', { expectedUid: 'abc', actualUid: profile.uid })
  }
  {
    const f = fixture()
    const store = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    writeFileSync(f.file, '## A\n- one\n- two\n')
    const out = await store.replaceSection({ target: 'project-memory', section: 'A', body: '- replacement\n' }, f.probe())
    assert(out.ok)
    assert(!readFileSync(f.file, 'utf8').includes('- two'))
    record('O03-section-overwrite-without-revision', { success: out.ok, droppedOldEntries: true })
  }
  {
    const dir = join(root, 'invalid-write')
    const home = join(dir, 'home')
    const cwd = join(dir, 'repo')
    const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(dir, 'state'), write: { ensureLayout: true } })
    const probe = probeEnvironment({ cfg, cwd })
    const out = await createStore({ cfg, stateDir: cfg.stateDir }).append({ target: 'project-memory', text: 'invalid\nmultiline' }, probe)
    assert.equal(out.code, 'multiline_text')
    assert(existsSync(probe.project.dir))
    record('init-invalid-write-creates-directory', { refusedAs: out.code, directoryCreated: true })
  }
  {
    const input = { readOnly: true, workbuddyHome: join(root, 'configured-home'), search: { enabled: false }, inject: { limits: { user: 3000 } } }
    const parsed = await Config['~standard'].validate(input)
    assert(!parsed.issues)
    assert.equal(parsed.value.readOnly.get(), true)
    const effective = normalizeConfig(parsed.value)
    assert.equal(effective.readOnly, false)
    assert.equal(effective.workbuddyHome, '')
    assert.equal(effective.search.enabled, true)
    assert.equal(effective.inject.limits.user, 8000)
    record('O04-volatile-wrapper-normalized-to-default', { schemaReadOnly: true, normalizedReadOnly: effective.readOnly, configuredSearch: false, normalizedSearch: effective.search.enabled, configuredUserLimit: 3000, normalizedUserLimit: effective.inject.limits.user })
  }
  {
    const f = fixture()
    writeFileSync(f.file, '## A\n- initial\n')
    const store = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    let unlock, entered
    const ready = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { unlock = resolve })
    const holding = withLock(join(f.cfg.stateDir, 'locks', `${pathKey(f.file)}.lock`), 3000, () => { entered(); return gate })
    await ready
    const input = { target: 'project-memory', section: 'A', text: 'same request', operationId: 'simultaneous-id' }
    const first = store.append(input, f.probe())
    const second = store.append(input, f.probe())
    unlock(); await holding
    const out = await Promise.all([first, second])
    assert(out.every(x => x.ok && !x.duplicate))
    const copies = readFileSync(f.file, 'utf8').split('same request').length - 1
    assert.equal(copies, 2)
    record('O03-concurrent-identical-id-duplicates', { successes: out.filter(x => x.ok).length, copies })
  }
  {
    const f = fixture()
    writeFileSync(f.file, '## A\n- original\n')
    const store = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    const edited = await store.replaceSection({ target: 'project-memory', section: 'A', body: '- revised\n' }, f.probe())
    assert(edited.ok)
    const name = store.listRevisions(f.file)[0].name
    const input = { target: 'project-memory', name, expectedRevision: edited.revision, operationId: 'restore-replay' }
    assert((await store.restore(input, f.probe())).ok)
    const replay = await store.restore(input, f.probe())
    assert.equal(replay.code, 'conflict')
    record('O03-restore-replay-not-idempotent', { secondResult: replay.code })
  }
  {
    const f = fixture()
    const store = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    assert((await store.append({ target: 'project-memory', section: 'A', text: 'project', operationId: 'reused-id' }, f.probe())).ok)
    const user = await store.append({ target: 'user-memory', section: 'A', text: 'user', operationId: 'reused-id' }, f.probe())
    assert(user.ok && user.duplicate)
    assert(!existsSync(join(f.home, 'MEMORY.md')))
    record('O03-id-reused-on-other-target-false-duplicate', { duplicate: user.duplicate, userFileCreated: false })
  }
  {
    const f = fixture()
    const daily = join(f.memoryDir, '2000-01-01.md')
    writeFileSync(daily, '- historical\n')
    const store = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    const out = await withLock(join(f.cfg.stateDir, 'locks', `${pathKey(daily)}.lock`), 3000, () => store.prune({ dryRun: false, dates: ['2000-01-01'], operationId: 'prune-under-lock' }, f.probe()))
    assert(out.ok && !existsSync(daily))
    record('O03-prune-ignores-daily-write-lock', { prunedWhileWriteLockHeld: true })
  }
  {
    const f = fixture()
    const original = join(f.memoryDir, '2000-01-01.md')
    writeFileSync(original, '- before preview\n')
    const store = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    const plan = await store.prune({ dryRun: true, beforeDays: 30 }, f.probe())
    assert.equal(plan.candidates.length, 1)
    writeFileSync(original, '- changed after preview\n')
    writeFileSync(join(f.memoryDir, '2000-01-02.md'), '- created after preview\n')
    const out = await store.prune({ dryRun: false, beforeDays: 30, operationId: 'drifted-plan' }, f.probe())
    assert.equal(out.pruned.length, 2)
    assert(readFileSync(join(f.memoryDir, 'archive', '2000-01-01.md'), 'utf8').includes('changed after preview'))
    const replay = await store.prune({ dryRun: false, beforeDays: 30, operationId: 'drifted-plan' }, f.probe())
    assert.equal(replay.code, 'nothing_to_prune')
    record('O03-prune-preview-not-bound-and-replay-not-duplicate', { previewFiles: 1, executedFiles: 2, archivedChangedContent: true, secondResult: replay.code })
  }
  {
    const f = fixture()
    writeFileSync(f.file, '## A\n- original\n')
    const store = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    const RealDate = globalThis.Date
    const epoch = RealDate.now()
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [epoch])) } static now() { return epoch } }
    let backups
    try {
      assert((await store.replaceSection({ target: 'project-memory', section: 'A', body: '- first\n' }, f.probe())).ok)
      assert((await store.replaceSection({ target: 'project-memory', section: 'A', body: '- second\n' }, f.probe())).ok)
      backups = store.listRevisions(f.file)
    } finally { globalThis.Date = RealDate }
    assert.equal(backups.length, 1)
    const saved = store.readRevision(f.file, backups[0].name)
    assert(saved.text.includes('first') && !saved.text.includes('original'))
    record('O03-same-millisecond-backup-overwrite', { writes: 2, backupFiles: backups.length, originalStillBackedUp: false })
  }
  {
    const f = fixture()
    writeFileSync(f.file, '## A\n- observed\n')
    const revision = contentRevision(readFileSync(f.file, 'utf8'))
    const first = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    const second = createStore({ cfg: f.cfg, stateDir: f.cfg.stateDir })
    const out = await Promise.all([
      first.append({ target: 'project-memory', section: 'A', text: 'one', expectedRevision: revision }, f.probe()),
      second.append({ target: 'project-memory', section: 'A', text: 'two', expectedRevision: revision }, f.probe()),
    ])
    assert.equal(out.filter(x => x.ok).length, 1)
    assert.equal(out.filter(x => x.code === 'conflict').length, 1)
    record('O07-independent-stores-same-cas-correctly-refused', { successes: 1, conflicts: 1 })
  }
  {
    const f = fixture({ dataFolderName: '.codebuddy' })
    const layout = f.probe().layout
    assert.equal(layout.projectMemory, join(f.cwd, '.codebuddy', 'memory', 'MEMORY.md'))
    record('O10-existing-explicit-codebuddy-path', { explicitFolder: '.codebuddy', selectedCorrectly: true })
  }
  console.log(JSON.stringify({ outcome: 'confirmed-existing-behavior', checks: results.length, results }, null, 2))
} finally {
  const checked = realpathSync(root)
  assert.equal(dirname(checked).toLowerCase(), tempParent.toLowerCase())
  assert(basename(checked).startsWith('wbm-plan-recheck-'))
  assert.equal(resolve(checked), resolve(root))
  rmSync(checked, { recursive: true, force: true })
}
