/** `memory_read`: current content, revision and section list for one target. */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { readTextSafe } from '../fsx.js'
import { parseSections } from '../markdown.js'
import { contentRevision } from '../write/fslock.js'
import { resolveTarget, TARGETS } from '../write/store.js'
import { resolveCwd } from '../inject.js'
import { probeEnvironment } from '../env.js'

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {(key: string, vars?: Record<string, string|number>) => string} deps.t
 */
export function readTool({ cfg, t }) {
  return defineTool({
    name: 'memory_read',
    description:
      'Read a WorkBuddy memory file: project MEMORY.md, a daily note, or the user-level MEMORY.md. Returns the revision that memory_append/memory_edit expect, plus the section list when asked.',
    parameters: {
      target: { type: 'string', required: true, description: `${TARGETS.join(' | ')}` },
      date: { type: 'string', description: 'YYYY-MM-DD, only for project-daily' },
      section: { type: 'string', description: 'return just this section, including its heading' },
      sectionsOnly: { type: 'boolean', description: 'return headings and entry counts instead of the body' },
      limit: { type: 'number', description: 'maximum characters of body to return (default 20000)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }) ?? null, detail: true })
      const resolved = resolveTarget(String(args.target ?? ''), probe, args.date)
      if (!resolved.path) return { ok: false, code: resolved.error ?? 'unknown_target', targets: TARGETS }

      if (!existsSync(resolved.path)) {
        return { ok: false, code: 'not_found', path: resolved.path, hint: 'the file does not exist yet; memory_append creates it' }
      }

      const file = readTextSafe(resolved.path, { maxBytes: 2 * 1024 * 1024 })
      if (!file.ok) return { ok: false, code: 'unreadable', path: resolved.path, error: file.error }

      const revision = contentRevision(file.text)
      const sections = parseSections(file.text).map((section) => ({
        heading: section.heading,
        level: section.level,
        line: section.line + 1,
        entries: file.text
          .slice(section.start, section.end)
          .split(/\r?\n/)
          .filter((line) => /^[ \t]*[-*][ \t]+\S/.test(line)).length,
      }))

      if (args.sectionsOnly) {
        return { ok: true, path: resolved.path, revision, bytes: file.bytes, sections }
      }

      if (args.section) {
        const match = parseSections(file.text).find((section) => section.heading.toLowerCase() === String(args.section).toLowerCase())
        if (!match) return { ok: false, code: 'no_section', path: resolved.path, revision, sections }
        return {
          ok: true,
          path: resolved.path,
          revision,
          bytes: file.bytes,
          section: match.heading,
          content: file.text.slice(match.start, match.end),
        }
      }

      const limit = Number.isFinite(args.limit) ? Math.max(1, Number(args.limit)) : 20000
      const content = file.text.length > limit ? `${file.text.slice(0, limit)}\n\n…(${t('truncated', { limit })})` : file.text

      return { ok: true, path: resolved.path, revision, bytes: file.bytes, sections, content }
    },
  })
}
