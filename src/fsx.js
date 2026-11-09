/** Small filesystem helpers shared by the probe, the snapshot cache and the tools. */

import { accessSync, constants, readFileSync, statSync } from 'node:fs'

/** `stat` that reports failure instead of throwing. */
export function statSafe(path) {
  if (!path) return null
  try {
    const stat = statSync(path)
    return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile(), isDirectory: stat.isDirectory() }
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
 * @param {string} path - absolute path.
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ ok: boolean, text: string, bytes: number, mtimeMs: number, truncated: boolean, error?: string }}
 */
export function readTextSafe(path, options = {}) {
  const empty = { ok: false, text: '', bytes: 0, mtimeMs: 0, truncated: false }
  if (!path) return { ...empty, error: 'no_path' }
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { ...empty, error: 'not_a_file' }
    let text = readFileSync(path, 'utf8')
    let truncated = false
    const maxBytes = options.maxBytes
    if (typeof maxBytes === 'number' && maxBytes > 0 && stat.size > maxBytes) {
      // Slice on a character boundary so the tail is valid UTF-8.
      text = truncateHead(text, maxBytes)
      truncated = true
    }
    return { ok: true, text, bytes: stat.size, mtimeMs: stat.mtimeMs, truncated }
  } catch (error) {
    return { ...empty, error: error?.code ?? String(error) }
  }
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
