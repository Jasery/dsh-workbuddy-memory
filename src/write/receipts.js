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
 *    touching the source, and no unknown receipt is ever evicted to make room;
 *  - one megabyte per receipt, so a corrupted or pathological record cannot
 *    make every read pay for it;
 *  - terminal records expire after 24 hours. Deduplication is honest only
 *    inside that window, which is why the window is stated, not hidden.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readTextSafe } from '../fsx.js'
import { writeFileAtomic, writeFileExclusive } from './fslock.js'

export const RECEIPT_LIMITS = Object.freeze({
  terminalMs: 24 * 60 * 60 * 1000,
  maxRecords: 2000,
  maxPending: 100,
  maxBytes: 1024 * 1024,
})

const EXPIRABLE = new Set(['committed', 'partial', 'outcome_unknown'])
const PENDING = new Set(['applying', 'partial'])

/**
 * @param {{ stateDir: string }} deps
 */
export function createReceiptStore({ stateDir }) {
  const dir = join(stateDir, 'receipts')

  function fileFor(operationId) {
    const digest = createHash('sha1').update(String(operationId), 'utf8').digest('hex')
    return join(dir, `${digest.slice(0, 32)}.json`)
  }

  /**
   * Read one receipt. A missing file is not an error; a corrupt or oversized
   * one is, because overwriting it could erase the only record of a write.
   */
  function read(operationId) {
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
        // terminal record is gone, not silently reused forever.
        rmSync(file, { force: true })
        return { ok: true, record: null }
      }
      return { ok: true, record }
    } catch {
      return { ok: false, code: 'receipt_capacity', reason: 'corrupt' }
    }
  }

  /** Write a new receipt without ever replacing an existing one. */
  function begin(record) {
    const room = maintain()
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
  function update(record) {
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
  function drop(operationId) {
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
   * Only time expires records. A full store refuses the new operation; it never
   * deletes a record it does not understand, because that record may be the
   * only evidence that some write already happened.
   */
  function maintain(now = Date.now()) {
    let names = []
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'))
    } catch {
      return { ok: true }
    }
    // Below the pending cap neither limit can be hit, so an ordinary write does
    // not pay to parse every receipt. Only a store near a limit is scanned.
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

      if (!record || typeof record !== 'object') {
        // A corrupt file cannot be interpreted. Age it out by mtime rather than
        // deleting a record whose meaning we cannot prove.
        const stat = statSafe(file)
        if (stat && now - stat.mtimeMs > RECEIPT_LIMITS.terminalMs) {
          rmSync(file, { force: true })
          continue
        }
        total += 1
        continue
      }

      const updated = Number(record.updatedAt ?? record.createdAt ?? 0)
      if (EXPIRABLE.has(record.status) && now - updated > RECEIPT_LIMITS.terminalMs) {
        rmSync(file, { force: true })
        continue
      }
      total += 1
      if (PENDING.has(record.status)) pending += 1
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

  function ensureDir() {
    mkdirSync(dir, { recursive: true })
  }

  return {
    read,
    begin: (record) => {
      try {
        ensureDir()
      } catch (error) {
        return { ok: false, code: 'receipt_capacity', reason: String(error?.code ?? error) }
      }
      return begin(record)
    },
    update,
    drop,
    fileFor,
  }
}

function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}
