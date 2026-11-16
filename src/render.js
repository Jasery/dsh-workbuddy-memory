import { readTextSafe, truncateChars, truncateUtf16 } from './fsx.js'
import { analyzeMemory } from './layers.js'

export const SECTION_ORDER = { project: 200, rules: 210, user: 220, profile: 230 }

/**
 * States that mean "this source did what it was asked to do".
 *
 * Everything else — a legacy fallback, an over-budget core, a truncated topic
 * list — is something the model or the user needs to know about, because the
 * block in front of them is not the whole story. `ambiguous` is normal here
 * because it already gets its own explicit line in the topic directory.
 */
const NORMAL_STATES = new Set(['layered', 'full', 'enabled', 'disabled', 'unavailable', 'read-only-entry', 'ambiguous'])

/** Whether a state says the injected text is a subset or a fallback. */
export const isAbnormalState = (state) => !NORMAL_STATES.has(String(state))

/** Whether a source fell back to whole-file injection, which makes the mode mixed. */
const isLegacy = (state) => String(state).startsWith('legacy:')

export function renderSections({ cfg, probe, t, readFile }) {
  const sections = []
  const states = {}
  const read = readFile ?? ((path, maxBytes = 2 * 1024 * 1024) => {
    const file = readTextSafe(path, { maxBytes })
    return file.ok && !file.truncated ? file.text : ''
  })
  const sanitize = cfg.inject.sanitizePaths ? (text) => redact(text, probe.layout.home) : (text) => text
  const layered = cfg.inject.mode === 'layered'
  const source = (key, label, path, enabled) => {
    if (!enabled || !path) { states[key] = 'disabled'; return }
    const raw = read(path)
    if (!raw.trim()) { states[key] = 'unavailable'; return }
    if (!layered) {
      const limit = cfg.inject.limits[key]
      if (!(limit > 0)) { states[key] = 'disabled'; return }
      const block = renderFileBlock({ label, raw, limit, sanitize, t })
      if (block) sections.push({ name: `workbuddy-memory:${key}`, order: SECTION_ORDER[key], text: block })
      states[key] = 'full'
      return
    }
    if (!(cfg.inject.limits[key] > 0)) { states[key] = 'disabled'; return }
    const parsed = analyzeMemory(raw)
    if (parsed.mode === 'legacy') {
      const limit = cfg.inject.limits[key]
      const block = renderFileBlock({ label, raw, limit, sanitize, t })
      if (block) sections.push({ name: `workbuddy-memory:${key}`, order: SECTION_ORDER[key], text: block })
      states[key] = `legacy:${parsed.reason}`
      return
    }
    const budget = Math.floor(cfg.inject.coreBudget * 0.375)
    const prefix = `### ${label}\n\n`
    const core = renderEntries(parsed.coreEntries, `## ${t('coreHeading')}`, Math.max(0, budget - prefix.length), t)
    const text = sanitize(`${prefix}${core.text}`)
    sections.push({ name: `workbuddy-memory:${key}`, order: SECTION_ORDER[key], text })
    // An over-budget core is not a normal state: the model has to know that the
    // entries it can read are a prefix, not the whole file.
    states[key] = core.dropped > 0 ? `layered:core-over-budget(${core.dropped})` : 'layered'
    return parsed.topics.map((topic) => topic.heading ?? t('unsectioned'))
  }

  const projectTopics = cfg.inject.project && probe.project.memoryExists
    ? source('project', t('section.project'), probe.project.memoryPath, true) : (states.project = 'disabled', [])
  const userTopics = cfg.inject.user && probe.user.memoryExists
    ? source('user', t('section.user'), probe.user.memoryPath, true) : (states.user = 'disabled', [])

  if (cfg.inject.rules && cfg.inject.limits.rules > 0) {
    const rules = t(layered ? (cfg.readOnly ? 'compactRulesReadOnly' : 'compactRules') : (cfg.readOnly ? 'rulesReadOnly' : 'rules'))
    const lines = Array.isArray(rules) ? rules : []
    if (lines.length) {
      const budget = layered ? Math.floor(cfg.inject.coreBudget * 0.125) : cfg.inject.limits.rules
      const base = `### ${t('section.rules')}\n\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`
      const hint = layered ? '' : cfg.readOnly ? '' : distillHint({ cfg, probe, t })
      const text = layered ? fitText(base, budget).text : `${truncateChars(base, Math.max(0, budget - hint.length))}${hint}`
      sections.push({ name: 'workbuddy-memory:rules', order: SECTION_ORDER.rules, text })
      states.rules = 'enabled'
    }
  } else states.rules = 'disabled'

  let profileTopics = []
  if (!cfg.inject.profile || cfg.inject.limits.profile === 0) states.profile = 'disabled'
  else if (probe.profile.ambiguous) {
    if (!layered) sections.push({ name: 'workbuddy-memory:profile', order: SECTION_ORDER.profile, text: `### ${t('section.profile')}\n\n${t('ambiguousProfile')}` })
    states.profile = 'ambiguous'
  } else if (probe.profile.exists && probe.profile.path) {
    if (!layered) {
      const raw = read(probe.profile.path)
      const block = renderFileBlock({ label: t('section.profile'), raw, limit: cfg.inject.limits.profile, sanitize, t })
      if (block) sections.push({ name: 'workbuddy-memory:profile', order: SECTION_ORDER.profile, text: block })
      states.profile = 'full'
    } else {
      states.profile = 'read-only-entry'
      profileTopics = [t('profileEntry')]
    }
  } else states.profile = 'unavailable'

  if (layered) {
    const extra = [...(projectTopics ?? []), ...(userTopics ?? []), ...profileTopics]
    // A compatibility note is a non-normal state, not only a `legacy:` one: an
    // over-budget core also means the model is reading a subset.
    const warnings = Object.entries(states).filter(([, state]) => !NORMAL_STATES.has(state)).map(([key, state]) => `${key}=${state}`)
    const entries = []
    if (warnings.length) entries.push(`${t('compatibility')}: ${warnings.join(', ')}`)
    if (cfg.inject.profile && cfg.inject.limits.profile > 0 && probe.profile.ambiguous) entries.push(t('ambiguousProfile'))
    // Sanitize before measuring: redaction only shortens, so the budget still
    // holds, and a home path must not reach the prompt through a topic heading.
    for (const topic of [...new Set(extra)]) entries.push(`${t('topicDirectory')}: ${sanitize(topic)}`)
    const budget = Math.floor(cfg.inject.coreBudget * 0.125)
    const tail = entries.length ? fitText(`### ${t('topicDirectory')}\n\n${entries.join('\n')}`, budget, { notice: t('directoryMore') }) : { text: '', dropped: 0 }
    if (tail.text) {
      // A partial topic list has to say so: an 11-of-40 list read as the whole
      // list is the same "written but invisible" failure as an over-budget core.
      states.directory = tail.dropped > 0 ? `directory-truncated(${tail.dropped})` : 'enabled'
      sections.push({ name: 'workbuddy-memory:profile', order: SECTION_ORDER.profile, text: tail.text })
    }
  }
  sections.sort((left, right) => left.order - right.order)
  sections.states = states
  sections.mode = layered ? (Object.values(states).some(isLegacy) ? 'mixed' : 'layered') : 'full'
  return sections
}

/**
 * Render a whole file under its own limit, in UTF-16 code units.
 *
 * Every number here — `prefix.length`, `room`, `note.length`, and the cut
 * itself — has to be in the same unit, because the limit is declared in code
 * units and compared against `text.length` afterwards. Counting the body in
 * code points while measuring the wrapper in code units let an emoji-heavy
 * legacy file overflow the very limit this function exists to enforce.
 *
 * A limit too small to say anything in yields no block at all. The shape that
 * must never appear is a fragment of the first heading — `### Project memory\n\n## `
 * reads like a corrupted file rather than like a limit that is too small to
 * speak in. A cut inside ordinary body text is still allowed: a partial entry
 * followed by the truncation note is honest, and the caller records the reason
 * in its state either way.
 *
 * @returns {string} the block, or '' when it contributes nothing.
 */
function renderFileBlock({ label, raw, limit, sanitize, t }) {
  if (!raw?.trim() || !(limit > 0)) return ''
  const body = raw.trim()
  const prefix = `### ${label}\n\n`
  if (prefix.length >= limit) return ''
  const room = limit - prefix.length
  let kept = truncateUtf16(body, room)
  if (cutsFirstHeading(body, kept)) return ''
  let note = ''
  if (kept.length < body.length) {
    const candidate = `\n\n_${t('truncated', { limit })}_`
    if (candidate.length <= room) {
      note = candidate
      kept = truncateUtf16(body, room - note.length)
      if (cutsFirstHeading(body, kept)) return ''
    }
  }
  return `${prefix}${sanitize(kept)}${note}`
}

/**
 * Whether `kept` stops partway through a first line that is a heading.
 *
 * That is the one fragment that cannot stand on its own: `## ` with no title is
 * not a shortened section, it is a broken one.
 */
function cutsFirstHeading(body, kept) {
  if (kept.length >= body.length) return false
  const first = body.split('\n', 1)[0] ?? ''
  return /^#{1,6}[ \t]/.test(first) && kept.length < first.length
}

/**
 * Render the always-on core: a heading plus as many complete entries as fit.
 *
 * The core is a *prefix* of the file, so the scan stops at the first entry that
 * does not fit. Skipping it and collecting later, smaller ones would inject a
 * discontinuous subset, and a model reading it has no way to tell a skipped
 * entry from a deleted one.
 *
 * Room for the overflow notice is reserved before any entry is placed: the
 * notice and the heading share the same budget as the entries, so adding it can
 * never push the block over.
 *
 * @param {{ text: string }[]} entries
 * @param {string} heading
 * @param {number} budget - UTF-16 code units for the whole block body.
 * @param {(key: string, vars?: Record<string, string|number>) => string} t
 * @returns {{ text: string, dropped: number, droppedChars: number }}
 */
function renderEntries(entries, heading, budget, t) {
  const lines = [heading]
  const used = () => lines.join('\n').length
  const notice = (count) => t('coreOverBudget', { count })
  // Reserve the notice slot before placing any entry, and reserve the worst
  // case: a longer count has more digits, and the notice must fit whatever the
  // final number turns out to be. `notice(dropped)` is therefore never longer
  // than the reservation, so the block cannot be pushed over by adding it.
  const reserve = entries.length > 0 ? notice(entries.length).length + 1 : 0
  let dropped = 0
  let droppedChars = 0
  for (let index = 0; index < entries.length; index += 1) {
    const item = `- ${entries[index].text}`
    if (used() + 1 + item.length > budget - reserve) {
      // The core is a file prefix: stop here rather than collecting later,
      // smaller entries past the gap.
      for (const rest of entries.slice(index)) {
        dropped += 1
        droppedChars += rest.text.length
      }
      break
    }
    lines.push(item)
  }
  if (dropped > 0) {
    // `coreBudget` bottoms out at 4000, so the heading plus this notice always
    // fits the reserved slot. The guard keeps the budget a hard cap anyway: the
    // notice is a courtesy, the cap is the promise, and `states` still carries
    // the count if the notice cannot be placed.
    const line = notice(dropped)
    if (used() + 1 + line.length <= budget) lines.push(line)
  }
  return { text: lines.join('\n'), dropped, droppedChars }
}

/**
 * Fit whole lines of `text` into `budget` UTF-16 code units.
 *
 * Lines are never cut: a half line in a topic list reads as a topic name that
 * does not exist. With `options.notice`, room for that line is reserved before
 * any line is placed, so the notice is never the thing that overflows the
 * budget it has to fit in.
 *
 * `dropped`/`droppedChars` report what did not fit so the caller can say so
 * instead of losing it silently.
 *
 * @param {string} text
 * @param {number} budget
 * @param {{ notice?: string }} [options]
 * @returns {{ text: string, dropped: number, droppedChars: number }}
 */
function fitText(text, budget, options = {}) {
  const notice = typeof options.notice === 'string' ? options.notice : ''
  const all = text.split('\n')
  if (text.length <= budget) return { text, dropped: 0, droppedChars: 0 }
  const reserve = notice ? notice.length + 1 : 0
  const kept = []
  for (const line of all) {
    const candidate = [...kept, line].join('\n')
    if (candidate.length > budget - reserve) break
    kept.push(line)
  }
  const dropped = all.slice(kept.length)
  const out = notice && dropped.length > 0 && kept.length > 0 ? [...kept, notice].join('\n') : kept.join('\n')
  return { text: out, dropped: dropped.length, droppedChars: dropped.reduce((sum, line) => sum + line.length + 1, 0) }
}

export function distillHint({ cfg, probe, t }) {
  if (!cfg.inject.user || !probe.user.memoryExists) return ''
  const limit = Number(cfg.inject.limits.user) || 0
  const above = Number(cfg.inject.distillAbove) || 0
  const chars = fileCharCount(probe.user.memoryPath)
  if (limit > 0 && chars > limit) return `\n\n${t('overLimitHint', { chars, limit, above })}`
  if (above > 0 && chars > above) return `\n\n${t('distillOverLimit', { chars, above, limit })}`
  return ''
}

function fileCharCount(path) {
  if (!path) return 0
  const file = readTextSafe(path, { maxBytes: 2 * 1024 * 1024 })
  return file.ok ? file.text.length : 0
}

export function redact(text, home) {
  if (!home || !text) return text
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
  let output = text
  for (const variant of variants) if (variant) output = output.split(variant).join('~')
  return output
}
