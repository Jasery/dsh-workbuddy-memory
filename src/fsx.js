/** Small filesystem helpers shared by the probe, the snapshot cache and the tools. */

import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'

/** `stat` that reports failure instead of throwing. */
export function statSafe(path) {
  if (!path) return null
  try {
    const stat = statSync(path)
    return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, isFile: stat.isFile(), isDirectory: stat.isDirectory() }
  } catch {
    return null
  }
}

/** Whether this process may write to `path` (or create it, for a missing path). */
export function isWritable(path) {
  if (!path) return false
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Read a UTF-8 file, reporting rather than throwing.
 *
 * With `maxBytes`, the read is bounded at the descriptor itself: whatever the
 * first `stat` claimed, at most `maxBytes` are ever allocated or read, and one
 * probe byte after the cap tells whether the file continues. The old path chose
 * "bounded" from a stat taken before the read, so a file that grew in between
 * was loaded in full under a cap that promised otherwise.
 *
 * The caller also learns whether the file was stable during the read. A file
 * that changed below the cap yields `ok: false, error: 'changed'` instead of a
 * snapshot nobody can safely hash; a file that reached the cap stays
 * `truncated: true` so a reader can refuse it without trusting a prefix.
 *
 * Without `maxBytes` the read is still a snapshot of the size seen on the open
 * descriptor, but it is checked: the same descriptor is f-stat'ed again after
 * the read, and any change to size or mtime yields `ok: false, error: 'changed'`
 * with no text. A write caller's CAS then refuses instead of hashing a prefix
 * that happens to equal the revision it was given. The check covers changes the
 * read itself could see; a write landing after the final `fstat` is outside what
 * this helper can detect.
 *
 * @param {string} path - absolute path.
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ ok: boolean, text: string, bytes: number, mtimeMs: number, truncated: boolean, error?: string }}
 */
export function readTextSafe(path, options = {}) {
  const empty = { ok: false, text: '', bytes: 0, mtimeMs: 0, truncated: false }
  if (!path) return { ...empty, error: 'no_path' }

  const maxBytes = options.maxBytes
  const bounded = typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
  const cap = bounded ? Math.floor(maxBytes) : 0

  let fd
  try {
    fd = openSync(path, 'r')
    const before = fstatSync(fd)
    if (!before.isFile()) return { ...empty, error: 'not_a_file' }

    if (!bounded) {
      const buffer = readBytes(fd, before.size)
      const after = fstatSync(fd)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        return {
          ok: false,
          text: '',
          bytes: after.size,
          mtimeMs: after.mtimeMs,
          truncated: false,
          error: 'changed',
        }
      }
      return {
        ok: true,
        text: decodeUtf8Prefix(buffer),
        bytes: after.size,
        mtimeMs: after.mtimeMs,
        truncated: false,
      }
    }

    const buffer = readBytes(fd, cap)
    let truncated = before.size > cap
    if (!truncated && buffer.length === cap) {
      // One byte past the cap is enough to know the file did not end there. It
      // is never decoded, so no unread content leaks into the returned text.
      truncated = readSync(fd, Buffer.allocUnsafe(1), 0, 1, cap) > 0
    }

    const after = fstatSync(fd)
    const changed = after.size !== before.size || after.mtimeMs !== before.mtimeMs
    if (changed && !truncated) {
      return {
        ok: false,
        text: '',
        bytes: after.size,
        mtimeMs: after.mtimeMs,
        truncated: false,
        error: 'changed',
      }
    }

    return {
      ok: true,
      text: decodeUtf8Prefix(buffer),
      bytes: after.size,
      mtimeMs: after.mtimeMs,
      truncated,
    }
  } catch (error) {
    return { ...empty, error: error?.code ?? String(error) }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // A failed close must not replace the read result.
      }
    }
  }
}

/**
 * Read at most `limit` bytes from `fd`, stopping at the first short read.
 *
 * @param {number} fd
 * @param {number} limit
 * @returns {Buffer}
 */
function readBytes(fd, limit) {
  const buffer = Buffer.allocUnsafe(limit)
  let total = 0
  while (total < limit) {
    const read = readSync(fd, buffer, total, limit - total, total)
    if (read <= 0) break
    total += read
  }
  return buffer.subarray(0, total)
}

/**
 * Decode valid UTF-8 bytes, discarding a character cut in half at the end.
 *
 * `Buffer.toString` would turn that half into U+FFFD, which then looks like
 * content the file never contained.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeUtf8Prefix(buffer) {
  let end = buffer.length
  let lead = end - 1
  let continuations = 0
  while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80 && continuations < 3) {
    continuations += 1
    lead -= 1
  }
  if (lead >= 0) {
    const first = buffer[lead]
    const needed = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : first < 0x80 ? 1 : 0
    if (needed === 0 || continuations + 1 < needed) end = lead
  }
  return buffer.subarray(0, end).toString('utf8')
}

/**
 * Cut text to at most `maxBytes` UTF-8 bytes without splitting a character.
 *
 * Counts UTF-16 code units the way a JavaScript string does, so a surrogate
 * pair (emoji) is never halved. That matters because the injected block is a
 * prefix: a broken pair at the cut point poisons everything after it.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateHead(text, maxBytes) {
  if (typeof text !== 'string' || maxBytes <= 0) return ''
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    const isPair = code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
    const length = isPair ? 2 : 1
    const point = isPair ? text.codePointAt(index) : code
    const size = utf8Length(point)
    if (bytes + size > maxBytes) break
    bytes += size
    index += length
  }
  return text.slice(0, index)
}

function utf8Length(codePoint) {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/**
 * Cut text to at most `maxChars` code points.
 *
 * Limits are stated in characters, not bytes, so a Chinese note is not cut
 * three times shorter than an English one. Iterating by code point also keeps
 * surrogate pairs whole.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateChars(text, maxChars) {
  if (typeof text !== 'string' || maxChars <= 0) return ''
  if (text.length <= maxChars) return text

  let count = 0
  let index = 0
  while (index < text.length && count < maxChars) {
    const code = text.charCodeAt(index)
    const isPair = code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
    index += isPair ? 2 : 1
    count += 1
  }
  return text.slice(0, index)
}
