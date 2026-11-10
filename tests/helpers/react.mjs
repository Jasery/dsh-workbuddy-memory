/**
 * A minimal React runtime, just enough to drive a component through clicks.
 *
 * The panel is one component with hooks and fetch calls; freezing only its pure
 * helpers left every interaction untested. This runs the real component with a
 * real hook order, real effect deps and real re-renders, so a test can click a
 * row and assert what the fetch layer was asked to do.
 *
 * Not a general implementation: one mounted component, no keys, no context.
 */

export function createRuntime() {
  const hooks = []
  let index = 0
  let dirty = false
  let effects = []

  const sameDeps = (a, b) => Boolean(a && b) && a.length === b.length && a.every((value, at) => Object.is(value, b[at]))

  const api = {
    createElement(type, props, ...children) {
      const flat = children.flat().filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: props ?? {}, children: flat }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const at = index++
      if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(hooks[at]) : next
        if (Object.is(value, hooks[at])) return
        hooks[at] = value
        dirty = true
      }
      return [hooks[at], set]
    },
    useRef(initial) {
      const at = index++
      if (!(at in hooks)) hooks[at] = { current: initial ?? null }
      return hooks[at]
    },
    useEffect(fn, deps) {
      const at = index++
      const previous = hooks[at]
      if (previous && (!deps || sameDeps(previous.deps, deps))) return
      hooks[at] = { deps }
      effects.push(() => {
        previous?.cleanup?.()
        const cleanup = fn()
        if (typeof cleanup === 'function') hooks[at].cleanup = cleanup
      })
    },
    useMemo(fn, deps) {
      const at = index++
      const previous = hooks[at]
      if (previous && deps && sameDeps(previous.deps, deps)) return previous.value
      const value = fn()
      hooks[at] = { deps, value }
      return value
    },
    useCallback(fn, deps) {
      return api.useMemo(() => fn, deps)
    },
  }

  /** Run the component, its effects, and any re-render they cause. */
  async function settle(Component, props, { turns = 12 } = {}) {
    let tree = null
    for (let turn = 0; turn < turns; turn += 1) {
      dirty = false
      effects = []
      index = 0
      tree = Component(props)
      for (const effect of effects) effect()
      await tick()
      if (!dirty) return tree
    }
    return tree
  }

  /** Feed an event to a node's handler, then let the resulting renders settle. */
  async function fire(node, handler, Component, props, event = {}) {
    const fn = node?.props?.[handler]
    if (typeof fn !== 'function') throw new Error(`no ${handler} on ${describeNode(node)}`)
    await fn({ preventDefault() {}, stopPropagation() {}, target: { value: event.value }, currentTarget: { blur() {} }, ...event })
    return settle(Component, props)
  }

  return {
    api,
    settle,
    fire,
    /** Forget every hook slot, as if the component had just mounted. */
    reset() {
      hooks.length = 0
      index = 0
      dirty = false
      effects = []
    },
  }
}

/** Let pending promises and timers run one round. */
export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** All elements in a rendered tree, depth first. */
export function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** Flattened text of a rendered tree. */
export function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return (node.children ?? []).map(text).join('')
}

/** First node whose text contains `needle`. */
export function byText(node, needle) {
  return walk(node).find((candidate) => text(candidate).includes(needle)) ?? null
}

function describeNode(node) {
  if (!node) return 'null'
  return typeof node.type === 'string' ? `<${node.type}>` : String(node.type?.name ?? node.type)
}
