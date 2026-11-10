/**
 * dsh-workbuddy-memory — one set of Markdown memory files, two clients.
 *
 * WorkBuddy owns the files; this plugin reads them into the DSH system prompt
 * and writes them back through guarded tools. No second copy, no sync daemon.
 */

import { readFileSync } from 'node:fs'
import { Config, normalizeConfig } from './config.js'
import { createTranslator, resolveLanguage } from './locale.js'
import { registerSections } from './inject.js'
import { registerTools } from './tools/index.js'
import { registerWriteGuard } from './write/guard.js'
import { registerRoutes } from './host/routes.js'
import { createStore } from './write/store.js'
import { resolveStateDir } from './paths.js'

export const name = 'dsh-workbuddy-memory'
export const inject = ['systemPrompt', 'tools']
export { Config }

/** Package version, read once for the panel's status line. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

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

  // The panel has no agent scope, so it shows the project the last prompt
  // assembly saw. That is the same project the chat is talking about.
  const recent = { cwd: null }

  let sections = null
  try {
    sections = registerSections(ctx, {
      cfg,
      t,
      onProbe: (_probe, cwd) => {
        if (typeof cwd === 'string' && cwd.length > 0) recent.cwd = cwd
      },
    })
  } catch (error) {
    // A broken injection path must not stop the tools from working.
    ctx.logger?.warn?.(`[workbuddy-memory] section registration failed: ${error?.message ?? error}`)
  }

  let stateDir = ''
  let store = null
  try {
    stateDir = resolveStateDir(cfg.stateDir).path
    store = createStore({ cfg, stateDir })
    registerTools(ctx, { cfg, t, store })
    registerWriteGuard(ctx, { cfg, t })
    void sections
  } catch (error) {
    ctx.logger?.warn?.(`[workbuddy-memory] tool registration failed: ${error?.message ?? error}`)
  }

  if (cfg.ui.enabled) {
    // Optional: headless profiles have no web server, and that must not stop
    // the plugin from loading.
    ctx.inject(['webServer'], (scoped) => {
      try {
        // The panel writes through the same store the tools use. It is one
        // instance per plugin, so a panel write and a tool write queue on the
        // same lock.
        registerRoutes(scoped, { cfg, recent, stateDir, version: VERSION, store })
      } catch (error) {
        ctx.logger?.warn?.(`[workbuddy-memory] panel routes failed: ${error?.message ?? error}`)
      }
    })
  }
}
