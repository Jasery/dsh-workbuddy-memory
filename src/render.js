/**
 * Turn probed memory files into system-prompt sections.
 *
 * Rendering is pure and synchronous: it takes whatever the snapshot cache
 * decided is current and produces text. Nothing here writes, and an empty
 * string means "contribute nothing" — the host drops empty sections.
 */

import { readTextSafe, truncateChars } from './fsx.js'

export const SECTION_ORDER = {
  project: 200,
  rules: 210,
  user: 220,
  profile: 230,
}

/**
 * @param {object} input
 * @param {object} input.cfg - normalized config.
 * @param {object} input.probe - result of `probeEnvironment`.
 * @param {(key: string, vars?: Record<string, string|number>) => string} input.t
 * @returns {{ name: string, order: number, text: string }[]}
 */
export function renderSections({ cfg, probe, t }) {
  const sections = []
  const sanitize = cfg.inject.sanitizePaths ? (text) => redact(text, probe.layout.home) : (text) => text

  if (cfg.inject.project && probe.project.memoryExists) {
    const text = renderFileBlock({
      label: t('section.project'),
      path: probe.project.memoryPath,
      limit: cfg.inject.limits.project,
      sanitize,
      t,
    })
    if (text) sections.push({ name: 'workbuddy-memory:project', order: SECTION_ORDER.project, text })
  }

  if (cfg.inject.rules) {
    const rules = t('rules')
    const lines = Array.isArray(rules) ? rules : []
    if (lines.length > 0) {
      const body = lines.map((line, index) => `${index + 1}. ${line}`).join('\n')
      sections.push({
        name: 'workbuddy-memory:rules',
        order: SECTION_ORDER.rules,
        text: truncateChars(`### ${t('section.rules')}\n\n${body}`, cfg.inject.limits.rules),
      })
    }
  }

  if (cfg.inject.user && probe.user.memoryExists) {
    const text = renderFileBlock({
      label: t('section.user'),
      path: probe.user.memoryPath,
      limit: cfg.inject.limits.user,
      sanitize,
      t,
    })
    if (text) sections.push({ name: 'workbuddy-memory:user', order: SECTION_ORDER.user, text })
  }

  if (cfg.inject.profile) {
    if (probe.profile.ambiguous) {
      sections.push({
        name: 'workbuddy-memory:profile',
        order: SECTION_ORDER.profile,
        text: `### ${t('section.profile')}\n\n${t('ambiguousProfile')}`,
      })
    } else if (probe.profile.exists) {
      const text = renderFileBlock({
        label: t('section.profile'),
        path: probe.profile.path,
        limit: cfg.inject.limits.profile,
        sanitize,
        t,
      })
      if (text) sections.push({ name: 'workbuddy-memory:profile', order: SECTION_ORDER.profile, text })
    }
  }

  return sections
}

function renderFileBlock({ label, path, limit, sanitize, t }) {
  if (!path) return ''
  const file = readTextSafe(path, { maxBytes: 1024 * 1024 })
  if (!file.ok || !file.text.trim()) return ''

  const body = file.text.trim()
  const kept = truncateChars(body, limit)
  const note = kept.length < body.length ? `\n\n_${t('truncated', { limit })}_` : ''
  return `### ${label}\n\n${sanitize(kept)}${note}`
}

/**
 * Replace the WorkBuddy home prefix with `~`.
 *
 * Only the home directory itself: replacing every absolute path would make
 * genuinely useful references (a repo path recorded in a note) useless.
 */
export function redact(text, home) {
  if (!home || !text) return text
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
  let output = text
  for (const variant of variants) {
    if (variant) output = output.split(variant).join('~')
  }
  return output
}
