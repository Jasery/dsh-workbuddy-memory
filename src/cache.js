import { readTextSafe, statSafe } from './fsx.js'
import { resolve } from 'node:path'

const MAX_FILES = 64
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
/**
 * The largest memory file that is ever read whole — by the prompt and by the
 * panel alike, so the two cannot disagree about whether a file was seen in
 * full.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Read one bounded read as "the whole file, or the reason there is none".
 *
 * `readTextSafe` reports a half-dozen outcomes; a caller that must have the
 * complete file (the prompt, which refuses to inject a prefix, and the panel,
 * which cannot judge a file it only saw the start of) needs them as one
 * answer. Keeping the mapping here means both callers refuse a file on the
 * same terms.
 *
 * @param {ReturnType<typeof readTextSafe>} file
 * @returns {{ ok: true, text: string, bytes: number } | { ok: false, reason: 'missing'|'not_a_file'|'too_large'|'changed'|'unreadable', bytes: number }}
 */
export function completeSnapshot(file) {
  if (file?.ok && !file.truncated && typeof file.text === 'string') return { ok: true, text: file.text, bytes: file.bytes }
  const bytes = Number(file?.bytes) || 0
  if (file?.ok) return { ok: false, reason: 'too_large', bytes }
  const code = String(file?.error ?? '')
  if (code === 'ENOENT') return { ok: false, reason: 'missing', bytes }
  if (code === 'not_a_file' || code === 'EISDIR') return { ok: false, reason: 'not_a_file', bytes }
  if (code === 'changed') return { ok: false, reason: 'changed', bytes }
  return { ok: false, reason: 'unreadable', bytes }
}

/** Bounded file snapshots; metadata changes invalidate the cached text. */
export function createFileCache() {
  const files = new Map()
  let totalBytes = 0
  const drop = (key) => {
    const old = files.get(key)
    if (old) totalBytes -= old.bytes
    files.delete(key)
  }
  return {
    read(path) {
      if (!path) return ''
      const key = resolve(path)
      const stat = statSafe(key)
      if (!stat?.isFile || stat.size > MAX_FILE_BYTES) {
        drop(key)
        return ''
      }
      const hit = files.get(key)
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.ctimeMs === stat.ctimeMs && hit.size === stat.size) {
        files.delete(key)
        files.set(key, hit)
        return hit.text
      }
      drop(key)
      const snapshot = completeSnapshot(readTextSafe(key, { maxBytes: MAX_FILE_BYTES }))
      if (!snapshot.ok) return ''
      const after = statSafe(key)
      if (!after?.isFile || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.size !== stat.size) return ''
      const text = snapshot.text
      const bytes = snapshot.bytes
      if (bytes > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) return ''
      while (files.size >= MAX_FILES || totalBytes + bytes > MAX_TOTAL_BYTES) drop(files.keys().next().value)
      files.set(key, { mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, size: after.size, bytes, text })
      totalBytes += bytes
      return text
    },
    invalidate(path) { if (path) drop(resolve(path)) },
    clear() { files.clear(); totalBytes = 0 },
    get size() { return files.size },
    get bytes() { return totalBytes },
  }
}

export function createAssemblyCache() {
  const entries = new WeakMap()
  return {
    get(context, compute) {
      if (!context || typeof context !== 'object') return compute()
      if (entries.has(context)) return entries.get(context)
      const value = compute()
      entries.set(context, value)
      return value
    },
  }
}

export function createFrozenStore() {
  const entries = new Map()
  return {
    get(key, compute) { if (entries.has(key)) return entries.get(key); const value = compute(); entries.set(key, value); return value },
    invalidate(key) { entries.delete(key) },
    clear() { entries.clear() },
  }
}
