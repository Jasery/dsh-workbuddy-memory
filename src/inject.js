/**
 * System-prompt injection.
 *
 * Four sections, registered once and always present at their `order`. Each
 * provider decides per assembly whether it has text: returning `''` makes the
 * host drop that section, which is how turning a block off takes effect
 * without reloading the plugin.
 *
 * The working directory comes from `context.agent.session.header.cwd`. That
 * field is not in the public `AssembleContext` type — the agent loop extends it,
 * and the loop's own prompt variables read it the same way. If it is missing,
 * the project block is skipped rather than falling back to `process.cwd()`:
 * injecting another project's memory is worse than injecting none.
 */

import { createAssemblyCache, createFrozenStore } from './cache.js'
import { probeEnvironment } from './env.js'
import { renderSections, SECTION_ORDER } from './render.js'

const SECTION_NAMES = {
  project: 'workbuddy-memory:project',
  rules: 'workbuddy-memory:rules',
  user: 'workbuddy-memory:user',
  profile: 'workbuddy-memory:profile',
}

/**
 * Read the session working directory out of the assemble context.
 *
 * @param {object} context
 * @returns {string|null}
 */
export function resolveCwd(context) {
  const cwd = context?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

/**
 * Register the four memory sections.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {(key: string, vars?: Record<string, string|number>) => string} deps.t
 * @param {(key: string) => void} [deps.onProbe]
 */
export function registerSections(ctx, deps) {
  const { cfg, t, onProbe } = deps
  const perAssembly = createAssemblyCache()
  const frozen = createFrozenStore()

  /**
   * Probe + render for one assembly.
   * @param {object} context
   */
  const build = (context) => {
    const cwd = resolveCwd(context)
    const probe = probeEnvironment({ cfg, cwd, detail: false })
    if (typeof onProbe === 'function') onProbe(probe)
    return { cwd, probe, sections: renderSections({ cfg, probe, t }) }
  }

  /**
   * The state for this assembly, honouring the refresh mode.
   * @param {object} context
   */
  const stateFor = (context) => {
    if (!cfg.inject.enabled) return { sections: [] }

    if (cfg.inject.refresh === 'first-turn') {
      const key = `${resolveCwd(context) ?? '(no-cwd)'}`
      return /** @type {{ sections: {name: string, text: string}[] }} */ (frozen.get(key, () => build(context)))
    }

    return /** @type {{ sections: {name: string, text: string}[] }} */ (perAssembly.get(context, () => build(context)))
  }

  for (const [key, name] of Object.entries(SECTION_NAMES)) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name,
        order: SECTION_ORDER[key],
        interpolate: false,
        text: (context) => {
          try {
            const state = stateFor(context)
            const hit = state.sections.find((section) => section.name === name)
            return hit?.text ?? ''
          } catch (error) {
            // Never break a turn because memory could not be read.
            ctx.logger?.warn?.(`[workbuddy-memory] section ${name} failed: ${error?.message ?? error}`)
            return ''
          }
        },
      }),
    )
  }

  return {
    /** Drop the frozen snapshot, e.g. after this plugin writes a memory file. */
    invalidate() {
      frozen.clear()
    },
  }
}
