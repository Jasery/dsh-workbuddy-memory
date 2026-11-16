/**
 * Persistent, bounded operation receipts.
 *
 * The old ledger was an optimization: `operationLog: false` disabled duplicate
 * detection entirely, and a crash between the file write and the ledger append
 * left no way to tell "already committed" from "never started". A receipt is
 * written *before* the destructive step, so a retry can prove what happened by
 * comparing the hashes it recorded with what is on disk now.
 *
 * The store is deliberately small and self-contained:
 *
 *  - one JSON file per operationId, named by its hash, so lookup is O(1);
 *  - a hard cap on records (2000) and unresolved operations (100), checked
 *    before anything is created — at the cap the caller refuses without
 *    touching the source, and no unresolved receipt is ever evicted to make
 *    room;
 *  - one megabyte per receipt, so a corrupted or pathological record cannot
 *    make every read pay for it;
 *  - only *committed* records expire (after 24 hours). `applying`, `partial` and
 *    `outcome_unknown` are unresolved: they may describe a write that is still
 *    in flight or one whose result nobody knows, so they stay forever, count
 *    toward the pending cap, and are never aged out by mtime.
 *
 * Every read, expiry sweep, capacity admission and write runs under one
 * cross-process lock for this state directory. The counts and expiry decisions
 * are therefore atomic across processes: two writers cannot both see 99
 * unresolved receipts, and a sweep cannot delete a receipt created after it
 * scanned the directory.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { readTextSafe } from '../fsx.js'
import { withLock, writeFileAtomic, writeFileExclusive } from './fslock.js'

export const RECEIPT_LIMITS = Object.freeze({
  terminalMs: 24 * 60 * 60 * 1000,
  maxRecords: 2000,
  maxPending: 100,
  maxBytes: 1024 * 1024,
})

/** Only a proven terminal record may age out. */
const EXPIRABLE = new Set(['committed'])

/**
 * @param {{ stateDir: string, lockWaitMs?: number }} deps
 */
export function createReceiptStore({ stateDir, lockWaitMs = 3000 }) {
  const dir = join(stateDir, 'receipts')
  const lockPath = join(stateDir, 'locks', 'receipts.lock')

  function fileFor(operationId) {
    const digest = createHash('sha1').update(String(operationId), 'utf8').digest('hex')
    return join(dir, `${digest.slice(0, 32)}.json`)
  }

  /**
   * Read one receipt. A missing file is not an error; a corrupt or oversized
   * one is, because overwriting it could erase the only record of a write.
   *
   * Must run under the store lock: expiring a committed record is a durable
   * decision and a concurrent create of the same id must not be swallowed.
   */
  function readLocked(operationId) {
    const file = fileFor(operationId)
    if (!existsSync(file)) return { ok: true, record: null }
    const loaded = readTextSafe(file, { maxBytes: RECEIPT_LIMITS.maxBytes })
    if (!loaded.ok) return { ok: false, code: 'receipt_capacity', reason: loaded.error ?? 'unreadable' }
    if (loaded.truncated) return { ok: false, code: 'receipt_capacity', reason: 'record_too_large' }
    try {
      const record = JSON.parse(loaded.text)
      if (!record || record.id !== String(operationId)) {
        return { ok: false, code: 'receipt_capacity', reason: 'corrupt' }
      }
      const updated = Number(record.updatedAt ?? record.createdAt ?? 0)
      if (EXPIRABLE.has(record.status) && Date.now() - updated > RECEIPT_LIMITS.terminalMs) {
        // Deduplication is promised only inside the retention window. An old
        // terminal record is gone, not silently reused forever. Unresolved
        // records never take this branch.
        rmSync(file, { force: true })
        return { ok: true, record: null }
      }
      return { ok: true, record }
    } catch {
      return { ok: false, code: 'receipt_capacity', reason: 'corrupt' }
    }
  }

  /** Write a new receipt without ever replacing an existing one. */
  function beginLocked(record) {
    const room = maintainLocked()
    if (!room.ok) return room
    const body = serialize(record)
    if (!body.ok) return body
    try {
      writeFileExclusive(fileFor(record.id), body.text, { fsync: true })
      return { ok: true, record: body.record }
    } catch (error) {
      if (error?.code === 'EEXIST') return { ok: false, code: 'receipt_capacity', reason: 'duplicate_id' }
      return { ok: false, code: 'receipt_capacity', reason: String(error?.code ?? error) }
    }
  }

  /** Replace the record for an id already created by `begin`. */
  function updateLocked(record) {
    const body = serialize(record)
    if (!body.ok) return body
    try {
      writeFileAtomic(fileFor(record.id), body.text, { fsync: true })
      return { ok: true, record: body.record }
    } catch (error) {
      return { ok: false, code: 'receipt_capacity', reason: String(error?.code ?? error) }
    }
  }

  /** Remove a receipt created for a write that never touched the source. */
  function dropLocked(operationId) {
    try {
      rmSync(fileFor(operationId), { force: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * Expire old terminal records, then report whether a new one fits.
   *
   * Only time expires committed records. A full store refuses the new
   * operation; it never deletes an unresolved or unreadable record, because
   * that record may be the only evidence that some write is in flight.
   */
  function maintainLocked(now = Date.now()) {
    let names = []
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch {
      return { ok: true }
    }
    // Below the pending cap neither limit can be hit (pending ≤ names), so an
    // ordinary write does not pay to parse every receipt.
    if (names.length < RECEIPT_LIMITS.maxPending) return { ok: true }

    let total = 0
    let pending = 0
    for (const name of names) {
      const file = join(dir, name)
      let record = null
      const loaded = readTextSafe(file, { maxBytes: RECEIPT_LIMITS.maxBytes })
      if (loaded.ok && !loaded.truncated) {
        try {
          record = JSON.parse(loaded.text)
        } catch {
          record = null
        }
      }

      if (!record || typeof record !== 'object' || typeof record.status !== 'string') {
        // Meaning unknown. Treat it as an unresolved slot: refusing is honest,
        // deleting a record whose meaning cannot be proven is not.
        total += 1
        pending += 1
        continue
      }

      if (!EXPIRABLE.has(record.status)) {
        total += 1
        pending += 1
        continue
      }

      const updated = Number(record.updatedAt ?? record.createdAt ?? 0)
      if (now - updated > RECEIPT_LIMITS.terminalMs) {
        rmSync(file, { force: true })
        continue
      }
      total += 1
    }

    if (total >= RECEIPT_LIMITS.maxRecords) {
      return { ok: false, code: 'receipt_capacity', reason: 'records' }
    }
    if (pending >= RECEIPT_LIMITS.maxPending) {
      return { ok: false, code: 'receipt_capacity', reason: 'pending' }
    }
    return { ok: true }
  }

  function serialize(record) {
    const body = { ...record, updatedAt: Date.now() }
    let text
    try {
      text = JSON.stringify(body)
    } catch (error) {
      return { ok: false, code: 'receipt_capacity', reason: String(error?.message ?? error) }
    }
    if (Buffer.byteLength(text, 'utf8') > RECEIPT_LIMITS.maxBytes) {
      return { ok: false, code: 'receipt_capacity', reason: 'record_too_large' }
    }
    return { ok: true, text, record: body }
  }

  /**
   * The lock-free view handed to a transaction holder. Its methods are
   * synchronous, because the caller already holds `lockPath`; calling
   * `withTransaction` again from inside would deadlock.
   */
  const locked = {
    read: readLocked,
    begin: beginLocked,
    update: updateLocked,
    drop: dropLocked,
    maintain: maintainLocked,
  }

  /**
   * Run `fn` with the receipt store held. Every writer that must make several
   * receipt decisions atomically (admission + create, read + update) uses this
   * instead of the one-shot helpers below.
   *
   * @template T
   * @param {(tx: typeof locked) => T} fn
   * @param {{ waitMs?: number }} [options]
   * @returns {Promise<T>}
   */
  function withTransaction(fn, options = {}) {
    return withLock(lockPath, options.waitMs ?? lockWaitMs, () => fn(locked))
  }

  return {
    lockPath,
    fileFor,
    withTransaction,
    read: (operationId) => {
      // A store that never wrote has no directory; do not create one or a lock
      // just to answer "no receipt".
      if (!existsSync(dir)) return Promise.resolve({ ok: true, record: null })
      return withTransaction((tx) => tx.read(operationId), { waitMs: lockWaitMs })
    },
    begin: (record) =>
      withTransaction(
        (tx) => {
          try {
            mkdirSync(dir, { recursive: true })
          } catch (error) {
            return { ok: false, code: 'receipt_capacity', reason: String(error?.code ?? error) }
          }
          return tx.begin(record)
        },
        { waitMs: lockWaitMs },
      ),
    update: (record) => withTransaction((tx) => tx.update(record), { waitMs: lockWaitMs }),
    drop: (operationId) => withTransaction((tx) => tx.drop(operationId), { waitMs: lockWaitMs }),
  }
}
