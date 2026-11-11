/**
 * Cross-process lock and atomic replacement.
 *
 * The lock is a directory: creating one is atomic on every platform, and it
 * needs no native dependency. It only excludes writers that cooperate — a
 * WorkBuddy `Edit` does not know it exists — so the write path re-reads and
 * re-hashes inside the lock instead of trusting the lock alone.
 */

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Stable short id for a path, used as a lock and backup file name.
 *
 * Windows paths are case-insensitive and separator-insensitive: `C:\x\MEMORY.md`
 * and `c:/x/memory.md` are one file, so they must produce one lock name and one
 * backup directory. Hashing the raw string gave them two, and two writers
 * targeting one file then did not serialize at all.
 */
export function pathKey(path) {
  return createHash('sha1').update(identity(path)).digest('hex').slice(0, 16)
}

/** Fold the parts of a path the platform itself ignores. */
export function identity(path) {
  const text = String(path ?? '')
  if (process.platform !== 'win32') return text
  return text.replace(/\//g, '\\').toLowerCase()
}

/** Content revision: what the caller saw, so a stale write is detectable. */
export function contentRevision(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Run `operation` while holding a lock directory.
 *
 * Ownership is proven by a nonce: acquiring writes one, and releasing only
 * removes the directory while that same nonce is still in the owner file. A
 * lock reclaimed from a dead process is therefore never deleted by the process
 * that lost it — the previous version removed the directory unconditionally,
 * so a slow holder whose lock had just been reclaimed would delete the new
 * holder's lock on its way out.
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
  let token
  while (true) {
    token = tryAcquire(lockPath)
    if (token) break
    if (Date.now() >= deadline) {
      const held = readOwner(lockPath)
      // Reclaim only what is provably dead: a live holder is never stolen from,
      // however long it has been running.
      if (held && isStale(held) && reclaim(lockPath)) continue
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
    release(lockPath, token)
  }
}

/** Take the lock, or return null when someone else holds it. */
function tryAcquire(lockPath) {
  try {
    mkdirSync(lockPath)
  } catch (error) {
    if (error?.code === 'EEXIST') return null
    if (error?.code === 'ENOENT') {
      mkdirSync(dirname(lockPath), { recursive: true })
      return tryAcquire(lockPath)
    }
    throw error
  }
  const token = randomUUID()
  try {
    writeFileSync(
      join(lockPath, 'owner'),
      JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? '',
        token,
      }),
      'utf8',
    )
  } catch {
    // An unreadable owner file only weakens stale detection, not the lock.
  }
  return token
}

function readOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(join(lockPath, 'owner'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Whether the owner recorded in this lock is provably gone.
 *
 * Age alone is not evidence: a long append on a slow disk can hold the lock for
 * minutes. Only a dead pid on the same host counts, plus an owner file so old
 * that no live process could still be behind it.
 */
function isStale(owner) {
  if (!owner || typeof owner !== 'object') {
    // No owner file at all: either a crash between mkdir and write, or a lock
    // from a version that predates the owner file. Age decides.
    return true
  }
  if (owner?.host && process.env.COMPUTERNAME && owner.host !== process.env.COMPUTERNAME) return false
  if (!owner?.pid) return true
  try {
    process.kill(owner.pid, 0)
    // Alive on this host. A very old timestamp still means the holder is stuck
    // in a way no timeout will fix, but stealing from a live process is worse
    // than a refusal, so it stays held.
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/** Remove a provably dead lock; true when this caller may retry the acquire. */
function reclaim(lockPath) {
  try {
    rmSync(lockPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Release only a lock this caller still owns. */
function release(lockPath, token) {
  const held = readOwner(lockPath)
  // A missing owner file is the crash-window case: the directory is ours
  // (we just created it) and nobody else can have written an owner since.
  if (held && token && held.token && held.token !== token) return
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
 * A symlinked target is resolved first: `rename` would replace the link itself,
 * leaving the file the reader actually sees untouched — the guard canonicalizes
 * paths, so read, write and guard would then all address different files.
 *
 * @param {string} path
 * @param {string} content
 * @param {{ fsync?: boolean, mode?: number }} [options]
 */
export function writeFileAtomic(path, content, options = {}) {
  const target = resolveLink(path)
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.${pathKey(target)}.${process.pid}.${Date.now()}.tmp`)

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
    renameSync(temp, target)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Best effort.
    }
    throw error
  }
}

/** Follow a symlink/junction to the file it names; the path itself when absent. */
export function resolveLink(path) {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
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
