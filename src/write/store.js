/**
 * The single write path.
 *
 * Every writer — tools today, the panel later — goes through `write()`. One
 * lock, one revision check, one backup, one atomic replace. A second path is a
 * back door, and a back door makes the fence decorative.
 *
 * Guarantees, stated honestly:
 *  - DSH against DSH: the operation lock and the file lock serialize writers,
 *    so no lost update and no duplicate operation.
 *  - DSH against a non-locking editor (WorkBuddy `Edit`): only detected
 *    conflicts are refused. A write landing inside the same few milliseconds
 *    can still be overwritten; the backup and the post-write revision are what
 *    make it recoverable rather than silent.
 *  - Append-only daily files: `O_APPEND` cannot truncate existing bytes.
 *  - A destructive write to a file that already has content requires an
 *    explicit `expectedRevision`. There is no "rewrite the current text" mode
 *    that skips the check.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { isWritable, readTextSafe } from '../fsx.js'
import { appendToSection, editEntry, editEntryAt, removeSection, replaceSectionBody, validateDocument } from '../markdown.js'
import { analyzeMemory } from '../layers.js'
import { resolveLanguage } from '../locale.js'
import { PLAN_LIMITS, createPlanStore, newPlanId, nextArchivePath, readMoveSource, scanCandidates } from './archive.js'
import {
  appendFileDurable,
  contentRevision,
  identity,
  pathKey,
  resolveLink,
  withLock,
  writeFileAtomic,
  writeFileExclusive,
} from './fslock.js'
import { createReceiptStore } from './receipts.js'

export const TARGETS = ['project-memory', 'project-daily', 'user-memory']

/** Actions the panel may ask for. Anything not here is refused before it runs. */
export const ACTIONS = ['add', 'edit', 'remove', 'replace-section', 'replace-document', 'remove-section', 'prune', 'restore']

/** The ledger is append-only and read per write; rotate it at this size. */
const LEDGER_ROTATE_BYTES = 2 * 1024 * 1024

/** A memory file larger than this cannot be rewritten from a verified source. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

/** Operation ids are bounded so a receipt name and a fingerprint stay sane. */
const MAX_OPERATION_ID = 200

/**
 * Section used when an append names none.
 *
 * Deliberately language-neutral: writing a hardcoded Chinese heading into an
 * English memory file would be a silent surprise, and the caller can always
 * pass `section` instead.
 */
export const DEFAULT_SECTION = 'Notes'

/**
 * Today as `YYYY-MM-DD` in the machine's own timezone.
 *
 * `toISOString()` is UTC: at 00:30 in Asia/Shanghai it still says yesterday, so
 * "today's note" would be written into the previous day's file for the first
 * eight hours of every day. The daily file is user-visible, so it follows the
 * user's clock, not the server's.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function localDateStamp(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Resolve one target to a path and its writing style.
 *
 * @param {string} target
 * @param {object} probe - result of `probeEnvironment`.
 * @param {string} [date] - `YYYY-MM-DD` for `project-daily`.
 */
function isDateStamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''))
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/**
 * Does a legacy document hold memory text, or only structure?
 *
 * The legacy→layered guard protects content a person already wrote: deciding
 * which of those entries belong in the always-on core is their call, not a
 * side effect of an ordinary append. A blank file, a file of whitespace, or one
 * that carries nothing but heading lines has no such content — there is no
 * ownership to confirm, and refusing the write would leave the store
 * permanently empty, because the first ordinary append is how it gets filled.
 *
 * @param {string} text - the document as it stands.
 * @returns {boolean} true when something other than a heading or blank line is there.
 */
function holdsMemoryContent(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .some((line) => {
      const body = line.trim()
      return body !== '' && !/^#{1,6}(\s|$)/.test(body)
    })
}

export function resolveTarget(target, probe, date) {
  switch (target) {
    case 'project-memory':
      return { path: probe.project.memoryPath, mode: 'rewrite', dir: probe.project.dir, exists: probe.project.exists }
    case 'project-daily': {
      const stamp = date ?? localDateStamp()
      if (!isDateStamp(stamp)) return { path: null, mode: 'append', dir: probe.project.dir, error: 'bad_date' }
      return { path: probe.project.dir ? join(probe.project.dir, `${stamp}.md`) : null, mode: 'append', dir: probe.project.dir }
    }
    case 'user-memory':
      return { path: probe.user.memoryPath, mode: 'rewrite', dir: probe.layout.home, exists: probe.user.memoryExists }
    default:
      return { path: null, mode: 'rewrite', dir: null, error: 'unknown_target' }
  }
}

/**
 * Create the write path.
 *
 * The probe is passed per call rather than captured: each session has its own
 * working directory, and a captured probe would write into whichever project
 * happened to load the plugin first.
 *
 * @param {object} deps
 * @param {object} deps.cfg - normalized config.
 * @param {string} deps.stateDir - where locks, backups, receipts and the log live.
 * @param {(event: object) => void} [deps.onCommit] - host-wide commit hook.
 */
function canWriteDirectory(path) {
  let current = resolve(path)
  while (true) {
    const stat = statSafe(current)
    if (stat?.isDirectory?.()) return isWritable(current)
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export function createStore({ cfg, stateDir, onCommit }) {
  const lockDir = join(stateDir, 'locks')
  const backupDir = join(stateDir, 'backups')
  const logDir = join(stateDir, 'log')
  const receipts = createReceiptStore({ stateDir, lockWaitMs: cfg.write.lockWaitMs })
  const plans = createPlanStore()
  const listeners = new Set()
  if (typeof onCommit === 'function') listeners.add(onCommit)

  /**
   * Subscribe to commits that actually changed bytes.
   *
   * The event is emitted after every lock is released, so a listener may read
   * the file without deadlocking against the writer. Listeners are isolated:
   * a synchronous throw or a rejected promise from one cannot change the
   * result of the write or stop the other listeners.
   *
   * @param {(event: {path: string, target: string, operation: string, revision: string, operationId: string|null}) => unknown} listener
   * @returns {() => void} disposer
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function emit(events) {
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          const result = listener(event)
          if (result && typeof result.then === 'function') result.catch(() => {})
        } catch {
          // A listener is an observer, never a gate.
        }
      }
    }
  }

  /** One operation id, bounded; `null` means the caller did not ask for replay. */
  function operationOf(value) {
    if (value === undefined || value === null) return { ok: true, id: null }
    const id = String(value).trim()
    if (!id) return { ok: true, id: null }
    if (id.length > MAX_OPERATION_ID) return { ok: false, code: 'operation_id_too_long' }
    return { ok: true, id }
  }

  function opLockPath(operationId) {
    return join(lockDir, `op-${pathKey(`operation:${operationId}`)}.lock`)
  }

  function canonicalPath(path) {
    return identity(resolveLink(path))
  }

  /**
   * Bind one operationId to the exact targets, action and semantic request.
   * Two different requests may not share an id, even if both are writes.
   */
  function fingerprintFor({ action, paths, request }) {
    const payload = {
      action,
      paths: [...new Set(paths.filter(Boolean).map(canonicalPath))].sort(),
      request: stable(request),
    }
    return contentRevision(JSON.stringify(payload))
  }

  /** Read a rewrite source, refusing a raced, partial or oversized snapshot. */
  function readForWrite(path) {
    if (!existsSync(path)) return { ok: true, exists: false, text: '', bytes: 0 }
    const file = readTextSafe(path, { maxBytes: MAX_SOURCE_BYTES })
    if (!file.ok) return { ok: false, code: 'unreadable', error: file.error, path }
    if (file.truncated) return { ok: false, code: 'too_large', bytes: file.bytes, path }
    return { ok: true, exists: true, text: file.text, bytes: file.bytes }
  }

  /**
   * Persist one receipt transition.
   *
   * A receipt the store could not durably update is not a receipt: callers
   * branch on `ok`, because continuing as if the transition had landed is how
   * a crashed `applying` record turns a later legitimate deletion into a
   * rewrite that revives it.
   */
  function markReceipt(tx, record, patch) {
    if (!record || !tx) return { ok: false, code: 'receipt_capacity', reason: 'no_receipt' }
    const next = { ...record, ...patch }
    const written = tx.update(next)
    if (!written.ok) {
      return { ok: false, code: written.code ?? 'receipt_capacity', reason: written.reason ?? 'update_failed' }
    }
    return { ok: true, record: written.record ?? next }
  }

  /**
   * Shared operation lock → receipt transaction → file lock → CAS → transform →
   * backup → receipt applying → atomic replace → verified post-read.
   *
   * The receipt transaction is taken before the file lock and held for the
   * whole write. That serializes memory writes across processes, which is the
   * price of making admission, expiry and the duplicate lookup true at the same
   * time; memory writes are rare. Everything that can change source bytes
   * happens inside both locks, and the receipt is written before the
   * destructive step so a crash leaves evidence a retry can interpret.
   */
  async function commitRewrite({
    action,
    target,
    path,
    operationId,
    expectedRevision,
    request,
    requireCas,
    allowNoBackup = false,
    transform,
    prepare,
  }) {
    const op = operationOf(operationId)
    if (!op.ok) return fail(op.code)
    const fingerprint = fingerprintFor({ action, paths: [path], request })

    const exec = async (id) => {
      const body = (tx) =>
        withLock(join(lockDir, `${pathKey(path)}.lock`), cfg.write.lockWaitMs, () => run(tx, id))
      return id ? receipts.withTransaction(body, { waitMs: cfg.write.lockWaitMs }) : body(null)
    }

    const run = (tx, id) => {
      const prior = id ? tx.read(id) : { ok: true, record: null }
      if (!prior.ok) return fail(prior.code, { reason: prior.reason, operationId: id })
      let record = prior.record
      if (record) {
        if (record.fingerprint !== fingerprint) return fail('operation_mismatch', { operationId: id, path })
        if (record.status === 'committed') return { result: { ...record.result, duplicate: true }, event: null }
        if (record.status !== 'applying') {
          // partial/outcome_unknown is unresolved: only a person may resolve it.
          return fail('outcome_unknown', { operationId: id, path, reason: record.status })
        }
      }

      const current = readForWrite(path)
      if (!current.ok) return fail(current.code, { path, error: current.error, bytes: current.bytes })
      const before = contentRevision(current.text)

      if (record) {
        if (before === record.after) {
          // The source holds exactly the planned bytes: this is the commit a
          // crash never got to record. Record it, or say that we could not.
          const done = markReceipt(tx, record, { status: 'committed' })
          if (!done.ok) {
            return {
              result: fail('outcome_unknown', {
                operationId: id,
                path,
                committed: true,
                revision: before,
                reason: 'receipt_update_failed',
              }),
              event: { path, target, operation: action, revision: before, operationId: id },
            }
          }
          return { result: { ...(done.record.result ?? record.result), duplicate: true }, event: null }
        }
        // Matching the old snapshot is not proof the write never ran: the file
        // could have been changed to `after` and back. Refuse to redo it.
        markReceipt(tx, record, {
          status: 'outcome_unknown',
          result: { ...record.result, ok: false, code: 'outcome_unknown' },
        })
        return fail('outcome_unknown', { operationId: id, path, reason: 'applying_unverified' })
      }

      // Every destructive action on existing content must name what it saw.
      if (requireCas && current.exists && !expectedRevision) {
        return fail('revision_required', { path, revision: before })
      }
      if (expectedRevision && String(expectedRevision) !== before) {
        recordOperation({
          id,
          at: Date.now(),
          target,
          path,
          status: 'conflict',
          expectedRevision: String(expectedRevision),
          revision: before,
        })
        return {
          result: {
            ok: false,
            code: 'conflict',
            expectedRevision: String(expectedRevision),
            revision: before,
            path,
            hint: 'the file changed since it was read; read again before writing',
          },
          event: null,
        }
      }

      let output
      try {
        output = prepare ? prepare() : transform(current.text)
      } catch (error) {
        return fail('write_failed', { path, message: String(error?.message ?? error) })
      }
      if (!output || output.ok === false) {
        return fail(output?.reason ?? 'no_match', { path, hits: output?.hits ?? [], issues: output?.issues ?? [] })
      }
      if (output.replaced === 0) {
        const extra = { path, hits: output.hits ?? [], issues: output.issues ?? [] }
        if (output.duplicates) extra.duplicates = output.duplicates
        return fail(output.reason ?? 'no_match', extra)
      }

      const afterText = String(output.text ?? '')
      // Only a write that would *recast* existing content as layered needs a
      // person's confirmation. An empty or title-only legacy file holds nothing
      // to recast, so an ordinary append is allowed to bootstrap it.
      const capturesLegacyContent =
        !['replace-document', 'restore'].includes(action) &&
        analyzeMemory(current.text).mode === 'legacy' &&
        analyzeMemory(afterText).mode === 'layered' &&
        holdsMemoryContent(current.text)
      if (current.exists && capturesLegacyContent) {
        return fail('layering_confirmation_required', { path, revision: before })
      }
      const afterRevision = contentRevision(afterText)
      const extra = pickExtra(output)
      const planned = {
        ok: true,
        revision: afterRevision,
        previous: before,
        path,
        bytes: Buffer.byteLength(afterText, 'utf8'),
        backup: null,
        created: Boolean(output.created),
        section: output.section ?? null,
        ...extra,
      }

      // No byte changed (a restore that restores the current text): report it
      // without taking a backup or replacing the file for no reason.
      if (afterRevision === before) {
        planned.changed = false
        planned.created = Boolean(output.created)
        if (id) {
          const begun = tx.begin({
            version: 1,
            id,
            fingerprint,
            action,
            target,
            path,
            before,
            after: before,
            status: 'committed',
            result: planned,
            createdAt: Date.now(),
          })
          if (!begun.ok) return fail(begun.code, { reason: begun.reason, path })
        }
        return { result: planned, event: null }
      }

      if (!allowNoBackup && current.exists && cfg.write.backupKeep <= 0) {
        if (id) tx.drop(id)
        return fail('backup_required', { path, backupKeep: cfg.write.backupKeep })
      }

      if (id) {
        const begun = tx.begin({
          version: 1,
          id,
          fingerprint,
          action,
          target,
          path,
          before,
          after: afterRevision,
          status: 'applying',
          result: planned,
          createdAt: Date.now(),
        })
        if (!begun.ok) return fail(begun.code, { reason: begun.reason, path })
        record = begun.record
        if (!record) return fail('receipt_capacity', { reason: 'begin_returned_nothing', path })
      }

      let snapshot = { ok: true, path: null }
      if (cfg.write.backupKeep > 0 && current.exists) {
        snapshot = backup(path)
        if (!snapshot.ok) {
          // Nothing changed yet; drop the receipt so the id stays reusable.
          if (id) tx.drop(id)
          return fail('backup_failed', { path, error: snapshot.error })
        }
        planned.backup = snapshot.path ?? null
      }

      try {
        writeFileAtomic(path, afterText, { fsync: cfg.write.fsync })
      } catch (error) {
        // Atomic replace either landed or it did not; a throw means it did not,
        // so the id can be cleared instead of being left to haunt the caller.
        if (id) tx.drop(id)
        return fail('write_failed', { path, message: String(error?.message ?? error) })
      }

      const after = readForWrite(path)
      if (!after.ok) {
        if (id) {
          markReceipt(tx, record, { status: 'outcome_unknown', result: { ...planned, ok: false, code: 'outcome_unknown' } })
        }
        return fail('outcome_unknown', {
          path,
          committed: true,
          error: after.error,
          revision: null,
        })
      }
      const actual = contentRevision(after.text)
      if (actual !== afterRevision) {
        if (id) {
          markReceipt(tx, record, { status: 'outcome_unknown', result: { ...planned, ok: false, code: 'outcome_unknown' } })
        }
        return fail('outcome_unknown', { path, committed: true, expectedRevision: afterRevision, revision: actual })
      }

      planned.bytes = after.bytes
      const result = { ...planned, revision: actual }
      if (id) {
        const done = markReceipt(tx, record, { status: 'committed', after: actual, result })
        if (!done.ok) {
          // The bytes are verified on disk but the receipt did not land. Say
          // that plainly, and still tell listeners the path changed.
          return {
            result: fail('outcome_unknown', {
              path,
              committed: true,
              revision: actual,
              operationId: id,
              reason: 'receipt_update_failed',
            }),
            event: { path, target, operation: action, revision: actual, operationId: id },
          }
        }
      }
      recordOperation({ id, at: Date.now(), target, path, status: 'committed', before, after: actual, backup: snapshot.path ?? null })
      return {
        result,
        event: {
          path,
          target,
          operation: action,
          revision: actual,
          operationId: id ?? null,
        },
      }
    }

    return runOperation({ op, action, exec })
  }

  /** Wrap an exec with the operation lock and emit its event after release. */
  async function runOperation({ op, exec }) {
    let outcome
    try {
      outcome = op.id
        ? await withLock(opLockPath(op.id), cfg.write.lockWaitMs, () => exec(op.id))
        : await exec(null)
    } catch (error) {
      if (error?.code === 'lock_timeout') return fail('lock_timeout', { owner: error.owner })
      return fail('write_failed', { message: error?.message ?? String(error) })
    }
    if (outcome?.event) emit([outcome.event])
    // Early refusals return the result directly; commits return a pair so the
    // event can be emitted after both locks are gone.
    if (outcome && typeof outcome === 'object' && 'result' in outcome) return outcome.result
    return outcome
  }

  /**
   * Replace or remove one entry, addressed by line number.
   *
   * The panel knows the row it rendered, not a substring that may occur twice
   * in the same section — so it sends a position, and this refuses the write if
   * that position no longer holds an entry (the file moved underneath it).
   *
   * @param {{ target: string, section: string, line: number, replacement?: string, mode?: 'replace'|'remove', expectedRevision?: string, operationId?: string }} input
   */
  async function editAt(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')

    const resolved = resolveTarget(input.target, probe)
    if (!resolved.path || resolved.mode !== 'rewrite') return fail('bad_target', { target: input.target })

    return commitRewrite({
      action: input.mode === 'remove' ? 'remove' : 'edit',
      target: input.target,
      path: resolved.path,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      requireCas: true,
      request: {
        target: input.target,
        section: String(input.section ?? ''),
        line: Number(input.line),
        replacement: input.replacement === undefined ? null : String(input.replacement),
        mode: input.mode ?? 'replace',
        expectedRevision: input.expectedRevision ? String(input.expectedRevision) : null,
      },
      transform: (current) => {
        const result = editEntryAt(current, input.section, input.line, {
          replacement: input.replacement,
          mode: input.mode ?? 'replace',
        })
        return { text: result.text, replaced: result.replaced, reason: result.reason, hits: result.lines }
      },
    })
  }

  /** Delete one entry by line. Same chain as `editAt`, one fewer input. */
  async function remove(input, probe) {
    return editAt({ ...input, mode: 'remove' }, probe)
  }

  /**
   * Replace one section body (L2).
   *
   * The section heading and every line outside the section are kept byte for
   * byte; only the body the editor showed is swapped. Validation lives in
   * `replaceSectionBody`, so an invalid body is refused before any write.
   *
   * @param {{ target: string, section: string, body: string, expectedRevision?: string, operationId?: string }} input
   */
  async function replaceSection(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')

    const resolved = resolveTarget(input.target, probe)
    if (!resolved.path || resolved.mode !== 'rewrite') return fail('bad_target', { target: input.target })

    return commitRewrite({
      action: 'replace-section',
      target: input.target,
      path: resolved.path,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      requireCas: true,
      request: {
        target: input.target,
        section: String(input.section ?? ''),
        body: String(input.body ?? ''),
        expectedRevision: input.expectedRevision ? String(input.expectedRevision) : null,
      },
      transform: (current) => {
        const result = replaceSectionBody(current, String(input.section ?? ''), String(input.body ?? ''))
        if (!result.ok) return { text: current, replaced: 0, reason: result.reason, issues: result.issues }
        return { text: result.text, replaced: 1, entries: result.entries }
      },
    })
  }

  /**
   * Replace the whole document (L3).
   *
   * Off unless `ui.allowFullTextEdit` is on: this bypasses the entry model, so
   * the only structural guarantees left are the checks in `validateDocument`.
   * The writer still runs the same lock, CAS, backup and receipt chain.
   *
   * @param {{ target: string, text: string, expectedRevision?: string, operationId?: string }} input
   */
  async function replaceDocument(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')
    if (!cfg.ui.allowFullTextEdit) return fail('full_text_disabled')

    const resolved = resolveTarget(input.target, probe)
    if (!resolved.path || resolved.mode !== 'rewrite') return fail('bad_target', { target: input.target })

    const text = String(input.text ?? '')
    const validation = validateDocument(text)
    if (!validation.ok) return fail('invalid_structure', { issues: validation.issues })

    return commitRewrite({
      action: 'replace-document',
      target: input.target,
      path: resolved.path,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      requireCas: true,
      request: {
        target: input.target,
        text,
        expectedRevision: input.expectedRevision ? String(input.expectedRevision) : null,
      },
      transform: () => ({ text, replaced: 1 }),
    })
  }

  /** Delete one whole section (heading and body) with the usual backup chain. */
  async function removeSectionAction(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')

    const resolved = resolveTarget(input.target, probe)
    if (!resolved.path || resolved.mode !== 'rewrite') return fail('bad_target', { target: input.target })

    return commitRewrite({
      action: 'remove-section',
      target: input.target,
      path: resolved.path,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      requireCas: true,
      request: {
        target: input.target,
        section: String(input.section ?? ''),
        expectedRevision: input.expectedRevision ? String(input.expectedRevision) : null,
      },
      transform: (current) => {
        const result = removeSection(current, String(input.section ?? ''))
        if (!result.ok) return { text: current, replaced: 0, reason: result.reason }
        return { text: result.text, replaced: result.removed, removed: result.removed }
      },
    })
  }

  /**
   * Put a file back to one of its own backups.
   *
   * The caller must name the revision it saw (`expectedRevision`), so a restore
   * cannot silently discard writes made after the diff was shown. The file as
   * it stands is backed up first, which makes the restore itself undoable.
   *
   * @param {{ target: string, name: string, expectedRevision: string, operationId?: string }} input
   */
  async function restore(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')

    const resolved = resolveTarget(input.target, probe)
    if (!resolved.path || resolved.mode !== 'rewrite') return fail('bad_target', { target: input.target })
    if (!input.expectedRevision) return fail('revision_required')

    return commitRewrite({
      action: 'restore',
      target: input.target,
      path: resolved.path,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      requireCas: true,
      request: {
        target: input.target,
        name: String(input.name ?? ''),
        expectedRevision: String(input.expectedRevision),
      },
      prepare: () => {
        const snapshot = readRevision(resolved.path, String(input.name ?? ''))
        if (!snapshot.ok) return { ok: false, reason: snapshot.code }
        return { text: snapshot.text, replaced: 1, restoredFrom: snapshot.name }
      },
    })
  }

  /**
   * Archive old daily files. WorkBuddy-aligned: the *model* distills durable
   * conclusions into MEMORY.md first (via append/edit); this action only moves
   * the raw daily logs out of the active memory dir into `archive/`. It never
   * writes MEMORY.md, so it cannot bloat the injected long-term store.
   *
   * A preview is pure memory: it creates no state directory, no archive
   * directory and no receipt. An apply is bound to the preview's exact set and
   * to the revision of each selected source.
   *
   * @param {{ beforeDays?: number, dates?: string[], dryRun?: boolean, planId?: string, operationId?: string }} input
   */
  async function prune(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')

    const dir = probe.project.dir
    if (!dir || !existsSync(dir)) return fail('no_store', { dir })

    const beforeDays = Math.min(Math.max(Number(input.beforeDays ?? 30) || 0, 1), 3650)
    const dates = normalizeDates(input.dates)
    if (!dates.ok) return fail('bad_date', { dates: input.dates })

    if (input.dryRun !== false) {
      const scan = scanCandidates(dir, { beforeDays, dates: dates.list ?? undefined })
      if (!scan.ok) return fail(scan.code, { dir })
      const now = Date.now()
      const plan = {
        planId: newPlanId(),
        projectDir: canonicalPath(dir),
        beforeDays,
        dates: scan.candidates.map((row) => row.date),
        candidates: scan.candidates,
        createdAt: now,
        expiresAt: now + PLAN_LIMITS.ttlMs,
      }
      plans.put(plan)
      return {
        ok: true,
        dryRun: true,
        planId: plan.planId,
        beforeDays,
        target: 'project-daily',
        candidates: scan.candidates,
        entries: scan.candidates.reduce((sum, row) => sum + row.entries, 0),
        expiresAt: plan.expiresAt,
      }
    }

    const op = operationOf(input.operationId)
    if (!op.ok) return fail(op.code)
    if (!op.id) return fail('operation_required')
    if (!dates.list || dates.list.length === 0) return fail('plan_required', { reason: 'dates_required' })

    const archiveDir = join(dir, 'archive')
    const fingerprint = fingerprintFor({
      action: 'prune',
      paths: [dir],
      request: {
        planId: input.planId ? String(input.planId) : null,
        dates: dates.list,
      },
    })

    let outcome
    try {
      outcome = await withLock(opLockPath(op.id), cfg.write.lockWaitMs, () =>
        receipts.withTransaction(
          (tx) => {
            const prior = tx.read(op.id)
            if (!prior.ok) return { result: fail(prior.code, { reason: prior.reason, operationId: op.id }), events: [] }
            const receipt = prior.record
            if (receipt) {
              if (receipt.fingerprint !== fingerprint) return { result: fail('operation_mismatch', { operationId: op.id }), events: [] }
              if (receipt.status === 'committed') return { result: { ...receipt.result, duplicate: true }, events: [] }
              if (!Array.isArray(receipt.manifest)) return { result: fail('outcome_unknown', { operationId: op.id }), events: [] }
              return applyArchive({ dir, archiveDir, operationId: op.id, fingerprint, receipt, tx })
            }

            const plan = plans.get(input.planId)
            if (!plan) return { result: fail('plan_required', { reason: 'unknown_plan' }), events: [] }
            if (plan.projectDir !== canonicalPath(dir)) return { result: fail('plan_conflict', { reason: 'project' }), events: [] }
            if (Date.now() > plan.expiresAt) return { result: fail('plan_conflict', { reason: 'expired' }), events: [] }
            if (dates.list.length > PLAN_LIMITS.maxFiles) {
              return { result: fail('archive_capacity', { limit: PLAN_LIMITS.maxFiles }), events: [] }
            }

            const byDate = new Map(plan.candidates.map((row) => [row.date, row]))
            const items = []
            for (const date of dates.list) {
              const candidate = byDate.get(date)
              if (!candidate) return { result: fail('plan_conflict', { reason: 'unknown_date', date }), events: [] }
              if (!candidate.revision) {
                return { result: fail(candidate.error === 'too_large' ? 'too_large' : 'unreadable', { date }), events: [] }
              }
              items.push({
                date,
                name: candidate.name,
                revision: candidate.revision,
                archivePath: null,
                status: 'pending',
              })
            }

            return applyArchive({
              dir,
              archiveDir,
              operationId: op.id,
              fingerprint,
              receipt: null,
              fresh: { planId: plan.planId, items },
              tx,
            })
          },
          { waitMs: cfg.write.lockWaitMs },
        ),
      )
    } catch (error) {
      if (error?.code === 'lock_timeout') return fail('lock_timeout', { owner: error.owner })
      return fail('write_failed', { message: String(error?.message ?? error) })
    }

    if (outcome?.events?.length) emit(outcome.events)
    return outcome?.result
  }

  /**
   * Move a prepared manifest. The lock order is operation → receipt
   * transaction → archive → sorted source file locks; all source locks are taken
   * before any move, and every manifest update happens inside the transaction,
   * so a concurrent retry cannot observe half a move.
   */
  async function applyArchive({ dir, archiveDir, operationId, fingerprint, receipt, fresh, tx }) {
    const sourcePaths = (receipt ? receipt.manifest : fresh.items).map((item) => join(dir, item.name))
    return withLock(join(lockDir, `${pathKey(archiveDir)}.lock`), cfg.write.lockWaitMs, () =>
      withManyLocks(
        sourcePaths.map((path) => join(lockDir, `${pathKey(path)}.lock`)),
        cfg.write.lockWaitMs,
        () => {
          let record = receipt
          let items = receipt ? receipt.manifest.map((item) => ({ ...item })) : fresh.items.map((item) => ({ ...item }))

          if (record) {
            const again = tx.read(operationId)
            if (!again.ok) return { result: fail(again.code, { reason: again.reason }), events: [] }
            if (!again.record) return { result: fail('outcome_unknown', { reason: 'receipt_disappeared' }), events: [] }
            if (again.record.fingerprint !== fingerprint) {
              return { result: fail('operation_mismatch', { operationId }), events: [] }
            }
            if (again.record.status === 'committed') {
              return { result: { ...again.record.result, duplicate: true }, events: [] }
            }
            record = again.record
            items = record.manifest.map((item) => ({ ...item }))
            if (items.some((item) => !item.archivePath || !item.name)) {
              return { result: fail('outcome_unknown', { reason: 'manifest_incomplete' }), events: [] }
            }
          } else {
            for (const item of items) {
              const source = join(dir, item.name)
              if (!existsSync(source)) {
                return { result: fail('plan_conflict', { reason: 'missing', date: item.date }), events: [] }
              }
              const read = readMoveSource(source)
              if (!read.ok) return { result: fail(read.code, { date: item.date, error: read.error }), events: [] }
              if (read.revision !== item.revision) {
                return {
                  result: fail('plan_conflict', { reason: 'changed', date: item.date, expected: item.revision, revision: read.revision }),
                  events: [],
                }
              }
            }
            for (const item of items) {
              const target = nextArchivePath(archiveDir, item.date)
              if (!target) return { result: fail('archive_capacity', { date: item.date }), events: [] }
              item.archivePath = target
            }
            const begun = tx.begin({
              version: 1,
              id: operationId,
              fingerprint,
              action: 'prune',
              target: 'project-daily',
              status: 'applying',
              createdAt: Date.now(),
              before: null,
              after: null,
              planId: fresh.planId,
              manifest: items,
            })
            if (!begun.ok) return { result: fail(begun.code, { reason: begun.reason }), events: [] }
            record = begun.record ?? record
            if (!record) {
              // A store implementation that returned no record cannot be resumed,
              // so do not pretend the move is recoverable.
              return { result: fail('receipt_capacity', { reason: 'begin_returned_nothing' }), events: [] }
            }
          }

          try {
            mkdirSync(archiveDir, { recursive: true })
          } catch (error) {
            return { result: fail('archive_failed', { error: String(error?.message ?? error) }), events: [] }
          }

          const pruned = []
          const failed = []
          const events = []
          for (const item of items) {
            if (item.status === 'moved') {
              const check = readMoveSource(item.archivePath)
              if (check.ok && check.revision === item.revision) {
                pruned.push({ date: item.date, name: item.name, archivePath: item.archivePath })
              } else {
                item.status = 'outcome_unknown'
                failed.push({ date: item.date, name: item.name, code: 'outcome_unknown', reason: 'moved_target_unverified' })
              }
              continue
            }
            if (item.status === 'outcome_unknown') {
              failed.push({ date: item.date, name: item.name, code: 'outcome_unknown', reason: 'previous_attempt_ambiguous' })
              continue
            }

            const source = join(dir, item.name)
            const sourceExists = existsSync(source)
            const targetExists = existsSync(item.archivePath)

            if (sourceExists && targetExists) {
              item.status = 'outcome_unknown'
              failed.push({ date: item.date, name: item.name, code: 'outcome_unknown', reason: 'both_exist' })
            } else if (!sourceExists && !targetExists) {
              item.status = 'outcome_unknown'
              failed.push({ date: item.date, name: item.name, code: 'outcome_unknown', reason: 'neither_exists' })
            } else if (!sourceExists && targetExists) {
              const check = readMoveSource(item.archivePath)
              if (check.ok && check.revision === item.revision) {
                item.status = 'moved'
                pruned.push({ date: item.date, name: item.name, archivePath: item.archivePath })
              } else {
                item.status = 'outcome_unknown'
                failed.push({ date: item.date, name: item.name, code: 'outcome_unknown', reason: 'target_unverified' })
              }
            } else {
              const read = readMoveSource(source)
              if (!read.ok) {
                item.status = 'failed'
                failed.push({ date: item.date, name: item.name, code: read.code, error: read.error ?? null })
              } else if (read.revision !== item.revision) {
                item.status = 'outcome_unknown'
                failed.push({ date: item.date, name: item.name, code: 'outcome_unknown', reason: 'revision_changed' })
              } else {
                try {
                  renameSync(source, item.archivePath)
                  item.status = 'moved'
                  pruned.push({ date: item.date, name: item.name, archivePath: item.archivePath })
                  events.push({
                    path: source,
                    target: 'project-daily',
                    operation: 'prune',
                    revision: item.revision,
                    operationId,
                    archivePath: item.archivePath,
                  })
                } catch (error) {
                  item.status = 'failed'
                  failed.push({ date: item.date, name: item.name, code: 'rename_failed', error: String(error?.message ?? error) })
                }
              }
            }

            record.manifest = items
            record.status = 'applying'
            const saved = tx.update(record)
            if (!saved.ok) {
              // Stop here: the durable manifest is now behind the disk. A retry
              // resolves each item by source/target hash instead of re-enumerating.
              return {
                result: {
                  ok: false,
                  code: 'partial',
                  pruned,
                  failed,
                  archive: archiveDir,
                  planId: record.planId ?? null,
                  receipt: 'outcome_unknown',
                  reason: 'receipt_update_failed',
                },
                events,
              }
            }
          }

          const result = { ok: failed.length === 0, pruned, failed, archive: archiveDir, planId: record.planId ?? null }
          record.status = failed.length === 0 ? 'committed' : 'partial'
          record.result = failed.length === 0 ? { ...result, ok: true } : { ...result, ok: false, code: 'partial' }
          record.manifest = items
          const saved = tx.update(record)
          if (!saved.ok) {
            // The moves are real but the final status is not durable: never
            // report this as ok.
            if (failed.length === 0) {
              return {
                result: {
                  ok: false,
                  code: 'outcome_unknown',
                  committed: true,
                  pruned,
                  failed,
                  archive: archiveDir,
                  planId: record.planId ?? null,
                  reason: 'receipt_update_failed',
                },
                events,
              }
            }
            return {
              result: { ...result, ok: false, code: 'partial', receipt: 'outcome_unknown', reason: 'receipt_update_failed' },
              events,
            }
          }
          recordOperation({ id: operationId, at: Date.now(), target: 'project-daily', path: archiveDir, status: failed.length === 0 ? 'committed' : 'partial', pruned: pruned.map((row) => row.date) })
          if (failed.length === 0) return { result, events }
          return { result: { ...result, code: 'partial' }, events }
        },
      ),
    )
  }

  /** Result helper so every refusal has the same shape. */
  function fail(code, extra = {}) {
    return { ok: false, code, ...extra }
  }

  /**
   * The ledger file, with rotation.
   *
   * It is append-only and read on every write, so an unbounded file eventually
   * costs a full read per operation. Rotation keeps one previous generation —
   * enough for the panel's commit/conflict counts.
   */
  function ledgerPath() {
    return join(logDir, 'operations.jsonl')
  }

  function rotateLedger() {
    const file = ledgerPath()
    try {
      const stat = statSync(file)
      if (stat.size < LEDGER_ROTATE_BYTES) return
      renameSync(file, `${file}.1`)
    } catch {
      // Missing file or a concurrent rotation: both are fine.
    }
  }

  /**
   * The tail of the ledger, newest last.
   *
   * @param {number} max - how many trailing records to keep.
   * @returns {string[]} non-empty lines.
   */
  function ledgerTail(max) {
    const file = ledgerPath()
    if (!existsSync(file)) return []
    let lines = []
    try {
      lines = readFileSync(file, 'utf8').split('\n')
    } catch {
      return []
    }
    const kept = []
    for (let index = lines.length - 1; index >= 0 && kept.length < max; index -= 1) {
      const line = lines[index]
      if (line) kept.push(line)
    }
    return kept.reverse()
  }

  function recordOperation(record) {
    if (!cfg.write.operationLog) return
    try {
      mkdirSync(logDir, { recursive: true })
      rotateLedger()
      appendFileSync(ledgerPath(), `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // The ledger is for statistics. Receipts are what make a retry safe.
    }
  }

  /**
   * Copy the current file next to its siblings, keeping at most N.
   *
   * The name carries the time *and* a UUID, and the create is exclusive: two
   * backups in the same millisecond are two files, never one overwriting the
   * other. Returns `{ ok: true, path }` or `{ ok: false, error }`.
   */
  function backup(path) {
    if (cfg.write.backupKeep <= 0) return { ok: true, path: null }
    if (!existsSync(path)) return { ok: true, path: null }
    let content
    try {
      content = readFileSync(path, 'utf8')
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = backupDirFor(path)
    try {
      mkdirSync(dir, { recursive: true })
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const target = join(dir, `${stamp}-${randomUUID().slice(0, 8)}.md`)
        try {
          writeFileExclusive(target, content, { fsync: false, mode: 0o600 })
          pruneBackups(dir)
          return { ok: true, path: target }
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
      }
      return { ok: false, error: 'backup_name_collision' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /** One directory per file, named by path, so revisions cannot cross files. */
  function backupDirFor(path) {
    return join(backupDir, pathKey(path))
  }

  /**
   * Revisions of one file, newest first.
   *
   * @param {string} path - absolute path of the memory file.
   * @returns {{ name: string, bytes: number, mtime: number }[]}
   */
  function listRevisions(path) {
    const dir = backupDirFor(path)
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    return names
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, stat: statSafe(join(dir, name)) }))
      .filter((row) => row.stat?.isFile())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .map((row) => ({ name: row.name, bytes: row.stat.size, mtime: row.stat.mtimeMs }))
  }

  /**
   * Read one revision. The name must already be in `listRevisions`, so a caller
   * cannot walk out of the backup directory with `../` or an absolute path.
   *
   * @param {string} path
   * @param {string} name
   */
  function readRevision(path, name) {
    const known = listRevisions(path).find((row) => row.name === name)
    if (!known) return { ok: false, code: 'no_revision' }
    const file = readTextSafe(join(backupDirFor(path), name), { maxBytes: MAX_SOURCE_BYTES })
    if (!file.ok) return { ok: false, code: 'unreadable', error: file.error }
    if (file.truncated) return { ok: false, code: 'too_large', bytes: file.bytes }
    return { ok: true, name, text: file.text, bytes: file.bytes, mtime: known.mtime, revision: contentRevision(file.text) }
  }

  /**
   * Counts from the operation ledger, newest-last.
   *
   * The panel shows conflicts because a stale panel is the one thing a person
   * cannot otherwise see: a write refused for being out of date looks exactly
   * like a write that never happened.
   */
  function operationStats(max = 500) {
    const empty = { total: 0, conflicts: 0, lastConflictAt: null, lastCommitAt: null }
    const lines = ledgerTail(max)
    if (lines.length === 0) return empty
    let conflicts = 0
    let lastConflictAt = null
    let lastCommitAt = null
    for (const line of lines) {
      if (!line) continue
      try {
        const record = JSON.parse(line)
        if (record.status === 'conflict') {
          conflicts += 1
          lastConflictAt = Math.max(lastConflictAt ?? 0, Number(record.at) || 0) || null
        } else if (record.status === 'committed') {
          lastCommitAt = Math.max(lastCommitAt ?? 0, Number(record.at) || 0) || null
        }
      } catch {
        // A torn line from a crash; skip it.
      }
    }
    return { total: lines.length, conflicts, lastConflictAt, lastCommitAt }
  }

  function pruneBackups(dir) {
    try {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const stale of files.slice(cfg.write.backupKeep)) {
        rmSync(join(dir, stale.name), { force: true })
      }
    } catch {
      // Pruning is housekeeping.
    }
  }

  /**
   * Append one entry.
   *
   * @param {{ target: string, section?: string, text: string, date?: string, expectedRevision?: string, operationId?: string }} input
   */
  async function append(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')

    const resolved = resolveTarget(input.target, probe, input.date)
    if (!resolved.path) return fail(resolved.error ?? 'no_store', { target: input.target })
    if (!resolved.dir) return fail('no_store', { target: input.target })
    const op = operationOf(input.operationId)
    if (!op.ok) return fail(op.code)
    const text = String(input.text ?? '').trim()
    if (!text) return fail('empty_text')
    if (/\r?\n/.test(text)) return fail('multiline_text', { target: input.target, hint: 'pass one line per call; call again for another entry' })
    if (input.section !== undefined && typeof input.section !== 'string') return fail('bad_section')
    if (input.section !== undefined && !String(input.section).trim()) return fail('empty_heading')
    if (input.section && /[\r\n]/.test(String(input.section))) return fail('bad_section')

    if (!canWriteDirectory(resolved.dir)) return fail('no_store', { target: input.target, dir: resolved.dir, reason: 'not_writable' })
    if (!existsSync(resolved.dir)) {
      if (!cfg.write.ensureLayout) return fail('no_store', { target: input.target, dir: resolved.dir })
      try { mkdirSync(resolved.dir, { recursive: true }) }
      catch (error) { return fail('no_store', { target: input.target, dir: resolved.dir, error: String(error?.message ?? error) }) }
    }

    if (resolved.mode === 'append') {
      return appendDaily({
        target: input.target,
        path: resolved.path,
        op,
        text,
        expectedRevision: input.expectedRevision,
        request: {
          target: input.target,
          section: null,
          text,
          date: input.date ? String(input.date) : null,
          expectedRevision: input.expectedRevision ? String(input.expectedRevision) : null,
        },
      })
    }

    return commitRewrite({
      action: 'append',
      target: input.target,
      path: resolved.path,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      requireCas: false,
      allowNoBackup: true,
      request: {
        target: input.target,
        section: input.section ? String(input.section).trim() : null,
        text,
        date: input.date ? String(input.date) : null,
        expectedRevision: input.expectedRevision ? String(input.expectedRevision) : null,
      },
      transform: (current) => {
        let section = input.section ? String(input.section).trim() : DEFAULT_SECTION
        const language = resolveLanguage(cfg.locale)
        const coreHeading = language === 'zh' ? '常驻记忆' : 'Core Memory'
        const initial = current || (language === 'zh' ? '# 记忆\n\n## 常驻记忆\n\n' : '# Memory\n\n## Core Memory\n\n')
        if (/^(常驻记忆|core memory)$/i.test(section)) {
          const parsed = analyzeMemory(current)
          if (!current || parsed.mode === 'layered') section = parsed.coreHeading ?? coreHeading
        }
        const result = appendToSection(initial, section, text)
        if (!result.ok) return { text: current, replaced: 0, reason: result.reason, hits: result.lines ?? [] }
        return { text: result.text, replaced: 1, created: !current || result.created, section }
      },
    })
  }

  /** Append to a daily file: O_APPEND, optional CAS, receipt and verified read. */
  async function appendDaily({ target, path, op, text, expectedRevision, request }) {
    const fingerprint = fingerprintFor({ action: 'append', paths: [path], request })
    const exec = async (id) => {
      // Same order as a rewrite: receipt transaction before the file lock, so
      // admission and the duplicate lookup cannot interleave with a sweep.
      const body = (tx) =>
        withLock(join(lockDir, `${pathKey(path)}.lock`), cfg.write.lockWaitMs, () => run(tx, id))
      return id ? receipts.withTransaction(body, { waitMs: cfg.write.lockWaitMs }) : body(null)
    }

    const run = (tx, id) => {
      const prior = id ? tx.read(id) : { ok: true, record: null }
      if (!prior.ok) return { result: fail(prior.code, { reason: prior.reason, operationId: id }) }
      let record = prior.record
      if (record) {
        if (record.fingerprint !== fingerprint) {
          return { result: fail('operation_mismatch', { operationId: id, path }) }
        }
        if (record.status === 'committed') return { result: { ...record.result, duplicate: true } }
        if (record.status !== 'applying') {
          return { result: fail('outcome_unknown', { operationId: id, path, reason: record.status }) }
        }
      }

      const current = existsSync(path)
        ? readTextSafe(path, { maxBytes: MAX_SOURCE_BYTES })
        : { ok: true, text: '', bytes: 0, truncated: false }
      // `changed` used to look like an empty file here, so an append could
      // overwrite the EOL/prefix decision and write over a raced snapshot.
      if (!current.ok) return { result: fail('unreadable', { path, error: current.error }) }
      if (current.truncated) return { result: fail('too_large', { path, bytes: current.bytes }) }

      const before = contentRevision(current.text)
      if (record) {
        if (before === record.after) {
          const done = markReceipt(tx, record, { status: 'committed' })
          if (!done.ok) {
            return {
              result: fail('outcome_unknown', {
                operationId: id,
                path,
                committed: true,
                revision: before,
                reason: 'receipt_update_failed',
              }),
              event: { path, target, operation: 'append', revision: before, operationId: id },
            }
          }
          return { result: { ...(done.record.result ?? record.result), duplicate: true } }
        }
        // Appended and then changed back is indistinguishable from "never ran".
        markReceipt(tx, record, {
          status: 'outcome_unknown',
          result: { ...record.result, ok: false, code: 'outcome_unknown' },
        })
        return { result: fail('outcome_unknown', { operationId: id, path, reason: 'applying_unverified' }) }
      }

      if (expectedRevision && String(expectedRevision) !== before) {
        recordOperation({
          id,
          at: Date.now(),
          target,
          path,
          status: 'conflict',
          expectedRevision: String(expectedRevision),
          revision: before,
        })
        return {
          result: {
            ok: false,
            code: 'conflict',
            expectedRevision: String(expectedRevision),
            revision: before,
            path,
          },
        }
      }

      const eol = current.text.includes('\r\n') ? '\r\n' : '\n'
      const prefix = !current.text ? '' : current.text.endsWith('\n') ? '' : eol
      const body = `${prefix}- ${text}${eol}`
      const afterRevision = contentRevision(current.text + body)

      if (id) {
        const begun = tx.begin({
          version: 1,
          id,
          fingerprint,
          action: 'append',
          target,
          path,
          before,
          after: afterRevision,
          status: 'applying',
          result: { ok: true, revision: afterRevision, path },
          createdAt: Date.now(),
        })
        if (!begun.ok) return { result: fail(begun.code, { reason: begun.reason, path }) }
        record = begun.record
        if (!record) return { result: fail('receipt_capacity', { reason: 'begin_returned_nothing', path }) }
      }

      try {
        appendFileDurable(path, body, { fsync: cfg.write.fsync })
      } catch (error) {
        // A failed append is not provably a zero-byte write, so the receipt
        // stays `applying` and a retry refuses instead of appending twice.
        return { result: fail('write_failed', { path, message: String(error?.message ?? error) }) }
      }

      const after = readTextSafe(path, { maxBytes: MAX_SOURCE_BYTES })
      if (!after.ok || after.truncated) {
        if (id) {
          markReceipt(tx, record, { status: 'outcome_unknown', result: { ok: false, code: 'outcome_unknown', path } })
        }
        return {
          result: fail('outcome_unknown', { path, committed: true, error: after.error ?? (after.truncated ? 'too_large' : null) }),
        }
      }
      if (!after.text.endsWith(body)) {
        if (id) {
          markReceipt(tx, record, { status: 'outcome_unknown', result: { ok: false, code: 'outcome_unknown', path } })
        }
        return { result: fail('outcome_unknown', { path, committed: true, reason: 'appended_text_missing' }) }
      }

      const actual = contentRevision(after.text)
      const result = { ok: true, revision: actual, path, bytes: after.bytes, appended: true }
      if (id) {
        const done = markReceipt(tx, record, { status: 'committed', after: actual, result })
        if (!done.ok) {
          return {
            result: fail('outcome_unknown', {
              path,
              committed: true,
              revision: actual,
              operationId: id,
              reason: 'receipt_update_failed',
            }),
            event: { path, target, operation: 'append', revision: actual, operationId: id },
          }
        }
      }
      recordOperation({ id, at: Date.now(), target, path, status: 'committed', before, after: actual })
      return {
        result,
        event: { path, target, operation: 'append', revision: actual, operationId: id ?? null },
      }
    }

    return runOperation({ op, exec })
  }

  /**
   * Replace or remove one entry.
   *
   * @param {{ target: string, section: string, match: string, replacement?: string, mode?: 'replace'|'remove', expectedRevision?: string, operationId?: string }} input
   */
  async function edit(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')

    const resolved = resolveTarget(input.target, probe)
    if (!resolved.path || resolved.mode !== 'rewrite') return fail('bad_target', { target: input.target })

    return commitRewrite({
      action: input.mode === 'remove' ? 'remove' : 'edit',
      target: input.target,
      path: resolved.path,
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      requireCas: true,
      request: {
        target: input.target,
        section: String(input.section ?? ''),
        match: String(input.match ?? ''),
        replacement: input.replacement === undefined ? null : String(input.replacement),
        mode: input.mode ?? 'replace',
        expectedRevision: input.expectedRevision ? String(input.expectedRevision) : null,
      },
      transform: (current) => {
        const result = editEntry(current, input.section, input.match, {
          replacement: input.replacement,
          mode: input.mode ?? 'replace',
        })
        return {
          text: result.text,
          replaced: result.replaced,
          reason: result.reason,
          hits: result.lines,
          duplicates: result.reason === 'ambiguous_section' ? result.lines?.length : undefined,
        }
      },
    })
  }

  return {
    append,
    edit,
    editAt,
    remove,
    replaceSection,
    replaceDocument,
    removeSection: removeSectionAction,
    restore,
    prune,
    listRevisions,
    readRevision,
    operationStats,
    backupDirFor,
    subscribe,
  }
}

/** Normalize a date selection; `{list:null}` means "no explicit list". */
function normalizeDates(value) {
  if (value === undefined || value === null) return { ok: true, list: null }
  const list = (Array.isArray(value) ? value : [value]).map((row) => String(row).trim()).filter(Boolean)
  if (list.length === 0) return { ok: true, list: null }
  for (const date of list) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false }
  }
  return { ok: true, list: [...new Set(list)].sort() }
}

/** Acquire several locks in the given order, releasing in reverse order. */
async function withManyLocks(lockPaths, waitMs, operation) {
  const run = async (index) => {
    if (index >= lockPaths.length) return operation()
    return withLock(lockPaths[index], waitMs, () => run(index + 1))
  }
  return run(0)
}

/** Keep only the transform's result fields, never `undefined`. */
function pickExtra(output) {
  const extra = {}
  for (const key of ['hits', 'issues', 'duplicates', 'created', 'section', 'removed', 'entries', 'restoredFrom']) {
    if (output[key] !== undefined) extra[key] = output[key]
  }
  return extra
}

/** JSON stringify with sorted object keys, so a fingerprint is stable. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key])
    return out
  }
  return value
}

/** `statSync` that answers null instead of throwing. */
function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}
