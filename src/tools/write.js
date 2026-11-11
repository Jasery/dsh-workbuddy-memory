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
 * `memory_prune`: archive old daily logs, WorkBuddy-style.
 *
 * The model is expected to distill durable conclusions into MEMORY.md first
 * (memory_append / memory_edit); this tool only moves the raw YYYY-MM-DD.md
 * logs into `memory/archive/`. It never writes MEMORY.md, so it cannot bloat
 * the injected long-term store. `dryRun` defaults to true.
 */
export function pruneTool({ cfg, store }) {
  return defineTool({
    name: 'memory_prune',
    description:
      'Archive old project daily logs (YYYY-MM-DD.md) into memory/archive/ AFTER you have distilled their durable conclusions into MEMORY.md with memory_append/memory_edit. Never copies entries into MEMORY.md. dryRun defaults to true and returns the plan without moving anything; pass dryRun:false to archive.',
    parameters: {
      beforeDays: { type: 'number', description: 'archive files older than this many days (default 30)' },
      dates: { type: 'string', description: 'comma-separated YYYY-MM-DD list to archive instead of using beforeDays' },
      dryRun: { type: 'boolean', description: 'true (default) returns the plan only; false performs the archive' },
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
      return store.prune(
        {
          beforeDays: args.beforeDays === undefined ? undefined : Number(args.beforeDays),
          dates,
          dryRun: args.dryRun !== false,
          operationId: args.operationId ? String(args.operationId) : undefined,
        },
        probe,
      )
    },
  })
}
