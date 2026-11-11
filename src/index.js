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
import { createProjectCatalog } from './host/catalog.js'
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

  // The panel has no agent scope: it does not know which project a browser tab
  // belongs to. What it can know is which working directories this plugin has
  // assembled a prompt for, so it offers that list and nothing else — a project
  // the panel has never seen cannot be addressed, which keeps the route from
  // becoming a file browser.
  const recent = {
    cwd: null,
    /** @type {Map<string, number>} cwd → last seen, newest last. */
    seen: new Map(),
    /** Remember a workspace, capped so a long session cannot grow it forever. */
    note(cwd) {
      if (typeof cwd !== 'string' || cwd.length === 0) return
      recent.cwd = cwd
      recent.seen.delete(cwd)
      recent.seen.set(cwd, Date.now())
      while (recent.seen.size > 12) recent.seen.delete(recent.seen.keys().next().value)
    },
  }

  let sections = null
  try {
    sections = registerSections(ctx, {
      cfg,
      t,
      onProbe: (_probe, cwd) => recent.note(cwd),
    })
  } catch (error) {
    // A broken injection path must not stop the tools from working.
    ctx.logger?.warn?.(`[workbuddy-memory] section registration failed: ${error?.message ?? error}`)
  }

  // The panel's project list prefers DSH's durable workspace registry. It is
  // read without declaring a dependency: the service may activate after this
  // plugin, and the catalog degrades to `recent.seen` when a profile does not
  // compose it.
  const catalog = createProjectCatalog({
    cfg,
    recent,
    registry: () => ctx.get?.('workspaceRegistry')?.list?.() ?? [],
  })

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
        registerRoutes(scoped, { cfg, recent, stateDir, version: VERSION, store, catalog })
      } catch (error) {
        ctx.logger?.warn?.(`[workbuddy-memory] panel routes failed: ${error?.message ?? error}`)
      }
    })
  }
}
