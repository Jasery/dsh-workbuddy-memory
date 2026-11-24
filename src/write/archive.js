/**
 * Archive preview plans and the small filesystem facts an apply needs.
 *
 * A preview must be free: scanning a project's daily notes may not create the
 * state directory, the archive directory, or a receipt. The plan therefore
 * lives only in memory, bounded to 100 plans and ten minutes. The apply path
 * persists its own copy of the manifest in a receipt before moving anything, so
 * a crash or restart resumes from that manifest instead of an expired preview.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ageInDays } from '../env.js'
import { readTextSafe } from '../fsx.js'
import { allEntries } from '../markdown.js'
import { contentRevision } from './fslock.js'

export const PLAN_LIMITS = Object.freeze({
  maxPlans: 100,
  ttlMs: 10 * 60 * 1000,
  maxFiles: 1000,
})

/**
 * How old, in whole days, a daily note must be before the *default* archive
 * preview picks it up.
 *
 * One number for every place that used to hard-code its own 30: the archive
 * scan (a note is a candidate from this age on), the overview's "to archive"
 * count, the route's fallback and the panel's opening value. They disagreed by
 * a day — the scan took a note at exactly 30 days, the overview flagged it only
 * at 31 — so a file could be archived by the default preview while the panel
 * said there was nothing to archive.
 *
 * It is a constant, not a setting, on purpose: nothing has asked to tune it.
 */
export const ARCHIVE_AFTER_DAYS = 30

/**
 * Whether a note of `ageDays` falls inside a preview of `beforeDays`.
 *
 * The one boundary both halves of the plugin share: a preview lists a note
 * exactly when this says so, and the overview flags a project exactly when its
 * oldest note does. `null` (an unparseable date) is never a candidate.
 *
 * @param {number|null} ageDays
 * @param {number} [beforeDays]
 */
export const isArchivable = (ageDays, beforeDays = ARCHIVE_AFTER_DAYS) =>
  ageDays !== null && Number.isFinite(beforeDays) && ageDays >= beforeDays

const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/

/** Bounded in-memory registry for preview plans. */
export function createPlanStore({ now = () => Date.now() } = {}) {
  const plans = new Map()

  function sweep(at = now()) {
    for (const [id, plan] of plans) {
      if (at > plan.expiresAt) plans.delete(id)
    }
    while (plans.size >= PLAN_LIMITS.maxPlans) {
      const oldest = plans.keys().next().value
      plans.delete(oldest)
    }
  }

  function put(plan) {
    sweep()
    plans.set(plan.planId, plan)
    return plan
  }

  function get(planId) {
    if (!planId) return null
    // An expired plan is still returned so the caller can distinguish
    // "expired" (plan_conflict) from "never existed" (plan_required).
    return plans.get(String(planId)) ?? null
  }

  return { put, get }
}

/** Build a plan id: random, never derived from a path or a date list. */
export function newPlanId() {
  return randomUUID()
}

/**
 * List the daily files that match the preview's selector.
 *
 * A file that cannot be read in full is still listed — hiding it would make the
 * preview look complete when it is not — but its revision is `null`, and an
 * apply refuses to move a candidate without a verified revision.
 */
export function scanCandidates(dir, { beforeDays, dates } = {}) {
  if (!dir) return { ok: false, code: 'no_store' }
  let names = []
  try {
    names = readdirSync(dir).filter((name) => DATE_FILE.test(name))
  } catch {
    return { ok: false, code: 'no_store', dir }
  }

  const wanted = Array.isArray(dates) && dates.length > 0 ? new Set(dates.map(String)) : null
  const candidates = []
  for (const name of names.sort()) {
    const date = name.slice(0, 10)
    if (wanted ? !wanted.has(date) : !isArchivable(ageInDays(date), beforeDays)) continue
    const file = readTextSafe(join(dir, name), { maxBytes: MAX_SOURCE_BYTES })
    const readable = file.ok && !file.truncated
    candidates.push({
      date,
      name,
      bytes: file.ok ? file.bytes : 0,
      entries: readable ? allEntries(file.text).length : 0,
      revision: readable ? contentRevision(file.text) : null,
      error: readable ? null : file.truncated ? 'too_large' : file.error ?? 'unreadable',
    })
  }
  return { ok: true, candidates }
}

/**
 * A deterministic, currently free archive path for one date.
 *
 * The first apply persists the chosen path in its receipt. On resume the stored
 * path is used; this helper is only for a fresh manifest, so a retry never
 * invents a second target for the same date.
 */
export function nextArchivePath(archiveDir, date) {
  let candidate = join(archiveDir, `${date}.md`)
  if (!existsSync(candidate)) return candidate
  for (let n = 1; n < 10000; n += 1) {
    candidate = join(archiveDir, `${date}-${n}.md`)
    if (!existsSync(candidate)) return candidate
  }
  return null
}

/** Read one source for a move, refusing a partial or oversized snapshot. */
export function readMoveSource(path) {
  const file = readTextSafe(path, { maxBytes: MAX_SOURCE_BYTES })
  if (!file.ok) return { ok: false, code: file.error === 'too_large' ? 'too_large' : 'unreadable', error: file.error }
  if (file.truncated) return { ok: false, code: 'too_large', error: 'truncated' }
  return { ok: true, text: file.text, bytes: file.bytes, revision: contentRevision(file.text) }
}
