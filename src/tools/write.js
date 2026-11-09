/** `memory_append`: add one entry to a section or a daily note. */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { probeEnvironment } from '../env.js'
import { resolveCwd } from '../inject.js'
import { TARGETS } from '../write/store.js'

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {object} deps.store
 */
export function appendTool({ cfg, store }) {
  return defineTool({
    name: 'memory_append',
    description:
      'Append one entry to WorkBuddy memory. Rewrites only the target section of MEMORY.md, or appends a bullet to today\'s daily note. Returns the new revision; pass it back as expectedRevision on the next write.',
    parameters: {
      target: { type: 'string', required: true, description: `${TARGETS.join(' | ')}` },
      text: { type: 'string', required: true, description: 'entry text, without the leading "- "' },
      section: { type: 'string', description: 'section heading to append under (MEMORY.md targets)' },
      date: { type: 'string', description: 'YYYY-MM-DD, only for project-daily' },
      expectedRevision: { type: 'string', description: 'revision from memory_read; the write is refused when it no longer matches' },
      operationId: { type: 'string', description: 'idempotency key; replaying the same value does not write twice' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }) ?? null, detail: false })
      return store.append(
        {
          target: String(args.target ?? ''),
          section: args.section ? String(args.section) : undefined,
          text: String(args.text ?? ''),
          date: args.date ? String(args.date) : undefined,
          expectedRevision: args.expectedRevision ? String(args.expectedRevision) : undefined,
          operationId: args.operationId ? String(args.operationId) : undefined,
        },
        probe,
      )
    },
  })
}

/** `memory_edit`: replace or remove one entry. */
export function editTool({ cfg, store }) {
  return defineTool({
    name: 'memory_edit',
    description:
      'Replace or remove one existing entry in a WorkBuddy MEMORY.md, matched by literal text inside the given section. Refuses when the match is ambiguous, so the caller can be more specific instead of the tool guessing.',
    parameters: {
      target: { type: 'string', required: true, description: 'project-memory | user-memory' },
      section: { type: 'string', required: true, description: 'section heading that contains the entry' },
      match: { type: 'string', required: true, description: 'literal text identifying exactly one entry in that section' },
      replacement: { type: 'string', description: 'replacement line (without "- "), for mode=replace' },
      mode: { type: 'string', description: 'replace (default) | remove' },
      expectedRevision: { type: 'string', description: 'revision from memory_read' },
      operationId: { type: 'string', description: 'idempotency key' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }) ?? null, detail: false })
      return store.edit(
        {
          target: String(args.target ?? ''),
          section: String(args.section ?? ''),
          match: String(args.match ?? ''),
          replacement: args.replacement === undefined ? undefined : String(args.replacement),
          mode: args.mode === 'remove' ? 'remove' : 'replace',
          expectedRevision: args.expectedRevision ? String(args.expectedRevision) : undefined,
          operationId: args.operationId ? String(args.operationId) : undefined,
        },
        probe,
      )
    },
  })
}
