import { readTextSafe, truncateChars, truncateUtf16 } from './fsx.js'
import { analyzeMemory } from './layers.js'

export const SECTION_ORDER = { project: 200, rules: 210, user: 220, profile: 230 }

/**
 * How `inject.coreBudget` is divided between the four layered blocks.
 *
 * The rules share is the one that has to absorb a *language* difference, not just
 * a size one: the same four or five rules cost 369 UTF-16 units in Chinese and 663
 * in English, because English needs more words for the same content. At the old
 * 12.5% (500 units) the English block could not hold a daily-file rule at all —
 * `fitText` would have dropped it silently, and the model would never learn that
 * daily files exist. 17.5% gives English room (700 units) while Chinese keeps
 * headroom.
 *
 * These are ratios, not units, so they scale with `coreBudget`.
 */
export const LAYERED_SHARES = { project: 0.35, user: 0.35, rules: 0.175, directory: 0.125 }

/** Units one layered block may use. */
export const shareOf = (coreBudget, block) => Math.floor(coreBudget * LAYERED_SHARES[block])

/**
 * States that mean "this source did what it was asked to do".
 *
 * Everything else — a legacy fallback, an over-budget core, a truncated topic
 * list, a limit too small to say anything in — is something the model or the
 * user needs to know about, because the block in front of them is not the whole
 * story. `ambiguous` is normal here because it already gets its own explicit
 * line in the topic directory.
 */
const NORMAL_STATES = new Set(['layered', 'full', 'enabled', 'disabled', 'unavailable', 'read-only-entry', 'ambiguous'])

/** Whether a state says the injected text is a subset or a fallback. */
export const isAbnormalState = (state) => !NORMAL_STATES.has(String(state))

/**
 * The state for a whole-file block, which may have contributed nothing.
 *
 * `renderFileBlock` returns `''` when the limit cannot fit the label plus one
 * line of body, and the caller then drops the section. Recording `full` anyway
 * claimed the whole file had been injected while the model saw nothing — and
 * because `full` is a normal state, `compatibility` stayed silent about it.
 *
 * @param {string} block - what `renderFileBlock` returned.
 * @returns {string}
 */
const fileState = (block) => (block ? 'full' : 'full:too-small')

/** Whether a source fell back to whole-file injection, which makes the mode mixed. */
const isLegacy = (state) => String(state).startsWith('legacy:')

/**
 * A readable gloss for a compatibility state.
 *
 * `user=legacy:missing_core` is a state name, not an explanation: a model
 * reading it cannot tell whether the block in front of it is whole. The gloss
 * says what the state means for what was injected.
 *
 * @param {string} state
 * @param {(key: string) => string} t
 * @returns {string} an empty string when the state needs no gloss.
 */
function stateGloss(state, t) {
  const value = String(state ?? '')
  if (value.startsWith('legacy:')) return t('gloss.legacy')
  if (value.startsWith('layered:core-over-budget')) return t('gloss.coreOverBudget')
  if (value.startsWith('directory-truncated')) return t('gloss.directoryTruncated')
  if (value === 'full:too-small') return t('gloss.tooSmall')
  return ''
}

export function renderSections({ cfg, probe, t, readFile }) {
  const sections = []
  const states = {}
  /** Sources that carry more than their layered share; reported in the directory. */
  const overShare = []
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
      states[key] = fileState(block)
      return
    }
    if (!(cfg.inject.limits[key] > 0)) { states[key] = 'disabled'; return }
    const parsed = analyzeMemory(raw)
    if (parsed.mode === 'legacy') {
      const limit = cfg.inject.limits[key]
      const block = renderFileBlock({ label, raw, limit, sanitize, t })
      if (block) sections.push({ name: `workbuddy-memory:${key}`, order: SECTION_ORDER[key], text: block })
      states[key] = `legacy:${parsed.reason}`
      // A legacy file is injected whole under its own limit, so it is not
      // squeezed by `coreBudget` — but it is still cut, and a cut nobody is told
      // about reads as a complete file. Reported against the limit it is
      // actually cut at, with wording that does not promise a core split it
      // does not have.
      if (limit > 0 && raw.length > limit) overShare.push({ key, label, chars: raw.length, legacy: limit })
      return
    }
    const budget = shareOf(cfg.inject.coreBudget, key === 'project' ? 'project' : 'user')
    const prefix = `### ${label}\n\n`
    const core = renderEntries(parsed.coreEntries, `## ${t('coreHeading')}`, Math.max(0, budget - prefix.length), t)
    const text = sanitize(`${prefix}${core.text}`)
    sections.push({ name: `workbuddy-memory:${key}`, order: SECTION_ORDER[key], text })
    // An over-budget core is not a normal state: the model has to know that the
    // entries it can read are a prefix, not the whole file.
    states[key] = core.dropped > 0 ? `layered:core-over-budget(${core.dropped})` : 'layered'
    // The layered signal a full-mode session gets from the distillation hint,
    // expressed as a size instead of an instruction. It goes in the directory,
    // never in the core block: a count inside the always-on text would change
    // the prompt on every save, and a prompt that jitters is worse than one
    // that is slightly too quiet.
    //
    // Two conditions, because two different things are being promised: past the
    // core's *share* the model is reading a subset, and past `distillAbove` the
    // file has reached the size the plugin itself calls "time to distil".
    const distillAbove = key === 'user' ? Number(cfg.inject.distillAbove) || 0 : 0
    if (raw.length > budget || (distillAbove > 0 && raw.length > distillAbove)) {
      overShare.push({ key, label, chars: raw.length, distill: distillAbove > 0 && raw.length > distillAbove })
    }
    // The topic name is not enough on its own: `memory_read` needs a target as
    // well as a section, and a name like `Git 配置` exists in whichever file it
    // was written in. Carrying the source here is what lets the directory be
    // actionable instead of a list of words the model has to guess a target for.
    return parsed.topics.map((topic) => ({ source: key, name: topic.heading ?? t('unsectioned') }))
  }

  const projectTopics = cfg.inject.project && probe.project.memoryExists
    ? source('project', t('section.project'), probe.project.memoryPath, true) : (states.project = 'disabled', [])
  const userTopics = cfg.inject.user && probe.user.memoryExists
    ? source('user', t('section.user'), probe.user.memoryPath, true) : (states.user = 'disabled', [])

  if (cfg.inject.rules && cfg.inject.limits.rules > 0) {
    const rules = t(layered ? (cfg.readOnly ? 'compactRulesReadOnly' : 'compactRules') : (cfg.readOnly ? 'rulesReadOnly' : 'rules'))
    const lines = Array.isArray(rules) ? rules : []
    if (lines.length) {
      const budget = layered ? shareOf(cfg.inject.coreBudget, 'rules') : cfg.inject.limits.rules
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
      states.profile = fileState(block)
    } else {
      states.profile = 'read-only-entry'
      profileTopics = [t('profileEntry')]
    }
  } else states.profile = 'unavailable'

  if (layered) {
    const extra = [...(projectTopics ?? []), ...(userTopics ?? [])]
    // A compatibility note is a non-normal state, not only a `legacy:` one: an
    // over-budget core also means the model is reading a subset.
    const warnings = Object.entries(states).filter(([, state]) => !NORMAL_STATES.has(state))
    const entries = []
    if (warnings.length) {
      // The state name stays (it is what `memory_status` reports and what a
      // search finds), and each distinct meaning gets one gloss — deduplicated,
      // because two sources can fall back for the same reason and repeating the
      // sentence would spend the budget saying the same thing twice.
      entries.push(`${t('compatibility')}: ${warnings.map(([key, state]) => `${key}=${state}`).join(', ')}`)
      const glosses = [...new Set(warnings.map(([, state]) => stateGloss(state, t)).filter(Boolean))]
      for (const gloss of glosses) entries.push(`- ${gloss}`)
    }
    // A file larger than its layered share is the one signal a full-mode
    // session gets from the distillation hint and a layered session otherwise
    // loses. The count is the file's real size, so it does not move when the
    // core is re-cut; it only changes when someone edits the file.
    for (const item of overShare) {
      const key = item.legacy ? 'overShareLegacy' : item.distill ? 'overShareDistill' : 'overShare'
      entries.push(`- ${t(key, { label: item.label, chars: item.chars, limit: item.legacy ?? 0 })}`)
    }
    if (cfg.inject.profile && cfg.inject.limits.profile > 0 && probe.profile.ambiguous) entries.push(t('ambiguousProfile'))
    // How to read a topic, first, because `fitText` drops whole lines from the
    // end: the one line that makes the rest of the list usable has to be the one
    // that cannot be cut. A directory of nouns with no verb is a list the model
    // can recognise but not act on — it has the topic name and still has to
    // guess whether that is a `section` argument or a search string.
    //
    // Only when there is a topic to read: a directory of nothing but
    // compatibility notes and the profile line has no `NAME` for the sentence to
    // refer to, and an instruction pointing at nothing is worse than silence.
    if (extra.length) entries.push(`- ${t('topicHint')}`)
    // Sanitize before measuring: redaction only shortens, so the budget still
    // holds, and a home path must not reach the prompt through a topic heading.
    //
    // One line per topic, `<source>/<name>`. The heading above already says "on
    // demand topics", so repeating that phrase on every line spent 10 of the 500
    // units this block has (18 in English) saying nothing at all; the source
    // prefix costs less than that and carries the one fact a bare topic name
    // cannot: which file the section lives in. `memory_read` needs a target as
    // well as a section, and a name like `Git 配置` exists in whichever file it
    // was written in — without the prefix the model has to guess, and a wrong
    // guess is a `no_section` round trip.
    //
    // A flat list rather than per-source groups on purpose: `fitText` drops whole
    // lines from the end, so a group header could survive while every topic under
    // it was cut, leaving a heading with nothing beneath it.
    const seen = new Set()
    for (const topic of extra) {
      const key = `${topic.source}\u0000${topic.name}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(`- ${topic.source}/${sanitize(topic.name)}`)
    }
    for (const hint of profileTopics) entries.push(`- ${hint}`)
    const budget = shareOf(cfg.inject.coreBudget, 'directory')
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
