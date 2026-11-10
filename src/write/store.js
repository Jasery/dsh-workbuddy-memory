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
import { allEntries, appendToSection, editEntry, editEntryAt, removeLines } from '../markdown.js'
import { ageInDays } from '../env.js'
import { readTextSafe } from '../fsx.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const TARGETS = ['project-memory', 'project-daily', 'user-memory']

/** Actions the panel may ask for. Anything not here is refused before it runs. */
export const ACTIONS = ['add', 'edit', 'remove', 'consolidate', 'restore']

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
export function resolveTarget(target, probe, date) {
  switch (target) {
    case 'project-memory':
      return { path: probe.project.memoryPath, mode: 'rewrite', dir: probe.project.dir, exists: probe.project.exists }
    case 'project-daily': {
      const stamp = date ?? localDateStamp()
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

    const replay = seenOperation(input.operationId)
    if (replay?.status === 'committed') return { ok: true, duplicate: true, revision: replay.after, path: resolved.path }

    return writeEverywhere(resolved.path, input.target, input.expectedRevision, input.operationId, (current) => {
      const result = editEntryAt(current, input.section, input.line, {
        replacement: input.replacement,
        mode: input.mode ?? 'replace',
      })
      return { text: result.text, replaced: result.replaced, reason: result.reason, hits: result.lines }
    })
  }

  /** Delete one entry by line. Same chain as `editAt`, one fewer input. */
  async function remove(input, probe) {
    return editAt({ ...input, mode: 'remove' }, probe)
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

    const snapshot = readRevision(resolved.path, String(input.name ?? ''))
    if (!snapshot.ok) return fail(snapshot.code, { target: input.target })

    return writeEverywhere(resolved.path, input.target, input.expectedRevision, input.operationId, () => ({
      text: snapshot.text,
      replaced: 1,
      restoredFrom: snapshot.name,
    }))
  }

  /**
   * Fold old daily files into the project's long-term memory.
   *
   * `dryRun` is the default: the panel shows the plan first, and running it
   * means sending the same request with `dryRun: false`. Each daily file lands
   * under its own `## YYYY-MM-DD` heading, so the archive keeps its dates
   * instead of inventing topics the plugin cannot infer.
   *
   * Two files are touched, so the journal records which sources were already
   * cleared — a crash between the target write and the source cleanup resumes
   * without writing the same entries twice.
   *
   * @param {{ beforeDays?: number, dates?: string[], dryRun?: boolean, expectedRevision?: string, operationId?: string }} input
   */
  async function consolidate(input, probe) {
    if (cfg.readOnly) return fail('read_only')
    if (!cfg.write.enabled) return fail('write_disabled')

    const dir = probe.project.dir
    if (!dir || !existsSync(dir)) return fail('no_store', { dir })
    const targetPath = probe.project.memoryPath
    if (!targetPath) return fail('no_store')

    const beforeDays = Math.min(Math.max(Number(input.beforeDays ?? 30) || 0, 1), 3650)
    const wanted = Array.isArray(input.dates) && input.dates.length > 0 ? new Set(input.dates.map(String)) : null

    let names = []
    try {
      names = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    } catch {
      return fail('no_store', { dir })
    }

    const candidates = []
    for (const name of names.sort()) {
      const date = name.slice(0, 10)
      if (wanted ? !wanted.has(date) : ageInDays(date) < beforeDays) continue
      const file = readTextSafe(join(dir, name), { maxBytes: 2 * 1024 * 1024 })
      if (!file.ok) continue
      const entries = allEntries(file.text).map((entry) => entry.text)
      if (entries.length === 0) continue
      candidates.push({ date, name, bytes: file.bytes, revision: contentRevision(file.text), entries })
    }

    const plan = {
      ok: true,
      dryRun: input.dryRun !== false,
      beforeDays,
      target: 'project-memory',
      targetPath,
      candidates,
      entries: candidates.reduce((sum, row) => sum + row.entries.length, 0),
    }
    if (plan.dryRun) return plan
    if (candidates.length === 0) return fail('nothing_to_consolidate', { beforeDays })

    const operationId = input.operationId || `consolidate-${Date.now()}`
    const replay = seenOperation(operationId)
    if (replay?.status === 'committed') return { ok: true, duplicate: true, revision: replay.after, path: targetPath }

    // 1. Write every entry into the target under its date heading.
    const written = await writeEverywhere(targetPath, 'project-memory', input.expectedRevision, operationId, (current) => {
      let text = current
      for (const row of candidates) {
        for (const entry of row.entries) {
          text = appendToSection(text, row.date, entry).text
        }
      }
      return { text, replaced: 1, created: true }
    })
    if (!written.ok) return written

    // 2. Clear the folded entries from each source, highest line first.
    const journalPath = join(logDir, `${operationId.replace(/[^\w.-]/g, '_')}.json`)
    const cleared = []
    const failed = []
    for (const row of candidates) {
      const sourcePath = join(dir, row.name)
      try {
        const current = readTextSafe(sourcePath)
        if (!current.ok) {
          failed.push({ date: row.date, code: 'unreadable' })
          continue
        }
        const lines = allEntries(current.text)
          .filter((entry) => row.entries.includes(entry.text))
          .map((entry) => entry.line)
        if (lines.length === 0) {
          cleared.push(row.date)
          continue
        }
        backup(sourcePath)
        writeFileAtomic(sourcePath, removeLines(current.text, lines), { fsync: cfg.write.fsync })
        cleared.push(row.date)
      } catch (error) {
        failed.push({ date: row.date, code: String(error?.message ?? error) })
      }
    }

    try {
      mkdirSync(logDir, { recursive: true })
      writeFileAtomic(
        journalPath,
        `${JSON.stringify({ id: operationId, at: Date.now(), beforeDays, target: targetPath, revision: written.revision, candidates: candidates.map((row) => ({ date: row.date, name: row.name, entries: row.entries.length })), cleared, failed }, null, 2)}\n`,
        { fsync: false },
      )
    } catch {
      // The journal is for forensics; the write already committed.
    }

    return {
      ok: true,
      revision: written.revision,
      path: targetPath,
      backup: written.backup,
      consolidated: candidates.map((row) => ({ date: row.date, entries: row.entries.length })),
      cleared,
      failed,
      journal: journalPath,
    }
  }

  /** Result helper so every refusal has the same shape. */
  function fail(code, extra = {}) {
    return { ok: false, code, ...extra }
  }

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
      const dir = backupDirFor(path)
      mkdirSync(dir, { recursive: true })
      const target = join(dir, `${stamp}.md`)
      writeFileAtomic(target, readFileSync(path, 'utf8'), { fsync: false, mode: 0o600 })
      pruneBackups(dir)
      return target
    } catch {
      return null
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
    const file = readTextSafe(join(backupDirFor(path), name), { maxBytes: 2 * 1024 * 1024 })
    if (!file.ok) return { ok: false, code: 'unreadable', error: file.error }
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
    const file = join(logDir, 'operations.jsonl')
    const empty = { total: 0, conflicts: 0, lastConflictAt: null, lastCommitAt: null }
    if (!existsSync(file)) return empty
    let lines = []
    try {
      lines = readFileSync(file, 'utf8').trim().split('\n').slice(-max)
    } catch {
      return empty
    }
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
    if (!existsSync(resolved.dir)) {
      // `write.ensureLayout` is off by default: inventing a hidden `.workbuddy`
      // in someone's workspace can race WorkBuddy's own setup, so the refusal is
      // the default. When it is on, the first write bootstraps the folder.
      if (!cfg.write.ensureLayout) return fail('no_store', { target: input.target, dir: resolved.dir })
      try {
        mkdirSync(resolved.dir, { recursive: true })
      } catch (error) {
        return fail('no_store', { target: input.target, dir: resolved.dir, error: String(error?.message ?? error) })
      }
    }

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
        // Recorded so the panel can show "someone else wrote this" instead of
        // silently offering a write that will keep failing.
        recordOperation({
          id: operationId,
          at: Date.now(),
          target,
          path,
          status: 'conflict',
          expectedRevision,
          revision: before,
        })
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

  return { append, edit, editAt, remove, restore, consolidate, listRevisions, readRevision, operationStats, backupDirFor }
}

/** `statSync` that answers null instead of throwing. */
function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}
