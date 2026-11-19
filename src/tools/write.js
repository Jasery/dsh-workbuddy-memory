/** `memory_append` and `memory_edit`: the two entry-level writes the model gets. */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { probeEnvironment } from '../env.js'
import { resolveCwd } from '../inject.js'
import { TARGETS } from '../write/store.js'

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {object} deps.store
 */
export function appendTool({ cfg, store, ctx }) {
  return defineTool({
    name: 'memory_append',
    description:
      'Append one entry to WorkBuddy memory: a section of MEMORY.md, or a bullet in today\'s daily note. On a daily note, passing `section` creates that `##` heading when missing and appends under it (the file is rewritten with a backup); without `section` the bullet is appended at the end of the file, which lands in the last section if the note already has one. Returns the new revision; pass it back as expectedRevision on the next write.',
    parameters: {
      target: { type: 'string', required: true, description: `${TARGETS.join(' | ')}` },
      text: { type: 'string', required: true, description: 'entry text, without the leading "- "' },
      section: {
        type: 'string',
        description:
          'section heading to append under; created if missing. For a daily note, omitting it appends a bare bullet at the end of the file',
      },
      date: { type: 'string', description: 'YYYY-MM-DD, only for project-daily' },
      expectedRevision: { type: 'string', description: 'revision from memory_read; the write is refused when it no longer matches' },
      operationId: { type: 'string', description: 'idempotency key; replaying the same value does not write twice' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }, ctx) ?? null, detail: false })
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
export function editTool({ cfg, store, ctx }) {
  return defineTool({
    name: 'memory_edit',
    description:
      'Replace or remove one existing bullet entry in a WorkBuddy MEMORY.md, matched by literal text inside the given section. Only bullet lines are addressable: prose and sub-headings are refused with not_an_entry, and an ambiguous match is refused rather than guessed. The "- " marker and indentation are preserved, so replacement takes the entry text, not a whole line. A daily note can be edited the same way; pass its date.',
    parameters: {
      target: { type: 'string', required: true, description: 'project-memory | user-memory | project-daily' },
      date: { type: 'string', description: 'YYYY-MM-DD, only for project-daily; defaults to today' },
      section: { type: 'string', required: true, description: 'section heading that contains the entry' },
      match: { type: 'string', required: true, description: 'literal text identifying exactly one bullet entry in that section' },
      replacement: { type: 'string', description: 'new entry text for mode=replace; the leading "- " is optional and never needed. Required (non-empty) when replacing.' },
      mode: { type: 'string', description: 'replace (default) | remove' },
      expectedRevision: { type: 'string', description: 'revision from memory_read' },
      operationId: { type: 'string', description: 'idempotency key' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }, ctx) ?? null, detail: false })
      return store.edit(
        {
          target: String(args.target ?? ''),
          date: args.date ? String(args.date) : undefined,
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
