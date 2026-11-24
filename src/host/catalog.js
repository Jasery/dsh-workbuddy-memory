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
 * A row's `injection` is the judgment the prompt makes about the same file
 * (`measureSource`), so the panel calls out exactly the files the prompt cuts
 * and no others. What is cached per file identity (`mtimeMs` + `ctimeMs` +
 * `size`) is the *parse* — everything that does not depend on configuration.
 * The judgment is re-run from that parse on every request, so a settings
 * change shows on the next poll without touching the disk. Content never
 * leaves this module: a row carries the numbers, never the text.
 *
 * A stat-based identity has one blind spot, inherent to the filesystem: two
 * same-size writes inside one timestamp tick carry the same `mtime`/`ctime`.
 * How wide that tick is depends on the filesystem — sub-millisecond on NTFS,
 * ext4 and APFS, a full two seconds on FAT and exFAT. The plugin's own writes
 * never rely on it (`invalidate` runs after each commit); an external edit far
 * enough apart for the filesystem to stamp differently is seen.
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join, resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'
import { memoryLayout } from '../paths.js'
import { parseSections, topSection } from '../markdown.js'
import { readTextSafe } from '../fsx.js'
import { completeSnapshot, MAX_FILE_BYTES } from '../cache.js'
import { measureSource } from '../render.js'
import { analyzeMemory } from '../layers.js'
import { createTranslator, resolveLanguage } from '../locale.js'
import { contentRevision } from '../write/fslock.js'
import { isArchivable } from '../write/archive.js'
import { ageInDays } from '../env.js'

/** Parse results held for re-judging, bounded so a long session cannot grow them without end. */
const MAX_CACHED_BYTES = 8 * 1024 * 1024
const MAX_CACHED_FILES = 512
/**
 * The most the cache ever holds, whatever the working set. Past the soft
 * bounds above it evicts; past these it evicts entries it would rather keep.
 * Twice the soft bound: room for a working set that only just overshoots to
 * stay resident instead of being evicted whole on every poll.
 */
const HARD_CACHED_BYTES = 2 * MAX_CACHED_BYTES
const HARD_CACHED_FILES = 2 * MAX_CACHED_FILES

const NO_FILE = Object.freeze({ exists: false, read: 'missing' })

/**
 * How many flagged projects `/state` carries before it says how many more
 * there are. The preview is what a person scans; the rest is one request away.
 */
export const ATTENTION_PREVIEW = 8

/**
 * The most flagged projects `/state` ever carries, for any value of the
 * `attention` parameter. "All" starts as one click, but the panel then keeps
 * asking for it on every poll (so the list does not shrink back three seconds
 * later), and on a machine with hundreds of flagged projects it was 208 KiB
 * per request (measured at 500), growing without bound. A person scans a page
 * and asks again; `attentionMore` still says what is past the cap.
 */
export const ATTENTION_LIMIT = 200

/**
 * How many flagged projects a request carries, from its `attention` value.
 *
 * `'all'` and any number are clamped to `ATTENTION_LIMIT`; anything that is
 * not a usable positive number — missing, empty, `0`, negative, `Infinity`,
 * `NaN`, text — is the preview bound. A preview of nothing is not a useful
 * reading of "0", and `Infinity` is not a number of projects.
 *
 * @param {string|number|undefined} attention
 * @returns {number}
 */
export function attentionBound(attention) {
  if (attention === undefined || attention === null || attention === '') return ATTENTION_PREVIEW
  if (attention === 'all') return ATTENTION_LIMIT
  const value = Number(attention)
  if (!Number.isFinite(value) || value <= 0) return ATTENTION_PREVIEW
  return Math.min(Math.floor(value), ATTENTION_LIMIT)
}

/**
 * Why a project needs attention, in a stable order. Several at once is the
 * normal case — a long-neglected project is over budget *and* behind on
 * archiving — and listing each reason once keeps the summary counts and the
 * preview telling the same story.
 */
const reasonsOf = (row) => {
  const reasons = []
  if (row.overLimit) reasons.push('over-limit')
  if (row.stale) reasons.push('stale')
  if (!row.exists) reasons.push('missing')
  if (row.injection?.status === 'unmeasurable') reasons.push('unmeasurable')
  return reasons
}

/** Aggregate counters for the global overview, over exactly the rows given. */
export function totalsOf(rows) {
  // A file nobody read whole has no entry count (`null`). Summing it as 0
  // made the total look complete while quietly leaving such files out; the
  // count of them travels beside the sum so the panel can say so.
  const uncounted = rows.filter((row) => row.hasMemory && row.entries === null || row.entries === undefined && row.hasMemory).length
  return {
    projects: rows.length,
    withMemory: rows.filter((row) => row.hasMemory).length,
    entries: rows.reduce((sum, row) => sum + (Number(row.entries) || 0), 0),
    // Memory files whose entries are not in `entries` because nobody measured them.
    entriesUncounted: uncounted,
    dailyFiles: rows.reduce((sum, row) => sum + (row.daily ?? 0), 0),
    // One project, one count, however many entries it lost.
    overLimit: rows.filter((row) => row.overLimit).length,
    stale: rows.filter((row) => row.stale).length,
    missing: rows.filter((row) => row.exists === false).length,
    unmeasurable: rows.filter((row) => row.injection?.status === 'unmeasurable').length,
  }
}

/**
 * The overview that goes with a full, sorted row list: its totals, a bounded
 * preview of the projects that need attention, and how many more of each kind
 * sit past the preview.
 *
 * Exported for the route's recent-only fallback, which has rows without the
 * judgment fields and so gets the same shape with nothing flagged in it.
 */
export function overviewOf(rows, attention) {
  const flagged = rows.filter((row) => reasonsOf(row).length > 0)
  const shown = Math.min(attentionBound(attention), flagged.length)
  const preview = flagged.slice(0, shown).map((row) => ({
    key: row.key,
    name: row.name,
    title: row.title,
    exists: row.exists,
    // Enough for "open" to land on the file a person most likely wants.
    hasMemory: row.hasMemory,
    latestDaily: row.latestDaily,
    oldestDaily: row.oldestDaily,
    oldestDailyAgeDays: row.oldestDailyAgeDays,
    injection: row.injection,
    reasons: reasonsOf(row),
  }))
  // Every kind is always present, so a reader never has to test for a missing
  // key to learn that there is nothing more.
  const attentionMore = { 'over-limit': 0, stale: 0, missing: 0, unmeasurable: 0 }
  for (const row of flagged.slice(shown)) {
    for (const reason of reasonsOf(row)) attentionMore[reason] += 1
  }
  return { totals: totalsOf(rows), attention: preview, attentionTotal: flagged.length, attentionMore }
}

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

/**
 * Count the rows the detail view shows: one per bullet line, including the
 * ones written above the first `##`.
 *
 * The ranges are walked exactly as `/content` walks them — every level-2+
 * section, then the region above the first one — so the overview's "N 条"
 * and the detail page's rows cannot disagree. Counting only `parseSections`
 * used to drop the top bullets: a file whose entries all sat above the first
 * heading read as "0 entries" in the overview while the detail page listed
 * them all.
 */
function countDocumentEntries(text) {
  const lines = text.split(/\r?\n/)
  const bullet = (index) => Boolean(/^[ \t]*[-*][ \t]+\S/.test(lines[index] ?? ''))
  let count = 0
  for (const section of parseSections(text)) {
    for (let index = section.line + 1; index <= section.endLine; index += 1) if (bullet(index)) count += 1
  }
  const top = topSection(text)
  if (top) {
    for (let index = top.line + 1; index <= top.endLine; index += 1) if (bullet(index)) count += 1
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
 * @param {object} deps.cfg - normalized config. Read on every call, never
 *   copied: the host deep-updates this one object in place, and a judgment
 *   made against a stale copy is the bug this module exists to remove.
 * @param {{ seen?: Map<string, number>, cwd?: string|null }} deps.recent
 * @param {() => Array<{ path?: string, title?: string, updatedAt?: string }>} [deps.registry]
 *   Lazy workspace registry reader; called per request so a late service
 *   activation is picked up without a reload.
 * @param {(key: string, vars?: object) => string} [deps.t] - the host translator,
 *   the same one the prompt renders its headings in.
 * @param {(path: string, options: object) => object} [deps.read] - bounded file
 *   reader; `readTextSafe` unless a test wants to count the reads.
 */
export function createProjectCatalog({ cfg, recent, registry, t = createTranslator(resolveLanguage(cfg.locale)), read = readTextSafe }) {
  /** path → { stamp, held, meta, pass }, least recently used first. */
  const stats = new Map()
  let heldBytes = 0
  /** Bumped at the start of every `list()`: tells an entry read in this pass from an older one. */
  let pass = 0

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

  /**
   * Keep one parse.
   *
   * Two bounds, because one bound thrashes. The soft bound is where the
   * least recently used entries start going; the hard bound is where they
   * must. With a single bound, a working set just over it (six files of
   * 1.5 MiB against 8 MiB) evicted the oldest entry for every insert and so
   * re-read, re-hashed and re-parsed every file on every poll — a regression
   * against the unbounded cache this replaced, and exactly the cost the
   * cache exists to avoid. Between the bounds the cache is allowed to be
   * over its soft size; what a person gets is a slower poll on a machine
   * that genuinely carries that much memory, instead of a fast poll that
   * So eviction only ever removes an entry from an *earlier* pass than the
   * one inserting. A pass is one `list()` — it visits every project — so an
   * entry read in this pass is one the next poll will want, and evicting it
   * buys nothing. Past the hard bound the cache takes that loss anyway,
   * because it is a promise about memory.
   */
  function remember(path, entry) {
    const old = stats.get(path)
    if (old) {
      heldBytes -= old.held
      stats.delete(path)
    }
    stats.set(path, { ...entry, pass })
    heldBytes += entry.held
    // One eviction. With `oldestOnly`, only an entry from an earlier pass
    // is eligible; the entries are stored oldest first, so the first one
    // found is the least recently used.
    const evict = (oldestOnly) => {
      for (const [key, candidate] of stats) {
        if (oldestOnly && candidate.pass >= pass) continue
        heldBytes -= candidate.held
        stats.delete(key)
        return true
      }
      return false
    }
    while (heldBytes > MAX_CACHED_BYTES || stats.size > MAX_CACHED_FILES) {
      if (!evict(true)) break
    }
    while (heldBytes > HARD_CACHED_BYTES || stats.size > HARD_CACHED_FILES) {
      if (!evict(false)) break
    }
  }

  /**
   * Everything about one memory file that does not depend on configuration.
   *
   * Read whole and bounded, exactly as the prompt reads it: a file past the
   * cap is *not* described from its prefix — a prefix can hide the core
   * heading, or a second one — but reported as unmeasured, with no length.
   *
   * `file` is for `measureSource` and never leaves this module: it carries
   * the text and its parse.
   */
  function memoryStats(path) {
    const stat = statSafe(path)
    if (!stat) return { exists: false, bytes: 0, chars: null, entries: null, revision: null, mtime: null, file: NO_FILE }
    const mtime = stat.mtimeMs
    if (!stat.isFile()) return { exists: true, bytes: stat.size, chars: null, entries: null, revision: null, mtime, file: { exists: true, read: 'not_a_file' } }

    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
    const cached = stats.get(path)
    if (cached && cached.stamp === stamp) {
      // Re-inserted so it is the most recently used, and stamped with this
      // pass so eviction will not take an entry the current list() just read.
      stats.delete(path)
      const touched = { ...cached, pass }
      stats.set(path, touched)
      return touched.meta
    }

    // A file the stat already puts past the cap is not read at all.
    const raw = stat.size > MAX_FILE_BYTES ? { ok: true, truncated: true, text: '', bytes: stat.size } : read(path, { maxBytes: MAX_FILE_BYTES })
    const snapshot = completeSnapshot(raw)
    if (!snapshot.ok) {
      // A failure is a result of *this* read, not a fact about the file, so
      // it is not cached. A sharing violation during an editor save makes
      // exactly one read fail; the prompt's fileCache never caches it and
      // injects the file normally on the next turn, and the panel has to
      // recover on the same terms instead of saying "cannot measure" until
      // the file changes. (A file past the cap lands here too, and is
      // re-decided from `stat.size` above without a read — cheap.)
      return { exists: true, bytes: snapshot.bytes || stat.size, chars: null, entries: null, revision: null, mtime, file: { exists: true, read: snapshot.reason } }
    }
    const meta = {
      exists: true,
      bytes: snapshot.bytes,
      chars: snapshot.text.length,
      entries: countDocumentEntries(snapshot.text),
      revision: contentRevision(snapshot.text),
      mtime,
      file: { exists: true, read: 'ok', text: snapshot.text, parsed: analyzeMemory(snapshot.text) },
    }
    remember(path, { stamp, held: snapshot.bytes, meta })
    return meta
  }

  function describe(seed, { home, dataFolderName, current }) {
    const layout = memoryLayout({ home, cwd: seed.path, dataFolderName })
    const memory = memoryStats(layout.projectMemory)
    const daily = listDaily(layout.projectMemoryDir)
    const missing = !statSafe(seed.path)
    const injection = measureSource({ cfg, t, key: 'project', file: memory.file })
    // `overLimit` and `status` remain as projections of `injection` for callers
    // written against the first panel; the panel itself reads `injection`.
    const overLimit = injection.overLimit
    // The same boundary the default archive preview uses, so "to archive"
    // here and the dialog's first list are the same files.
    const stale = isArchivable(daily.oldestAgeDays)
    const status = missing
      ? 'missing'
      : injection.status === 'unmeasurable'
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
      // `null` when the file could not be read whole: a length nobody measured
      // is not a length of zero.
      entries: memory.entries,
      bytes: memory.bytes,
      chars: memory.chars,
      revision: memory.revision,
      mtime: memory.mtime,
      injection,
      overLimit,
      stale,
      status,
    }
  }

  /**
   * Every known project, current first, then most recently active.
   *
   * The totals and the attention preview are taken over *all* the rows, before
   * the display bound is applied. Summing the rows returned instead made the
   * overview contradict itself past `ui.maxProjects`: "60 projects, 1 over
   * limit" beside a "needs attention" list that could not contain the one.
   *
   * @param {object} input
   * @param {string} input.home - WorkBuddy home.
   * @param {string} input.dataFolderName - per-workspace memory folder name.
   * @param {string|null} [input.current] - the live session cwd.
   * @param {number} [input.limit] - display bound.
   * @param {number|'all'} [input.attention] - how many flagged projects the
   *   preview carries; `'all'` for the whole list.
   * @returns {{ rows: object[], truncated: boolean, total: number, totals: object, attention: object[], attentionTotal: number, attentionMore: Record<string, number> }}
   */
  function list({ home, dataFolderName, current = recent?.cwd ?? null, limit = cfg.ui.maxProjects, attention }) {
    // A new pass: nothing read from here on is eligible for eviction until
    // the next one (see `remember`).
    pass += 1
    const rows = [...seeds().values()].map((seed) => describe(seed, { home, dataFolderName, current }))
    rows.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      const byActive = (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
      if (byActive !== 0) return byActive
      return a.name.localeCompare(b.name)
    })
    const bound = Math.max(1, Number(limit) || cfg.ui.maxProjects)
    return { rows: rows.slice(0, bound), truncated: rows.length > bound, total: rows.length, ...overviewOf(rows, attention) }
  }

  /**
   * Resolve a project key back to a path.
   *
   * The key is only honoured for a path this catalog listed: the set is finite
   * and lived, so a stale or hostile key cannot address an arbitrary directory.
   * It resolves against every known project, not only the rows `list` returned:
   * a project past the display bound is still one the panel may open.
   */
  function resolveKey(key, options) {
    if (!key) return null
    for (const seed of seeds().values()) {
      if (projectKey(seed.path) !== key) continue
      return describe(seed, { home: options.home, dataFolderName: options.dataFolderName, current: options.current })
    }
    return null
  }

  /** Drop cached stats after a write so the next poll sees the new revision. */
  function invalidate() {
    stats.clear()
    heldBytes = 0
  }

  return { list, resolve: resolveKey, invalidate, keyFor: projectKey, pathIdentity }
}
