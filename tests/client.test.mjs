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
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { Config, normalizeConfig } from '../src/config.js'
import { pinNavigator } from './helpers/locale.mjs'

// The copy assertions below are Chinese. Without a pinned language they assert
// against whatever locale the runner happens to have — English on CI, and on
// Node 20 not even that, since the runtime has no `navigator` at all.
pinNavigator('zh-CN')

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
const { humanBytes, getJson, MemoryOverviewPanel, OverviewIcon, SettingsCard, writeConfigField, PANEL_OVERVIEW, API } = module.__internals

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
  // No state yet: the overview shows a loading state, never a row of zeros or
  // an empty-machine message it has no evidence for.
  assert.match(body, /读取中/)
  assert.doesNotMatch(body, /项目 0|条目 0|还没有任何项目/)
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

/**
 * A form that refuses what the host refuses.
 *
 * The old `fakeForm` answered `true` to every write, which is why the dotted-path
 * bug below survived a green suite: the card passed `'inject.limits.project'`,
 * the fake accepted it, and only a real host rejected it as "not volatile".
 * This double applies the host's own rule — a path segment that names no schema
 * field cannot be written — so a mis-addressed write fails here too.
 */
function hostRuleForm(snap, schema, record = []) {
  const isVolatilePath = (node, path) => {
    if (node?.meta?.volatile) return true
    const [key, ...rest] = path
    const child = key === undefined ? undefined : node?.dict?.[key]
    return child !== undefined && isVolatilePath(child, rest)
  }
  return {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    set: async (field, value) => {
      record.push({ field, path: [field], value })
      return isVolatilePath(schema, [field])
    },
    mutate: async (ops) => {
      record.push(...ops)
      return ops.every((op) => isVolatilePath(schema, op.path))
    },
  }
}

test('a writable snapshot leaves every control enabled', () => {
  const tree = expand(SettingsCard({ form: fakeForm(snapshot({ value: { inject: {}, write: {}, search: {}, guard: {}, ui: { allowWriteActions: true } } })) }))
  const inputs = walk(tree).filter((node) => node.type === 'input')

  assert.equal(inputs.length >= 7, true, 'the card should render its switches')
  assert.equal(inputs.every((node) => node.props.disabled === false), true, 'a writable form must stay editable')
  assert.match(text(tree), /revision 3/)
  assert.match(text(tree), /可写/)
})

test('the card has no full-text switch: source mode is a feature, not a setting', () => {
  // Source mode and drafts are how the panel edits a whole file. Whether to use
  // them is the person's call, so there is no switch to find — and the card must
  // not offer one that only makes the panel worse.
  const tree = expand(
    SettingsCard({
      form: fakeForm(
        snapshot({
          value: { inject: {}, write: {}, search: {}, guard: {}, ui: { allowWriteActions: true } },
        }),
      ),
    }),
  )
  const body = text(tree)
  assert.doesNotMatch(body, /全文编辑/, 'the card must not offer a full-text editing switch')
  assert.doesNotMatch(body, /Full-text editing/)
  // The controls that remain still follow the panel write switch.
  const off = expand(
    SettingsCard({
      form: fakeForm(snapshot({ value: { inject: {}, write: {}, search: {}, guard: {}, ui: { allowWriteActions: false } } })),
    }),
  )
  assert.equal(walk(off).filter((node) => node.type === 'input').length >= 1, true)
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

const { fillOf, filterEntries, highlightParts, lineDiff, describeCode, shortPath } = module.__internals

test('fill comes from the prompt numbers, and the level from what was actually lost', () => {
  // This replaces `ratio(chars, limit)`, which divided a file's length by the
  // limit whatever the mode and so described nothing under layered injection.
  // The fill is what the prompt would need over what it allows itself.
  assert.deepEqual(fillOf(undefined), { percent: null, level: 'none', near: false })
  assert.deepEqual(fillOf({ budget: 0, need: 900 }), { percent: null, level: 'none', near: false }, 'no budget: nothing to fill')

  const half = fillOf({ budget: 1400, need: 700, overLimit: false })
  assert.deepEqual(half, { percent: 50, level: 'ok', near: false })

  // Close to the budget is worth a quiet word, and is not an alert.
  const near = fillOf({ budget: 1400, need: 1300, overLimit: false })
  assert.equal(near.near, true)
  assert.equal(near.level, 'warn')

  // The level is "over" only when something was lost — never from the ratio
  // alone, so a block that just fits is not "over".
  assert.equal(fillOf({ budget: 1400, need: 1400, overLimit: false }).level, 'warn', 'exactly full, nothing lost')
  assert.equal(fillOf({ budget: 1400, need: 2100, overLimit: true }).level, 'over')
  // And "over" from the judgment even when the numbers alone would not say so
  // (a single entry dropped to the notice reservation can leave need <= budget).
  assert.equal(fillOf({ budget: 1400, need: 1400, overLimit: true }).level, 'over')
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

test('every refusal the host can return has copy, not a bare code', async () => {
  // The panel renders `describeCode(result.code)`, so an unmapped code shows the
  // caller an English identifier. Two of them are on the most-travelled paths:
  // `layering_confirmation_required` fires when someone adds a section named
  // "Core Memory" to an unsplit file, and `receipt_capacity` fires on *every*
  // click once the receipt store is full — a dead end nobody can read.
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    )

  // `issues[].code` is a structural sub-code: the panel renders the line number
  // of each issue, never the code itself, so these four are not top-level
  // refusals.
  const ISSUE_CODES = new Set(['heading', 'not_entry', 'nul', 'unclosed_fence'])
  const found = new Set()
  for (const file of walk('src')) {
    if (!file.endsWith('.js') || file.endsWith('client.js')) continue
    const source = readFileSync(file, 'utf8')
    for (const pattern of [/code:\s*'([a-z0-9_]+)'/g, /fail\(\s*'([a-z0-9_]+)'/g, /error:\s*'([a-z0-9_]+)'/g]) {
      for (const match of source.matchAll(pattern)) found.add(match[1])
    }
  }
  // Codes that reach `fail()` through a transform's `reason` rather than a
  // literal at the refusal site.
  for (const reason of ['no_match', 'ambiguous', 'stale_line', 'not_an_entry', 'invalid_body', 'no_section', 'ambiguous_section', 'empty_text', 'multiline_text', 'empty_heading']) {
    found.add(reason)
  }
  found.delete('read_only')
  found.delete('truncated')
  found.delete('changed')

  const unmapped = [...found].filter((code) => !ISSUE_CODES.has(code) && describeCode(code) === code).sort()
  assert.deepEqual(unmapped, [], `these codes would reach the panel as English identifiers: ${unmapped.join(', ')}`)
})

test('the refusals with a way out say what that way is', () => {
  // "Failed" is not an instruction. Each of these has exactly one exit and the
  // copy has to name it.
  assert.match(describeCode('layering_confirmation_required'), /常驻|核心/)
  assert.match(describeCode('layering_confirmation_required'), /草案|源码|面板/)

  const capacity = describeCode('receipt_capacity', { stateDir: 'C:\\state' })
  assert.match(capacity, /C:\\state\\receipts/, 'the receipt dead end names the directory to clean')
  assert.match(capacity, /回执/)
  assert.match(capacity, /未决/, 'unresolved receipts are not safe to delete blindly')
  // Without a state directory on screen the copy still says where it lives.
  assert.match(describeCode('receipt_capacity'), /\.dsh\/workbuddy-memory\/receipts/)
  // A POSIX state directory keeps its own separator instead of gaining a
  // backslash the shell would have to fix.
  assert.match(describeCode('receipt_capacity', { stateDir: '/home/me/.dsh/state' }), /\/home\/me\/\.dsh\/state\/receipts/)

  // `backup_required` used to send people to a "backup count" control that the
  // panel never had, so the exit was a dead end. It has to name the config key
  // a person can actually change, not a label that does not exist.
  assert.match(describeCode('backup_required'), /backupKeep|备份/)
  assert.match(describeCode('backup_required'), /write\.backupKeep|配置|config/)
  assert.doesNotMatch(describeCode('backup_required'), /「备份保留数」|"backup count"/, 'no control with that name exists')
  assert.match(describeCode('plan_required'), /计划|预览/)
  assert.match(describeCode('plan_conflict'), /计划|预览/)
  assert.match(describeCode('operation_mismatch'), /操作 ID|operation/)
  assert.match(describeCode('operation_required'), /操作 ID|operation/)
  assert.match(describeCode('operation_id_too_long'), /200/)
  assert.match(describeCode('outcome_unknown'), /同一个|same/)
  assert.match(describeCode('partial'), /重试|retry/)
  assert.match(describeCode('archive_capacity'), /分批|batch/)
  assert.match(describeCode('revision_required'), /revision/)
  assert.match(describeCode('read_conflict'), /重新读|read/)
  assert.match(describeCode('bad_offset'), /offset|偏移/)
  assert.match(describeCode('profile_not_found'), /画像|profile/)
  assert.match(describeCode('ambiguous_profile'), /profileUid|候选/)
  assert.match(describeCode('too_large'), /256|KB|MB|太大/)
  assert.match(describeCode('invalid_structure'), /结构|围栏/)
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

test('a nested config field is written by its path segments, not as one dotted name', async () => {
  // The regression: the card passed `'inject.limits.project'` straight to
  // `form.set`, which wraps its argument as `path: [field]`. The host then looked
  // for a field literally named "inject.limits.project", found none, and refused
  // the write as "not volatile" — every nested key was uneditable from the card
  // while the three top-level scalars worked. Assert the segments, and assert the
  // host's own rule accepts them.
  const record = []
  const form = hostRuleForm(snapshot(), Config, record)

  assert.equal(await writeConfigField(form, 'inject.limits.project', 12000), true)
  assert.deepEqual(record, [{ op: 'set', path: ['inject', 'limits', 'project'], value: 12000 }])

  // The top-level scalar keeps working too.
  record.length = 0
  assert.equal(await writeConfigField(form, 'readOnly', true), true)
  assert.deepEqual(record, [{ op: 'set', path: ['readOnly'], value: true }])

  // A key that is not volatile anywhere (reload-only) is still refused, and it is
  // the host refusing it — not this helper second-guessing the schema.
  assert.equal(await writeConfigField(form, 'stateDir', '/tmp/x'), false)
})

test('every field the card writes is one the host will accept', async () => {
  // Scanning the source rather than listing fields by hand is the point: a control
  // added later with a bad path fails here without anyone remembering to extend a
  // list. `commit(...)` and `setFlag(...)` are the only two ways the panel writes
  // config, so their literals are the complete set of paths it can attempt.
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const fields = [...source.matchAll(/\b(?:commit|setFlag)\(\s*'([^']+)'/g)].map((match) => match[1])
  assert.ok(fields.length >= 15, `expected the card to write many fields, found ${fields.length}`)

  const form = hostRuleForm(snapshot(), Config, [])
  const refused = []
  for (const field of new Set(fields)) {
    if (!(await writeConfigField(form, field, 1))) refused.push(field)
  }

  assert.deepEqual(refused, [], `these written fields are refused by the host: ${JSON.stringify(refused)}`)
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

test('the card exposes the injection mode and the layered budget', () => {
  // These two keys decide what reaches the prompt by default, and `full` is the
  // documented troubleshooting exit. A schema key with no control is reachable
  // only by hand-editing the profile YAML — which the README tells people not
  // to do, because the inserted entry and the card's entry then collide.
  const tree = expand(
    SettingsCard({
      form: fakeForm(
        snapshot({
          value: {
            inject: { enabled: true, mode: 'full', coreBudget: 6000, limits: { user: 8000 } },
            write: {},
            search: {},
            guard: {},
            ui: { allowWriteActions: true },
          },
        }),
      ),
    }),
  )
  const body = text(tree)

  assert.match(body, /注入模式/, 'the mode control is labelled')
  assert.match(body, /常驻预算/, 'the budget control is labelled')
  assert.match(body, /UTF-16/, 'the budget says which unit it counts')
  assert.match(body, /4000/, 'the budget states its range')
  assert.match(body, /20000/, 'the budget states its upper bound')

  const select = walk(tree).find((node) => node.type === 'select')
  assert.ok(select, 'the mode is a choice, not a free-text field')
  assert.equal(select.props.value, 'full', 'the stored mode is the one shown')
  assert.equal(select.props.disabled, false)
  const options = walk(select).filter((node) => node.type === 'option').map((node) => node.props.value)
  assert.deepEqual(options, ['layered', 'full'], 'both modes are offered')
  assert.match(text(select), /分层/)
  assert.match(text(select), /full/)

  const numbers = walk(tree)
    .filter((node) => node.type === 'input' && node.props.type === 'number')
    .map((node) => node.props)
  const budget = numbers.find((props) => String(props.value) === '6000')
  assert.ok(budget, `the budget shows its stored value, got ${JSON.stringify(numbers.map((n) => n.value))}`)
  assert.equal(budget.min, 4000)
  assert.equal(budget.max, 20000)
})

test('the mode is a closed choice, so a typo cannot look like it saved', () => {
  const calls = []
  const form = {
    getSnapshot: () =>
      snapshot({
        value: {
          inject: { enabled: true, mode: 'layered', coreBudget: 4000, limits: { user: 8000 } },
          write: {},
          search: {},
          guard: {},
          ui: { allowWriteActions: true },
        },
      }),
    subscribe: () => () => {},
    set: async (field, next) => {
      calls.push([field, next])
      return true
    },
  }
  const tree = expand(SettingsCard({ form }))

  const select = walk(tree).find((node) => node.type === 'select')
  assert.ok(select, 'the mode is a select, not a text field')
  select.props.onChange({ target: { value: 'full' } })
  assert.deepEqual(calls.at(-1), ['inject.mode', 'full'], 'the mode is committed to inject.mode')

  // The budget's range is on the control itself, and the card clamps what it
  // renders to the same bounds `normalizeConfig` applies — see the out-of-range
  // test below for why the control alone is not enough.
  const budget = walk(tree).find((node) => node.type === 'input' && node.props.type === 'number' && String(node.props.value) === '4000')
  assert.ok(budget, 'the budget field is rendered')
  assert.equal(budget.props.min, 4000)
  assert.equal(budget.props.max, 20000)
})

test('an out-of-range budget shows the value that is actually in force', () => {
  // The schema does not clamp: a stored 1000 stays 1000 in the snapshot, and
  // `normalizeConfig` is what turns it into 4000 at run time. So a card that
  // rendered the stored value would show 1000 while the plugin ran at 4000 —
  // the exact "it looked like it worked" failure the range is meant to prevent.
  // `<input min max>` does not help: it constrains validity, not input or blur.
  assert.equal(normalizeConfig({ inject: { coreBudget: 1000 } }).inject.coreBudget, 4000)
  assert.equal(normalizeConfig({ inject: { coreBudget: 25000 } }).inject.coreBudget, 20000)

  for (const [stored, effective] of [[1000, 4000], [25000, 20000]]) {
    const tree = expand(
      SettingsCard({
        form: fakeForm(
          snapshot({
            value: { inject: { enabled: true, coreBudget: stored, limits: { user: 8000 } }, write: {}, search: {}, guard: {}, ui: {} },
          }),
        ),
      }),
    )
    const budget = walk(tree).find(
      (node) => node.type === 'input' && node.props.type === 'number' && node.props.min === 4000 && node.props.max === 20000,
    )
    assert.ok(budget, `the budget field is rendered for a stored ${stored}`)
    assert.equal(
      String(budget.props.value),
      String(effective),
      `a stored ${stored} is shown as the ${effective} that normalizeConfig applies`,
    )
  }
})

test('the user-limit hint says it only bounds the full and legacy paths', () => {
  // In layered mode `limits.user` is an on/off switch: the real ceiling is
  // coreBudget. A hint that still promised "the maximum injected characters"
  // would be wrong on the default configuration.
  const body = text(expand(SettingsCard({ form: fakeForm(snapshot()) })))
  assert.match(body, /分层/, 'the hint names the mode where the key does not cap the block')
  assert.match(body, /常驻预算|coreBudget/, 'the hint points at the real ceiling')
})

test('the distillation hint matches where the threshold actually applies', () => {
  // `render.js` reads `inject.distillAbove` in the layered directory as well as
  // in the full-mode rules, so "full mode only" was false. And because the
  // threshold defaults to `2 × limits.user`, the limit is not a pure switch in
  // layered mode either — the two hints have to agree with the code and with
  // each other.
  const body = text(expand(SettingsCard({ form: fakeForm(snapshot()) })))
  assert.doesNotMatch(body, /只在整份|只.*full.*模式生效/, 'the threshold is not full-mode only')
  assert.match(body, /分层/, 'the hint names both modes the threshold applies to')
  assert.match(body, /目录|提示/, 'and says what the layered mode does with it')
  // The derivation is stated where a person tunes the limit, not only in the
  // threshold field: changing the limit alone moves the threshold.
  assert.match(body, /两倍|×\s*2|x\s*2|两 倍|2 倍/, 'the default threshold is named as twice the limit')
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

test('every literal the panel translates exists in both dictionaries', () => {
  // A key added to one language and not the other shows up in the other
  // language as the raw key — `panel.emptyOverview` did exactly that on its
  // first run. This reads the source, so a new `t('…')` with no copy fails
  // here before it fails in someone's panel.

  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const block = (name, next) => source.slice(source.indexOf(`const ${name} = {`), source.indexOf(`const ${next} = {`))
  const zh = block('ZH', 'EN')
  const en = source.slice(source.indexOf('const EN = {'), source.indexOf('function bindCopy'))
  // Only keys that are really passed to the translator: `t('key'` or
  // `t("key"`, not object property names or other functions' string arguments.
  const keys = [...new Set([...source.matchAll(/\bt\(\s*'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.-]+)'/g)].map((match) => match[1]))]
  const missing = keys.filter((key) => !zh.includes(`'${key}':`) || !en.includes(`'${key}':`)).sort()
  assert.deepEqual(missing, [], 'keys with no copy in both languages')
  assert.ok(keys.length > 100, `the scan found the dictionaries (${keys.length} keys)`)
})
