/**
 * dsh-workbuddy-memory — one set of Markdown memory files, two clients.
 *
 * WorkBuddy owns the files; this plugin reads them into the DSH system prompt
 * and writes them back through guarded tools. No second copy, no sync daemon.
 */

import { Config, normalizeConfig } from './config.js'
import { createTranslator, resolveLanguage } from './locale.js'
import { registerSections } from './inject.js'
import { registerTools } from './tools/index.js'

export const name = 'dsh-workbuddy-memory'
export const inject = ['systemPrompt', 'tools']
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  let cfg
  try {
    cfg = normalizeConfig(config)
  } catch (error) {
    ctx.logger?.warn?.(`[workbuddy-memory] invalid config, falling back to defaults: ${error?.message ?? error}`)
    cfg = normalizeConfig({})
  }

  const t = createTranslator(resolveLanguage(cfg.locale))

  try {
    registerSections(ctx, { cfg, t })
  } catch (error) {
    // A broken injection path must not stop the tools from working.
    ctx.logger?.warn?.(`[workbuddy-memory] section registration failed: ${error?.message ?? error}`)
  }

  try {
    registerTools(ctx, { cfg, t })
  } catch (error) {
    ctx.logger?.warn?.(`[workbuddy-memory] tool registration failed: ${error?.message ?? error}`)
  }
}
