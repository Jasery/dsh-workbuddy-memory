/** Tool registry for this plugin. */

import { statusTool } from './status.js'

/**
 * Register every tool this build ships.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {(key: string, vars?: Record<string, string|number>) => string} deps.t
 * @returns {{ names: string[] }}
 */
export function registerTools(ctx, deps) {
  const tools = [statusTool(deps)]
  for (const tool of tools) ctx.tools.register(tool)
  return { names: tools.map((tool) => tool.name) }
}
