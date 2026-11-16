/** `memory_read`: current content, revision and section list for one target. */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { readTextSafe, statSafe } from '../fsx.js'
import { findSections, parseSections } from '../markdown.js'
import { contentRevision } from '../write/fslock.js'
import { resolveTarget, TARGETS } from '../write/store.js'
import { resolveCwd } from '../inject.js'
import { probeEnvironment } from '../env.js'

/**
 * Reads stop here. A memory file this large is not a memory file; hashing the
 * first two megabytes and calling that the revision would invite an edit that
 * overwrites everything the read never saw.
 */
const MAX_READ_BYTES = 2 * 1024 * 1024
const DEFAULT_LIMIT = 20000
const MAX_LIMIT = 200000

/** Refusal shared by the pre-check and the post-read check. */
function tooLargeResult(path, bytes) {
  return {
    ok: false,
    code: 'too_large',
    path,
    bytes,
    limitBytes: MAX_READ_BYTES,
    revision: null,
    writable: false,
    hint: 'open the file outside the tool; a revision computed from a partial read would allow the write to destroy the rest',
  }
}

/**
 * Targets a read may name.
 *
 * `user-profile` is deliberately not in `store.TARGETS`: it is read-only, and
 * adding it to the write enumeration would make the store look as if it could
 * rewrite someone's account profile.
 */
export const READ_TARGETS = [...TARGETS, 'user-profile']

/** Resolve a read target, including the read-only profile. */
function resolveReadTarget(target, probe, date) {
  if (target !== 'user-profile') return resolveTarget(target, probe, date)
  if (probe.profile?.ambiguous) {
    return { path: null, error: 'ambiguous_profile', candidates: probe.profile.candidates }
  }
  if (!probe.profile?.path) return { path: null, error: 'profile_not_found' }
  return { path: probe.profile.path, mode: 'read' }
}

function isHigh(code) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLow(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

function resolveLimit(value) {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)))
}

/**
 * Take one page of `text` by UTF-16 offset and length, never splitting a pair.
 *
 * `nextOffset` is the offset of the first character not returned, so a caller
 * can continue exactly where this page stopped. When the limit would cut an
 * emoji in half the page gives up one unit; when the very first character is
 * that emoji it includes the pair instead of returning an empty page forever.
 * An offset inside a pair is not a position the file has, so it is refused
 * rather than silently moved: the caller's cursor would otherwise advance to a
 * place it never asked for.
 */
function pageText(text, requested, limitValue, t) {
  const offset = requested === undefined ? 0 : requested
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return { error: 'bad_offset' }
  if (offset < text.length && isLow(text.charCodeAt(offset))) return { error: 'bad_offset' }

  const start = offset

  const limit = resolveLimit(limitValue)
  let end = Math.min(start + limit, text.length)
  if (end > start && end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) {
    end = end - 1 > start ? end - 1 : end + 1
  }

  const truncated = end < text.length
  const raw = text.slice(start, end)
  return {
    offset: start,
    nextOffset: end,
    truncated,
    content: truncated ? `${raw}\n\n…(${t('truncated', { limit })})` : raw,
  }
}

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {(key: string, vars?: Record<string, string|number>) => string} deps.t
 */
export function readTool({ cfg, t, ctx }) {
  return defineTool({
    name: 'memory_read',
    description:
      'Read a WorkBuddy memory file: project MEMORY.md, a daily note, the user-level MEMORY.md, or the read-only user profile. Returns the revision that memory_append/memory_edit expect, plus the section list when asked.',
    parameters: {
      target: { type: 'string', required: true, description: `${READ_TARGETS.join(' | ')}` },
      date: { type: 'string', description: 'YYYY-MM-DD, only for project-daily' },
      section: { type: 'string', description: 'return just this section, including its heading' },
      sectionsOnly: { type: 'boolean', description: 'return headings and entry counts instead of the body' },
      limit: { type: 'number', description: `maximum UTF-16 code units to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      offset: { type: 'number', description: 'UTF-16 offset into the selected text; continue from the previous nextOffset' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }, ctx) ?? null, detail: true })
      const resolved = resolveReadTarget(String(args.target ?? ''), probe, args.date)
      if (!resolved.path) {
        return {
          ok: false,
          code: resolved.error ?? 'unknown_target',
          targets: READ_TARGETS,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        }
      }

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

      const stat = statSafe(resolved.path)
      if (stat && stat.size >= MAX_READ_BYTES) return tooLargeResult(resolved.path, stat.size)

      const file = readTextSafe(resolved.path, { maxBytes: MAX_READ_BYTES })
      if (!file.ok) {
        // A file that grew after the stat above must not be reported as a
        // clean snapshot of what the caller is about to edit.
        if (file.error === 'changed') {
          return {
            ok: false,
            code: 'read_conflict',
            path: resolved.path,
            bytes: file.bytes,
            revision: null,
            writable: false,
            hint: 'the file changed while it was being read; read it again before writing',
          }
        }
        return { ok: false, code: 'unreadable', path: resolved.path, error: file.error }
      }
      // The stat above is only an early exit. The read is the authority: it
      // knows whether it stopped at the cap. Hashing a prefix here would hand
      // out a revision that deletes everything the read never saw.
      if (file.truncated || file.bytes >= MAX_READ_BYTES) return tooLargeResult(resolved.path, file.bytes)

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
        const page = pageText(file.text.slice(match.start, match.end), args.offset, args.limit, t)
        if (page.error) return { ok: false, code: page.error, path: resolved.path, revision, sections }
        return {
          ok: true,
          path: resolved.path,
          revision,
          bytes: file.bytes,
          section: match.heading,
          offset: page.offset,
          nextOffset: page.nextOffset,
          truncated: page.truncated,
          content: page.content,
        }
      }

      const page = pageText(file.text, args.offset, args.limit, t)
      if (page.error) return { ok: false, code: page.error, path: resolved.path, revision, sections }
      return {
        ok: true,
        path: resolved.path,
        revision,
        bytes: file.bytes,
        sections,
        offset: page.offset,
        nextOffset: page.nextOffset,
        truncated: page.truncated,
        content: page.content,
      }
    },
  })
}
