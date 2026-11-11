/** Tool registry for this plugin. */

import { statusTool } from './status.js'
import { readTool } from './read.js'
import { appendTool, editTool, pruneTool } from './write.js'
import { searchTool } from './search.js'

/** Store methods that change a file, and so invalidate what was injected. */
const MUTATORS = ['append', 'edit', 'editAt', 'remove', 'replaceSection', 'replaceDocument', 'removeSection', 'restore', 'prune']

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
  for (const tool of tools) ctx.tools.register(tool)
  return { names: tools.map((tool) => tool.name) }
}
