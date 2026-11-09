/** `memory_status`: everything needed to answer "why is my memory not showing up". */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { probeEnvironment } from '../env.js'
import { resolveCwd } from '../inject.js'

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
