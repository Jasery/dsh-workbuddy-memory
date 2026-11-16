import { readTextSafe, truncateChars } from './fsx.js'
import { analyzeMemory } from './layers.js'

export const SECTION_ORDER = { project: 200, rules: 210, user: 220, profile: 230 }

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
    const core = renderEntries(parsed.coreEntries, `## ${t('coreHeading')}`, Math.max(0, budget - prefix.length))
    const text = sanitize(`${prefix}${core}`)
    sections.push({ name: `workbuddy-memory:${key}`, order: SECTION_ORDER[key], text })
    states[key] = 'layered'
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
      const text = layered ? fitText(base, budget) : `${truncateChars(base, Math.max(0, budget - hint.length))}${hint}`
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
    const warnings = Object.entries(states).filter(([, state]) => state.startsWith?.('legacy:')).map(([key, state]) => `${key}=${state}`)
    const entries = []
    if (warnings.length) entries.push(`${t('compatibility')}: ${warnings.join(', ')}`)
    if (cfg.inject.profile && cfg.inject.limits.profile > 0 && probe.profile.ambiguous) entries.push(t('ambiguousProfile'))
    for (const topic of [...new Set(extra)]) entries.push(`${t('topicDirectory')}: ${topic}`)
    const tail = entries.length ? fitText(`### ${t('topicDirectory')}\n\n${entries.join('\n')}`, Math.floor(cfg.inject.coreBudget * 0.125)) : ''
    if (tail) {
      states.directory = 'enabled'
      sections.push({ name: 'workbuddy-memory:profile', order: SECTION_ORDER.profile, text: tail })
    }
  }
  sections.sort((left, right) => left.order - right.order)
  sections.states = states
  sections.mode = layered ? (Object.values(states).some((state) => state.startsWith?.('legacy:')) ? 'mixed' : 'layered') : 'full'
  return sections
}

function renderFileBlock({ label, raw, limit, sanitize, t }) {
  if (!raw?.trim() || !(limit > 0)) return ''
  const body = raw.trim()
  const prefix = `### ${label}\n\n`
  if (prefix.length >= limit) return truncateChars(prefix, limit)
  const room = limit - prefix.length
  let kept = truncateChars(body, room)
  let note = ''
  if (kept.length < body.length) {
    const candidate = `\n\n_${t('truncated', { limit })}_`
    if (candidate.length <= room) {
      note = candidate
      kept = truncateChars(body, room - note.length)
    }
  }
  return `${prefix}${sanitize(kept)}${note}`
}

function renderEntries(entries, heading, budget) {
  const lines = [heading]
  for (const entry of entries) {
    const item = `- ${entry.text}`
    const candidate = [...lines, item].join('\n')
    if (candidate.length > budget) continue
    lines.push(item)
  }
  return lines.join('\n')
}

function fitText(text, budget) {
  if (text.length <= budget) return text
  const kept = []
  for (const line of text.split('\n')) {
    const candidate = [...kept, line].join('\n')
    if (candidate.length > budget) break
    kept.push(line)
  }
  return kept.join('\n')
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
