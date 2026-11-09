/**
 * The single write path.
 *
 * Every writer — tools today, the panel later — goes through `write()`. One
 * lock, one revision check, one backup, one atomic replace. A second path is a
 * back door, and a back door makes the fence decorative.
 *
 * Guarantees, stated honestly:
 *  - DSH against DSH: the lock serializes writers, so no lost update.
 *  - DSH against a non-locking editor (WorkBuddy `Edit`): only detected
 *    conflicts are refused. A write landing inside the same few milliseconds
 *    can still be overwritten; the backup and the post-write revision are what
 *    make it recoverable rather than silent.
 *  - Append-only daily files: `O_APPEND` cannot truncate existing bytes.
 */

import { appendFileDurable, contentRevision, pathKey, withLock, writeFileAtomic } from './fslock.js'
import { appendToSection, editEntry } from '../markdown.js'
import { readTextSafe } from '../fsx.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const TARGETS = ['project-memory', 'project-daily', 'user-memory']

/**
 * Resolve one target to a path and its writing style.
 *
 * @param {string} target
 * @param {object} probe - result of `probeEnvironment`.
 * @param {string} [date] - `YYYY-MM-DD` for `project-daily`.
 */
export function resolveTarget(target, probe, date) {
  switch (target) {
    case 'project-memory':
      return { path: probe.project.memoryPath, mode: 'rewrite', dir: probe.project.dir, exists: probe.project.exists }
    case 'project-daily': {
      const stamp = date ?? new Date().toISOString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) return { path: null, mode: 'append', dir: probe.project.dir, error: 'bad_date' }
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
 * @param {string} deps.stateDir - where locks, backups and the log live.
 */
export function createStore({ cfg, stateDir }) {
  const lockDir = join(stateDir, 'locks')
  const backupDir = join(stateDir, 'backups')
  const logDir = join(stateDir, 'log')

  /** Result helper so every refusal has the same shape. */
  const fail = (code, extra = {}) => ({ ok: false, code, ...extra })

  /**
   * Whether this write is a replay of an operation already committed.
   * @param {string} operationId
   */
  function seenOperation(operationId) {
    if (!operationId || !cfg.write.operationLog) return null
    const file = join(logDir, 'operations.jsonl')
    if (!existsSync(file)) return null
    try {
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      for (let index = lines.length - 1; index >= 0 && index > lines.length - 501; index -= 1) {
        const line = lines[index]
        if (!line) continue
        try {
          const record = JSON.parse(line)
          if (record.id === operationId) return record
        } catch {
          // A torn last line from a crash; keep scanning older records.
        }
      }
    } catch {
      return null
    }
    return null
  }

  function recordOperation(record) {
    if (!cfg.write.operationLog) return
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(join(logDir, 'operations.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // The log is an optimization for duplicate detection, not the truth.
    }
  }

  /** Copy the current file next to its siblings, keeping at most N. */
  function backup(path) {
    if (cfg.write.backupKeep <= 0) return null
    if (!existsSync(path)) return null
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dir = join(backupDir, pathKey(path))
      mkdirSync(dir, { recursive: true })
      const target = join(dir, `${stamp}.md`)
      writeFileAtomic(target, readFileSync(path, 'utf8'), { fsync: false, mode: 0o600 })
      pruneBackups(dir)
      return target
    } catch {
      return null
    }
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
    if (!existsSync(resolved.dir)) return fail('no_store', { target: input.target, dir: resolved.dir })

    const replay = seenOperation(input.operationId)
    if (replay?.status === 'committed') return { ok: true, duplicate: true, revision: replay.after, path: resolved.path }

    const text = String(input.text ?? '').trim()
    if (!text) return fail('empty_text')

    if (resolved.mode === 'append') {
      // Daily files: pure append, so another writer's bytes cannot be lost.
      return withLock(join(lockDir, `${pathKey(resolved.path)}.lock`), cfg.write.lockWaitMs, () => {
        const current = existsSync(resolved.path) ? readTextSafe(resolved.path) : { text: '', bytes: 0 }
        const eol = current.text.includes('\r\n') ? '\r\n' : '\n'
        const prefix = !current.text ? '' : current.text.endsWith('\n') ? '' : eol
        const body = `${prefix}- ${text}${eol}`
        appendFileDurable(resolved.path, body, { fsync: cfg.write.fsync })
        const after = readTextSafe(resolved.path)
        const revision = contentRevision(after.text)
        recordOperation({ id: input.operationId, at: Date.now(), target: input.target, path: resolved.path, status: 'committed', after: revision })
        return { ok: true, revision, path: resolved.path, bytes: after.bytes, appended: true }
      })
    }

    return writeEverywhere(resolved.path, input.target, input.expectedRevision, input.operationId, (current) => {
      if (!input.section) return { text: appendToSection(current, '记录', text).text, created: true }
      const result = appendToSection(current, input.section, text)
      return { text: result.text, created: result.created }
    })
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

    const replay = seenOperation(input.operationId)
    if (replay?.status === 'committed') return { ok: true, duplicate: true, revision: replay.after, path: resolved.path }

    return writeEverywhere(resolved.path, input.target, input.expectedRevision, input.operationId, (current) => {
      const result = editEntry(current, input.section, input.match, {
        replacement: input.replacement,
        mode: input.mode ?? 'replace',
      })
      return { text: result.text, replaced: result.replaced, reason: result.reason, hits: result.lines }
    })
  }

  /** Shared lock → re-read → transform → backup → replace path. */
  function writeEverywhere(path, target, expectedRevision, operationId, transform) {
    return withLock(join(lockDir, `${pathKey(path)}.lock`), cfg.write.lockWaitMs, () => {
      const current = existsSync(path) ? readTextSafe(path) : { ok: true, text: '', bytes: 0 }
      if (!current.ok && current.error !== 'not_a_file') return fail('unreadable', { error: current.error, path })

      const before = contentRevision(current.text)
      if (expectedRevision && expectedRevision !== before) {
        return {
          ok: false,
          code: 'conflict',
          expectedRevision,
          revision: before,
          path,
          hint: 'the file changed since it was read; read again before writing',
        }
      }

      const result = transform(current.text)
      if (result.replaced === 0) return fail(result.reason ?? 'no_match', { path, hits: result.hits ?? [] })

      const backupPath = backup(path)
      writeFileAtomic(path, result.text, { fsync: cfg.write.fsync })
      const after = readTextSafe(path)
      const revision = contentRevision(after.text)
      recordOperation({ id: operationId, at: Date.now(), target, path, status: 'committed', before, after: revision, backup: backupPath })
      return { ok: true, revision, previous: before, path, bytes: after.bytes, backup: backupPath ?? undefined, created: result.created }
    }).catch((error) => {
      if (error?.code === 'lock_timeout') return fail('lock_timeout', { owner: error.owner })
      return fail('write_failed', { message: error?.message ?? String(error) })
    })
  }

  return { append, edit }
}
