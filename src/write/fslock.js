/**
 * Cross-process lock and atomic replacement.
 *
 * The lock is a directory: creating one is atomic on every platform, and it
 * needs no native dependency. It only excludes writers that cooperate — a
 * WorkBuddy `Edit` does not know it exists — so the write path re-reads and
 * re-hashes inside the lock instead of trusting the lock alone.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

/** Stable short id for a path, used as a lock and backup file name. */
export function pathKey(path) {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

/** Content revision: what the caller saw, so a stale write is detectable. */
export function contentRevision(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Run `operation` while holding a lock directory.
 *
 * @template T
 * @param {string} lockPath - directory that represents the lock.
 * @param {number} waitMs - how long to keep trying before giving up.
 * @param {() => Promise<T>|T} operation
 * @returns {Promise<T>}
 * @throws {{ code: 'lock_timeout' }} when the lock could not be taken.
 */
export async function withLock(lockPath, waitMs, operation) {
  const deadline = Date.now() + Math.max(0, waitMs)
  while (true) {
    if (tryAcquire(lockPath)) break
    if (Date.now() >= deadline) {
      const held = readOwner(lockPath)
      if (held && isStale(held)) {
        release(lockPath)
        continue
      }
      const error = new Error(`lock busy: ${lockPath}`)
      error.code = 'lock_timeout'
      error.owner = held
      throw error
    }
    await delay(25 + Math.floor(Math.random() * 25))
  }

  try {
    return await operation()
  } finally {
    release(lockPath)
  }
}

function tryAcquire(lockPath) {
  try {
    mkdirSync(lockPath)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    if (error?.code === 'ENOENT') {
      mkdirSync(dirname(lockPath), { recursive: true })
      return tryAcquire(lockPath)
    }
    throw error
  }
  try {
    writeFileSync(
      join(lockPath, 'owner'),
      JSON.stringify({ pid: process.pid, at: Date.now(), host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? '' }),
      'utf8',
    )
  } catch {
    // An unreadable owner file only weakens stale detection, not the lock.
  }
  return true
}

function readOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(join(lockPath, 'owner'), 'utf8'))
  } catch {
    return null
  }
}

function isStale(owner) {
  const age = Date.now() - Number(owner?.at ?? 0)
  if (!Number.isFinite(age) || age > 120000) return true
  if (owner?.host && process.env.COMPUTERNAME && owner.host !== process.env.COMPUTERNAME) return false
  if (!owner?.pid) return true
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

function release(lockPath) {
  try {
    rmSync(lockPath, { recursive: true, force: true })
  } catch {
    // Leaving a stale directory behind is recoverable; throwing here is not.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Replace a file's content atomically.
 *
 * Writes a sibling temporary file, optionally flushes it, then renames over the
 * target. A crash leaves either the old file or the new one, never a half file.
 *
 * @param {string} path
 * @param {string} content
 * @param {{ fsync?: boolean, mode?: number }} [options]
 */
export function writeFileAtomic(path, content, options = {}) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.${pathKey(path)}.${process.pid}.${Date.now()}.tmp`)

  let fd
  try {
    fd = openSync(temp, 'wx', options.mode ?? 0o600)
    writeSync(fd, content, null, 'utf8')
    if (options.fsync !== false) {
      try {
        fsyncSync(fd)
      } catch {
        // A platform without fsync still gets rename atomicity.
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }

  try {
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Best effort.
    }
    throw error
  }
}

/** Append without rewriting — the one write that cannot truncate existing bytes. */
export function appendFileDurable(path, content, options = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a', options.mode ?? 0o600)
  try {
    writeSync(fd, content, null, 'utf8')
    if (options.fsync !== false) {
      try {
        fsyncSync(fd)
      } catch {
        // Best effort.
      }
    }
  } finally {
    closeSync(fd)
  }
}

/** Whether `path` exists and is a regular file. */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether a directory exists. */
export function isDir(path) {
  return existsSync(path)
}
