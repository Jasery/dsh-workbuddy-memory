/**
 * The browser half, rendered with a four-hook React stand-in.
 *
 * The point is not to simulate a browser: it is to freeze the contract between
 * the panel and whatever the host hands it. Two bugs in a row came from reading
 * fields the host had stopped sending (`snap.mode`), so the snapshot shape is
 * asserted here rather than discovered in a browser.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** Capture the module the host would have loaded. */
function loadClient() {
  let exported
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        exported = factory(fakeRequire)
      },
    },
  }
  // The module registers itself on import.
  return import('../src/client.js').then(() => {
    delete globalThis.window
    return exported
  })
}

/** Just enough React for a single synchronous render. */
const fakeRequire = (name) => {
  if (name !== 'react') throw new Error(`unexpected require: ${name}`)
  return {
    createElement(type, props, ...children) {
      const flat = children.flat().filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: props ?? {}, children: flat }
    },
    Fragment: 'Fragment',
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useRef(value) {
      return { current: value ?? null }
    },
  }
}

/** Expand function components so the tree contains only host elements. */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { type: node.type, props: node.props, children: (node.children ?? []).map(expand).filter((c) => c !== null) }
}

/** Every element in a rendered tree, depth first. */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** Text of a rendered tree, flattened. */
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(text).join('')
}

const module = await loadClient()
const { humanBytes, getJson, MemoryOverviewPanel, OverviewIcon, SettingsCard, PANEL_OVERVIEW, API } = module.__internals

test('the module exports what the host mounts', () => {
  assert.equal(typeof module.apply, 'function')
  // `locale` is a service name the client runtime injects; without it the panel
  // has no host language and silently keeps its own copy.
  assert.deepEqual(module.inject, ['slots', 'locale'])
  assert.equal(PANEL_OVERVIEW, 'workbuddy-memory')
  assert.equal(API, '/workbuddy-memory')
})

test('humanBytes covers the units a memory file uses', () => {
  assert.equal(humanBytes(0), '0 B')
  assert.equal(humanBytes(999), '999 B')
  assert.equal(humanBytes(1024), '1.0 KB')
  assert.equal(humanBytes(23_743), '23.2 KB')
  assert.equal(humanBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(humanBytes(undefined), '—')
  assert.equal(humanBytes(NaN), '—')
})

test('getJson reports the host error code, not an opaque failure', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: 1 }) })
    assert.deepEqual(await getJson(`${API}/state`), { ok: true, value: 1 })

    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, code: 'no_route' }) })
    await assert.rejects(() => getJson(`${API}/state`), /no_route/)

    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } })
    await assert.rejects(() => getJson(`${API}/state`), /bad_json/)
  } finally {
    globalThis.fetch = original
  }
})

test('the overview names the aggregate scope before anything is selected', () => {
  const tree = expand(MemoryOverviewPanel({}))
  const body = text(tree)
  assert.match(body, /全部项目/)
  assert.match(body, /还没有任何项目写过记忆/)
})

test('the overview icon is a standalone svg', () => {
  const icon = expand(OverviewIcon())
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.viewBox, '0 0 24 24')
})

/** A snapshot shaped like the 0.2.2 host sends: no `mode` field. */
function snapshot(overrides = {}) {
  return {
    status: 'ready',
    value: { inject: {}, write: {}, search: {}, guard: {}, ui: {} },
    base: undefined,
    user: undefined,
    revision: 3,
    writable: true,
    ...overrides,
  }
}

function fakeForm(snap) {
  return { getSnapshot: () => snap, subscribe: () => () => {}, set: async () => true }
}

test('a writable snapshot leaves every control enabled', () => {
  const tree = expand(SettingsCard({ form: fakeForm(snapshot({ value: { inject: {}, write: {}, search: {}, guard: {}, ui: { allowWriteActions: true } } })) }))
  const inputs = walk(tree).filter((node) => node.type === 'input')

  assert.equal(inputs.length >= 7, true, 'the card should render its switches')
  assert.equal(inputs.every((node) => node.props.disabled === false), true, 'a writable form must stay editable')
  assert.match(text(tree), /revision 3/)
  assert.match(text(tree), /可写/)
})

test('full-text editing follows the panel write switch', () => {
  const on = expand(
    SettingsCard({
      form: fakeForm(
        snapshot({
          value: { inject: {}, write: {}, search: {}, guard: {}, ui: { allowWriteActions: true, allowFullTextEdit: true } },
        }),
      ),
    }),
  )
  const onInputs = walk(on).filter((node) => node.type === 'input')
  assert.equal(onInputs.every((node) => node.props.disabled === false), true, 'write + full text on leaves every control enabled')

  const off = expand(
    SettingsCard({
      form: fakeForm(snapshot({ value: { inject: {}, write: {}, search: {}, guard: {}, ui: { allowWriteActions: false } } })),
    }),
  )
  const disabled = walk(off).filter((node) => node.type === 'input' && node.props.disabled === true)
  assert.equal(disabled.length >= 1, true, 'full text cannot be enabled while panel writes are off')
})

test('the card keys editability off `writable`, not off a mode field', () => {
  // 0.2.2 dropped `mode`; a snapshot without it must still be editable.
  const snap = snapshot({ value: { inject: {}, write: {}, search: {}, guard: {}, ui: { allowWriteActions: true } } })
  assert.equal('mode' in snap, false)
  const inputs = walk(expand(SettingsCard({ form: fakeForm(snap) }))).filter((node) => node.type === 'input')
  assert.equal(inputs.every((node) => node.props.disabled === false), true)
})

test('a host that refuses writes disables the controls', () => {
  const tree = expand(SettingsCard({ form: fakeForm(snapshot({ writable: false })) }))
  const inputs = walk(tree).filter((node) => node.type === 'input')
  assert.equal(inputs.every((node) => node.props.disabled === true), true)
  assert.match(text(tree), /只读/)
})

test('an overridden field is reported as such', () => {
  const withUser = expand(SettingsCard({ form: fakeForm(snapshot({ user: { readOnly: true } })) }))
  assert.match(text(withUser), /有本机覆盖/)

  const plain = expand(SettingsCard({ form: fakeForm(snapshot()) }))
  assert.match(text(plain), /跟随默认/)
})

test('loading and unavailable snapshots say so instead of rendering an empty form', () => {
  const loading = expand(SettingsCard({ form: fakeForm(snapshot({ status: 'loading' })) }))
  assert.match(text(loading), /读取配置/)

  const unavailable = expand(SettingsCard({ form: fakeForm(snapshot({ status: 'unavailable' })) }))
  assert.match(text(unavailable), /无法写入宿主配置/)
})

const { ratio, filterEntries, highlightParts, lineDiff, describeCode, shortPath } = module.__internals

test('ratio reports how full a limit is, and says when it overflows', () => {
  assert.deepEqual(ratio(0, 100), { value: 0, percent: 0, level: 'ok' })
  assert.deepEqual(ratio(50, 100), { value: 0.5, percent: 50, level: 'ok' })
  assert.equal(ratio(85, 100).level, 'warn')
  assert.deepEqual(ratio(120, 100), { value: 1, percent: 120, level: 'over' })
  // A zero limit means "no cap", not "always full".
  assert.deepEqual(ratio(10, 0), { value: 0, percent: 0, level: 'none' })
})

test('filterEntries matches case-insensitively and ignores a blank query', () => {
  const rows = [{ text: 'Node 22' }, { text: 'docker' }]
  assert.equal(filterEntries(rows, '').length, 2)
  assert.deepEqual(filterEntries(rows, 'NODE').map((row) => row.text), ['Node 22'])
  assert.deepEqual(filterEntries(rows, '   ').map((row) => row.text), ['Node 22', 'docker'])
  assert.equal(filterEntries(rows, 'nope').length, 0)
})

test('highlightParts splits around the first hit only', () => {
  assert.deepEqual(highlightParts('a Node b node c', 'node'), { before: 'a ', hit: 'Node', after: ' b node c' })
  assert.deepEqual(highlightParts('plain', 'zzz'), { before: 'plain', hit: '', after: '' })
  assert.deepEqual(highlightParts('plain', ''), { before: 'plain', hit: '', after: '' })
})

test('lineDiff counts added and removed rows', () => {
  const diff = lineDiff('a\nb\nc\n', 'a\nB\nc\n')
  assert.equal(diff.truncated, false)
  assert.equal(diff.added, 1)
  assert.equal(diff.removed, 1)
  assert.deepEqual(
    diff.rows.filter((row) => row.type !== 'same').map((row) => row.text),
    ['b', 'B'],
  )
})

test('lineDiff refuses to build a table for a huge file', () => {
  const big = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n')
  const diff = lineDiff(big, big.replace('line 0', 'line zero'))
  assert.equal(diff.truncated, true)
  assert.equal(diff.reason, 'too_large')
})

test('a refusal code becomes a sentence a person can act on', () => {
  assert.match(describeCode('write_actions_disabled'), /面板写操作/)
  assert.match(describeCode('conflict'), /被改过/)
  // An unmapped code is shown as-is rather than swallowed.
  assert.equal(describeCode('weird_new_code'), 'weird_new_code')
})

test('paths in the status bar keep their tail, not their depth', () => {
  assert.equal(shortPath(String.raw`C:\Users\admin\.workbuddy`), '…/admin/.workbuddy')
  assert.equal(shortPath('D:/git/x'), 'D:/git/x')
  assert.equal(shortPath(''), '—')
  assert.equal(shortPath(null), '—')
})

// The file already holds one loaded module (line 79); ESM evaluates client.js
// exactly once, so a second load would resolve to undefined.

test('the panel follows the host language, not a hardcoded one', async () => {
  const { bindCopy } = module.__internals

  // Node exposes `navigator` as a getter-only global, so it is replaced through
  // a property definition rather than assignment.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const setNavigator = (value) => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  }
  try {
    setNavigator({ language: 'zh-CN', languages: ['zh-CN'] })
    assert.match(bindCopy(null)('code.read_only'), /只读/)

    setNavigator({ language: 'en-US', languages: ['en-US'] })
    assert.match(bindCopy(null)('code.read_only'), /Read-only/)
  } finally {
    if (original === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', original)
  }
})

test('a host locale service wins over the browser', async () => {
  const { bindCopy } = module.__internals

  // A host that answers Chinese while the browser says English: the host wins.
  const hostZh = bindCopy({ locale: { bind: () => (key) => (key === 'code.read_only' ? '来自宿主的译文' : key) } })
  assert.equal(hostZh('code.read_only'), '来自宿主的译文')

  // A host that misses the key leaves the local dictionary to answer.
  const hostMiss = bindCopy({ locale: { bind: () => (key) => key } })
  assert.match(hostMiss('code.read_only'), /只读|Read-only/)

  // A host that throws must not take the panel down with it.
  const hostThrows = bindCopy({
    locale: {
      bind: () => () => {
        throw new Error('locale torn down')
      },
    },
  })
  assert.match(hostThrows('code.read_only'), /只读|Read-only/)
})

test('placeholders are filled from the vars argument', async () => {
  const { bindCopy } = module.__internals
  const t = bindCopy(null)

  // Both dictionaries carry the same placeholder names, so the assertion works
  // whichever language the runner happens to resolve.
  const text = t('count.entries', { n: 7 })
  assert.match(text, /7/)
  assert.doesNotMatch(text, /\{n\}/)
})



test('the injection limits are editable from the card, not just configurable in schema', () => {
  // A schema key with no control is invisible: the person can only reach it by
  // hand-editing cordis.patch.yml. The panel must expose the keys the plugin
  // actually reads.
  const tree = expand(
    SettingsCard({
      form: fakeForm(
        snapshot({
          value: {
            inject: { enabled: true, distillAbove: 16000, limits: { user: 8000, project: 10000, rules: 2000, profile: 2000 } },
            write: { enabled: true },
            search: {},
            guard: {},
            ui: { allowWriteActions: true },
          },
        }),
      ),
    }),
  )
  const body = text(tree)

  for (const label of ['用户记忆上限', '蒸馏阈值', '项目记忆上限']) {
    assert.match(body, new RegExp(label), `the card must expose "${label}"`)
  }

  // And the current values must be readable in the inputs, not just labelled.
  const numbers = walk(tree)
    .filter((node) => node.type === 'input')
    .map((node) => String(node.props.value ?? ''))
  assert.ok(numbers.includes('8000'), `user limit shows 8000, got ${JSON.stringify(numbers)}`)
  assert.ok(numbers.includes('16000'), 'the distillation threshold shows its effective value')
  assert.ok(numbers.includes('10000'), 'the project limit shows its value')
})

test('an empty snapshot still shows the effective defaults for the limits', () => {
  // `inject` absent entirely is the first-mount case; the card must not render
  // blanks where a number belongs.
  const tree = expand(SettingsCard({ form: fakeForm(snapshot({ value: {} })) }))
  const numbers = walk(tree)
    .filter((node) => node.type === 'input')
    .map((node) => String(node.props.value ?? ''))
  assert.ok(numbers.includes('8000'), 'the user limit falls back to the shipped 8000')
  // `distillAbove: 0` means "twice the limit", so the field shows 16000 — the
  // threshold actually in force. Showing the raw 0 would read as "off".
  assert.ok(numbers.includes('16000'), `the threshold shows its effective value, got ${JSON.stringify(numbers)}`)
})

test('a stored 0 for the threshold is displayed as twice the limit', () => {
  const tree = expand(
    SettingsCard({
      form: fakeForm(snapshot({ value: { inject: { enabled: true, distillAbove: 0, limits: { user: 5000 } }, write: {}, search: {}, guard: {}, ui: {} } })),
    }),
  )
  const numbers = walk(tree)
    .filter((node) => node.type === 'input')
    .map((node) => String(node.props.value ?? ''))
  assert.ok(numbers.includes('10000'), `5000 x 2 = 10000, got ${JSON.stringify(numbers)}`)

  // An explicit threshold is shown as stored.
  const explicit = expand(
    SettingsCard({
      form: fakeForm(snapshot({ value: { inject: { enabled: true, distillAbove: 20000, limits: { user: 5000 } }, write: {}, search: {}, guard: {}, ui: {} } })),
    }),
  )
  const shown = walk(explicit)
    .filter((node) => node.type === 'input')
    .map((node) => String(node.props.value ?? ''))
  assert.ok(shown.includes('20000'), 'an explicit threshold is not overridden by the derivation')
})
