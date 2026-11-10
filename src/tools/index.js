/** Tool registry for this plugin. */

import { statusTool } from './status.js'
import { readTool } from './read.js'
import { appendTool, consolidateTool, editTool } from './write.js'
import { searchTool } from './search.js'

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
 * @returns {{ names: string[] }}
 */
export function registerTools(ctx, deps) {
  const tools = [statusTool(deps), readTool(deps)]
  if (deps.cfg.search.enabled) tools.push(searchTool(deps))
  tools.push(appendTool(deps), editTool(deps), consolidateTool(deps))
  for (const tool of tools) ctx.tools.register(tool)
  return { names: tools.map((tool) => tool.name) }
}
