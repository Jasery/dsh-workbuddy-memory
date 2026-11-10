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
      'Replace or remove one existing bullet entry in a WorkBuddy MEMORY.md, matched by literal text inside the given section. Only bullet lines are addressable: prose and sub-headings are refused with not_an_entry, and an ambiguous match is refused rather than guessed. The "- " marker and indentation are preserved, so replacement takes the entry text, not a whole line.',
    parameters: {
      target: { type: 'string', required: true, description: 'project-memory | user-memory' },
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

/**
 * `memory_consolidate`: fold old daily notes into the project's MEMORY.md.
 *
 * The rules block already tells the model to use this tool across days, so it
 * has to exist. `dryRun` defaults to true for the same reason the panel shows a
 * plan first: folding several files is not a step anyone wants to discover by
 * having done it.
 */
export function consolidateTool({ cfg, store }) {
  return defineTool({
    name: 'memory_consolidate',
    description:
      'Fold old project daily notes (YYYY-MM-DD.md) into the project MEMORY.md, one `## YYYY-MM-DD` section per date, then clear the folded lines from the sources. dryRun defaults to true and returns the plan without writing; pass dryRun:false to run it.',
    parameters: {
      beforeDays: { type: 'number', description: 'fold files older than this many days (default 30)' },
      dates: { type: 'string', description: 'comma-separated YYYY-MM-DD list to fold instead of using beforeDays' },
      dryRun: { type: 'boolean', description: 'true (default) returns the plan only; false performs the merge' },
      expectedRevision: { type: 'string', description: 'revision of the project MEMORY.md from memory_read' },
      operationId: { type: 'string', description: 'idempotency key' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }) ?? null, detail: false })
      const dates =
        typeof args.dates === 'string' && args.dates.trim()
          ? args.dates.split(',').map((value) => value.trim()).filter(Boolean)
          : undefined
      return store.consolidate(
        {
          beforeDays: args.beforeDays === undefined ? undefined : Number(args.beforeDays),
          dates,
          dryRun: args.dryRun !== false,
          expectedRevision: args.expectedRevision ? String(args.expectedRevision) : undefined,
          operationId: args.operationId ? String(args.operationId) : undefined,
        },
        probe,
      )
    },
  })
}
