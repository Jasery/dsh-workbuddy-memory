import { createAssemblyCache, createFileCache } from './cache.js'
import { probeEnvironment } from './env.js'
import { renderSections, SECTION_ORDER } from './render.js'

const SECTION_NAMES = { project: 'workbuddy-memory:project', rules: 'workbuddy-memory:rules', user: 'workbuddy-memory:user', profile: 'workbuddy-memory:profile' }

export function resolveCwd(context, ctx) {
  const session = context?.agent?.session
  try {
    const workingDirectory = ctx?.get?.('workingDirectory')?.get?.(session)
    if (typeof workingDirectory === 'string' && workingDirectory.length > 0) return workingDirectory
  } catch {}
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

export function registerSections(ctx, deps) {
  const { cfg, t, onProbe, onCommit } = deps
  let perAssembly = createAssemblyCache()
  const fileCache = createFileCache()
  const firstTurn = new WeakMap()
  const assembled = new WeakMap()
  const disposers = []
  let generation = 0
  const signature = () => JSON.stringify(cfg)
  const dispose = () => { while (disposers.length) { try { disposers.pop()?.() } catch {} } }

  const build = (context) => {
    const cwd = resolveCwd(context, ctx)
    const probe = probeEnvironment({ cfg, cwd, detail: false })
    if (typeof onProbe === 'function') onProbe(probe, cwd)
    const sections = cfg.inject.enabled ? renderSections({ cfg, probe, t, readFile: (path) => fileCache.read(path) }) : []
    // The topic directory shares the `profile` section name with the profile
    // block, so its state is read from `directory` rather than from the name.
    const blocks = sections.map(({ name, text }) => {
      const key = name.slice('workbuddy-memory:'.length)
      const state = name === 'workbuddy-memory:profile' && sections.states?.directory
        ? sections.states.directory
        : sections.states?.[key]
      return { name, chars: text.length, state: state ?? (text ? 'enabled' : 'disabled') }
    })
    const session = context?.agent?.session
    if (session && typeof session === 'object') {
      assembled.set(session, {
        cwd,
        blocks,
        totalChars: blocks.reduce((sum, block) => sum + block.chars, 0),
        states: sections.states ?? {},
        mode: sections.mode ?? cfg.inject.mode,
        generation,
        configSignature: signature(),
      })
    }
    return { cwd, probe, sections }
  }

  const stateFor = (context) => {
    if (!cfg.inject.enabled) return { sections: [] }
    const session = context?.agent?.session
    const cwd = resolveCwd(context, ctx)
    const configSignature = signature()
    if (cfg.inject.refresh === 'first-turn' && session && typeof session === 'object') {
      const previous = firstTurn.get(session)
      if (previous && previous.cwd === cwd && previous.generation === generation && previous.configSignature === configSignature) return previous.state
      const state = build(context)
      firstTurn.set(session, { cwd, generation, configSignature, state })
      return state
    }
    return perAssembly.get(context, () => build(context))
  }

  try {
    for (const [key, name] of Object.entries(SECTION_NAMES)) {
      const off = ctx.effect(() => ctx.systemPrompt.section({
        name,
        order: SECTION_ORDER[key],
        interpolate: false,
        text: (context) => {
          try { return stateFor(context).sections.find((section) => section.name === name)?.text ?? '' }
          catch (error) {
            ctx.logger?.warn?.(`[workbuddy-memory] section ${name} failed: ${error?.message ?? error}`)
            return ''
          }
        },
      }))
      if (typeof off === 'function') disposers.push(off)
    }
  } catch (error) { dispose(); throw error }

  const unsubscribe = typeof onCommit === 'function' ? onCommit((event) => {
    fileCache.invalidate(event?.path)
    generation += 1
    perAssembly = createAssemblyCache()
  }) : null

  return {
    invalidate() { generation += 1; perAssembly = createAssemblyCache() },
    lastAssembly(session) {
      if (!session || typeof session !== 'object') return null
      const value = assembled.get(session)
      if (!value || value.generation !== generation || value.configSignature !== signature()) return null
      return { cwd: value.cwd, blocks: value.blocks, totalChars: value.totalChars, states: value.states, mode: value.mode, measuredAs: 'plugin-contribution' }
    },
    dispose() { try { unsubscribe?.() } catch {}; dispose() },
  }
}
