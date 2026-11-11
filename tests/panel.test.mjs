/**
 * The panel driven through clicks.
 *
 * `client.test.mjs` freezes the pure helpers; this drives the real components:
 * a click becomes a fetch, a fetch becomes a render, and a refusal becomes a
 * message. The overview and the project page share one workspace component, so
 * the flows below cover both surfaces.
 */

import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { createRuntime, text, walk } from './helpers/react.mjs'

const runtime = createRuntime()

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
const { MemoryWorkspace, PruneDialog } = client.__internals

/** Expand nested function components (icons) so text is readable. */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { type: node.type, props: node.props, children: (node.children ?? []).map(expand).filter((child) => child !== null) }
}

const OVERVIEW = { mode: 'overview', layout: 'wide' }
const PROJECT = { mode: 'project', layout: 'wide' }
const MemoryOverviewPanel = MemoryWorkspace
const MemoryProjectPanel = MemoryWorkspace

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

const dailyContent = {
  ok: true,
  target: 'project-daily',
  date: '2026-11-09',
  path: 'C:\\repo\\.workbuddy\\memory\\2026-11-09.md',
  bytes: 20,
  revision: 'rev-daily',
  entries: 1,
  truncated: false,
  text: '# 2026-11-09\n\n- 上午：写代码\n',
  sections: [],
  writable: false,
}

function stateFor(overrides = {}) {
  const state = {
    ok: true,
    version: '0.1.0',
    cwd: 'C:\\repo',
    selected: null,
    readOnly: false,
    writeEnabled: true,
    allowWriteActions: true,
    allowFullTextEdit: true,
    limits: { project: 10000, user: 4000, profile: 2000, rules: 2000 },
    dataFolderName: '.workbuddy',
    home: { path: 'C:\\Users\\me\\.workbuddy', source: 'env', detail: 'WORKBUDDY_CONFIG_DIR' },
    projects: [
      {
        key: 'proj-a',
        path: 'C:\\repo',
        name: 'repo',
        title: 'repo',
        source: 'workspace',
        current: true,
        hasMemory: true,
        daily: 1,
        entries: 3,
        bytes: 1200,
        chars: 900,
        revision: 'rev-project',
        mtime: 1,
        latestDaily: '2026-11-09',
        oldestDailyAgeDays: 1,
        overLimit: false,
        stale: false,
        status: 'ok',
      },
      {
        key: 'proj-b',
        path: 'C:\\other',
        name: 'other',
        title: 'other',
        source: 'workspace',
        current: false,
        hasMemory: false,
        daily: 1,
        entries: 0,
        bytes: 0,
        chars: 0,
        revision: null,
        mtime: null,
        latestDaily: '2026-11-08',
        oldestDailyAgeDays: 2,
        overLimit: false,
        stale: false,
        status: 'daily-only',
      },
    ],
    totals: { projects: 2, withMemory: 1, entries: 3, dailyFiles: 2, overLimit: 0, stale: 0 },
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
        memory: 'C:\\Users\\me\\.workbuddy\\MEMORY.md',
        exists: true,
        memoryExists: true,
        bytes: 23743,
        chars: 8000,
        writable: true,
        entries: 9,
        revision: 'rev-user',
      },
      profile: { target: 'profile', path: null, exists: true, bytes: 1551, ambiguous: true, readOnly: true, entries: 0 },
    },
    backups: { count: 3, latest: 1 },
    operations: { total: 4, conflicts: 1, lastConflictAt: 1, lastCommitAt: 2 },
  }
  return { ...state, ...overrides }
}

/** Install a fetch that answers state/content and records actions. */
function installFetch({
  state = stateFor(),
  content = (url) => (String(url).includes('target=project-daily') ? dailyContent : projectContent),
  actionResult = () => ({ ok: true, revision: 'rev-next', backup: 'C:\\b\\2026-11-10T00-00-00-000Z.md' }),
} = {}) {
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
    const body = href.includes('/content') ? content(href) : state
    return { ok: true, status: 200, json: async () => body }
  }
  return calls
}

/** Keep the poll and undo timers out of the test. */
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

/** Open the first project's MEMORY.md from the overview tree. */
async function openProject(props = {}) {
  const view = { ...OVERVIEW, ...props }
  let tree = await runtime.settle(MemoryWorkspace, view)
  const row = walk(tree).find(
    (node) => node.type === 'button' && String(node.props?.className ?? '').includes('wbm-project') && text(node).includes('repo'),
  )
  assert.ok(row, 'the overview lists the project')
  tree = await runtime.fire(row, 'onClick', MemoryWorkspace, view)
  return tree
}

test('the overview lists every project and the global stores', async () => {
  installFetch()
  const restore = installTimers()
  try {
    const tree = await runtime.settle(MemoryOverviewPanel, {})
    const body = text(expand(tree))
    assert.match(body, /repo/)
    assert.match(body, /other/)
    assert.match(body, /全部项目/)
    assert.match(body, /用户 MEMORY\.md/)
    assert.match(body, /用户画像/)
  } finally {
    restore()
  }
})

test('selecting a project opens its MEMORY.md and renders sections', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    const tree = await openProject()
    assert.ok(calls.gets.some((url) => url.includes('project=proj-a')))
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

test('editing an entry posts one edit with the revision it saw', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openProject()
    const entry = walk(tree).find((node) => node.props?.title === '点击编辑' && text(node) === 'Node 22')
    assert.ok(entry, 'a writable entry is clickable')
    tree = await runtime.fire(entry, 'onClick', MemoryOverviewPanel, {})

    const input = walk(tree).find((node) => node.type === 'input' && node.props.value === 'Node 22')
    assert.ok(input, 'the row becomes an input')
    tree = await runtime.fire(input, 'onChange', MemoryOverviewPanel, {}, { value: 'Node 24' })

    const save = walk(tree).find((node) => node.type === 'button' && text(node) === '保存')
    assert.ok(save, 'the editor offers save')
    await runtime.fire(save, 'onClick', MemoryOverviewPanel, {})

    assert.equal(calls.actions.length, 1)
    // The click carries an idempotency key so the store can tell a retry from a
    // deliberate second write; the rest of the body is unchanged.
    const { operationId, ...rest } = calls.actions[0]
    assert.equal(typeof operationId, 'string')
    assert.ok(operationId.length > 0, 'every action carries an operationId')
    assert.deepEqual(rest, {
      type: 'edit',
      target: 'project-memory',
      section: '环境',
      line: 3,
      replacement: 'Node 24',
      expectedRevision: 'rev-project',
    })
  } finally {
    restore()
  }
})

test('deleting an entry posts remove for that exact line', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    const tree = await openProject()
    const remove = walk(tree).find((node) => node.props?.title === '删除')
    assert.ok(remove, 'a writable entry offers delete')
    await runtime.fire(remove, 'onClick', MemoryOverviewPanel, {})
    assert.equal(calls.actions[0].type, 'remove')
    assert.equal(calls.actions[0].line, 3)
    assert.equal(calls.actions[0].section, '环境')
  } finally {
    restore()
  }
})

test('a read-only panel hides write controls and offers enable', async () => {
  installFetch({ state: stateFor({ allowWriteActions: false }) })
  const restore = installTimers()
  try {
    const tree = await openProject()
    assert.equal(walk(tree).some((node) => node.props?.title === '删除'), false)
    assert.equal(walk(tree).some((node) => node.props?.title === '点击编辑'), false)
    const body = text(expand(tree))
    assert.match(body, /面板编辑未开启/)
    assert.match(body, /启用编辑/)
  } finally {
    restore()
  }
})

test('a daily note is append-only: no row edit, but an add control', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openProject()
    const daily = walk(tree).find((node) => node.type === 'button' && text(node).includes('2026-11-09'))
    assert.ok(daily, 'the daily row is listed')
    tree = await runtime.fire(daily, 'onClick', MemoryOverviewPanel, {})

    assert.ok(calls.gets.some((url) => url.includes('target=project-daily')))
    assert.equal(walk(tree).some((node) => node.props?.title === '删除'), false, 'no delete on an append-only file')
    assert.equal(walk(tree).some((node) => node.props?.title === '点击编辑'), false, 'no inline edit on an append-only file')
    assert.match(text(expand(tree)), /日期笔记是追加文件/)
    assert.ok(walk(tree).some((node) => node.type === 'button' && text(node) === '添加一条'))
  } finally {
    restore()
  }
})

test('a conflict keeps the draft and offers the three ways out', async () => {
  const calls = installFetch({ actionResult: () => ({ ok: false, code: 'conflict', revision: 'rev-other', expectedRevision: 'rev-project' }) })
  const restore = installTimers()
  try {
    let tree = await openProject()
    const entry = walk(tree).find((node) => node.props?.title === '点击编辑' && text(node) === 'Node 22')
    tree = await runtime.fire(entry, 'onClick', MemoryOverviewPanel, {})
    const input = walk(tree).find((node) => node.type === 'input' && node.props.value === 'Node 22')
    tree = await runtime.fire(input, 'onChange', MemoryOverviewPanel, {}, { value: 'Node 24' })
    const save = walk(tree).find((node) => node.type === 'button' && text(node) === '保存')
    tree = await runtime.fire(save, 'onClick', MemoryOverviewPanel, {})

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

test('typing in the document search filters rows without another request', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openProject()
    const before = calls.gets.length
    const search = walk(tree).find((node) => node.type === 'input' && String(node.props?.placeholder ?? '').includes('搜索当前文件'))
    assert.ok(search, 'the document search is present')
    tree = await runtime.fire(search, 'onChange', MemoryOverviewPanel, {}, { value: 'node' })
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
    const tree = await runtime.settle(MemoryOverviewPanel, {})
    assert.match(text(expand(tree)), /面板接口没有注册/)
  } finally {
    restore()
  }
})

test('the project panel resolves the workspace from the viewed session', async () => {
  const calls = installFetch()
  const restore = installTimers()
  const props = {
    useSessions: (selector) => selector({ byId: { s1: { id: 's1', cwd: 'C:\\repo', retainedBy: { mainView: 1 } } } }),
    useWorkspaces: (selector) => selector({ items: [] }),
  }
  try {
    const tree = await runtime.settle(MemoryWorkspace, { ...PROJECT, ...props })
    assert.ok(calls.gets.some((url) => url.includes('project=proj-a')), calls.gets.join('\n'))
    assert.match(text(expand(tree)), /MEMORY\.md/)
  } finally {
    restore()
  }
})

test('an over-limit project is called out in the summary chips', async () => {
  const state = stateFor()
  state.projects[0] = { ...state.projects[0], overLimit: true, chars: 12000, status: 'over-limit' }
  state.totals = { ...state.totals, overLimit: 1 }
  installFetch({ state })
  const restore = installTimers()
  try {
    const tree = await runtime.settle(MemoryOverviewPanel, {})
    const body = text(expand(tree))
    assert.match(body, /超限 1/)
    assert.match(body, /已超注入限额/)
  } finally {
    restore()
  }
})

test('the prune dialog plans first, then archives the picked dates', async () => {
  const actions = []
  const act = async (payload) => {
    actions.push(payload)
    if (payload.dryRun !== false) {
      return {
        ok: true,
        dryRun: true,
        candidates: [
          { date: '2026-09-01', name: '2026-09-01.md', bytes: 40, entries: 2 },
          { date: '2026-09-02', name: '2026-09-02.md', bytes: 20, entries: 1 },
        ],
      }
    }
    return { ok: true, pruned: [{ date: '2026-09-01' }, { date: '2026-09-02' }] }
  }
  const flashes = []
  const props = {
    projectKey: 'proj-a',
    act,
    onClose: () => {},
    flash: (message) => flashes.push(message),
    reload: async () => {},
  }

  let tree = await runtime.settle(PruneDialog, props)
  assert.equal(actions[0].dryRun, true)
  assert.equal(actions[0].type, 'prune')
  assert.equal(text(expand(tree)).includes('2026-09-01 · 2 条'), true)

  const archive = walk(tree).find((node) => node.type === 'button' && String(text(node)).startsWith('归档'))
  assert.ok(archive, 'the plan offers an archive button')
  tree = await runtime.fire(archive, 'onClick', PruneDialog, props)

  const written = actions.find((payload) => payload.dryRun === false)
  assert.deepEqual(written.dates, ['2026-09-01', '2026-09-02'])
  assert.equal(written.type, 'prune')
  assert.equal(flashes.length, 1)
})

test('the panel drops the history browser and the empty-project note', async () => {
  installFetch()
  const restore = installTimers()
  try {
    const tree = await openProject()
    assert.equal(walk(tree).some((node) => node.type === 'button' && text(node) === '历史'), false, 'no history entry')
    assert.equal(text(expand(tree)).includes('这个项目还没有记忆'), false, 'no empty-project note')
    assert.ok(walk(tree).some((node) => String(node.props?.className ?? '').includes('wbm-tree-children')), 'expanded files use a tree container')
  } finally {
    restore()
  }
})
