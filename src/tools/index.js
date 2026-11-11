/** Tool registry for this plugin. */

import { statusTool } from './status.js'
import { readTool } from './read.js'
import { appendTool, editTool, pruneTool } from './write.js'
import { searchTool } from './search.js'

/** Store methods that change a file, and so invalidate what was injected. */
const MUTATORS = ['append', 'edit', 'editAt', 'remove', 'replaceSection', 'replaceDocument', 'removeSection', 'restore', 'prune']

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
 * Wrap the store so every committed write announces itself.
 *
 * The injected prefix is frozen for `inject.refresh: 'first-turn'`, and even
 * `on-change` caches per assembly. Without this notification the model writes
 * memory and then keeps reading the version from before its own write.
 *
 * @param {object} store
 * @param {() => void} onWrite
 */
function withWriteNotice(store, onWrite) {
  if (!store || typeof onWrite !== 'function') return store
  const wrapped = { ...store }
  for (const name of MUTATORS) {
    const original = store[name]
    if (typeof original !== 'function') continue
    wrapped[name] = async (...args) => {
      const result = await original.apply(store, args)
      if (result?.ok) {
        try {
          onWrite()
        } catch {
          // A cache miss is cheaper than a failed write.
        }
      }
      return result
    }
  }
  return wrapped
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
 * `search.enabled` is read at registration time as well as inside the tool, so
 * turning it off removes the tool from the model's catalog instead of leaving a
 * definition that only ever returns a refusal.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {(key: string, vars?: Record<string, string|number>) => string} deps.t
 * @param {object} deps.store
 * @param {() => void} [deps.onWrite] - called after a committed write.
 * @returns {{ names: string[] }}
 */
export function registerTools(ctx, deps) {
  const scoped = { ...deps, store: withWriteNotice(deps.store, deps.onWrite) }
  const tools = [statusTool(scoped), readTool(scoped)]
  if (scoped.cfg.search.enabled) tools.push(searchTool(scoped))
  tools.push(appendTool(scoped), editTool(scoped), pruneTool(scoped))
  for (const tool of tools) ctx.tools.register(harden(tool))
  return { names: tools.map((tool) => tool.name) }
}
