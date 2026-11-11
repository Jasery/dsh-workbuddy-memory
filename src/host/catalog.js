/**
 * The project catalog behind the panel's global view.
 *
 * A "project" is a workspace path, not a session: several sessions share one
 * memory folder, and a workspace the user registered in DSH deserves to appear
 * even when this plugin has never assembled a prompt for it. Two sources are
 * merged, newest metadata wins:
 *
 *  - `workspaceRegistry.list()` — every durable workspace DSH knows about.
 *  - `recent.seen` — workspaces this plugin actually saw, including folders the
 *    user never registered as a workspace. Kept as a fallback and a bridge for
 *    hosts without the registry service.
 *
 * Nothing here walks the disk looking for `.workbuddy`: a recursive scan would
 * cross permissions and symlinks for no gain when the host already owns the
 * authoritative list.
 *
 * Stats are cached per file identity (`mtimeMs` + `size`), so a panel polling
 * every few seconds stats files instead of re-reading them. Only counts leave
 * this module; entry text stays behind `/content`.
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join, resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'
import { memoryLayout } from '../paths.js'
import { parseSections } from '../markdown.js'
import { readTextSafe } from '../fsx.js'
import { contentRevision } from '../write/fslock.js'
import { ageInDays } from '../env.js'

/** A memory file larger than this is described by its size alone. */
const MAX_PARSE_BYTES = 262144

/** Stable, non-reversible handle for a workspace path. */
export function projectKey(path) {
  return createHash('sha1').update(String(path)).digest('hex').slice(0, 8)
}

function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** Path identity: Windows folds case, every platform folds separators. */
function pathIdentity(path) {
  const normalized = resolvePath(String(path)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Count bullets inside level-2+ sections, the same rows the detail view shows. */
function countDocumentEntries(text) {
  const lines = text.split(/\r?\n/)
  let count = 0
  for (const section of parseSections(text)) {
    for (let index = section.line + 1; index <= section.endLine; index += 1) {
      if (/^[ \t]*[-*][ \t]+\S/.test(lines[index] ?? '')) count += 1
    }
  }
  return count
}

function listDaily(dir) {
  if (!dir) return { count: 0, latestDate: null, latestBytes: 0, oldestDate: null, oldestAgeDays: null }
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return { count: 0, latestDate: null, latestBytes: 0, oldestDate: null, oldestAgeDays: null }
  }
  const dates = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).map((name) => name.slice(0, 10)).sort()
  if (dates.length === 0) return { count: 0, latestDate: null, latestBytes: 0, oldestDate: null, oldestAgeDays: null }
  const latestDate = dates[dates.length - 1]
  const oldestDate = dates[0]
  return {
    count: dates.length,
    latestDate,
    latestBytes: statSafe(join(dir, `${latestDate}.md`))?.size ?? 0,
    oldestDate,
    oldestAgeDays: ageInDays(oldestDate),
  }
}

/**
 * Create the catalog.
 *
 * @param {object} deps
 * @param {object} deps.cfg - normalized config.
 * @param {{ seen?: Map<string, number>, cwd?: string|null }} deps.recent
 * @param {() => Array<{ path?: string, title?: string, updatedAt?: string }>} [deps.registry]
 *   Lazy workspace registry reader; called per request so a late service
 *   activation is picked up without a reload.
 */
export function createProjectCatalog({ cfg, recent, registry }) {
  /** path identity → { stamp, memory, daily } */
  const stats = new Map()

  function registryRows() {
    try {
      const rows = typeof registry === 'function' ? registry() : []
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /** Merge both sources into one path-keyed map, preserving workspace metadata. */
  function seeds() {
    const rows = new Map()
    for (const workspace of registryRows()) {
      if (!workspace || typeof workspace.path !== 'string' || !workspace.path) continue
      const path = resolvePath(workspace.path)
      rows.set(pathIdentity(path), {
        path,
        title: typeof workspace.title === 'string' ? workspace.title : '',
        source: 'workspace',
        updatedAt: typeof workspace.updatedAt === 'string' ? workspace.updatedAt : null,
        lastSeenAt: null,
      })
    }

    const seen = recent?.seen instanceof Map ? [...recent.seen.entries()] : []
    for (const [cwd, at] of seen) {
      if (typeof cwd !== 'string' || !cwd) continue
      const path = resolvePath(cwd)
      const key = pathIdentity(path)
      const row = rows.get(key)
      if (row) {
        row.lastSeenAt = typeof at === 'number' ? at : null
      } else {
        rows.set(key, { path, title: '', source: 'recent', updatedAt: null, lastSeenAt: typeof at === 'number' ? at : null })
      }
    }

    if (typeof recent?.cwd === 'string' && recent.cwd) {
      const path = resolvePath(recent.cwd)
      const key = pathIdentity(path)
      if (!rows.has(key)) rows.set(key, { path, title: '', source: 'recent', updatedAt: null, lastSeenAt: Date.now() })
    }
    return rows
  }

  /** Count entries without exposing the text. Re-parsed only when the file changes. */
  function memoryStats(path) {
    const stat = statSafe(path)
    if (!stat || !stat.isFile()) {
      return { exists: false, bytes: 0, chars: 0, entries: 0, revision: null, mtime: null, unreadable: false }
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    const cached = stats.get(path)
    if (cached && cached.stamp === stamp) return cached.memory

    const file = readTextSafe(path, { maxBytes: MAX_PARSE_BYTES })
    const memory = file.ok
      ? {
          exists: true,
          bytes: file.bytes,
          chars: file.text.length,
          entries: countDocumentEntries(file.text),
          revision: file.truncated ? null : contentRevision(file.text),
          mtime: stat.mtimeMs,
          unreadable: false,
        }
      : { exists: true, bytes: stat.size, chars: 0, entries: 0, revision: null, mtime: stat.mtimeMs, unreadable: true }
    stats.set(path, { ...(cached ?? {}), stamp, memory })
    return memory
  }

  function describe(seed, { home, dataFolderName, limits, current }) {
    const layout = memoryLayout({ home, cwd: seed.path, dataFolderName })
    const memory = memoryStats(layout.projectMemory)
    const daily = listDaily(layout.projectMemoryDir)
    const missing = !statSafe(seed.path)
    const overLimit = Boolean(limits?.project) && memory.chars > limits.project
    const stale = daily.oldestAgeDays !== null && daily.oldestAgeDays > 30
    const status = missing
      ? 'missing'
      : memory.unreadable
        ? 'unreadable'
        : overLimit
          ? 'over-limit'
          : stale
            ? 'stale'
            : !memory.exists && daily.count > 0
              ? 'daily-only'
              : !memory.exists
                ? 'empty'
                : 'ok'
    const updatedAt = seed.updatedAt ? Date.parse(seed.updatedAt) : null
    const lastActiveAt = Math.max(updatedAt ?? 0, seed.lastSeenAt ?? 0, memory.mtime ?? 0) || null
    return {
      key: projectKey(seed.path),
      path: seed.path,
      name: basename(seed.path) || seed.path,
      title: seed.title || '',
      source: seed.source,
      current: current ? pathIdentity(current) === pathIdentity(seed.path) : false,
      lastSeenAt: seed.lastSeenAt,
      lastActiveAt,
      exists: !missing,
      hasMemory: memory.exists,
      daily: daily.count,
      latestDaily: daily.latestDate,
      latestDailyBytes: daily.latestBytes,
      oldestDaily: daily.oldestDate,
      oldestDailyAgeDays: daily.oldestAgeDays,
      entries: memory.entries,
      bytes: memory.bytes,
      chars: memory.chars,
      revision: memory.revision,
      mtime: memory.mtime,
      overLimit,
      stale,
      status,
    }
  }

  /**
   * Every known project, current first, then most recently active.
   *
   * @param {object} input
   * @param {string} input.home - WorkBuddy home.
   * @param {string} input.dataFolderName - per-workspace memory folder name.
   * @param {object} [input.limits] - injection limits, used for `overLimit`.
   * @param {string|null} [input.current] - the live session cwd.
   * @param {number} [input.limit] - display bound.
   * @returns {{ rows: object[], truncated: boolean, total: number }}
   */
  function list({ home, dataFolderName, limits, current = recent?.cwd ?? null, limit = cfg.ui.maxProjects }) {
    const rows = [...seeds().values()].map((seed) => describe(seed, { home, dataFolderName, limits, current }))
    rows.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      const byActive = (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
      if (byActive !== 0) return byActive
      return a.name.localeCompare(b.name)
    })
    const bound = Math.max(1, Number(limit) || cfg.ui.maxProjects)
    return { rows: rows.slice(0, bound), truncated: rows.length > bound, total: rows.length }
  }

  /**
   * Resolve a project key back to a path.
   *
   * The key is only honoured for a path this catalog listed: the set is finite
   * and lived, so a stale or hostile key cannot address an arbitrary directory.
   */
  function resolveKey(key, options) {
    if (!key) return null
    for (const seed of seeds().values()) {
      if (projectKey(seed.path) !== key) continue
      return describe(seed, {
        home: options.home,
        dataFolderName: options.dataFolderName,
        limits: options.limits,
        current: options.current,
      })
    }
    return null
  }

  /** Drop cached stats after a write so the next poll sees the new revision. */
  function invalidate() {
    stats.clear()
  }

  return { list, resolve: resolveKey, invalidate, keyFor: projectKey, pathIdentity }
}
