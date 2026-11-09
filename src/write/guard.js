/**
 * Refuse bare writes into memory files.
 *
 * Without this, `write` and `edit` reach the same files with no lock, no
 * revision check and no backup — every guarantee in the design becomes
 * decorative. The guard is a monotonic refusal: once returned, no later
 * listener can turn it back into an allow.
 *
 * It classifies by real path, so a symlink or junction pointing into the memory
 * directory is refused too. It does not stop a shell command, and it says so:
 * this is a guard against accidents, not a security boundary.
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { probeEnvironment } from '../env.js'
import { resolveCwd } from '../inject.js'

const BARE_WRITERS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])

/** Resolve a path as far as it exists, so links are compared by target. */
export function canon(path) {
  if (!path) return ''
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
}

/** Whether `child` is `parent` or lives under it. */
export function isUnder(child, parent) {
  const a = canon(child)
  const b = canon(parent)
  if (!a || !b) return false
  if (a === b) return true
  const prefix = b.endsWith(sep) ? b : `${b}${sep}`
  return a.startsWith(prefix)
}

/**
 * The exact paths this session must protect.
 *
 * Deliberately narrow: the plugin's own files, skill files and WorkBuddy's
 * database sit under the same home directory, and blocking edits to those would
 * break unrelated workflows.
 *
 * @param {object} probe
 * @returns {{ files: string[], dirs: string[] }}
 */
export function protectedPaths(probe) {
  const files = [probe.layout.userMemory, probe.layout.userProfile, probe.layout.identity, probe.layout.soul, probe.profile?.path].filter(Boolean)
  const dirs = [probe.project.dir, probe.layout.cloudMemoryDir].filter(Boolean)
  return { files, dirs }
}

/**
 * Whether a write to `target` must be refused.
 *
 * @param {string} target - absolute path.
 * @param {object} probe
 */
export function isMemoryTarget(target, probe) {
  const { files, dirs } = protectedPaths(probe)
  if (files.some((file) => canon(file) === canon(target))) return true
  return dirs.some((dir) => isUnder(target, dir))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {(key: string, vars?: Record<string, string|number>) => string} deps.t
 */
export function registerWriteGuard(ctx, { cfg, t }) {
  if (typeof ctx.tools?.guard !== 'function') return false
  if (!cfg.guard?.enabled) return false

  ctx.effect(() =>
    ctx.tools.guard((exec) => {
      // Read-only means nothing is being written anyway; let a person fix a
      // broken file by hand instead of blocking them twice.
      if (cfg.readOnly) return undefined
      if (!BARE_WRITERS.has(String(exec?.name ?? ''))) return undefined

      const args = exec?.arguments
      const raw = args?.file_path ?? args?.path ?? args?.file
      if (typeof raw !== 'string' || !raw.trim()) return undefined

      const cwd = resolveCwd({ agent: exec?.agent }) ?? process.cwd()
      const target = isAbsolute(raw) ? raw : resolve(cwd, raw)
      const probe = probeEnvironment({ cfg, cwd, detail: false })

      return isMemoryTarget(target, probe) ? t('guard.refused', { path: raw }) : undefined
    }),
  )
  return true
}
