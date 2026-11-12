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
    // Read-only gets its own wording: telling the model how to write when every
    // write returns `read_only` just burns turns on retries.
    const rules = t(cfg.readOnly ? 'rulesReadOnly' : 'rules')
    const lines = Array.isArray(rules) ? rules : []
    if (lines.length > 0) {
      const body = lines.map((line, index) => `${index + 1}. ${line}`).join('\n')
      // The pressure hint is appended, not baked into the locale table: it is
      // the only line whose text depends on a live measurement, and read-only
      // sessions never write, so they never need it.
      const hint = cfg.readOnly ? '' : distillHint({ cfg, probe, t })
      // The hint is measured against the budget first. Truncating the whole
      // block would cut the hint itself whenever the base text is long, and the
      // hint exists precisely for the case where something needs cutting — so
      // the base gives way instead, and the hint always survives intact.
      const base = `### ${t('section.rules')}\n\n${body}`
      const room = Math.max(0, cfg.inject.limits.rules - hint.length)
      sections.push({
        name: 'workbuddy-memory:rules',
        order: SECTION_ORDER.rules,
        text: `${truncateChars(base, room)}${hint}`,
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

/**
 * A one-line pressure hint, appended to the rules block when the user memory
 * has outgrown its budget.
 *
 * Without it the file only ever grows: the injected block is truncated silently
 * at `limits.user`, so the model keeps appending to a store whose tail nobody
 * reads, and the truncation is invisible from inside the conversation. The hint
 * names the actual numbers so the model can decide rather than guess.
 *
 * `distillAbove` is a threshold on the file's real size, not on the injected
 * text: a file just over the limit is still worth reading in full, while one at
 * twice the limit is already losing half of itself on every turn.
 *
 * @param {{ cfg: object, probe: object, t: Function }} input
 * @returns {string} the hint with a leading newline, or '' when not over.
 */
export function distillHint({ cfg, probe, t }) {
  if (!cfg.inject.user || !probe.user.memoryExists) return ''
  const above = Number(cfg.inject.distillAbove) || 0
  if (above <= 0) return ''

  const chars = fileCharCount(probe.user.memoryPath)
  if (chars <= above) return ''

  return `\n\n${t('distillOverLimit', {
    chars,
    above,
    limit: cfg.inject.limits.user,
  })}`
}

/** Characters in a file, or 0 when it cannot be read. */
function fileCharCount(path) {
  if (!path) return 0
  const file = readTextSafe(path, { maxBytes: 4 * 1024 * 1024 })
  return file.ok ? file.text.length : 0
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
