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

import { createRuntime, text, tick, walk } from './helpers/react.mjs'

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
const { MemoryWorkspace, PruneDialog, HistoryDialog, DraftDialog } = client.__internals

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

/** Install a fetch that answers state/content/revisions and records actions. */
function installFetch({
  state = stateFor(),
  content = (url) => (String(url).includes('target=project-daily') ? dailyContent : projectContent),
  actionResult = () => ({ ok: true, revision: 'rev-next', backup: 'C:\\b\\2026-11-10T00-00-00-000Z.md' }),
  revisions = () => [{ name: '2026-11-09T10-00-00-000Z.md', mtime: 1, bytes: 30 }],
  revision = () => ({
    ok: true,
    target: 'project-memory',
    name: '2026-11-09T10-00-00-000Z.md',
    text: projectMemory.replace('Node 22', 'Node 20'),
    bytes: 30,
    revision: 'rev-backup',
    mtime: 1,
    current: { text: projectMemory, revision: 'rev-project', bytes: projectMemory.length },
  }),
} = {}) {
  const calls = { gets: [], actions: [], actionUrls: [] }
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body)
      calls.actions.push(payload)
      calls.actionUrls.push(href)
      const body = actionResult(payload)
      return { ok: body.ok !== false, status: body.ok === false ? 409 : 200, json: async () => body }
    }
    calls.gets.push(href)
    let body
    if (href.includes('/revision?')) body = revision(href)
    else if (href.includes('/revisions')) body = { ok: true, target: 'project-memory', revisions: revisions(href) }
    else if (href.includes('/content')) body = content(href)
    else body = state
    return { ok: body.ok !== false, status: body.ok === false ? 404 : 200, json: async () => body }
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
    assert.match(body, /保留草稿/)
    assert.match(body, /rev-other/)
    assert.equal(body.includes('覆盖磁盘'), false, 'the blind overwrite is gone')
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
        planId: payload.planId ?? 'plan-1',
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
  assert.equal(written.planId, 'plan-1', 'the apply carries the plan the person previewed')
  assert.equal(typeof written.operationId, 'string', 'the apply freezes its own operation id')
  assert.equal(flashes.length, 1)
})

test('a partial archive retries with the same id and the whole date set', async () => {
  const actions = []
  let attempt = 0
  const act = async (payload) => {
    actions.push(payload)
    if (payload.dryRun !== false) {
      return {
        ok: true,
        dryRun: true,
        planId: 'plan-7',
        candidates: [
          { date: '2026-09-01', name: '2026-09-01.md', bytes: 40, entries: 2 },
          { date: '2026-09-02', name: '2026-09-02.md', bytes: 20, entries: 1 },
        ],
      }
    }
    attempt += 1
    if (attempt === 1) {
      return { ok: false, code: 'partial', planId: 'plan-7', pruned: [{ date: '2026-09-01' }], failed: [{ date: '2026-09-02', code: 'outcome_unknown' }] }
    }
    return { ok: true, pruned: [{ date: '2026-09-01' }, { date: '2026-09-02' }] }
  }
  const props = { projectKey: 'proj-a', act, onClose: () => {}, flash: () => {}, reload: async () => {} }

  let tree = await runtime.settle(PruneDialog, props)
  const archive = () => walk(tree).find((node) => node.type === 'button' && /^(归档|重试)/.test(String(text(node))))
  tree = await runtime.fire(archive(), 'onClick', PruneDialog, props)

  const applies = actions.filter((payload) => payload.dryRun === false)
  assert.equal(applies.length, 1)
  assert.equal(applies[0].planId, 'plan-7')
  assert.match(text(expand(tree)), /没有全部完成|部分/, 'the partial outcome is stated, not hidden')

  // The retry must replay the exact same request: a failed subset would leave
  // the unresolved items without the receipt that decides their fate.
  tree = await runtime.fire(archive(), 'onClick', PruneDialog, props)
  const retried = actions.filter((payload) => payload.dryRun === false)
  assert.equal(retried.length, 2)
  assert.equal(retried[1].operationId, retried[0].operationId, 'the same id, so a replay cannot archive twice')
  assert.equal(retried[1].planId, retried[0].planId, 'the same plan, without re-enumerating it')
  assert.deepEqual(retried[1].dates, ['2026-09-01', '2026-09-02'], 'the whole set, not only the failed dates')
})

test('an expired plan asks for a fresh preview instead of retrying the old one', async () => {
  const actions = []
  const act = async (payload) => {
    actions.push(payload)
    if (payload.dryRun !== false) {
      return {
        ok: true,
        dryRun: true,
        planId: `plan-${actions.filter((row) => row.dryRun !== false).length}`,
        candidates: [{ date: '2026-09-01', name: '2026-09-01.md', bytes: 40, entries: 2 }],
      }
    }
    return { ok: false, code: 'plan_conflict', reason: 'expired' }
  }
  const props = { projectKey: 'proj-a', act, onClose: () => {}, flash: () => {}, reload: async () => {} }

  let tree = await runtime.settle(PruneDialog, props)
  const archive = () => walk(tree).find((node) => node.type === 'button' && /^(归档|重试)/.test(String(text(node))))
  tree = await runtime.fire(archive(), 'onClick', PruneDialog, props)

  assert.match(text(expand(tree)), /重新出计划|过期|失效/)
  // A stale plan is not a transient failure: replaying it would re-submit a set
  // nobody previewed. The old request must be dropped, not retried.
  const appliesBefore = actions.filter((payload) => payload.dryRun === false).length
  const retry = walk(tree).find((node) => node.type === 'button' && String(text(node)).startsWith('重试'))
  if (retry) {
    tree = await runtime.fire(retry, 'onClick', PruneDialog, props)
    assert.equal(actions.filter((payload) => payload.dryRun === false).length, appliesBefore, 'a stale plan is not re-applied')
  }

  const replan = walk(tree).find((node) => node.type === 'button' && text(node) === '重新出计划')
  assert.ok(replan, 'the dialog offers a new preview')
  tree = await runtime.fire(replan, 'onClick', PruneDialog, props)
  tree = await runtime.fire(archive(), 'onClick', PruneDialog, props)
  const applies = actions.filter((payload) => payload.dryRun === false)
  assert.equal(applies.length, 2)
  assert.notEqual(applies[1].planId, applies[0].planId, 'the new preview is a different plan')
})

test('the panel drops the old history browser and the empty-project note', async () => {
  installFetch()
  const restore = installTimers()
  try {
    const tree = await openProject()
    assert.equal(text(expand(tree)).includes('这个项目还没有记忆'), false, 'no empty-project note')
    assert.ok(walk(tree).some((node) => String(node.props?.className ?? '').includes('wbm-tree-children')), 'expanded files use a tree container')
  } finally {
    restore()
  }
})

// ── version history ────────────────────────────────────────────────────────

/** The doc-header control for one workflow, addressed by its title. */
function control(tree, title) {
  return walk(tree).find((node) => node.type === 'button' && node.props?.title === title)
}

test('the current file browses its backups, previews the diff, then restores that one', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openProject()
    const open = control(tree, '历史版本')
    assert.ok(open, 'the open file offers its version history')

    tree = await runtime.fire(open, 'onClick', MemoryOverviewPanel, {})
    assert.ok(calls.gets.some((url) => url.includes('/revisions?target=project-memory')), calls.gets.join('\n'))
    // The dialog is a component of its own, so its rows only appear once the
    // tree is expanded.
    assert.match(text(expand(tree)), /2026-11-09T10-00-00-000Z\.md/, 'the backups are listed')

    const pick = walk(expand(tree)).find((node) => node.type === 'button' && text(node).includes('2026-11-09T10-00-00-000Z.md'))
    assert.ok(pick, 'a listed backup is selectable')
    tree = await runtime.fire(pick, 'onClick', MemoryOverviewPanel, {})
    assert.ok(calls.gets.some((url) => url.includes('/revision?') && url.includes('name=2026-11-09T10-00-00-000Z.md')), calls.gets.join('\n'))
    const preview = text(expand(tree))
    assert.match(preview, /Node 20/, 'the diff shows what the backup contains')
    assert.match(preview, /Node 22/, 'and what the current file has')

    const apply = walk(expand(tree)).find((node) => node.type === 'button' && text(node).startsWith('恢复这个版本'))
    assert.ok(apply, 'a previewed backup can be restored')
    await runtime.fire(apply, 'onClick', MemoryOverviewPanel, {})

    const restoreAction = calls.actions.find((payload) => payload.type === 'restore')
    assert.ok(restoreAction, 'a restore was posted')
    assert.equal(restoreAction.target, 'project-memory')
    assert.equal(restoreAction.name, '2026-11-09T10-00-00-000Z.md')
    // The revision is the one the diff was computed against, frozen with it —
    // not whatever the document says by the time the button is clicked.
    assert.equal(restoreAction.expectedRevision, 'rev-project')
    assert.equal(typeof restoreAction.operationId, 'string')
  } finally {
    restore()
  }
})

test('a backup list that arrives after the project changed is dropped', async () => {
  const restore = installTimers()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const calls = installFetch()
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/revisions')) await gate
    return inner(url, init)
  }
  try {
    let tree = await openProject()
    // The click is not awaited: its handler is the request that is gated, and a
    // test that awaits it would deadlock instead of moving on to switch files.
    const pending = runtime.fire(control(tree, '历史版本'), 'onClick', MemoryOverviewPanel, {})
    await tick(5)
    tree = await runtime.settle(MemoryOverviewPanel, {})
    assert.match(text(expand(tree)), /历史版本|读取备份列表/, 'the dialog is open and waiting')

    // Switch project while the list request is still in flight.
    const other = walk(tree).find((node) => node.type === 'button' && String(node.props?.className ?? '').includes('wbm-project') && text(node).includes('other'))
    assert.ok(other, 'the rail lists the other project')
    tree = await runtime.fire(other, 'onClick', MemoryOverviewPanel, {})

    release()
    await pending
    tree = await runtime.settle(MemoryOverviewPanel, {})
    const body = text(expand(tree))
    assert.equal(body.includes('2026-11-09T10-00-00-000Z.md'), false, 'the stale list is not shown for the new project')
    assert.equal(body.includes('恢复这个版本'), false, 'and it cannot be restored')
  } finally {
    release()
    restore()
  }
})

test('undo restores the file the write happened in, not the file on screen', async () => {
  const calls = installFetch({
    content: (url) =>
      String(url).includes('target=user-memory')
        ? { ...projectContent, target: 'user-memory', revision: 'rev-user', path: 'C:\\Users\\me\\.workbuddy\\MEMORY.md' }
        : projectContent,
  })
  const restore = installTimers()
  try {
    let tree = await openProject()
    const entry = walk(tree).find((node) => node.props?.title === '点击编辑' && text(node) === 'Node 22')
    tree = await runtime.fire(entry, 'onClick', MemoryOverviewPanel, {})
    const input = walk(tree).find((node) => node.type === 'input' && node.props.value === 'Node 22')
    tree = await runtime.fire(input, 'onChange', MemoryOverviewPanel, {}, { value: 'Node 24' })
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '保存'), 'onClick', MemoryOverviewPanel, {})
    assert.equal(calls.actions.length, 1)

    // Move to a different file before pressing undo.
    const userRow = walk(tree).find((node) => node.type === 'button' && text(node).includes('用户 MEMORY.md'))
    assert.ok(userRow, 'the rail lists the user file')
    tree = await runtime.fire(userRow, 'onClick', MemoryOverviewPanel, {})
    assert.match(text(expand(tree)), /rev-user/, 'the panel now shows the other file')

    const undo = walk(tree).find((node) => node.type === 'button' && text(node) === '撤销')
    assert.ok(undo, 'undo is still offered within its window')
    await runtime.fire(undo, 'onClick', MemoryOverviewPanel, {})

    const restoreAction = calls.actions.find((payload) => payload.type === 'restore')
    assert.ok(restoreAction, 'undo posted a restore')
    assert.equal(restoreAction.target, 'project-memory', 'undo goes back to the file it wrote')
    assert.equal(restoreAction.name, '2026-11-10T00-00-00-000Z.md')
    // The write's own post-write revision, not the user file's `rev-user`.
    assert.equal(restoreAction.expectedRevision, 'rev-next')
    assert.equal(calls.actionUrls.at(-1).includes('project=proj-a'), true, 'and to the project it wrote in')
  } finally {
    restore()
  }
})

// ── drafts ─────────────────────────────────────────────────────────────────

/** Open the draft dialog from the document header. */
async function openDraft(tree) {
  const button = control(tree, '粘贴草案')
  assert.ok(button, 'the document offers a draft entry')
  return runtime.fire(button, 'onClick', MemoryOverviewPanel, {})
}

const DRAFT_TEXT = '# 项目记忆\n\n## 环境\n- Node 24\n- Windows\n\n## 待办\n- 联调\n'

/** Find one control inside the draft dialog, which needs expanding first. */
function inDraft(tree, predicate) {
  return walk(expand(tree)).find(predicate)
}

const draftBody = (tree) => inDraft(tree, (node) => node.type === 'textarea' && String(node.props?.placeholder ?? '').includes('草案'))
const draftButton = (tree, label) => inDraft(tree, (node) => node.type === 'button' && text(node) === label)

test('a drafted rewrite previews against its own base revision, then applies once with it', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openDraft(await openProject())
    const body = draftBody(tree)
    assert.ok(body, 'the dialog has a body field')
    tree = await runtime.fire(body, 'onChange', MemoryOverviewPanel, {}, { value: DRAFT_TEXT })
    const base = inDraft(tree, (node) => node.type === 'input' && String(node.props?.value ?? '') === 'rev-project')
    assert.ok(base, 'the base revision is prefilled from the file the person was looking at')

    tree = await runtime.fire(draftButton(tree, '预览差异'), 'onClick', MemoryOverviewPanel, {})
    assert.ok(calls.gets.some((url) => url.includes('/content?target=project-memory')), 'the full original is read back before previewing')
    const preview = text(expand(tree))
    assert.match(preview, /Node 24/, 'the diff shows the drafted line')
    assert.match(preview, /Node 22/, 'and the line it replaces')

    const apply = draftButton(tree, '应用草案')
    assert.ok(apply, 'a previewed draft can be applied')
    await runtime.fire(apply, 'onClick', MemoryOverviewPanel, {})

    const written = calls.actions.find((payload) => payload.type === 'replace-document')
    assert.ok(written, 'exactly one document write')
    assert.equal(written.text, DRAFT_TEXT)
    assert.equal(written.expectedRevision, 'rev-project', 'the frozen base, not the newest revision on disk')
    assert.equal(typeof written.operationId, 'string')
  } finally {
    restore()
  }
})

test('a draft whose base revision no longer matches is refused before any preview', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openDraft(await openProject())
    tree = await runtime.fire(draftBody(tree), 'onChange', MemoryOverviewPanel, {}, { value: DRAFT_TEXT })

    // Someone else wrote the file after the model produced the draft.
    const stale = installFetch({ content: () => ({ ...projectContent, revision: 'rev-newer' }) })
    tree = await runtime.fire(draftButton(tree, '预览差异'), 'onClick', MemoryOverviewPanel, {})

    const shown = text(expand(tree))
    assert.match(shown, /基线|不一致|被改过/, 'the mismatch is explained')
    assert.equal(shown.includes('Node 24'), false, 'no diff is built from a stale base')
    assert.equal(stale.actions.length, 0)
    assert.equal(calls.actions.length, 0)

    const apply = draftButton(tree, '应用草案')
    if (apply) {
      await runtime.fire(apply, 'onClick', MemoryOverviewPanel, {})
      assert.equal(calls.actions.length, 0, 'a stale draft cannot be applied')
    }
  } finally {
    restore()
  }
})

test('changing the draft body discards the preview it was built from', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openDraft(await openProject())
    tree = await runtime.fire(draftBody(tree), 'onChange', MemoryOverviewPanel, {}, { value: DRAFT_TEXT })
    tree = await runtime.fire(draftButton(tree, '预览差异'), 'onClick', MemoryOverviewPanel, {})
    assert.ok(draftButton(tree, '应用草案'), 'the preview enables the apply button')

    tree = await runtime.fire(draftBody(tree), 'onChange', MemoryOverviewPanel, {}, { value: DRAFT_TEXT.replace('Node 24', 'Node 26') })
    // The button stays rendered but must be disabled: a preview is a statement
    // about one body against one base, and both just changed.
    assert.equal(draftButton(tree, '应用草案').props.disabled, true, 'the preview is no longer valid')
    assert.equal(calls.actions.length, 0)
  } finally {
    restore()
  }
})

test('a source too large to read whole cannot be drafted against', async () => {
  const calls = installFetch({
    content: () => ({ ...projectContent, truncated: true, revision: null, text: projectMemory.slice(0, 10) }),
  })
  const restore = installTimers()
  try {
    let tree = await openDraft(await openProject())
    tree = await runtime.fire(draftBody(tree), 'onChange', MemoryOverviewPanel, {}, { value: DRAFT_TEXT })
    tree = await runtime.fire(draftButton(tree, '预览差异'), 'onClick', MemoryOverviewPanel, {})

    assert.match(text(expand(tree)), /太大|截断|上限/)
    assert.equal(draftButton(tree, '应用草案').props.disabled, true)
    assert.equal(calls.actions.length, 0, 'nothing is written from a truncated source')
  } finally {
    restore()
  }
})

test('a conflict never offers to overwrite the disk', async () => {
  const calls = installFetch({ actionResult: () => ({ ok: false, code: 'conflict', revision: 'rev-other', expectedRevision: 'rev-project' }) })
  const restore = installTimers()
  try {
    let tree = await openProject()
    const entry = walk(tree).find((node) => node.props?.title === '点击编辑' && text(node) === 'Node 22')
    tree = await runtime.fire(entry, 'onClick', MemoryOverviewPanel, {})
    const input = walk(tree).find((node) => node.type === 'input' && node.props.value === 'Node 22')
    tree = await runtime.fire(input, 'onChange', MemoryOverviewPanel, {}, { value: 'Node 24' })
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '保存'), 'onClick', MemoryOverviewPanel, {})

    const body = text(expand(tree))
    assert.match(body, /文件已被改动/)
    assert.match(body, /保留草稿/)
    assert.match(body, /rev-other/)
    // The old third button deleted `expectedRevision` and wrote anyway — the one
    // action this product must never offer.
    assert.equal(body.includes('覆盖磁盘'), false, 'no blind overwrite')
    assert.equal(calls.actions.length, 1, 'and no second write was attempted')
  } finally {
    restore()
  }
})

// ── refusals inside a modal ────────────────────────────────────────────────

/** The text a modal shows, expanded so nested components are readable. */
const modalText = (tree) => text(expand(tree))

/** The expanded dialog nodes: only what a person can actually read on the mask. */
const modalNodes = (tree) => walk(expand(tree)).filter((node) => String(node.props?.className ?? '').includes('wbm-mask'))

/** Text of just the modal on screen, without the covered banner behind it. */
function onlyModalText(tree) {
  const masks = modalNodes(tree)
  assert.ok(masks.length >= 1, 'a modal is open')
  return masks.map((node) => text(node)).join('')
}

/** Open a draft and preview it, so the apply button is live. */
async function previewedDraft() {
  let tree = await openDraft(await openProject())
  tree = await runtime.fire(draftBody(tree), 'onChange', MemoryOverviewPanel, {}, { value: DRAFT_TEXT })
  tree = await runtime.fire(draftButton(tree, '预览差异'), 'onClick', MemoryOverviewPanel, {})
  assert.ok(draftButton(tree, '应用草案'), 'the draft is previewed')
  return tree
}

test('a refused draft apply explains itself in the dialog, not behind the mask', async () => {
  // The banner renders in the normal flow with no z-index; the dialog's mask is
  // `position:fixed; z-index:55`. A refusal written only to the banner is a
  // refusal nobody can read or dismiss — the dialog does not change a word, so
  // the button looks like it did nothing at all.
  for (const code of ['too_large', 'full_text_disabled', 'invalid_structure']) {
    runtime.reset()
    const calls = installFetch({ actionResult: () => ({ ok: false, code }) })
    const restore = installTimers()
    try {
      const tree = await previewedDraft()
      const before = onlyModalText(tree)
      const applied = await runtime.fire(draftButton(tree, '应用草案'), 'onClick', MemoryOverviewPanel, {})
      assert.equal(calls.actions.length, 1, `${code}: one write was attempted`)

      const after = onlyModalText(applied)
      assert.notEqual(after, before, `${code}: the dialog says something`)
      // The copy for the code, not the raw identifier: a person reads a sentence.
      assert.equal(after.includes(code), false, `${code}: the code is translated, not printed raw`)
      assert.match(after, /太大|全文编辑|结构/, `${code}: the refusal names the reason`)
      // The apply button goes back to a state the person can act on: a preview
      // that just failed is not a preview that is ready to submit again.
      assert.equal(draftButton(applied, '应用草案').props.disabled, true, `${code}: a refused apply is not still ready`)
      assert.equal(draftButton(applied, '预览差异').props.disabled, false, `${code}: but re-previewing is offered`)
    } finally {
      restore()
    }
  }
})

test('a refused restore explains itself in the history dialog', async () => {
  for (const code of ['too_large', 'invalid_structure', 'lock_timeout']) {
    runtime.reset()
    const calls = installFetch({ actionResult: () => ({ ok: false, code }) })
    const restore = installTimers()
    try {
      let tree = await openProject()
      tree = await runtime.fire(control(tree, '历史版本'), 'onClick', MemoryOverviewPanel, {})
      const pick = walk(expand(tree)).find((node) => node.type === 'button' && text(node).includes('2026-11-09T10-00-00-000Z.md'))
      tree = await runtime.fire(pick, 'onClick', MemoryOverviewPanel, {})
      const before = onlyModalText(tree)
      const restoreButton = walk(expand(tree)).find((node) => node.type === 'button' && text(node).startsWith('恢复这个版本'))
      assert.ok(restoreButton, `${code}: a previewed backup can be restored`)

      const after = await runtime.fire(restoreButton, 'onClick', MemoryOverviewPanel, {})
      assert.equal(calls.actions.length, 1)
      assert.notEqual(onlyModalText(after), before, `${code}: the dialog says something`)
      assert.equal(onlyModalText(after).includes(code), false, `${code}: the code is translated`)
      assert.match(onlyModalText(after), /太大|结构|占用/, `${code}: the refusal names the reason`)
    } finally {
      restore()
    }
  }
})

test('a modal refusal does not also raise the banner nobody can see', async () => {
  // Two copies of the same failure is worse than one: the banner is covered by
  // the mask, so it can only be discovered after the dialog closes, long after
  // it stopped being relevant.
  const calls = installFetch({ actionResult: () => ({ ok: false, code: 'too_large' }) })
  const restore = installTimers()
  try {
    const tree = await previewedDraft()
    const applied = await runtime.fire(draftButton(tree, '应用草案'), 'onClick', MemoryOverviewPanel, {})
    assert.equal(calls.actions.length, 1)
    const expanded = expand(applied)
    const banners = walk(expanded).filter((node) => String(node.props?.className ?? '').includes('wbm-banner warn'))
    const insideModal = banners.filter((node) => text(node).includes('太大'))
    assert.ok(insideModal.length >= 1, 'the reason is in the dialog')
    // The top-level banner lives directly under `wbm-root`; one there would be
    // the invisible duplicate.
    const rootBanners = walk(expanded)
      .filter((node) => node.props?.className === 'wbm-root')
      .flatMap((root) => (root.children ?? []).filter((child) => String(child.props?.className ?? '').includes('wbm-banner warn')))
    assert.equal(rootBanners.length, 0, 'no duplicate banner behind the mask')
  } finally {
    restore()
  }
})

// ── draft entry gating ─────────────────────────────────────────────────────

test('a draft entry needs full-text editing, and offers the same way out as source mode', async () => {
  // The draft's only write is `replace-document`, which the store refuses with
  // `full_text_disabled` whenever the switch is off. Source mode already asks
  // whether to turn it on; a draft button that can only fail has no way out.
  //
  // The panel reads the switch through `runtime.flags`, which `readFlags` fills
  // from the host form; there is no form here, so the flag is set directly.
  const { runtime: moduleRuntime } = client.__internals
  const calls = installFetch({ state: stateFor({ allowFullTextEdit: false }) })
  const restore = installTimers()
  const previous = moduleRuntime.flags.allowFullTextEdit
  moduleRuntime.flags.allowFullTextEdit = false
  try {
    const tree = await openProject()
    const draftEntry = control(tree, '粘贴草案')
    const historyButton = control(tree, '历史版本')
    assert.ok(historyButton, 'history restores a backup, which the switch does not gate')

    assert.ok(draftEntry, 'the draft entry is still offered, because it leads somewhere')
    // The entry has to lead to the same confirmation source mode uses.
    const next = await runtime.fire(draftEntry, 'onClick', MemoryOverviewPanel, {})
    const body = onlyModalText(next)
    assert.match(body, /全文编辑/, 'the entry explains what is off')
    const confirm = walk(expand(next)).find((node) => node.type === 'button' && /开启|打开/.test(text(node)))
    assert.ok(confirm, 'and offers to turn it on')
    assert.equal(calls.actions.length, 0, 'nothing was written by opening it')
  } finally {
    moduleRuntime.flags.allowFullTextEdit = previous
    restore()
  }
})

test('a refused draft with full-text editing off says which switch to flip', async () => {
  // Reached when the flag flips while the dialog is open. The refusal has to
  // name the setting, because the panel cannot turn it on from inside a failed
  // apply.
  const calls = installFetch({ actionResult: () => ({ ok: false, code: 'full_text_disabled' }) })
  const restore = installTimers()
  try {
    const tree = await previewedDraft()
    const applied = await runtime.fire(draftButton(tree, '应用草案'), 'onClick', MemoryOverviewPanel, {})
    assert.equal(calls.actions.length, 1)
    assert.match(modalText(applied), /全文编辑/, 'the refusal names the setting')
  } finally {
    restore()
  }
})

// ── async window ───────────────────────────────────────────────────────────

test('changing the draft base while the preview is in flight discards the late response', async () => {
  // The apply button submits `baseRevision`, which the preview response sets.
  // A response that lands after the person retyped the base would put the old
  // base back on screen while the field still shows the new one — the panel
  // would then claim one baseline and submit another.
  const restore = installTimers()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let contentCalls = 0
  const calls = installFetch()
  const inner = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/content') && init.method !== 'POST') {
      contentCalls += 1
      // Only the draft's own read is gated; opening the file must not hang.
      if (contentCalls > 1) await gate
    }
    return inner(url, init)
  }
  try {
    let tree = await openDraft(await openProject())
    tree = await runtime.fire(draftBody(tree), 'onChange', MemoryOverviewPanel, {}, { value: DRAFT_TEXT })

    // Start the preview, but do not await it: the request is the gated one.
    const pending = runtime.fire(draftButton(tree, '预览差异'), 'onClick', MemoryOverviewPanel, {})
    await tick(5)
    tree = await runtime.settle(MemoryOverviewPanel, {})

    // Retype the base while the request is in flight.
    const baseField = inDraft(tree, (node) => node.type === 'input' && String(node.props?.value ?? '').startsWith('rev-'))
    assert.ok(baseField, 'the base field is on screen')
    tree = await runtime.fire(baseField, 'onChange', MemoryOverviewPanel, {}, { value: 'rev-typed-by-user' })

    release()
    await pending
    tree = await runtime.settle(MemoryOverviewPanel, {})

    const shownBase = inDraft(tree, (node) => node.type === 'input' && String(node.props?.value ?? '').startsWith('rev-'))
    assert.equal(shownBase?.props?.value, 'rev-typed-by-user', 'the field keeps what the person typed')
    // A late response must not re-enable apply: it was built against a base the
    // person has since replaced.
    assert.equal(draftButton(tree, '应用草案').props.disabled, true, 'the stale preview does not re-arm apply')
    assert.equal(calls.actions.length, 0, 'and nothing is written')
  } finally {
    release()
    restore()
  }
})

test('the baseline on screen is the one the draft submits', async () => {
  // The invariant behind the race above: whatever the dialog shows as the
  // source revision is what the apply has to send.
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openDraft(await openProject())
    tree = await runtime.fire(draftBody(tree), 'onChange', MemoryOverviewPanel, {}, { value: DRAFT_TEXT })
    const baseField = inDraft(tree, (node) => node.type === 'input' && String(node.props?.value ?? '').startsWith('rev-'))
    assert.ok(baseField, 'the dialog prefills the base')
    tree = await runtime.fire(baseField, 'onChange', MemoryOverviewPanel, {}, { value: 'rev-project' })
    tree = await runtime.fire(draftButton(tree, '预览差异'), 'onClick', MemoryOverviewPanel, {})
    tree = await runtime.fire(draftButton(tree, '应用草案'), 'onClick', MemoryOverviewPanel, {})

    const written = calls.actions.find((payload) => payload.type === 'replace-document')
    const shown = inDraft(tree, (node) => node.type === 'input' && String(node.props?.value ?? '').startsWith('rev-'))?.props?.value
    assert.ok(written, 'the draft was applied')
    assert.equal(written.expectedRevision, 'rev-project')
    assert.equal(String(shown ?? 'rev-project'), written.expectedRevision, 'screen and request agree')
  } finally {
    restore()
  }
})

// ── conflict ownership ─────────────────────────────────────────────────────

test('a conflict during a draft apply never stacks two masks', async () => {
  // Both `.wbm-mask` layers are `z-index:55`, and the draft dialog renders after
  // the conflict dialog, so the conflict's three exits are covered by the draft.
  // Closing the draft then left the conflict on screen with nothing to own it.
  const calls = installFetch({ actionResult: () => ({ ok: false, code: 'conflict', revision: 'rev-other', expectedRevision: 'rev-project' }) })
  const restore = installTimers()
  try {
    const tree = await previewedDraft()
    const applied = await runtime.fire(draftButton(tree, '应用草案'), 'onClick', MemoryOverviewPanel, {})
    assert.equal(calls.actions.length, 1)

    const masks = modalNodes(applied)
    assert.equal(masks.length, 1, `at most one modal is on screen, saw ${masks.length}`)
    // And the conflict is not left ownerless behind it.
    assert.equal(onlyModalText(applied).includes('文件已被改动'), false, 'no orphan conflict dialog under the draft')
  } finally {
    restore()
  }
})

test('a conflict during a restore never stacks two masks', async () => {
  const calls = installFetch({ actionResult: () => ({ ok: false, code: 'conflict', revision: 'rev-other', expectedRevision: 'rev-project' }) })
  const restore = installTimers()
  try {
    let tree = await openProject()
    tree = await runtime.fire(control(tree, '历史版本'), 'onClick', MemoryOverviewPanel, {})
    const pick = walk(expand(tree)).find((node) => node.type === 'button' && text(node).includes('2026-11-09T10-00-00-000Z.md'))
    tree = await runtime.fire(pick, 'onClick', MemoryOverviewPanel, {})
    const restoreButton = walk(expand(tree)).find((node) => node.type === 'button' && text(node).startsWith('恢复这个版本'))
    const after = await runtime.fire(restoreButton, 'onClick', MemoryOverviewPanel, {})

    const masks = modalNodes(after)
    assert.equal(masks.length, 1, `at most one modal is on screen, saw ${masks.length}`)
    assert.match(onlyModalText(after), /重新选版本|已被改动|被改过/, 'the history dialog carries the conflict message')
  } finally {
    restore()
  }
})

test('a conflict during a source save never stacks two masks', async () => {
  const calls = installFetch({ actionResult: () => ({ ok: false, code: 'conflict', revision: 'rev-other', expectedRevision: 'rev-project' }) })
  const restore = installTimers()
  try {
    let tree = await openSourceMode(await openProject())
    const area = walk(tree).find((node) => node.type === 'textarea' && String(node.props?.value ?? '').includes('Node 22'))
    tree = await runtime.fire(area, 'onChange', MemoryOverviewPanel, {}, { value: projectMemory.replace('Node 22', 'Node 24') })
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '预览差异'), 'onClick', MemoryOverviewPanel, {})
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '保存整份文件'), 'onClick', MemoryOverviewPanel, {})

    assert.equal(calls.actions.length, 1)
    const masks = modalNodes(tree)
    // Source mode is an inline editor, not a modal: a conflict here may open the
    // conflict dialog, but it must be the only one.
    assert.ok(masks.length <= 1, `at most one modal, saw ${masks.length}`)
  } finally {
    restore()
  }
})

// ── source mode ────────────────────────────────────────────────────────────

/** Enter source mode, clicking through the first-run confirmation. */
async function openSourceMode(tree) {
  // The source button is labelled, not titled: it is the one action whose label
  // already says what it does.
  const open = walk(tree).find((node) => node.type === 'button' && text(node) === '源码')
  assert.ok(open, 'source mode is offered for a whole readable file')
  const next = await runtime.fire(open, 'onClick', MemoryOverviewPanel, {})
  const confirm = walk(expand(next)).find((node) => node.type === 'button' && /我明白|开启并打开/.test(text(node)))
  if (!confirm) return next
  return runtime.fire(confirm, 'onClick', MemoryOverviewPanel, {})
}

test('a source edit previews its diff before writing, and writes against the revision it opened with', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openSourceMode(await openProject())

    const area = walk(tree).find((node) => node.type === 'textarea' && String(node.props?.value ?? '').includes('Node 22'))
    assert.ok(area, 'source mode starts from the file as it is')
    tree = await runtime.fire(area, 'onChange', MemoryOverviewPanel, {}, { value: projectMemory.replace('Node 22', 'Node 24') })

    // The first save only previews: a whole-file write is the shape that needs
    // a look before it lands.
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '预览差异'), 'onClick', MemoryOverviewPanel, {})
    assert.equal(calls.actions.length, 0, 'the preview writes nothing')
    const preview = text(expand(tree))
    assert.match(preview, /Node 24/, 'the drafted line is in the diff')
    assert.match(preview, /Node 22/, 'and the line it replaces')

    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '保存整份文件'), 'onClick', MemoryOverviewPanel, {})
    const written = calls.actions.find((payload) => payload.type === 'replace-document')
    assert.ok(written, 'the second click writes')
    assert.equal(written.expectedRevision, 'rev-project', 'the revision the editor opened with')
    assert.match(written.text, /Node 24/)
  } finally {
    restore()
  }
})

test('editing the source body again drops the diff it was previewed from', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openSourceMode(await openProject())
    const area = () => walk(tree).find((node) => node.type === 'textarea' && String(node.props?.value ?? '').includes('Node 2'))
    tree = await runtime.fire(area(), 'onChange', MemoryOverviewPanel, {}, { value: projectMemory.replace('Node 22', 'Node 24') })
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '预览差异'), 'onClick', MemoryOverviewPanel, {})
    assert.ok(walk(tree).some((node) => node.type === 'button' && text(node) === '保存整份文件'))

    tree = await runtime.fire(area(), 'onChange', MemoryOverviewPanel, {}, { value: projectMemory.replace('Node 22', 'Node 26') })
    const save = walk(tree).find((node) => node.type === 'button' && text(node) === '预览差异')
    assert.ok(save, 'the button goes back to previewing')
    assert.equal(calls.actions.length, 0)
  } finally {
    restore()
  }
})

// ── panel write permission ─────────────────────────────────────────────────

test('an undo entry is dropped with the file it belongs to when the project has none', async () => {
  const calls = installFetch()
  const restore = installTimers()
  try {
    let tree = await openProject()
    const entry = walk(tree).find((node) => node.props?.title === '点击编辑' && text(node) === 'Node 22')
    tree = await runtime.fire(entry, 'onClick', MemoryOverviewPanel, {})
    const input = walk(tree).find((node) => node.type === 'input' && node.props.value === 'Node 22')
    tree = await runtime.fire(input, 'onChange', MemoryOverviewPanel, {}, { value: 'Node 24' })
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '保存'), 'onClick', MemoryOverviewPanel, {})

    // `other` has no MEMORY.md and no daily note, so selecting it clears the
    // document without opening another one — the case that used to leave the
    // previous file's history on screen.
    const other = walk(tree).find((node) => node.type === 'button' && String(node.props?.className ?? '').includes('wbm-project') && text(node).includes('other'))
    assert.ok(other, 'the rail lists the project with no memory')
    tree = await runtime.fire(other, 'onClick', MemoryOverviewPanel, {})

    const body = text(expand(tree))
    assert.equal(body.includes('历史版本'), false, 'no management surface is offered with no file open')
    assert.equal(body.includes('粘贴草案'), false)
  } finally {
    restore()
  }
})

test('panel writes off hides history, drafts, source mode and archiving', async () => {
  installFetch({ state: stateFor({ allowWriteActions: false }) })
  const restore = installTimers()
  try {
    const tree = await openProject()
    for (const title of ['历史版本', '粘贴草案', '源码', '归档旧日期']) {
      assert.equal(control(tree, title), undefined, `${title} must not be offered`)
    }
    assert.match(text(expand(tree)), /面板编辑未开启/)
  } finally {
    restore()
  }
})
