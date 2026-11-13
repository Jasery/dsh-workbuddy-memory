/** `memory_append`: add one entry to a section or a daily note. */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { probeEnvironment } from '../env.js'
import { resolveCwd } from '../inject.js'
import { TARGETS, resolveTarget } from '../write/store.js'

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
 * `memory_replace_section`: rewrite one section's body in place.
 *
 * The panel has had this since the L2 editor; the model did not, so compressing
 * a nine-entry section into four meant nine `memory_edit` calls plus four
 * `memory_append` calls — slow, and each one burned a backup slot. The store
 * method, its validation and its lock/CAS/backup chain already existed.
 */
export function replaceSectionTool({ cfg, store }) {
  return defineTool({
    name: 'memory_replace_section',
    description:
      'Replace one section body of a WorkBuddy MEMORY.md, keeping its heading and every line outside the section byte-identical. The body must be only `- ` entries, continuation lines and blank lines: headings and prose are refused with invalid_body, because a heading here would split the section. Use this to compress a section instead of many memory_edit calls. Discards the section\'s other entries, so pass the complete new body.',
    parameters: {
      target: { type: 'string', required: true, description: 'project-memory | user-memory' },
      section: { type: 'string', required: true, description: 'section heading whose body is replaced' },
      body: { type: 'string', required: true, description: 'the complete new body: `- ` entries, continuation lines and blank lines only' },
      expectedRevision: { type: 'string', description: 'revision from memory_read; the write is refused when it no longer matches' },
      operationId: { type: 'string', description: 'idempotency key' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }) ?? null, detail: false })
      return store.replaceSection(
        {
          target: String(args.target ?? ''),
          section: String(args.section ?? ''),
          body: String(args.body ?? ''),
          expectedRevision: args.expectedRevision ? String(args.expectedRevision) : undefined,
          operationId: args.operationId ? String(args.operationId) : undefined,
        },
        probe,
      )
    },
  })
}

/**
 * `memory_restore`: put a memory file back to one of its own backups.
 *
 * The last resort for a bad batch of edits, and the only path back once a
 * destructive write has landed. `expectedRevision` is mandatory: a restore must
 * not silently discard writes made after the caller looked at the file. The file
 * as it stands is backed up first, so the restore itself is undoable.
 */
export function restoreTool({ cfg, store }) {
  return defineTool({
    name: 'memory_restore',
    description:
      'Put a WorkBuddy memory file back to one of its own backups. Call memory_list_revisions first to see the available names. expectedRevision is mandatory: pass the revision you last read, so a restore cannot silently discard newer writes. The current file is backed up first, so the restore is itself undoable.',
    parameters: {
      target: { type: 'string', required: true, description: 'project-memory | user-memory' },
      name: { type: 'string', required: true, description: 'backup file name from memory_list_revisions' },
      expectedRevision: { type: 'string', required: true, description: 'revision from memory_read; mandatory' },
      operationId: { type: 'string', description: 'idempotency key' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }) ?? null, detail: false })
      return store.restore(
        {
          target: String(args.target ?? ''),
          name: String(args.name ?? ''),
          expectedRevision: args.expectedRevision ? String(args.expectedRevision) : undefined,
          operationId: args.operationId ? String(args.operationId) : undefined,
        },
        probe,
      )
    },
  })
}

/**
 * `memory_list_revisions`: the backups a restore can name.
 *
 * `memory_restore` takes a backup file name, and a caller cannot guess one. The
 * panel already had this list over `/revisions`; without it the tool pair would
 * be unusable from the model side.
 */
export function listRevisionsTool({ cfg, store }) {
  return defineTool({
    name: 'memory_list_revisions',
    description:
      'List the backups of one WorkBuddy memory file, newest first. Use a name from here as memory_restore.name. Backups are taken before every write, and older ones are rotated away, so a long batch of edits can use up the earliest restore points.',
    parameters: {
      target: { type: 'string', required: true, description: 'project-memory | user-memory' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }) ?? null, detail: false })
      const resolved = resolveTarget(String(args.target ?? ''), probe)
      if (!resolved.path || resolved.mode !== 'rewrite') return { ok: false, code: 'bad_target', target: String(args.target ?? '') }
      const revisions = store.listRevisions(resolved.path)
      return { ok: true, target: String(args.target ?? ''), path: resolved.path, count: revisions.length, revisions }
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
