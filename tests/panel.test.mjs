/**
 * The panel driven through clicks.
 *
 * `client.test.mjs` froze the pure helpers; this drives the component itself:
 * a click becomes a fetch, a fetch becomes a render, and a refusal becomes a
 * message. That is the layer that regressed silently before.
 */

import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { createRuntime, text, walk, byText } from './helpers/react.mjs'

const runtime = createRuntime()

// Each test mounts a fresh panel; a shared hook array would leak the previous
// test's selection into the next one.
beforeEach(() => runtime.reset())

/** Load the browser half with the stub React. */
async function loadClient() {
  let exported
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        exported = factory((name) => {
          if (name !== 'react') throw new Error(`unexpected require: ${name}`)
          return runtime.api
        })
      },
    },
  }
  await import('../src/client.js')
  delete globalThis.window
  return exported
}

const client = await loadClient()
const { MemoryPanel } = client.__internals

/** Expand function components that own no hooks, so text is readable. */
const HOOKED = new Set(['MemoryPanel', 'ConsolidateDialog', 'RevisionsDialog'])
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
  if (typeof node.type === 'function') {
    if (HOOKED.has(node.type.name)) return { ...node, children: (node.children ?? []).map(expand) }
    return expand(node.type(node.props))
  }
  return { type: node.type, props: node.props, children: (node.children ?? []).map(expand).filter((child) => child !== null) }
}

const projectMemory = '# 项目记忆\n\n## 环境\n- Node 22\n- Windows\n\n## 待办\n- 联调\n'
const projectContent = {
  ok: true,
  target: 'project-memory',
  path: 'C:\\repo\\.workbuddy\\memory\\MEMORY.md',
  bytes: projectMemory.length,
  revision: 'rev-project',
  entries: 3,
  truncated: false,
  text: projectMemory,
  sections: [
    { heading: '环境', level: 2, line: 2, endLine: 5, entries: [{ line: 3, text: 'Node 22' }, { line: 4, text: 'Windows' }] },
    { heading: '待办', level: 2, line: 6, endLine: 7, entries: [{ line: 7, text: '联调' }] },
  ],
  writable: true,
}

function baseState(overrides = {}) {
  return {
    ok: true,
    version: '0.1.0',
    cwd: 'C:\\repo',
    readOnly: false,
    writeEnabled: true,
    allowWriteActions: true,
    limits: { project: 10000, user: 4000, profile: 2000, rules: 2000 },
    dataFolderName: '.workbuddy',
    projects: [{ key: 'proj-a', path: 'C:\\repo', name: 'repo', lastSeenAt: 2, current: true, hasMemory: true, daily: 1 }],
    home: { path: 'C:\\Users\\admin\\.workbuddy', source: 'env', detail: 'WORKBUDDY_CONFIG_DIR' },
    stores: {
      project: {
        target: 'project-memory',
        dir: 'C:\\repo\\.workbuddy\\memory',
        memory: 'C:\\repo\\.workbuddy\\memory\\MEMORY.md',
        exists: true,
        memoryExists: true,
        bytes: 1200,
        chars: 900,
        writable: true,
        entries: 3,
        revision: 'rev-project',
        daily: [{ name: '2026-11-09.md', date: '2026-11-09', bytes: 40, ageDays: 1 }],
      },
      user: {
        target: 'user-memory',
        memory: 'C:\\Users\\admin\\.workbuddy\\MEMORY.md',
        exists: true,
        memoryExists: true,
        bytes: 23743,
        chars: 8000,
        entries: 9,
        revision: 'rev-user',
      },
      profile: { target: 'profile', path: null, exists: true, bytes: 1551, ambiguous: true, readOnly: true, entries: 0 },
    },
    backups: { count: 3, latest: 1 },
    operations: { total: 4, conflicts: 1, lastConflictAt: 1, lastCommitAt: 2 },
    ...overrides,
  }
}

/** Install a fetch that answers state/content and records actions. */
function installFetch({ state = baseState(), content = projectContent, actionResult = () => ({ ok: true, revision: 'rev-next', backup: 'C:\\b\\2026-11-10T00-00-00-000Z.md' }) } = {}) {
  const calls = { gets: [], actions: [] }
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body)
      calls.actions.push(payload)
      const body = actionResult(payload)
      return { ok: body.ok !== false, status: body.ok === false ? 409 : 200, json: async () => body }
    }
    calls.gets.push(href)
    const body = href.includes('/content') ? content : state
    return { ok: true, status: 200, json: async () => body }
  }
  return calls
}

/** Keep the 3-second poll and the 10-second undo timer out of the test. */
function installTimers() {
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.document = { hidden: false }
  return () => {
    globalThis.setInterval = realSetInterval
    delete globalThis.document
  }
}

test('the tree lists both stores with their entry counts', async () => {
  installFetch()
  const restore = installTimers()
  try {
    const tree = await runtime.settle(MemoryPanel, {})
    const expanded = expand(tree)
    const body = text(expanded)
    assert.match(body, /MEMORY\.md/)
    assert.match(body, /3 条/)
    assert.match(body, /9 条/)
    assert.match(body, /2026-11-09/)
    assert.match(body, /备份 3/)
    assert.match(body, /冲突 1/)
    assert.match(body, /画像/)
  } finally {
    restore()
  }
})

test('opening a file renders its sections and rows', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    const row = walk(tree).find((node) => node.type?.name === 'Row' && node.props.label === 'MEMORY.md')
    tree = await runtime.fire(row, 'onClick', MemoryPanel, {})
    assert.ok(calls.gets.some((url) => url.includes('/content?target=project-memory')))

    const body = text(expand(tree))
    assert.match(body, /## 环境/)
    assert.match(body, /Node 22/)
    assert.match(body, /## 待办/)
    assert.match(body, /rev-project/)
  } finally {
    restore()
  }
})

test('editing a row posts one action with the revision it saw', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    const row = walk(tree).find((node) => node.type?.name === 'Row' && node.props.label === 'MEMORY.md')
    tree = await runtime.fire(row, 'onClick', MemoryPanel, {})

    const entry = walk(tree).find((node) => node.props?.title === '点击编辑' && text(node) === 'Node 22')
    assert.ok(entry, 'the row should be clickable in edit mode')
    tree = await runtime.fire(entry, 'onClick', MemoryPanel, {})

    const input = walk(tree).find((node) => node.type === 'input' && node.props.value === 'Node 22')
    assert.ok(input, 'clicking a row turns it into an input')
    await runtime.fire(input, 'onChange', MemoryPanel, {}, { value: 'Node 24' })

    const save = walk(tree).find((node) => node.type?.name === 'Btn' && node.props.label === '保存')
    tree = await runtime.settle(MemoryPanel, {})
    const treeAfterTyping = tree
    const saveAfter = walk(treeAfterTyping).find((node) => node.type?.name === 'Btn' && node.props.label === '保存')
    assert.ok(saveAfter ?? save)

    await runtime.fire(saveAfter, 'onClick', MemoryPanel, {})

    assert.equal(calls.actions.length, 1)
    assert.deepEqual(
      { ...calls.actions[0] },
      { type: 'edit', target: 'project-memory', section: '环境', line: 3, replacement: 'Node 24', expectedRevision: 'rev-project' },
    )
  } finally {
    restore()
  }
})

test('deleting a row posts remove for that exact line', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    const row = walk(tree).find((node) => node.type?.name === 'Row' && node.props.label === 'MEMORY.md')
    tree = await runtime.fire(row, 'onClick', MemoryPanel, {})

    const remove = walk(tree).find((node) => node.props?.title === '删除' && node.props?.onClick)
    assert.ok(remove, 'rows carry a delete control when the panel may write')
    tree = await runtime.fire(remove, 'onClick', MemoryPanel, {})

    assert.equal(calls.actions[0].type, 'remove')
    assert.equal(calls.actions[0].line, 3)
    assert.equal(calls.actions[0].section, '环境')
    assert.match(text(expand(tree)), /已删除/)
  } finally {
    restore()
  }
})

test('a read-only panel offers no write controls', async () => {
  installFetch({ state: baseState({ allowWriteActions: false }) })
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    const row = walk(tree).find((node) => node.type?.name === 'Row' && node.props.label === 'MEMORY.md')
    tree = await runtime.fire(row, 'onClick', MemoryPanel, {})
    const body = text(expand(tree))

    assert.equal(walk(tree).some((node) => node.props?.title === '删除'), false)
    assert.equal(walk(tree).some((node) => node.props?.title === '点击编辑'), false)
    assert.match(body, /面板只读/)
  } finally {
    restore()
  }
})

test('a daily note is browsable but offers no row editing', async () => {
  // The store refuses every daily edit with bad_target, so the panel must not
  // draw ✎/✕ on those rows — an affordance that always fails is a bug.
  const dailyText = '# 2026-11-09\n\n- 上午：写代码\n'
  const calls = installFetch({
    content: {
      ok: true,
      target: 'project-daily',
      date: '2026-11-09',
      path: 'C:\\repo\\.workbuddy\\memory\\2026-11-09.md',
      bytes: dailyText.length,
      revision: 'rev-daily',
      entries: 1,
      truncated: false,
      text: dailyText,
      sections: [],
      writable: false,
    },
  })
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    const row = walk(tree).find((node) => node.type?.name === 'Row' && node.props.label === '2026-11-09')
    tree = await runtime.fire(row, 'onClick', MemoryPanel, {})
    const body = text(expand(tree))

    assert.ok(calls.gets.some((url) => url.includes('target=project-daily')))
    assert.equal(walk(tree).some((node) => node.props?.title === '删除'), false, 'no delete control on an append-only file')
    assert.equal(walk(tree).some((node) => node.props?.title === '点击编辑'), false, 'no inline edit on an append-only file')
    assert.match(body, /日期笔记是追加写的/)
    // 整理 still applies: folding daily notes is exactly what it is for.
    assert.ok(walk(tree).some((node) => node.type?.name === 'Btn' && node.props.label === '整理…'))
  } finally {
    restore()
  }
})

test('a conflict keeps the draft and offers the three ways out', async () => {
  const calls = installFetch({
    actionResult: () => ({ ok: false, code: 'conflict', revision: 'rev-other', expectedRevision: 'rev-project' }),
  })
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    const row = walk(tree).find((node) => node.type?.name === 'Row' && node.props.label === 'MEMORY.md')
    tree = await runtime.fire(row, 'onClick', MemoryPanel, {})

    const entry = walk(tree).find((node) => node.props?.title === '点击编辑' && text(node) === 'Node 22')
    tree = await runtime.fire(entry, 'onClick', MemoryPanel, {})
    await runtime.fire(walk(tree).find((node) => node.type === 'input' && node.props.value === 'Node 22'), 'onChange', MemoryPanel, {}, { value: 'Node 24' })
    tree = await runtime.settle(MemoryPanel, {})
    const save = walk(tree).find((node) => node.type?.name === 'Btn' && node.props.label === '保存')
    tree = await runtime.fire(save, 'onClick', MemoryPanel, {})

    assert.equal(calls.actions[0].expectedRevision, 'rev-project')
    const body = text(expand(tree))
    assert.match(body, /文件已被改动/)
    assert.match(body, /重新加载/)
    assert.match(body, /覆盖磁盘/)
    assert.match(body, /rev-other/)
  } finally {
    restore()
  }
})

test('typing in the search box filters rows without another request', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    const row = walk(tree).find((node) => node.type?.name === 'Row' && node.props.label === 'MEMORY.md')
    tree = await runtime.fire(row, 'onClick', MemoryPanel, {})
    const before = calls.gets.length

    const search = walk(tree).find((node) => node.type === 'input' && node.props.type === 'search')
    tree = await runtime.fire(search, 'onChange', MemoryPanel, {}, { value: 'node' })

    const body = text(expand(tree))
    assert.match(body, /Node 22/)
    assert.doesNotMatch(body, /Windows/)
    assert.equal(calls.gets.length, before, 'filtering is local')
  } finally {
    restore()
  }
})

test('a host without the panel routes says so instead of rendering nothing', async () => {
  const restore = installTimers()
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, code: 'no_route' }) })
  try {
    const tree = await runtime.settle(MemoryPanel, {})
    assert.match(text(expand(tree)), /面板接口没有注册/)
  } finally {
    restore()
  }
})

const { ConsolidateDialog, RevisionsDialog } = client.__internals

test('the consolidate dialog plans first, then merges the picked dates', async () => {
  const actions = []
  const act = async (payload) => {
    actions.push(payload)
    if (payload.dryRun !== false) {
      return {
        ok: true,
        dryRun: true,
        candidates: [
          { date: '2026-09-01', name: '2026-09-01.md', bytes: 40, entries: ['旧一', '旧二'] },
          { date: '2026-09-02', name: '2026-09-02.md', bytes: 20, entries: ['旧三'] },
        ],
      }
    }
    return { ok: true, consolidated: [{ date: '2026-09-01', entries: 2 }] }
  }
  const flashes = []
  const state = { stores: { project: { revision: 'rev-project' } } }

  let tree = await runtime.settle(ConsolidateDialog, { state, act, onClose: () => {}, flash: (m) => flashes.push(m), reload: async () => {} })
  assert.equal(actions[0].dryRun, true)
  assert.equal(text(expand(tree)).includes('2026-09-01 · 2 条'), true)

  const merge = walk(tree).find((node) => node.type?.name === 'Btn' && String(node.props.label).startsWith('合并'))
  assert.ok(merge, 'the plan offers a merge button')
  tree = await runtime.fire(merge, 'onClick', ConsolidateDialog, { state, act, onClose: () => {}, flash: (m) => flashes.push(m), reload: async () => {} })

  const written = actions.find((payload) => payload.dryRun === false)
  assert.deepEqual(written.dates, ['2026-09-01', '2026-09-02'])
  assert.equal(written.expectedRevision, 'rev-project')
  assert.equal(flashes.length, 1)
})

test('the history dialog diffs a backup before restoring it', async () => {
  const actions = []
  const act = async (payload) => {
    actions.push(payload)
    return { ok: true }
  }
  const snapshotText = '## 环境\n- Node 22\n'
  const getJson = async (url) => {
    if (url.includes('/revisions')) {
      return { ok: true, revisions: [{ name: '2026-11-10T00-00-00-000Z.md', bytes: 20, mtime: Date.now() }] }
    }
    return { ok: true, name: '2026-11-10T00-00-00-000Z.md', text: snapshotText, revision: 'rev-snap', mtime: Date.now(), current: { text: '## 环境\n- Node 24\n', revision: 'rev-now', bytes: 20 } }
  }
  const props = {
    doc: { revision: 'rev-now', text: '## 环境\n- Node 24\n' },
    selected: { target: 'project-memory' },
    act,
    getJson,
    onClose: () => {},
    flash: () => {},
    reload: async () => {},
  }

  let tree = await runtime.settle(RevisionsDialog, props)
  const historyBtn = walk(tree).find((node) => node.type?.name === 'Btn' && String(node.props.label).includes('KB') || node.type?.name === 'Btn' && /2026|:/.test(String(node.props.label)))
  assert.ok(historyBtn, 'a backup is offered as a button')
  tree = await runtime.fire(historyBtn, 'onClick', RevisionsDialog, props)

  const body = text(expand(tree))
  assert.match(body, /\+1 \/ -1 行/)
  assert.match(body, /Node 22/)

  const restoreBtn = walk(tree).find((node) => node.type?.name === 'Btn' && node.props.label.includes('恢复'))
  tree = await runtime.fire(restoreBtn, 'onClick', RevisionsDialog, props)
  assert.equal(actions[0].type, 'restore')
  assert.equal(actions[0].name, '2026-11-10T00-00-00-000Z.md')
  assert.equal(actions[0].expectedRevision, 'rev-now')
})

test('two workspaces turn the project label into a picker', async () => {
  const projects = [
    { key: 'proj-a', path: 'C://repo', name: 'repo', lastSeenAt: 3, current: true, hasMemory: true, daily: 1 },
    { key: 'proj-b', path: 'C://other', name: 'other', lastSeenAt: 2, current: false, hasMemory: false, daily: 2 },
  ]
  const calls = installFetch({ state: baseState({ projects }) })
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    const select = walk(expand(tree)).find((node) => node.type === 'select')
    assert.ok(select, 'more than one workspace needs a picker')
    // Two workspaces plus the "follow the live session" escape hatch.
    assert.equal(select.children.length, 3)
    assert.match(text(select), /repo/)
    assert.match(text(select), /other/)
    // A workspace without a MEMORY.md still says how much daily history it has.
    assert.match(text(select), /仅 2 天流水/)

    tree = await runtime.fire(select, 'onChange', MemoryPanel, {}, { target: { value: 'proj-b' } })
    await runtime.settle(MemoryPanel, {})

    assert.ok(calls.gets.some((url) => url.includes('project=proj-b')), calls.gets.join('\n'))
  } finally {
    restore()
  }
})

test('one workspace stays a label instead of a one-item dropdown', async () => {
  installFetch()
  const restore = installTimers()
  try {
    const tree = await runtime.settle(MemoryPanel, {})
    assert.equal(walk(expand(tree)).some((node) => node.type === 'select'), false)
    assert.match(text(expand(tree)), /项目 repo/)
  } finally {
    restore()
  }
})

test('the limit meter counts characters, the unit the limit is in', async () => {
  const state = baseState()
  state.stores.user = { ...state.stores.user, bytes: 23743, chars: 8000 }
  installFetch({ state })
  const restore = installTimers()
  try {
    const tree = await runtime.settle(MemoryPanel, {})
    const body = text(expand(tree))
    // 8000 / 4000 = 200%. Reading bytes instead would claim 594%.
    assert.match(body, /200%/)
    assert.doesNotMatch(body, /594%/)
  } finally {
    restore()
  }
})

test('the panel pins its workspace instead of following a session race', async () => {
  const projects = [
    { key: 'proj-a', path: 'C://a', name: 'a', lastSeenAt: 2, current: true, hasMemory: true, daily: 0 },
    { key: 'proj-b', path: 'C://b', name: 'b', lastSeenAt: 1, current: false, hasMemory: true, daily: 0 },
  ]
  let state = baseState({ projects })
  const calls = { gets: [], actions: [] }
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    if (init.method === 'POST') {
      calls.actions.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    calls.gets.push(href)
    return { ok: true, status: 200, json: async () => (href.includes('/content') ? projectContent : state) }
  }
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryPanel, {})
    assert.ok(calls.gets.some((url) => url.includes('project=proj-a')), 'first load pins the current workspace')

    // A background turn in the other session moves `recent.cwd`; the panel
    // must stay where the person is looking.
    state = baseState({ projects: projects.map((row) => ({ ...row, current: row.key === 'proj-b' })) })
    tree = await runtime.settle(MemoryPanel, {})
    const refresh = walk(tree).find((node) => node.type?.name === 'Btn' && node.props.label === '刷新')
    tree = await runtime.fire(refresh, 'onClick', MemoryPanel, {})
    await runtime.settle(MemoryPanel, {})

    const latest = calls.gets.at(-1)
    assert.match(latest, /project=proj-a/)
  } finally {
    restore()
  }
})
