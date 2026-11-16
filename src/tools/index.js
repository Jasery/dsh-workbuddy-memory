/** Tool registry for this plugin. */

import { statusTool } from './status.js'
import { readTool } from './read.js'
import { appendTool, editTool } from './write.js'
import { searchTool } from './search.js'

/**
 * Make a tool result survive the host's lossless-JSON gate.
 *
 * The host snapshots every tool result and rejects it when any property is
 * `undefined`, not finite, or `-0`. A rejected snapshot fails *after* the write
 * already landed, so the caller sees `value is not lossless JSON` for a write
 * that actually succeeded — the worst shape of error, because a retry without
 * the same idempotency key writes twice.
 *
 * Store results are plain data, so the fix is to drop nothing and coerce:
 * `undefined` becomes `null` (a present-but-empty field, which is what the
 * callers already treat it as), and non-finite numbers become `null`.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen] - cycle guard; a repeated object is cut to null.
 * @returns {unknown} the same shape, lossless.
 */
export function lossless(value, seen = new WeakSet()) {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : null
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return null
  if (typeof value !== 'object') return value
  if (seen.has(value)) return null
  seen.add(value)

  if (Array.isArray(value)) {
    const out = value.map((entry) => lossless(entry, seen))
    seen.delete(value)
    return out
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = lossless(entry, seen)
  seen.delete(value)
  return out
}

/**
 * Run a tool body and return a result the host can always snapshot.
 *
 * @template T
 * @param {() => Promise<T>|T} body
 * @returns {Promise<unknown>}
 */
function safeResult(body) {
  return Promise.resolve()
    .then(body)
    .then((value) => lossless(value))
}

/** Replace a tool's execute with one whose result is sanitized. */
function harden(tool) {
  const execute = tool.execute
  if (typeof execute !== 'function') return tool
  return {
    ...tool,
    async execute(args, exec) {
      return safeResult(() => execute.call(tool, args, exec))
    },
  }
}

/**
 * Register every tool this build ships.
 *
 * The set is deliberately five: `status`, `read`, `search`, `append`, `edit`.
 * Bulk management — rewriting a whole section, restoring a backup, archiving old
 * daily logs — lives in the panel, where a person sees a preview and a diff
 * before the write. Registering those as tools as well meant the model could
 * perform the same destructive edits with nothing in front of it but its own
 * reasoning, and the version fence cannot ask "did you mean this?".
 *
 * There are no alias stubs for the retired names either: a definition that only
 * ever refuses still advertises an ability the model does not have.
 *
 * `search.enabled` is read at registration time as well as inside the tool, so
 * turning it off removes the tool from the model's catalog instead of leaving a
 * definition that only ever returns a refusal.
 *
 * The returned controller disposes exactly the registrations it made, so a
 * volatile change can remount the set without leaving the previous
 * `memory_read` (or a second one) behind.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {(key: string, vars?: Record<string, string|number>) => string} deps.t
 * @param {object} deps.store
 * @returns {{ names: string[], dispose: () => void }}
 */
export function registerTools(ctx, deps) {
  const scoped = { ...deps, ctx }
  const tools = [statusTool(scoped), readTool(scoped)]
  if (scoped.cfg.search.enabled) tools.push(searchTool(scoped))
  tools.push(appendTool(scoped), editTool(scoped))

  const disposers = []
  const dispose = () => {
    while (disposers.length > 0) {
      const off = disposers.pop()
      try {
        off()
      } catch {
        // One failed unregister must not strand the rest of the set.
      }
    }
  }

  try {
    for (const tool of tools) {
      const off = ctx.tools.register(harden(tool))
      if (typeof off === 'function') disposers.push(off)
    }
  } catch (error) {
    dispose()
    throw error
  }

  return { names: tools.map((tool) => tool.name), dispose }
}
