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

/** Replace `target`'s values in place, so every closure keeps one `cfg` object. */
function deepAssign(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      deepAssign(current, value)
    } else {
      target[key] = value
    }
  }
  return target
}

/**
 * A context whose `effect()` calls are recorded, so a registration helper that
 * only returns a boolean can still be unmounted precisely.
 */
function effectBag(ctx) {
  const disposers = []
  const scoped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'effect') {
        return (fn) => {
          const off = target.effect(fn)
          if (typeof off === 'function') disposers.push(off)
          return off
        }
      }
      const value = Reflect.get(target, property)
      // Services are returned as objects; helper methods keep the real context
      // as `this` so a wrapper never changes how the host resolves them.
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    ctx: scoped,
    dispose() {
      while (disposers.length > 0) {
        const off = disposers.pop()
        try {
          off()
        } catch {
          // A failed unregister must not strand the rest.
        }
      }
    },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const rawConfig = config
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
  const mountSections = () => {
    sections?.dispose?.()
    sections = null
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
  }
  mountSections()

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
  } catch (error) {
    ctx.logger?.warn?.(`[workbuddy-memory] store creation failed: ${error?.message ?? error}`)
  }

  let tools = null
  const mountTools = () => {
    tools?.dispose?.()
    tools = null
    if (!store) return
    try {
      tools = registerTools(ctx, { cfg, t, store, onWrite: () => sections?.invalidate?.() })
    } catch (error) {
      ctx.logger?.warn?.(`[workbuddy-memory] tool registration failed: ${error?.message ?? error}`)
    }
  }

  let guard = null
  const mountGuard = () => {
    guard?.dispose?.()
    guard = null
    if (typeof ctx.tools?.guard !== 'function' || !cfg.guard?.enabled) return

    const bag = effectBag(ctx)
    try {
      const registered = registerWriteGuard(bag.ctx, { cfg, t })
      if (registered) guard = bag
      else bag.dispose()
    } catch (error) {
      bag.dispose()
      ctx.logger?.warn?.(`[workbuddy-memory] guard registration failed: ${error?.message ?? error}`)
    }
  }

  let routesFiber = null
  let routesDispose = null
  const unmountRoutes = () => {
    if (typeof routesDispose === 'function') {
      try {
        routesDispose()
      } catch {
        // Fall through to the fiber, which owns the same registrations.
      }
    }
    routesDispose = null
    try {
      routesFiber?.dispose?.()
    } catch {
      // The plugin is going away anyway; a failed fiber dispose is not fatal.
    }
    routesFiber = null
  }
  const mountRoutes = () => {
    unmountRoutes()
    if (!cfg.ui.enabled) return
    try {
      const mounted = ctx.inject(['webServer'], (scoped) => {
        try {
          // The panel writes through the same store the tools use. It is one
          // instance per plugin, so a panel write and a tool write queue on the
          // same lock.
          registerRoutes(scoped, { cfg, recent, stateDir, version: VERSION, store, catalog })
        } catch (error) {
          ctx.logger?.warn?.(`[workbuddy-memory] panel routes failed: ${error?.message ?? error}`)
        }
      })
      // A real host returns a fiber; the test double returns a plain disposer.
      if (typeof mounted === 'function') routesDispose = mounted
      else routesFiber = mounted
    } catch (error) {
      ctx.logger?.warn?.(`[workbuddy-memory] panel injection failed: ${error?.message ?? error}`)
    }
  }

  mountTools()
  mountGuard()
  mountRoutes()

  /**
   * The host rewrites the references in place, then names the paths it changed.
   * Re-read the same raw object, deep-update the one `cfg` every closure holds,
   * and remount only the registrations whose shape depends on the change. A
   * context without `on` simply has no hot path — it must not pretend to have
   * one.
   */
  const onVolatileUpdate = (paths) => {
    let next
    try {
      next = normalizeConfig(rawConfig)
    } catch (error) {
      ctx.logger?.warn?.(`[workbuddy-memory] volatile update failed: ${error?.message ?? error}`)
      return
    }
    deepAssign(cfg, next)
    sections?.invalidate?.()

    const changed = Array.isArray(paths) ? paths.filter(Array.isArray) : []
    const all = changed.length === 0
    const top = new Set(changed.map((path) => path[0]))

    if (all || top.has('inject')) mountSections()
    if (all || top.has('search') || changed.some((path) => path[0] === 'ui' && path[1] === 'allowWriteActions')) {
      mountTools()
    }
    if (all || top.has('guard')) mountGuard()
    if (all || top.has('ui')) mountRoutes()
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('loader/volatile-update', onVolatileUpdate)
    } catch (error) {
      ctx.logger?.warn?.(`[workbuddy-memory] volatile subscription failed: ${error?.message ?? error}`)
    }
  }
}
