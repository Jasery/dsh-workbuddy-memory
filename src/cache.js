/**
 * Caches that keep the injected prefix stable without re-reading the disk.
 *
 * Two levels:
 *  - per-assembly: the same `AssembleContext` object reaches every section
 *    provider, so one probe serves all four blocks instead of four stats.
 *  - across assemblies: file text is reused while `mtime + size` are unchanged,
 *    which is what makes `refresh: on-change` cheap and `first-turn` free.
 */

import { statSafe } from './fsx.js'
import { readFileSync } from 'node:fs'

/** File text keyed by path, invalidated by `mtime + size`. */
export function createFileCache() {
  /** @type {Map<string, { mtimeMs: number, size: number, text: string }>} */
  const files = new Map()

  return {
    /**
     * Read a file, reusing the previous text when the stat is unchanged.
     *
     * @param {string} path
     * @returns {string} the file text, or `''` when unreadable.
     */
    read(path) {
      if (!path) return ''
      const stat = statSafe(path)
      if (!stat || !stat.isFile) return ''
      const hit = files.get(path)
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text
      let text = ''
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return ''
      }
      files.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text })
      return text
    },

    /** Drop one path (after this plugin writes it). */
    invalidate(path) {
      if (path) files.delete(path)
    },

    clear() {
      files.clear()
    },

    get size() {
      return files.size
    },
  }
}

/**
 * Cache one computed value per assembly context object.
 *
 * The context object lives for exactly one assembly, so entries are collected
 * with it; a provider that runs twice in the same assembly reuses the probe.
 */
export function createAssemblyCache() {
  /** @type {WeakMap<object, unknown>} */
  const entries = new WeakMap()

  return {
    /**
     * @template T
     * @param {object} context - the assemble context.
     * @param {() => T} compute
     * @returns {T}
     */
    get(context, compute) {
      if (!context || typeof context !== 'object') return compute()
      if (entries.has(context)) return /** @type {T} */ (entries.get(context))
      const value = compute()
      entries.set(context, value)
      return value
    },
  }
}

/**
 * Freeze the rendered sections once, for `refresh: first-turn`.
 *
 * Keyed by workspace so two sessions in different projects do not share text.
 */
export function createFrozenStore() {
  /** @type {Map<string, unknown>} */
  const entries = new Map()
  return {
    get(key, compute) {
      if (entries.has(key)) return entries.get(key)
      const value = compute()
      entries.set(key, value)
      return value
    },
    invalidate(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
  }
}
