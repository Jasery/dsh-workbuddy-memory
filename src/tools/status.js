/** `memory_status`: everything needed to answer "why is my memory not showing up". */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { probeEnvironment } from '../env.js'
import { readTextSafe } from '../fsx.js'
import { resolveCwd } from '../inject.js'

/** Characters in the user memory file; 0 when absent or unreadable. */
function userMemoryChars(probe) {
  if (!probe.user.memoryExists || !probe.user.memoryPath) return 0
  const file = readTextSafe(probe.user.memoryPath, { maxBytes: 4 * 1024 * 1024 })
  return file.ok ? file.text.length : 0
}

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {(key: string, vars?: Record<string, string|number>) => string} deps.t
 * @returns {object} a tool definition.
 */
export function statusTool({ cfg, t }) {
  return defineTool({
    name: 'memory_status',
    description:
      'Report the WorkBuddy memory stores this session sees: resolved home, project and user files, sizes, writability, profile resolution and the effective config. Read-only.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const cwd = resolveCwd({ agent: exec?.agent }) ?? null
      const probe = probeEnvironment({ cfg, cwd, detail: true })
      return describe(probe, cfg, t)
    },
  })
}

/** Shape the probe as the tool's answer. */
export function describe(probe, cfg, t) {
  const warnings = []
  if (cfg.readOnly) warnings.push(t('status.readOnly'))
  if (!probe.hasAnyMemory) warnings.push(t('noProject'))
  if (probe.profile.ambiguous) warnings.push(t('ambiguousProfile'))
  if (probe.project.exists && !probe.project.writable) warnings.push('project memory is not writable')

  // The injected block is truncated at `limits.user`, so a bigger file means
  // content nobody reads. Report both numbers: the size alone does not say
  // whether it is a problem, and the limit alone does not say whether the file
  // has outgrown it.
  const userChars = userMemoryChars(probe)
  const userOverLimit = cfg.inject.user && userChars > cfg.inject.limits.user
  const distillDue = cfg.inject.distillAbove > 0 && userChars > cfg.inject.distillAbove
  if (userOverLimit) {
    warnings.push(
      t('status.userOverLimit', {
        chars: userChars,
        limit: cfg.inject.limits.user,
        above: cfg.inject.distillAbove,
      }),
    )
  }

  return {
    ok: probe.hasAnyMemory,
    status: probe.status,
    readOnly: cfg.readOnly,
    home: probe.home,
    dataFolderName: probe.dataFolderName,
    state: probe.state,
    stores: {
      project: {
        dir: probe.project.dir,
        memory: probe.project.memoryPath,
        exists: probe.project.exists,
        memoryExists: probe.project.memoryExists,
        bytes: probe.project.memoryBytes,
        writable: probe.project.writable,
        dailyFiles: probe.project.dailyFiles.map((file) => file.name),
      },
      user: {
        memory: probe.user.memoryPath,
        exists: probe.user.memoryExists,
        bytes: probe.user.memoryBytes,
        chars: userChars,
        injected: Math.min(userChars, cfg.inject.limits.user),
        overLimit: Boolean(userOverLimit),
        distillDue: Boolean(distillDue),
        profile: probe.user.profilePath,
        profileExists: probe.user.profileExists,
        writable: probe.user.writable,
      },
      profile: {
        path: probe.profile.path,
        source: probe.profile.source,
        ambiguous: probe.profile.ambiguous,
        candidates: probe.profile.candidates ?? [],
      },
    },
    config: {
      inject: cfg.inject,
      write: cfg.write,
      search: cfg.search,
    },
    warnings,
  }
}
