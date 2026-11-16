/**
 * Post-fix verification of the memory optimisations, run against the current tree.
 *
 * Run: node docs/2026-11-16-优化复审验证.mjs
 *
 * This script used to assert that the reviewed problems *existed*: it passed
 * while section writes landed at EOF, budgets were measured in the wrong unit,
 * an oversized read handed out a prefix revision, a reused operation id was
 * treated as a duplicate on a different target, and a prune apply ignored the
 * plan it was previewed from. Every one of those was a real defect, and a green
 * run of that script therefore meant "still broken" — exactly the wrong polarity
 * for a check anyone would keep running.
 *
 * It now asserts the corrected behaviour instead, so a green run means the
 * guarantees hold and a red run means one of them regressed. The pre-fix version
 * stays in git history (the commit before the optimisation branch's tip) as the
 * evidence of what was found; it is not meant to be run against today's code.
 *
 * Isolation: creates and removes one checked temporary directory per case. It
 * never reads real memory, never touches a profile, and never uses the network.
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
import { describeBrief } from '../src/tools/status.js'
import { registerTools } from '../src/tools/index.js'
import { RECEIPT_LIMITS } from '../src/write/receipts.js'
import { createStore } from '../src/write/store.js'
import { contentRevision, pathKey, withLock } from '../src/write/fslock.js'

const tempParent = realpathSync(tmpdir())
const root = mkdtempSync(join(tempParent, 'wbm-fixed-verify-'))
const t = createTranslator('zh')

/** Every verified property, in the order it is proven. */
const results = []
let sequence = 0

/**
 * Record one verified property.
 *
 * @param {string} id - stable name, prefixed with the original review item.
 * @param {object} detail - the numbers the assertion actually observed.
 */
function record(id, detail) {
  results.push({ id, verified: true, ...detail })
}

/**
 * One isolated workspace: its own home, project, memory dir and state dir.
 *
 * @param {object} [raw] - config overrides.
 * @param {{ layout?: boolean }} [options] - `layout: false` leaves the project
 *   memory directory absent, which is what a first run looks like.
 */
function fixture(raw = {}, options = {}) {
  const dir = join(root, `case-${++sequence}`)
  const home = join(dir, 'home')
  const cwd = join(dir, 'repo')
  const memoryDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(home, { recursive: true })
  if (options.layout !== false) mkdirSync(memoryDir, { recursive: true })
  const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(dir, 'state'), ...raw })
  const file = join(memoryDir, 'MEMORY.md')
  const exec = { agent: { session: { id: 'fixture', header: { cwd } } } }
  const probe = () => probeEnvironment({ cfg, cwd, detail: true })
  const store = () => createStore({ cfg, stateDir: cfg.stateDir })
  return { dir, home, cwd, memoryDir, cfg, file, exec, probe, store }
}

/** A memory file that already uses the layered shape, in the active locale. */
const LAYERED = (entries) => `# 记忆\n\n## 常驻记忆\n${entries}\n\n## 主题\n- 长尾条目\n`

try {
  {
    // O01 — an append lands inside its section. Writing at EOF would put the
    // entry after later sections, where the panel and the model both read it as
    // belonging to whichever section happens to be last.
    const original = '# Memory\n\n## Core\n- old preference\n\n## Logs\n' + '- historical detail\n'.repeat(40)
    const after = appendToSection(original, 'Core', 'NEWEST-PREFERENCE').text
    assert.ok(after.includes('NEWEST-PREFERENCE'))
    assert.equal(after.slice(-120).includes('NEWEST-PREFERENCE'), false, 'the entry is not at EOF')
    assert.ok(after.indexOf('NEWEST-PREFERENCE') < after.indexOf('## Logs'), 'it sits inside its own section')
    record('O01-append-stays-inside-its-section', {
      offset: after.indexOf('NEWEST-PREFERENCE'),
      length: after.length,
      newestInTail120: false,
    })
  }

  {
    // O01 — the layered budget is a hard cap in UTF-16 code units, and it
    // includes the wrapper. The old code counted the body in code points while
    // comparing against a limit declared in code units, so an emoji-heavy core
    // overflowed the very limit it was supposed to enforce.
    const f = fixture()
    const entries = Array.from({ length: 40 }, (_, index) => `- 第${index}条 ${'😀'.repeat(20)}`).join('\n')
    writeFileSync(f.file, LAYERED(entries))
    const sections = renderSections({ cfg: f.cfg, probe: f.probe(), t })
    const block = sections.find((section) => section.name.endsWith(':project'))
    const budget = Math.floor(f.cfg.inject.coreBudget * 0.375)
    assert.ok(block, 'the project block is rendered')
    assert.ok(block.text.length <= budget, `block ${block.text.length} exceeds the ${budget}-unit share`)
    // Complete entries only: a half-cut emoji or a half-cut entry is not a
    // shortened block, it is a corrupt one.
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(block.text), false, 'no lone surrogate')
    assert.equal(/(^|\n)[^\n]*\uD83D$/.test(block.text), false, 'no half pair at a line end')
    assert.match(String(sections.states.project), /^layered(:core-over-budget\(\d+\))?$/, 'the state names the fallback')
    record('O01-layered-budget-holds-in-utf16-including-wrapper', {
      coreBudget: f.cfg.inject.coreBudget,
      perSourceShare: budget,
      actualUtf16: block.text.length,
      overBudgetNoticed: sections.states.project,
    })
  }

  {
    // O04 — a zero limit disables the source outright. Rendering just the
    // wrapper produced a heading with nothing under it, which reads as an empty
    // memory file rather than as a switched-off source.
    const f = fixture({ inject: { limits: { project: 0 } } })
    writeFileSync(f.file, LAYERED('- should be disabled'))
    const sections = renderSections({ cfg: f.cfg, probe: f.probe(), t })
    assert.equal(sections.find((section) => section.name.endsWith(':project')), undefined, 'no project block at all')
    assert.equal(sections.states.project, 'disabled')
    record('O04-zero-limit-renders-nothing', { configured: 0, blocks: sections.length, state: sections.states.project })
  }

  {
    // O01 — paging never splits a surrogate pair. A lone high surrogate in a
    // tool result is not just mojibake: it is not valid UTF-16, and the model
    // reads a replacement character where a character used to be.
    const f = fixture()
    writeFileSync(f.file, '- ' + '😀'.repeat(5) + '\n')
    const out = await readTool({ cfg: f.cfg, t }).execute({ target: 'project-memory', limit: 3 }, f.exec)
    assert.equal(out.ok, true)
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out.content), false, 'no lone high surrogate')
    assert.equal(/[\uDC00-\uDFFF]/.test(out.content), false, 'no lone low surrogate either')
    record('O01-read-paging-never-splits-a-surrogate-pair', { limit: 3, contentUtf16: out.content.length, loneSurrogate: false })
  }

  {
    // O01 — an oversized file is refused instead of hashed by prefix. A
    // revision computed from a truncated read is worse than no revision: the
    // store would accept it and the write would delete everything unseen.
    const f = fixture()
    const complete = '## A\n- ' + 'x'.repeat(2 * 1024 * 1024 + 32) + '\n'
    writeFileSync(f.file, complete)
    const out = await readTool({ cfg: f.cfg, t }).execute({ target: 'project-memory', sectionsOnly: true }, f.exec)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'too_large')
    assert.equal(out.revision, null, 'no revision is offered for a partial read')
    assert.notEqual(out.revision, contentRevision(complete))
    record('O01-oversized-read-refuses-without-a-revision', {
      code: out.code,
      reportedBytes: out.bytes,
      revision: out.revision,
    })
  }

  {
    // O06 — status does not invent an injected-character count. The old detail
    // view reported `min(chars, limit)` even with injection switched off, which
    // is a number about a block that was never assembled.
    const f = fixture({ inject: { enabled: false } })
    writeFileSync(join(f.home, 'MEMORY.md'), '- visible in status only\n')
    const brief = describeBrief(f.probe(), f.cfg, null, t)
    assert.equal('injected' in brief, false, 'no estimated injected count')
    assert.equal('chars' in brief, false, 'no character estimate either')
    assert.equal(brief.lastAssembly, null, 'and no assembly is claimed when nothing was assembled')
    record('O06-status-does-not-estimate-injected-characters', { keys: Object.keys(brief).sort(), enabled: false })
  }

  {
    // O05 — the snapshot is scoped to one session, not to a working directory.
    // Keying it by cwd meant a brand-new session in the same project read the
    // text an earlier session had frozen, which is how "I just edited it and the
    // model still sees the old copy" happens.
    const f = fixture({ inject: { refresh: 'first-turn' } })
    writeFileSync(f.file, LAYERED('- v1'))
    const definitions = new Map()
    const ctx = {
      systemPrompt: {
        section(definition) {
          definitions.set(definition.name, definition)
          return () => {}
        },
      },
      effect(fn) {
        return fn()
      },
      logger: { warn() {} },
    }
    const controller = registerSections(ctx, { cfg: f.cfg, t })
    const provider = definitions.get('workbuddy-memory:project')
    const sessionA = { id: 'A', header: { cwd: f.cwd } }
    const sessionB = { id: 'B', header: { cwd: f.cwd } }
    const context = (session) => ({ agent: { session }, scope: {} })

    assert.ok(provider.text(context(sessionA)).includes('v1'))
    writeFileSync(f.file, LAYERED('- v2'))
    // A different session object with the same cwd is a different session: its
    // first assembly reads the file as it is now.
    assert.ok(provider.text(context(sessionB)).includes('v2'), 'a fresh session is not served a stale snapshot')
    // And the first session keeps its own frozen snapshot until it is invalidated,
    // which is what `refresh: 'first-turn'` promises.
    assert.ok(provider.text(context(sessionA)).includes('v1'), 'the first session keeps its own snapshot')

    // Read the reported contribution before invalidating: the snapshot is
    // dropped by design on a generation bump, and a stale number is exactly what
    // `lastAssembly` refuses to hand out.
    const assembly = controller.lastAssembly(sessionB)
    assert.equal(assembly.measuredAs, 'plugin-contribution', 'the numbers are labelled as this plugin only')
    assert.equal(controller.lastAssembly(null), null)

    controller.invalidate()
    assert.ok(provider.text(context(sessionA)).includes('v2'), 'invalidation refreshes it')
    assert.equal(controller.lastAssembly(sessionB), null, 'a snapshot from an older generation is not reported')

    record('O05-snapshot-is-per-session-not-per-cwd', {
      freshSessionSeesCurrentText: true,
      firstSessionKeptItsSnapshot: true,
      invalidationRefreshes: true,
      measuredAs: assembly.measuredAs,
    })
  }

  {
    // O04 — the uid comes from the `user-<uid>-personal` directory, which is
    // where it lives. Parsing the `USER.md` path yielded an empty string and made
    // a single profile look like one with no account behind it.
    const f = fixture()
    const personal = join(f.home, 'user-abc-personal')
    mkdirSync(personal)
    writeFileSync(join(personal, 'USER.md'), '# User\n')
    const profile = f.probe().profile
    assert.equal(profile.source, 'single')
    assert.equal(profile.uid, 'abc')
    record('O04-single-profile-uid-is-parsed-from-its-directory', { expectedUid: 'abc', actualUid: profile.uid })
  }

  {
    // O03 — a destructive rewrite must name the revision it saw. Without it the
    // write is refused and the file is untouched.
    const f = fixture()
    writeFileSync(f.file, '## A\n- one\n- two\n')
    const store = f.store()
    const out = await store.replaceSection({ target: 'project-memory', section: 'A', body: '- replacement\n' }, f.probe())
    assert.equal(out.ok, false)
    assert.equal(out.code, 'revision_required')
    assert.equal(readFileSync(f.file, 'utf8'), '## A\n- one\n- two\n', 'nothing was dropped')
    record('O03-destructive-rewrite-requires-its-revision', { code: out.code, droppedOldEntries: false })
  }

  {
    // O02 — a refused write leaves no trace on disk. The old order created the
    // memory directory first, so a typo in `text` (a newline) still produced a
    // directory for a write that never happened.
    const dir = join(root, 'invalid-write')
    const home = join(dir, 'home')
    const cwd = join(dir, 'repo')
    const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(dir, 'state'), write: { ensureLayout: true } })
    const probe = probeEnvironment({ cfg, cwd })
    const out = await createStore({ cfg, stateDir: cfg.stateDir }).append(
      { target: 'project-memory', text: 'invalid\nmultiline' },
      probe,
    )
    assert.equal(out.code, 'multiline_text')
    assert.equal(existsSync(probe.project.dir), false, 'a refused write creates no directory')
    record('O02-a-refused-write-creates-nothing', { refusedAs: out.code, directoryCreated: false })
  }

  {
    // O04 — the values a person set survive the volatile reference layer. This
    // is the regression that made every settings-form change silently fall back
    // to the default, so it is checked through the real schema, not a plain
    // object that never looks like a reference.
    const input = {
      readOnly: true,
      workbuddyHome: join(root, 'configured-home'),
      search: { enabled: false },
      inject: { limits: { user: 3000 } },
    }
    const parsed = await Config['~standard'].validate(input)
    assert.equal(parsed.issues, undefined)
    assert.equal(parsed.value.readOnly.get(), true)
    const effective = normalizeConfig(parsed.value)
    assert.equal(effective.readOnly, true)
    assert.equal(effective.workbuddyHome, join(root, 'configured-home'))
    assert.equal(effective.search.enabled, false)
    assert.equal(effective.inject.limits.user, 3000)
    record('O04-volatile-values-survive-normalization', {
      readOnly: effective.readOnly,
      search: effective.search.enabled,
      userLimit: effective.inject.limits.user,
    })
  }

  {
    // O03 — one operation id commits once, even when two callers race with it.
    // The old path let both through because the duplicate lookup and the write
    // were not inside the same transaction.
    const f = fixture()
    writeFileSync(f.file, '## A\n- initial\n')
    const store = f.store()
    const input = { target: 'project-memory', section: 'A', text: 'same request', operationId: 'simultaneous-id' }
    const [first, second] = await Promise.all([store.append(input, f.probe()), store.append(input, f.probe())])
    assert.ok(first.ok && second.ok, 'both callers are answered')
    assert.equal([first, second].filter((out) => out.duplicate === true).length, 1, 'exactly one is a replay')
    const copies = readFileSync(f.file, 'utf8').split('same request').length - 1
    assert.equal(copies, 1)
    record('O03-one-operation-id-commits-once', { successes: 2, duplicates: 1, copies })
  }

  {
    // O03 — replaying a restore returns the original result instead of
    // re-restoring. The second attempt used to fail with `conflict` because the
    // caller's revision was already spent, which reads as "your retry broke it".
    const f = fixture()
    writeFileSync(f.file, '## A\n- original\n')
    const store = f.store()
    const edited = await store.replaceSection(
      { target: 'project-memory', section: 'A', body: '- revised\n', expectedRevision: contentRevision('## A\n- original\n') },
      f.probe(),
    )
    assert.equal(edited.ok, true)
    const name = store.listRevisions(f.file)[0].name
    const input = { target: 'project-memory', name, expectedRevision: edited.revision, operationId: 'restore-replay' }
    assert.equal((await store.restore(input, f.probe())).ok, true)
    const replay = await store.restore(input, f.probe())
    assert.equal(replay.ok, true)
    assert.equal(replay.duplicate, true)
    record('O03-restore-replay-is-idempotent', { secondOk: replay.ok, duplicate: replay.duplicate })
  }

  {
    // O03 — an operation id is bound to the request it was minted for. Reusing
    // it on another target used to return the first target's result as a
    // duplicate: the caller was told its user-memory write succeeded while
    // nothing had been written there at all.
    const f = fixture()
    const store = f.store()
    const first = await store.append({ target: 'project-memory', section: 'A', text: 'project', operationId: 'reused-id' }, f.probe())
    assert.equal(first.ok, true)
    const user = await store.append({ target: 'user-memory', section: 'A', text: 'user', operationId: 'reused-id' }, f.probe())
    assert.equal(user.ok, false)
    assert.equal(user.code, 'operation_mismatch')
    assert.equal(existsSync(join(f.home, 'MEMORY.md')), false, 'the other target was not written')
    record('O03-operation-id-is-bound-to-its-request', { code: user.code, userFileCreated: false })
  }

  {
    // O03 — an archive apply waits for the date locks the writers use. Taking no
    // lock meant a daily note could be appended to while it was being moved.
    const f = fixture({ write: { lockWaitMs: 40 } })
    const daily = join(f.memoryDir, '2000-01-01.md')
    writeFileSync(daily, '- historical\n')
    const store = f.store()
    const plan = await store.prune({ dryRun: true, beforeDays: 30 }, f.probe())
    assert.equal(plan.candidates.length, 1)
    const out = await withLock(join(f.cfg.stateDir, 'locks', `${pathKey(daily)}.lock`), 3000, () =>
      store.prune({ dryRun: false, planId: plan.planId, dates: ['2000-01-01'], operationId: 'prune-under-lock' }, f.probe()),
    )
    assert.equal(out.ok, false)
    assert.equal(out.code, 'lock_timeout')
    assert.equal(existsSync(daily), true, 'nothing moved while the writer held the lock')
    record('O03-archive-apply-waits-for-the-write-lock', { code: out.code, moved: false })
  }

  {
    // O03 — an apply is bound to the set the person previewed. A file that
    // changed after the preview is refused, and a file created after it is not
    // swept up by a fresh enumeration.
    const f = fixture()
    const original = join(f.memoryDir, '2000-01-01.md')
    writeFileSync(original, '- before preview\n')
    const store = f.store()
    const plan = await store.prune({ dryRun: true, beforeDays: 30 }, f.probe())
    assert.equal(plan.candidates.length, 1)
    writeFileSync(original, '- changed after preview\n')
    writeFileSync(join(f.memoryDir, '2000-01-02.md'), '- created after preview\n')
    const out = await store.prune(
      { dryRun: false, planId: plan.planId, dates: ['2000-01-01'], operationId: 'drifted-plan' },
      f.probe(),
    )
    assert.equal(out.ok, false)
    assert.equal(out.code, 'plan_conflict')
    assert.equal(readFileSync(original, 'utf8'), '- changed after preview\n', 'the changed file stayed put')
    assert.equal(existsSync(join(f.memoryDir, 'archive')), false, 'and no archive directory was created')
    record('O03-archive-apply-is-bound-to-its-plan', { code: out.code, changedFileMoved: false, newFileMoved: false })
  }

  {
    // O03 — two backups in the same millisecond are two files. Naming a backup
    // by timestamp alone meant the second write of a burst replaced the first
    // snapshot, and the pre-burst text became unrecoverable.
    const f = fixture()
    writeFileSync(f.file, '## A\n- zero\n')
    const store = f.store()
    const RealDate = globalThis.Date
    const epoch = RealDate.now()
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [epoch]))
      }
      static now() {
        return epoch
      }
    }
    let backups
    try {
      const first = await store.replaceSection(
        { target: 'project-memory', section: 'A', body: '- first\n', expectedRevision: contentRevision('## A\n- zero\n') },
        f.probe(),
      )
      assert.equal(first.ok, true)
      const second = await store.replaceSection(
        { target: 'project-memory', section: 'A', body: '- second\n', expectedRevision: first.revision },
        f.probe(),
      )
      assert.equal(second.ok, true)
      backups = store.listRevisions(f.file)
    } finally {
      globalThis.Date = RealDate
    }
    assert.equal(backups.length, 2, 'two writes, two snapshots')
    const texts = backups.map((row) => store.readRevision(f.file, row.name).text).sort()
    assert.deepEqual(texts, ['## A\n- first\n', '## A\n- zero\n'])
    record('O03-same-millisecond-backups-are-both-kept', { writes: 2, backupFiles: backups.length, originalStillBackedUp: true })
  }

  {
    // O07 — two independent stores still honour CAS. This one was already right
    // before the optimisation; it stays here so a shared lock cannot be
    // "simplified" into trusting the revision alone.
    const f = fixture()
    writeFileSync(f.file, '## A\n- observed\n')
    const revision = contentRevision(readFileSync(f.file, 'utf8'))
    const first = f.store()
    const second = f.store()
    const out = await Promise.all([
      first.append({ target: 'project-memory', section: 'A', text: 'one', expectedRevision: revision }, f.probe()),
      second.append({ target: 'project-memory', section: 'A', text: 'two', expectedRevision: revision }, f.probe()),
    ])
    assert.equal(out.filter((row) => row.ok).length, 1)
    assert.equal(out.filter((row) => row.code === 'conflict').length, 1)
    record('O07-independent-stores-honour-cas', { successes: 1, conflicts: 1 })
  }

  {
    // O09 — `backupKeep: 0` refuses the writes it cannot undo, and still allows
    // the one write that cannot destroy anything. An append adds bytes; it
    // cannot truncate what is already there.
    const f = fixture({ write: { backupKeep: 0 } })
    writeFileSync(f.file, '## A\n- one\n')
    const store = f.store()
    const edit = await store.edit(
      { target: 'project-memory', section: 'A', match: 'one', replacement: 'two', expectedRevision: contentRevision('## A\n- one\n') },
      f.probe(),
    )
    assert.equal(edit.code, 'backup_required')
    const appended = await store.append({ target: 'project-memory', section: 'A', text: '三条' }, f.probe())
    assert.equal(appended.ok, true)
    assert.equal(appended.backup, null)
    record('O09-backup-required-blocks-destructive-only', { editCode: edit.code, appendOk: appended.ok })
  }

  {
    // O08 — deduplication is promised inside a bounded window, and unresolved
    // records are never evicted to make room. These numbers are the promise.
    assert.deepEqual(
      { terminalMs: RECEIPT_LIMITS.terminalMs, maxRecords: RECEIPT_LIMITS.maxRecords, maxPending: RECEIPT_LIMITS.maxPending },
      { terminalMs: 24 * 60 * 60 * 1000, maxRecords: 2000, maxPending: 100 },
    )
    record('O08-receipt-window-is-bounded-and-stated', { ...RECEIPT_LIMITS })
  }

  {
    // O11 — the model catalog is exactly the five entry-level tools. Bulk
    // management lives in the panel, and there is no alias stub for a retired
    // name: a definition that only ever refuses still advertises an ability.
    const registered = []
    const ctx = {
      tools: {
        register(tool) {
          registered.push(tool.name)
          return () => {}
        },
      },
    }
    const f = fixture()
    const controller = registerTools(ctx, { cfg: f.cfg, t, store: f.store() })
    assert.deepEqual(registered, ['memory_status', 'memory_read', 'memory_search', 'memory_append', 'memory_edit'])
    for (const retired of ['memory_prune', 'memory_replace_section', 'memory_list_revisions', 'memory_restore']) {
      assert.equal(registered.includes(retired), false, `${retired} must not be registered`)
    }
    controller.dispose()
    record('O11-model-catalog-is-the-five-entry-tools', { registered })
  }

  {
    // O11 — a stale revision is refused, and there is no switch that turns the
    // refusal off. The removed `write.conflictPolicy` used to offer `overwrite`
    // and nothing read it; the panel's conflict dialog deliberately has no
    // "overwrite anyway" button either, because that button deletes the
    // `expectedRevision` the fence exists to check.
    const f = fixture()
    writeFileSync(f.file, '## A\n- one\n')
    assert.equal('conflictPolicy' in f.cfg.write, false, 'the lying switch is gone')
    const store = f.store()
    const stale = await store.append(
      { target: 'project-memory', section: 'A', text: 'two', expectedRevision: 'not-the-current-revision' },
      f.probe(),
    )
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'conflict')
    assert.equal(readFileSync(f.file, 'utf8'), '## A\n- one\n', 'the file is untouched')
    record('O11-stale-revision-is-always-refused', { code: stale.code, conflictPolicyKey: false })
  }

  {
    // O10 — an explicitly configured folder is the one used. A hardcoded
    // `.workbuddy` would read a different tree than the user's WorkBuddy does.
    const f = fixture({ dataFolderName: '.codebuddy' })
    const layout = f.probe().layout
    assert.equal(layout.projectMemory, join(f.cwd, '.codebuddy', 'memory', 'MEMORY.md'))
    record('O10-explicit-data-folder-is-honoured', { explicitFolder: '.codebuddy', selectedCorrectly: true })
  }

  {
    // First-use behaviour: reading creates nothing, and the first legal write is
    // what creates the layout. These two properties are what make "install it
    // and look" a safe operation.
    const f = fixture({}, { layout: false })
    const before = f.probe()
    assert.equal(before.project.exists, false, 'a read-only probe creates no directory')
    assert.equal(existsSync(join(f.cwd, '.workbuddy', 'memory')), false)
    const appended = await f.store().append({ target: 'project-memory', section: '常驻记忆', text: 'first entry' }, f.probe())
    assert.equal(appended.ok, true)
    assert.equal(existsSync(join(f.cwd, '.workbuddy', 'memory', 'MEMORY.md')), true, 'the first write created it')
    assert.equal(analyzeShape(readFileSync(f.file, 'utf8')), 'layered', 'and it created the layered shape')

    const guarded = fixture({ write: { ensureLayout: false } }, { layout: false })
    const refused = await guarded.store().append({ target: 'project-memory', text: 'no layout' }, guarded.probe())
    assert.equal(refused.code, 'no_store')
    assert.equal(existsSync(join(guarded.cwd, '.workbuddy', 'memory')), false, 'ensureLayout:false creates nothing')
    record('first-use-read-creates-nothing-first-write-creates-layout', {
      readCreatedNothing: true,
      firstWriteCreated: true,
      ensureLayoutFalseRefused: refused.code,
    })
  }

  console.log(
    JSON.stringify(
      {
        outcome: 'verified-current-behaviour',
        note: 'asserts the corrected behaviour; a red run means a guarantee regressed',
        checks: results.length,
        results,
      },
      null,
      2,
    ),
  )
} finally {
  const checked = realpathSync(root)
  assert.equal(dirname(checked).toLowerCase(), tempParent.toLowerCase())
  assert.equal(basename(checked).startsWith('wbm-fixed-verify-'), true)
  assert.equal(resolve(checked), resolve(root))
  rmSync(checked, { recursive: true, force: true })
}

/**
 * Whether a document is in the layered shape.
 *
 * Kept local and deliberately crude: this script only needs to distinguish "the
 * first write created a core section" from "it appended to a legacy file".
 *
 * @param {string} text
 * @returns {'layered'|'legacy'}
 */
function analyzeShape(text) {
  const headings = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => /^##\s+(.+?)\s*#*\s*$/.exec(line)?.[1])
    .filter(Boolean)
    .map((heading) => heading.toLowerCase())
  const cores = headings.filter((heading) => heading === '常驻记忆' || heading === 'core memory')
  return cores.length === 1 ? 'layered' : 'legacy'
}
