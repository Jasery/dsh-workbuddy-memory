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

import { isAbsolute, resolve, sep } from 'node:path'
import { probeEnvironment } from '../env.js'
import { resolveCwd } from '../inject.js'
import { resolveLink } from './fslock.js'

const BARE_WRITERS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])

/** `apply_patch` names its targets inside patch text, not in a path argument. */
const PATCH_TARGET = /^\*\*\*[ \t]+(?:Update|Add|Delete)[ \t]+File:[ \t]*(.+?)[ \t]*$/gm

/**
 * Every path a tool invocation would write, as written by the caller.
 *
 * `write`/`edit` carry one `file_path`; `apply_patch` carries a patch document
 * whose `*** Update File:` / `*** Add File:` / `*** Delete File:` lines each name
 * a target. Reading only `file_path` let a patch walk straight past the guard
 * and bypass the lock, the revision check and the backups.
 *
 * @param {string} name - tool name.
 * @param {object} args - tool arguments.
 * @returns {string[]}
 */
export function writeTargets(name, args) {
  if (name === 'apply_patch') {
    const patch = args?.input ?? args?.patch ?? args?.text
    if (typeof patch !== 'string') return []
    return [...patch.matchAll(PATCH_TARGET)].map((match) => match[1].trim()).filter(Boolean)
  }
  const raw = args?.file_path ?? args?.path ?? args?.file
  return typeof raw === 'string' && raw.trim() ? [raw.trim()] : []
}

/**
 * Resolve a path as far as it exists, so links are compared by target.
 *
 * A path that does not exist yet still has to canonicalise like its parent.
 * Resolving only complete paths meant `canon()` returned the caller's spelling
 * for anything about to be created — a Windows 8.3 short name (`RUNNER~1`), or
 * a differently-cased directory — and that spelling never matched the
 * canonicalised parent. `isMemoryTarget()` then answered "not memory" for a new
 * file in the memory directory, which is exactly the case the guard exists for.
 *
 * `resolveLink()` in `fslock.js` is the same rule and the same reason, so it is
 * the implementation rather than a second copy that can drift.
 *
 * @param {string} path
 * @returns {string} absolute, canonical where anything along the way exists.
 */
export function canon(path) {
  if (!path) return ''
  return resolveLink(path)
}

/** Fold the parts of a path the platform itself ignores. */
export function foldCase(path) {
  return process.platform === 'win32' ? String(path).toLowerCase() : String(path)
}

/** Whether `child` is `parent` or lives under it. */
export function isUnder(child, parent) {
  const a = canon(child)
  const b = canon(parent)
  if (!a || !b) return false
  // Windows compares paths case-insensitively. Without folding here, a caller
  // that spells the memory folder differently (`.WORKBUDDY`) walks past a
  // guard whose `realpath` fallback preserved the caller's case.
  const left = foldCase(a)
  const right = foldCase(b)
  if (left === right) return true
  const prefix = right.endsWith(sep) ? right : `${right}${sep}`
  return left.startsWith(prefix)
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
  const wanted = foldCase(canon(target))
  if (files.some((file) => foldCase(canon(file)) === wanted)) return true
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
      const name = String(exec?.name ?? '')
      if (!BARE_WRITERS.has(name)) return undefined

      const raw = writeTargets(name, exec?.arguments)
      if (raw.length === 0) return undefined

      const cwd = resolveCwd({ agent: exec?.agent }, ctx)
      const probe = probeEnvironment({ cfg, cwd, detail: false })
      for (const candidate of raw) {
        if (!isAbsolute(candidate) && !cwd) continue
        const target = isAbsolute(candidate) ? candidate : resolve(cwd, candidate)
        if (isMemoryTarget(target, probe)) return t('guard.refused', { path: candidate })
      }
      return undefined
    }),
  )
  return true
}
