/** `memory_read`: current content, revision and section list for one target. */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { readTextSafe, truncateChars } from '../fsx.js'
import { findSections, parseSections } from '../markdown.js'
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
        // Do not promise that memory_append creates the file: it only does when
        // `write.ensureLayout` is on and the project has a memory directory.
        return {
          ok: false,
          code: 'not_found',
          path: resolved.path,
          hint: 'the file does not exist yet; memory_append creates it when the memory directory exists or write.ensureLayout is on',
        }
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
        const matches = findSections(file.text, String(args.section))
        if (matches.length === 0) return { ok: false, code: 'no_section', path: resolved.path, revision, sections }
        // A duplicate heading is named rather than guessed at: the caller is
        // looking at one of them and would otherwise silently get the other.
        if (matches.length > 1) {
          return {
            ok: false,
            code: 'ambiguous_section',
            path: resolved.path,
            revision,
            sections,
            lines: matches.map((section) => section.line + 1),
          }
        }
        const match = matches[0]
        // The section branch used to return the whole body regardless of
        // `limit`, so reading an oversized section dumped it into context in one
        // go — exactly the case where a caller wants a cap.
        const limit = Number.isFinite(args.limit) ? Math.max(1, Number(args.limit)) : 20000
        const raw = file.text.slice(match.start, match.end)
        const content = raw.length > limit ? `${truncateChars(raw, limit)}\n\n…(${t('truncated', { limit })})` : raw
        return {
          ok: true,
          path: resolved.path,
          revision,
          bytes: file.bytes,
          section: match.heading,
          truncated: raw.length > limit,
          content,
        }
      }

      const limit = Number.isFinite(args.limit) ? Math.max(1, Number(args.limit)) : 20000
      const content = file.text.length > limit ? `${file.text.slice(0, limit)}\n\n…(${t('truncated', { limit })})` : file.text

      return { ok: true, path: resolved.path, revision, bytes: file.bytes, sections, content }
    },
  })
}
