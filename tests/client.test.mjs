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
const { humanBytes, getJson, MemoryPanel, MemoryIcon, SettingsCard, PANEL, API } = module.__internals

test('the module exports what the host mounts', () => {
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(PANEL, 'workbuddy-memory-panel')
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

test('the panel explains the project before anything is selected', () => {
  const tree = expand(MemoryPanel({}))
  const body = text(tree)
  assert.match(body, /面板还不知道你在哪个项目/)
  assert.match(body, /项目记忆在左边/)
  assert.match(body, /刷新/)
})

test('the panel icon is a standalone svg', () => {
  const icon = MemoryIcon()
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

test('full-text editing stays off until panel writes are on', () => {
  const tree = expand(SettingsCard({ form: fakeForm(snapshot()) }))
  const inputs = walk(tree).filter((node) => node.type === 'input')
  // 只读 + 两个路径 + 四个能力开关 + 面板写操作 stay usable; 全文编辑 does not.
  assert.equal(inputs.filter((node) => node.props.disabled === false).length, 8)
  assert.equal(inputs.filter((node) => node.props.disabled === true).length, 1)
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
