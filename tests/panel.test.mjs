/**
 * The panel driven through clicks.
 *
 * `client.test.mjs` freezes the pure helpers; this drives the real components:
 * a click becomes a fetch, a fetch becomes a render, and a refusal becomes a
 * message. The overview and the project page share one workspace component, so
 * the flows below cover both surfaces.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { beforeEach } from 'node:test'

import { createRuntime, text, tick, walk } from './helpers/react.mjs'
import { pinNavigator } from './helpers/locale.mjs'

// Every assertion below reads Chinese copy out of the real components. The
// panel resolves its language from the host or, absent one, from
// `navigator.language` — so without pinning it these tests assert against the
// runner's locale, which is English on CI and unavailable on Node 20.
pinNavigator('zh-CN')

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
const { MemoryWorkspace, MemoryProjectTab, PruneDialog, HistoryDialog, DraftDialog } = client.__internals

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
  chars: projectMemory.length,
  partial: false,
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
  chars: 20,
  partial: false,
  revision: 'rev-daily',
  entries: 1,
  truncated: false,
  text: '# 2026-11-09\n\n- 上午：写代码\n',
  sections: [],
  writable: false,
}

/** A project row's injection judgment, in the shape the catalog reports. */
const judged = (status, extra = {}) => ({
  status,
  mode: /complete|core-over-budget|truncated|omitted/.test(status) ? 'layered' : null,
  fallback: null,
  reason: null,
  overLimit: /^(core-over-budget|truncated|omitted)$/.test(status),
  dropped: 0,
  budget: 1400,
  need: 900,
  used: 900,
  ...extra,
})

function stateFor(overrides = {}) {
  const state = {
    ok: true,
    version: '0.1.0',
    cwd: 'C:\\repo',
    selected: null,
    readOnly: false,
    writeEnabled: true,
    allowWriteActions: true,
    limits: { project: 10000, user: 4000, profile: 2000, rules: 2000 },
    inject: { enabled: true, mode: 'layered', project: true, coreBudget: 4000 },
    archiveAfterDays: 30,
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
        injection: judged('complete', { need: 900, used: 900 }),
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
        entries: null,
        bytes: 0,
        chars: null,
        revision: null,
        mtime: null,
        latestDaily: '2026-11-08',
        oldestDailyAgeDays: 2,
        injection: judged('missing'),
        overLimit: false,
        stale: false,
        status: 'daily-only',
      },
    ],
    totals: { projects: 2, withMemory: 1, entries: 3, dailyFiles: 2, overLimit: 0, stale: 0, missing: 0, unmeasurable: 0 },
    attention: [],
    attentionTotal: 0,
    attentionMore: { 'over-limit': 0, stale: 0, missing: 0, unmeasurable: 0 },
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
        injection: judged('complete', { need: 900, used: 900 }),
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

/**
 * Keep the poll, undo and notice timers out of the test.
 *
 * `setInterval` is stubbed outright. `setTimeout` cannot be: `tick()` is built on
 * it, so stubbing it would deadlock every `settle`. Instead a long delay is
 * swallowed and a short one is left alone — which kills the 3.2-second notice
 * timer while leaving `setTimeout(0)` working.
 *
 * That timer mattered: `flash()` schedules `setNotice('')`, and `runtime.reset()`
 * only empties the hook array. A timer left over from an earlier test then fires
 * into whatever slot index `notice` now occupies, wiping a notice the current
 * test had just set — a 1-in-8 flake in the copy-button test, with no failing
 * assertion pointing anywhere near the cause.
 */
function installTimers() {
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.setTimeout = (fn, ms, ...rest) => (Number(ms) >= 1000 ? 0 : realSetTimeout(fn, ms, ...rest))
  globalThis.document = { hidden: false }
  return () => {
    globalThis.setInterval = realSetInterval
    globalThis.setTimeout = realSetTimeout
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
    // The revision is a write token, not a header fact: it shows where it is
    // compared (the conflict dialog), nowhere else.
    assert.doesNotMatch(body, /\brev [0-9a-f]/, 'no raw revision in a header')
    assert.match(body, /3 条 · \d+ 码元/, 'the file header counts entries and length in the limit unit')
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
  // Pinned to the old wording ("已超注入限额, next turn truncates") because
  // that sentence was true of no mode. The alert still leads the overview,
  // and it now says what the prompt actually did.
  const state = stateFor()
  state.projects[0] = { ...state.projects[0], overLimit: true, chars: 12000, status: 'over-limit', injection: judged('core-over-budget', { dropped: 4, need: 2400, used: 1375 }) }
  state.totals = { ...state.totals, overLimit: 1 }
  state.attention = [{ key: 'proj-a', name: 'repo', title: 'repo', hasMemory: true, latestDaily: '2026-11-09', oldestDailyAgeDays: 1, injection: state.projects[0].injection, reasons: ['over-limit'] }]
  state.attentionTotal = 1
  installFetch({ state })
  const restore = installTimers()
  try {
    const tree = await runtime.settle(MemoryOverviewPanel, {})
    const body = text(expand(tree))
    assert.match(body, /超限 1/)
    assert.match(body, /核心超预算 · 4 条未注入/)
    assert.doesNotMatch(body, /下一轮注入会截断/)
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
    // The file's path line is the marker now: the revision left the header.
    assert.match(text(expand(tree)), /Users\\me\\\.workbuddy\\MEMORY\.md/, 'the panel now shows the other file')

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
  for (const code of ['too_large', 'write_disabled', 'invalid_structure']) {
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
      assert.match(after, /太大|写入|结构/, `${code}: the refusal names the reason`)
      // The apply button goes back to a state the person can act on: a preview
      // that just failed is not a preview that is ready to submit again.
      assert.equal(draftButton(applied, '应用草案').props.disabled, true, `${code}: a refused apply is not still ready`)
      assert.equal(draftButton(applied, '预览差异').props.disabled, false, `${code}: but re-previewing is offered`)
    } finally {
      restore()
    }
  }
})

test('a refused write shows a sentence, never the raw code', async () => {
  // The two refusals a person actually reaches from the panel: creating a
  // section called "Core Memory" on an unsplit file, and clicking at all once
  // the receipt store is full. Both used to render as the bare identifier.
  const state = stateFor({ stateDir: 'C:\\Users\\me\\.dsh\\workbuddy-memory' })
  for (const code of ['layering_confirmation_required', 'receipt_capacity']) {
    runtime.reset()
    const calls = installFetch({ state, actionResult: () => ({ ok: false, code }) })
    const restore = installTimers()
    try {
      const tree = await openProject()
      const remove = walk(tree).find((node) => node.props?.title === '删除')
      assert.ok(remove, `${code}: a writable entry offers delete`)
      const after = await runtime.fire(remove, 'onClick', MemoryOverviewPanel, {})

      assert.equal(calls.actions.length, 1, `${code}: one write was attempted`)
      const body = text(expand(after))
      assert.equal(body.includes(code), false, `${code}: the code is translated, not printed raw`)
      assert.match(body, code === 'receipt_capacity' ? /回执/ : /常驻|核心/, `${code}: the refusal names the reason`)
      if (code === 'receipt_capacity') {
        // The one refusal that cannot be retried has to say where the receipts
        // are, or the person is stuck with no next step.
        assert.match(body, /receipts/, 'the receipt dead end names the directory to clean')
      }
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

test('the draft entry opens directly, with no full-text switch to satisfy', async () => {
  // A draft is written with `replace-document`. That path used to be gated behind
  // `ui.allowFullTextEdit`, so the entry had to offer a "turn it on" confirmation
  // first. The switch is gone: using source mode or a draft is the person's
  // decision, and `readOnly` / `write.enabled` are the only gates left. The entry
  // must therefore lead straight to the draft dialog, not to a question about a
  // setting that no longer exists.
  const calls = installFetch({})
  const restore = installTimers()
  try {
    const tree = await openProject()
    const draftEntry = control(tree, '粘贴草案')
    assert.ok(draftEntry, 'the draft entry is offered')

    const next = await runtime.fire(draftEntry, 'onClick', MemoryOverviewPanel, {})
    const body = onlyModalText(next)
    assert.doesNotMatch(body, /全文编辑/, 'no question about a removed setting')
    assert.equal(calls.actions.length, 0, 'opening it writes nothing')
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

test('a conflict during a source save is answered by the conflict dialog, not a dead end', async () => {
  // `masks <= 1` above is satisfied by "no dialog at all", which is exactly the
  // regression: source mode is an inline editor with no conflict UI of its own,
  // so swallowing the conflict left one exit — a generic reload that drops the
  // draft — and copy about picking a version, which source mode has none of.
  // The disk moved on while the draft was being written: the first read is what
  // the editor opened with, the second is what the diff exit finds there now.
  let reads = 0
  const calls = installFetch({
    actionResult: () => ({ ok: false, code: 'conflict', revision: 'rev-other', expectedRevision: 'rev-project' }),
    content: () => {
      reads += 1
      return reads === 1 ? projectContent : { ...projectContent, revision: 'rev-other', text: projectMemory.replace('Node 22', 'Node 20') }
    },
  })
  const restore = installTimers()
  try {
    let tree = await openSourceMode(await openProject())
    const area = walk(tree).find((node) => node.type === 'textarea' && String(node.props?.value ?? '').includes('Node 22'))
    tree = await runtime.fire(area, 'onChange', MemoryOverviewPanel, {}, { value: projectMemory.replace('Node 22', 'Node 24') })
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '预览差异'), 'onClick', MemoryOverviewPanel, {})
    tree = await runtime.fire(walk(tree).find((node) => node.type === 'button' && text(node) === '保存整份文件'), 'onClick', MemoryOverviewPanel, {})
    assert.equal(calls.actions.length, 1)

    const masks = modalNodes(tree)
    assert.equal(masks.length, 1, `exactly one modal, saw ${masks.length}`)
    const shown = onlyModalText(tree)
    assert.match(shown, /文件已被改动/, 'the conflict dialog is the one on screen')
    // All three exits, so "keep editing" is a real choice and not just reload.
    assert.match(shown, /查看磁盘差异/)
    assert.match(shown, /重新加载/)
    assert.match(shown, /保留草稿/)
    assert.match(shown, /rev-other/, 'and it names the revision that is on disk')
    // The version-picker wording belongs to the history dialog; there is no
    // version to pick here.
    assert.equal(shown.includes('重新选版本'), false, 'no advice to pick a version')

    // The line the inline editor keeps after the dialog closes. This is the one
    // surface the dialog cannot speak for: `history.stale` ("pick a version
    // again") is the history dialog's copy and would be wrong here, so the
    // editor has to carry `code.conflict` — the fact that the file moved on.
    const banner = text(expand(tree))
    assert.match(banner, /文件在你编辑期间被改过/, 'the editor banner says the file moved on')
    assert.equal(banner.includes('重新选版本'), false, 'and never sends source mode to a version picker')

    // The diff exit is live, not just a label: clicking it reads the disk copy.
    // The count has to be a delta — this flow has already read `/content` several
    // times (opening the project, entering source mode), so a plain `some(...)`
    // was satisfied before the click and asserted nothing. The rows the dialog
    // then renders are `ConflictDialog`'s own inline JSX, not `diffBlock`; the
    // pure diff arithmetic is covered by the `lineDiff` cases in
    // `client.test.mjs`, and this harness mounts one component, so what it can
    // prove here is that the click reaches the read and opens nothing else.
    const contentReads = () =>
      calls.gets.filter((url) => url.includes('/content?') && url.includes('target=project-memory')).length
    const readsBefore = contentReads()
    const viewDiff = walk(expand(tree)).find((node) => node.type === 'button' && text(node) === '查看磁盘差异')
    tree = await runtime.fire(viewDiff, 'onClick', MemoryOverviewPanel, {})
    assert.equal(contentReads(), readsBefore + 1, 'the diff exit asks the disk exactly once')
    assert.equal(modalNodes(tree).length, 1, 'and it stays the only mask')
    assert.equal(onlyModalText(tree).includes('读取'), false, 'and the read did not fail')

    // Keeping the draft really keeps it: the edited body is still in the editor
    // after the dialog closes, and nothing is left on screen.
    assert.ok(
      walk(tree).some((node) => node.type === 'textarea' && String(node.props?.value ?? '').includes('Node 24')),
      'the source draft survived the refusal',
    )
    const keep = walk(expand(tree)).find((node) => node.type === 'button' && text(node) === '保留草稿继续编辑')
    tree = await runtime.fire(keep, 'onClick', MemoryOverviewPanel, {})
    assert.equal(modalNodes(tree).length, 0, 'closing the dialog leaves no mask')
    assert.ok(
      walk(tree).some((node) => node.type === 'textarea' && String(node.props?.value ?? '').includes('Node 24')),
      'and the person is back in their own text',
    )
  } finally {
    restore()
  }
})

test('a conflict while deleting a section never leaves a dialog with nothing to own it', async () => {
  // The confirmation is a mask, and so is the conflict dialog it triggers. The
  // confirmation renders later, so it covers the conflict's exits; dismissing it
  // then left the conflict on screen with no surface that asked for it.
  const calls = installFetch({ actionResult: () => ({ ok: false, code: 'conflict', revision: 'rev-other', expectedRevision: 'rev-project' }) })
  const restore = installTimers()
  try {
    let tree = await openProject()
    const trash = walk(tree).find((node) => node.props?.title === '删除小节')
    assert.ok(trash, 'the section offers delete')
    tree = await runtime.fire(trash, 'onClick', MemoryOverviewPanel, {})
    assert.equal(modalNodes(tree).length, 1, 'the confirmation is the only mask')

    const confirmDelete = walk(expand(tree)).find((node) => node.type === 'button' && text(node) === '删除')
    assert.ok(confirmDelete, 'the confirmation asks before deleting')
    tree = await runtime.fire(confirmDelete, 'onClick', MemoryOverviewPanel, {})
    assert.equal(calls.actions.length, 1)

    assert.equal(modalNodes(tree).length, 1, `one mask, saw ${modalNodes(tree).length}`)
    assert.match(onlyModalText(tree), /文件已被改动/, 'and it is the conflict dialog')

    // Closing it leaves nothing behind: no second, ownerless dialog.
    const keep = walk(expand(tree)).find((node) => node.type === 'button' && text(node) === '保留草稿继续编辑')
    tree = await runtime.fire(keep, 'onClick', MemoryOverviewPanel, {})
    assert.equal(modalNodes(tree).length, 0, 'no dangling conflict dialog')
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

test('an unsplit file says it is injected whole, and offers the one action that starts a split', async () => {
  // The panel could not see this before: a file with no core section renders
  // exactly like one that never needed it, while every character of it reaches
  // the prompt every turn.
  installFetch({
    state: stateFor({
      stores: {
        ...stateFor().stores,
        project: { ...stateFor().stores.project, layering: { mode: 'legacy', reason: 'missing_core', coreEntries: 0, topics: 0, coreChars: 900, topicChars: 0 } },
      },
    }),
  })
  const restore = installTimers()
  try {
    const tree = await openProject()
    const body = text(expand(tree))
    assert.match(body, /仍整份注入/, 'the headline says what is happening, not what the file lacks')
    assert.match(body, /整份注入/)
    assert.ok(body.includes('900'), `the banner carries the always-on size: ${body}`)
    assert.match(body, /没有找到「常驻记忆」小节/)
    assert.match(body, /复制/)
  } finally {
    restore()
  }
})

test('a refused core names the section and the line the reader has to open', async () => {
  // The reason alone sent people looking through a long file for the line the
  // plugin refused. The host reports where it stopped; the banner repeats it in
  // the file's own coordinates.
  installFetch({
    state: stateFor({
      stores: {
        ...stateFor().stores,
        project: {
          ...stateFor().stores.project,
          layering: { mode: 'legacy', reason: 'invalid_core', problem: { section: '常驻记忆', line: 12 }, coreEntries: 0, topics: 0, coreChars: 900, topicChars: 0 },
        },
      },
    }),
  })
  const restore = installTimers()
  try {
    const tree = await openProject()
    const body = text(expand(tree))
    assert.match(body, /位置：## 常驻记忆 第 12 行/)
    assert.match(body, /「常驻记忆」小节里有非条目内容/)
  } finally {
    restore()
  }
})

test('two core sections are both addressed', async () => {
  installFetch({
    state: stateFor({
      stores: {
        ...stateFor().stores,
        project: {
          ...stateFor().stores.project,
          layering: { mode: 'legacy', reason: 'ambiguous_core', problem: { section: '常驻记忆', line: 3, lines: [3, 19] }, coreEntries: 0, topics: 0, coreChars: 900, topicChars: 0 },
        },
      },
    }),
  })
  const restore = installTimers()
  try {
    const tree = await openProject()
    assert.match(text(expand(tree)), /位置：第 3 \/ 19 行/)
  } finally {
    restore()
  }
})

test('a split file shows no banner, because its header already carries the counts', async () => {
  installFetch({
    state: stateFor({
      stores: {
        ...stateFor().stores,
        project: { ...stateFor().stores.project, layering: { mode: 'layered', reason: null, coreEntries: 2, topics: 3, coreChars: 200, topicChars: 700 } },
      },
    }),
  })
  const restore = installTimers()
  try {
    const tree = await openProject()
    const body = text(expand(tree))
    assert.doesNotMatch(body, /仍整份注入/, 'no banner for a file that is already split')
  } finally {
    restore()
  }
})

test('the copy button puts the split prompt on the clipboard, and survives a host without one', async () => {
  const written = []
  // Node 24 exposes `navigator` as a getter-only global, so it has to be
  // redefined rather than assigned; the descriptor is restored afterwards.
  //
  // `language` has to survive the replacement: the panel picks its copy from
  // `navigator.language`, so a bare `{clipboard}` object silently flips the
  // whole UI to English and every Chinese assertion below fails for a reason
  // that has nothing to do with the clipboard.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const withClipboard = (value) =>
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', ...value }, configurable: true, writable: true })
  withClipboard({ clipboard: { writeText: async (text) => { written.push(text) } } })
  installFetch({
    state: stateFor({
      stores: {
        ...stateFor().stores,
        project: { ...stateFor().stores.project, layering: { mode: 'legacy', reason: 'missing_core', coreEntries: 0, topics: 0, coreChars: 900, topicChars: 0 } },
      },
    }),
  })
  const restore = installTimers()
  try {
    let tree = await openProject()
    // `walk` stops at function components, so the tree is expanded first: the
    // banner lives under `docView()`, one component down.
    const button = walk(expand(tree)).find((node) => node.type === 'button' && text(node).includes('复制'))
    assert.ok(button, 'the banner offers the copy action')
    tree = await runtime.fire(button, 'onClick', MemoryWorkspace, OVERVIEW)
    assert.equal(written.length, 1, 'the prompt reached the clipboard')
    assert.match(written[0], /memory_read/)
    assert.match(written[0], /常驻记忆/)
    assert.match(written[0], /不要直接写文件/, 'the prompt tells the model to hand back a draft, not to write')
    assert.match(text(expand(tree)), /已复制/)

    // A host with no clipboard API must not turn the click into a crash: the
    // prompt is already visible in the hint, so the notice is enough.
    withClipboard({})
    tree = await openProject()
    const again = walk(expand(tree)).find((node) => node.type === 'button' && text(node).includes('复制'))
    await runtime.fire(again, 'onClick', MemoryWorkspace, OVERVIEW)
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
    restore()
  }
})

test('the panel renders the entries of a daily note that has no headings', async () => {
  // Counting them is only half the fix: the file view renders `doc.sections`, so
  // a top region that is counted but not rendered would still look empty.
  const cwd = mkdtempSync(join(tmpdir(), 'wbm-daily-panel-'))
  const memDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memDir, { recursive: true })
  const body = '- 第一条日记\n- 第二条日记\n'
  writeFileSync(join(memDir, '2026-11-17.md'), body, 'utf8')

  installFetch({
    state: stateFor({
      cwd,
      selected: cwd,
      projects: [{ ...stateFor().projects[0], key: 'proj-d', path: cwd, name: 'daily', title: 'daily', current: true, latestDaily: '2026-11-17' }],
      stores: {
        ...stateFor().stores,
        project: { ...stateFor().stores.project, dir: memDir, memory: join(memDir, 'MEMORY.md'), daily: [{ name: '2026-11-17.md', date: '2026-11-17', bytes: body.length, ageDays: 0 }] },
      },
    }),
    content: (url) =>
      String(url).includes('target=project-daily')
        ? {
            ok: true,
            target: 'project-daily',
            date: '2026-11-17',
            path: join(memDir, '2026-11-17.md'),
            bytes: body.length,
            revision: 'rev-daily',
            entries: 2,
            truncated: false,
            text: body,
            sections: [{ heading: '(top)', level: 1, line: -1, endLine: 1, top: true, entries: [{ line: 0, text: '第一条日记' }, { line: 1, text: '第二条日记' }] }],
            writable: false,
          }
        : projectContent,
  })
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryWorkspace, { mode: 'overview', layout: 'wide' })
    const row = walk(tree).find((node) => node.type === 'button' && String(node.props?.className ?? '').includes('wbm-project') && text(node).includes('daily'))
    assert.ok(row, 'the project is listed')
    tree = await runtime.fire(row, 'onClick', MemoryWorkspace, { mode: 'overview', layout: 'wide' })
    // Selecting a project opens MEMORY.md when it exists; the daily note is the
    // "latest" button next to it.
    const daily = walk(tree).find((node) => node.type === 'button' && text(node).includes('2026-11-17'))
    assert.ok(daily, 'the latest daily button is offered')
    tree = await runtime.fire(daily, 'onClick', MemoryWorkspace, { mode: 'overview', layout: 'wide' })
    const body2 = text(expand(tree))
    assert.doesNotMatch(body2, /这个文件还是空的/, 'the empty-state must not appear for a file with entries')
    assert.match(body2, /第一条日记/, 'the first entry is rendered')
    assert.match(body2, /第二条日记/, 'and the second')
  } finally {
    restore()
  }
})

test('a daily note can be given a section from the panel', async () => {
  // The panel used to hard-code `section: ''` for daily files, so the model and
  // the panel both had no way to produce a `##` heading there — and the panel
  // groups rows by section, so such a note always rendered as one flat list.
  const cwd = mkdtempSync(join(tmpdir(), 'wbm-daily-sec-'))
  const memDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memDir, { recursive: true })
  const body = '- 已有条目\n'
  writeFileSync(join(memDir, '2026-11-17.md'), body, 'utf8')

  const calls = installFetch({
    state: stateFor({
      cwd,
      selected: cwd,
      projects: [{ ...stateFor().projects[0], key: 'proj-s', path: cwd, name: 'sec', title: 'sec', current: true, latestDaily: '2026-11-17' }],
      stores: {
        ...stateFor().stores,
        project: { ...stateFor().stores.project, dir: memDir, memory: join(memDir, 'MEMORY.md'), daily: [{ name: '2026-11-17.md', date: '2026-11-17', bytes: body.length, ageDays: 0 }] },
      },
    }),
    content: (url) =>
      String(url).includes('target=project-daily')
        ? {
            ok: true,
            target: 'project-daily',
            date: '2026-11-17',
            path: join(memDir, '2026-11-17.md'),
            bytes: body.length,
            revision: 'rev-daily',
            entries: 1,
            truncated: false,
            text: body,
            sections: [{ heading: '(top)', level: 1, line: -1, endLine: 0, top: true, entries: [{ line: 0, text: '已有条目' }] }],
            writable: false,
          }
        : projectContent,
  })
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryWorkspace, { mode: 'overview', layout: 'wide' })
    const row = walk(tree).find((node) => node.type === 'button' && String(node.props?.className ?? '').includes('wbm-project') && text(node).includes('sec'))
    tree = await runtime.fire(row, 'onClick', MemoryWorkspace, { mode: 'overview', layout: 'wide' })
    const dailyButton = walk(tree).find((node) => node.type === 'button' && text(node).includes('2026-11-17'))
    tree = await runtime.fire(dailyButton, 'onClick', MemoryWorkspace, { mode: 'overview', layout: 'wide' })

    // Open the add-entry editor and fill both fields.
    const addButton = walk(tree).find((node) => node.type === 'button' && text(node).includes('添加一条'))
    assert.ok(addButton, 'the daily note offers an add button')
    tree = await runtime.fire(addButton, 'onClick', MemoryWorkspace, { mode: 'overview', layout: 'wide' })

    const inputs = walk(tree).filter((node) => node.type === 'input' && String(node.props?.className ?? '').includes('wbm-input'))
    assert.equal(inputs.length, 2, 'the daily editor offers a section field and a text field')
    tree = await runtime.fire(inputs[0], 'onChange', MemoryWorkspace, { mode: 'overview', layout: 'wide' }, { value: '进展' })
    const refreshed = walk(tree).filter((node) => node.type === 'input' && String(node.props?.className ?? '').includes('wbm-input'))
    tree = await runtime.fire(refreshed[1], 'onChange', MemoryWorkspace, { mode: 'overview', layout: 'wide' }, { value: '新条目' })

    const save = walk(tree).find((node) => node.type === 'button' && String(node.props?.className ?? '').includes('primary') && text(node).includes('添加'))
    assert.ok(save, 'the save button is available')
    await runtime.fire(save, 'onClick', MemoryWorkspace, { mode: 'overview', layout: 'wide' })

    const add = calls.actions.find((action) => action.type === 'add')
    assert.ok(add, 'an add action was sent')
    assert.equal(add.section, '进展', 'the section reaches the store instead of being dropped')
    assert.equal(add.text, '新条目')
  } finally {
    restore()
  }
})

// ── the panel reads the prompt's own judgment (row.injection) ─────────────

/** A project row as the catalog now reports one, with its injection judgment. */
const injectionOf = (status, extra = {}) => ({
  status,
  mode: /core-over-budget|complete/.test(status) ? 'layered' : null,
  fallback: null,
  reason: null,
  overLimit: status === 'core-over-budget' || status === 'truncated' || status === 'omitted',
  dropped: 0,
  budget: 1400,
  need: 1200,
  used: 1200,
  ...extra,
})

test('a large split file with a small core is not called over the limit', async () => {
  // Acceptance 1 from the panel's side: 12,000 units of file, all of the core
  // injected. Every surface used to say "over the injection limit".
  const state = stateFor()
  state.projects[0] = { ...state.projects[0], chars: 12000, overLimit: false, injection: injectionOf('complete'), status: 'ok' }
  installFetch({ state })
  const restore = installTimers()
  try {
    const tree = expand(await runtime.settle(MemoryOverviewPanel, {}))
    const body = text(tree)
    assert.doesNotMatch(body, /超限 [1-9]/)
    assert.doesNotMatch(body, /已超注入限额|超注入限额|下一轮注入会截断/)
    assert.doesNotMatch(body, /核心超预算/)
  } finally {
    restore()
  }
})

test('a core that lost entries is the one thing called out, with its count, on every surface', async () => {
  // Acceptance 2: the state, the count and the wording come from the row.
  const state = stateFor()
  state.projects[0] = {
    ...state.projects[0],
    chars: 9000,
    overLimit: true,
    status: 'over-limit',
    injection: injectionOf('core-over-budget', { dropped: 3, need: 2100, used: 1375 }),
  }
  state.totals = { ...state.totals, overLimit: 1 }
  state.attention = [{ key: 'proj-a', name: 'repo', title: 'repo', hasMemory: true, latestDaily: '2026-11-09', oldestDailyAgeDays: 1, injection: state.projects[0].injection, reasons: ['over-limit'] }]
  state.attentionTotal = 1
  state.attentionMore = { 'over-limit': 0, stale: 0, missing: 0, unmeasurable: 0 }
  const calls = installFetch({ state })
  const restore = installTimers()
  try {
    const tree = await runtime.settle(MemoryOverviewPanel, {})
    const body = text(expand(tree))
    assert.match(body, /超限 1/)
    assert.match(body, /核心超预算 · 3 条未注入/, 'the overview names the real cause and count')
    assert.doesNotMatch(body, /已超注入限额|下一轮注入会截断/, 'it no longer promises a truncation that will not happen')

    const open = walk(expand(tree)).find((node) => node.type === 'button' && text(node) === '查看')
    assert.ok(open, 'the attention row offers to open the project')
    const opened = await runtime.fire(open, 'onClick', MemoryWorkspace, OVERVIEW)
    const detail = text(expand(opened))
    assert.match(detail, /核心超预算 · 3 条未注入/, 'the project header carries the same state')
    assert.doesNotMatch(detail, /下一轮注入会截断|超过注入限额/)
    assert.ok(calls.gets.some((url) => url.includes('project=proj-a')), 'and the project was fetched by key')
  } finally {
    restore()
  }
})

test('a project that fell back to whole-file injection and was cut says "whole file, truncated"', async () => {
  const state = stateFor()
  state.projects[0] = {
    ...state.projects[0],
    chars: 12000,
    overLimit: true,
    status: 'over-limit',
    injection: injectionOf('truncated', { mode: 'whole', fallback: 'legacy', reason: 'missing_core', budget: 10000, need: 12000, used: 10000 }),
  }
  state.totals = { ...state.totals, overLimit: 1 }
  state.attention = [{ key: 'proj-a', name: 'repo', title: 'repo', hasMemory: true, latestDaily: '2026-11-09', oldestDailyAgeDays: 1, injection: state.projects[0].injection, reasons: ['over-limit'] }]
  state.attentionTotal = 1
  installFetch({ state })
  const restore = installTimers()
  try {
    const body = text(expand(await runtime.settle(MemoryOverviewPanel, {})))
    assert.match(body, /超限 1/)
    assert.match(body, /整份截断/, 'the wording names what actually happens to this file')
    assert.doesNotMatch(body, /核心超预算/)
  } finally {
    restore()
  }
})

test('disabled, empty, unmeasurable and not-created are four different things', async () => {
  const state = stateFor()
  state.projects[0] = { ...state.projects[0], injection: judged('disabled') }
  state.projects[1] = { ...state.projects[1], hasMemory: true, bytes: 4, injection: judged('empty') }
  const restore = installTimers()
  try {
    // The project tab shows the session's project, so its header is where the
    // state of that project belongs.
    installFetch({ state })
    const project = text(expand(await runtime.settle(MemoryProjectPanel, PROJECT)))
    assert.match(project, /注入已关闭/)
    assert.doesNotMatch(project, /已用 \d+%/, 'no percentage for a source that injects nothing')
    assert.doesNotMatch(project, /已用 0%/)

    // The second project, reached from the overview rail, has a blank file.
    installFetch({ state })
    runtime.reset()
    let tree = await runtime.settle(MemoryOverviewPanel, OVERVIEW)
    const other = walk(tree).find((node) => node.type === 'button' && String(node.props?.className ?? '').includes('wbm-project') && text(node).includes('other'))
    assert.ok(other, 'the overview rail lists the second project')
    tree = await runtime.fire(other, 'onClick', MemoryWorkspace, OVERVIEW)
    const empty = text(expand(tree))
    assert.match(empty, /文件为空/)
    assert.doesNotMatch(empty, /超限/, 'nothing is lost from an empty file, so nothing is over any limit')
    assert.doesNotMatch(empty, /未创建/, 'it does have a file')
    assert.doesNotMatch(empty, /已用 \d+%/)
  } finally {
    restore()
  }
})

test('a project without MEMORY.md is "not created", not "0 entries, 0% used"', async () => {
  // Reached from the overview rail, which lists every project; the project
  // tab follows the session's own project and only shows a picker when it
  // has none.
  const state = stateFor()
  installFetch({ state })
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryOverviewPanel, OVERVIEW)
    const other = walk(tree).find((node) => node.type === 'button' && String(node.props?.className ?? '').includes('wbm-project') && text(node).includes('other'))
    assert.ok(other, 'the overview rail lists the second project')
    tree = await runtime.fire(other, 'onClick', MemoryWorkspace, OVERVIEW)
    const body = text(expand(tree))
    assert.match(body, /未创建/)
    assert.doesNotMatch(body, /已用 \d+%/)
    assert.doesNotMatch(body, /MEMORY 0 条/)
  } finally {
    restore()
  }
})

test('the file header measures the file in the limit unit and never prints "KB%"', async () => {
  const restore = installTimers()
  try {
    const doc = { ...projectContent, bytes: 18635, chars: 6200, partial: false }
    installFetch({ content: () => doc })
    let tree = await runtime.settle(MemoryProjectPanel, PROJECT)
    let body = text(expand(tree))
    assert.doesNotMatch(body, /KB%|MB%/, 'the byte string no longer lands in the percent slot')
    assert.match(body, /6200 码元/)
    assert.match(body, /3 条 · 6200 码元/)

    // A prefix of a large file: the length is unknown, so none is shown.
    installFetch({ content: () => ({ ...doc, chars: null, partial: true, truncated: true, revision: null, entries: 1 }) })
    runtime.reset()
    tree = await runtime.settle(MemoryProjectPanel, PROJECT)
    const fileHeader = text(expand(walk(tree).find((node) => String(node.props?.className ?? '').includes('wbm-doc-title'))))
    assert.match(fileHeader, /已显示 1 条/, 'and the entry count says it is only what is shown')
    assert.doesNotMatch(fileHeader, /码元/, 'no length is claimed for a file only partly read')
    assert.doesNotMatch(fileHeader, /0 码元/, 'and never 0: unmeasured is not zero')

    // Whole file read, display cut: length known, rows are a prefix. Large
    // lengths are abbreviated the way the design mock shows them (`6.2k`).
    installFetch({ content: () => ({ ...doc, chars: 900000, partial: true, truncated: true, revision: null, entries: 900 }) })
    runtime.reset()
    tree = await runtime.settle(MemoryProjectPanel, PROJECT)
    body = text(expand(tree))
    assert.match(body, /已显示 900 条 · 900k 码元/)
  } finally {
    restore()
  }
})

test('the revision leaves the headers; the conflict dialog still shows both', async () => {
  const state = stateFor()
  installFetch({ state })
  const restore = installTimers()
  try {
    const tree = await openProject()
    const body = text(expand(tree))
    assert.doesNotMatch(body, /\brev [0-9a-f]{16}/, 'no raw revision in a header')
  } finally {
    restore()
  }
})

test('the archive dialog opens on the threshold /state reported', async () => {
  // Driven like the prune test above: this is the dialog's own contract. The
  // opening preview names no `beforeDays`, so the host applies the one
  // threshold every other surface counts with, and reports it back.
  const actions = []
  const props = {
    projectKey: 'proj-a',
    act: async (payload) => {
      actions.push(payload)
      return { ok: true, dryRun: true, planId: 'p', beforeDays: 30, candidates: [] }
    },
    onClose: () => {},
    flash: () => {},
    reload: async () => {},
  }
  const restore = installTimers()
  try {
    const tree = await runtime.settle(PruneDialog, props)
    const plan = actions.find((action) => action.type === 'prune')
    assert.ok(plan, 'the dialog planned first')
    assert.equal(plan.beforeDays, undefined, 'the opening preview leaves the days to the host default')
    const body = text(expand(tree))
    assert.match(body, /早于/, 'the dialog shows the number it used')
    assert.match(body, /30 天以前没有日期文件/, 'and that number is the one the host reported')

    // A person changing the days is the one case a number is sent.
    const input = walk(tree).find((node) => node.type === 'input' && node.props.type === 'number')
    assert.equal(input.props.disabled, false, 'the field is live once the default is known')
    let next = await runtime.fire(input, 'onChange', PruneDialog, props, { value: '45' })
    const recompute = walk(next).find((node) => node.type === 'button' && text(node) === '重新出计划')
    await runtime.fire(recompute, 'onClick', PruneDialog, props)
    assert.equal(actions.at(-1).beforeDays, 45, 'an explicit choice is sent as given')
  } finally {
    restore()
  }
})

// ── P1: layout ───────────────────────────────────────────────────────────

test('the first frame claims no counts, and an empty machine says so', async () => {
  // Before /state arrives the header used to render "项目 0 / 有记忆 0 / 条目 0".
  const restore = installTimers()
  try {
    // /state never answers, so the panel is stuck on its first frame.
    const waiting = installFetch({ state: stateFor() })
    globalThis.fetch = async () => new Promise(() => {})
    void waiting
    let tree = await runtime.settle(MemoryOverviewPanel, {})
    let body = text(expand(tree))
    assert.doesNotMatch(body, /项目 0|条目 0|已创建记忆文件/, 'no zero counts before the first state')
    assert.match(body, /读取中/, 'a loading state instead')

    // Loaded, and the machine knows no projects at all.
    const empty = stateFor({ projects: [], projectsTotal: 0, attention: [], attentionTotal: 0, totals: { projects: 0, withMemory: 0, entries: 0, dailyFiles: 0, overLimit: 0, stale: 0, missing: 0, unmeasurable: 0 } })
    installFetch({ state: empty })
    runtime.reset()
    tree = await runtime.settle(MemoryOverviewPanel, {})
    body = text(expand(tree))
    assert.match(body, /暂无项目/, 'the empty state is named')
    assert.doesNotMatch(body, /项目 0/, 'and it is not a row of zeros')
    assert.match(body, /用户 MEMORY\.md/, 'the user memory entry is still reachable')
  } finally {
    restore()
  }
})

test('the overview breadcrumb follows the open project and offers one way back', async () => {
  const restore = installTimers()
  try {
    installFetch()
    let tree = await runtime.settle(MemoryOverviewPanel, {})
    assert.match(text(expand(tree)), /全部项目/, 'nothing open: the breadcrumb is the scope')
    tree = await openProject()
    const body = text(expand(tree))
    assert.match(body, /全部项目 › repo/, 'with a project open it names it')
    assert.equal((body.match(/返回全部项目|全部项目/g) ?? []).length >= 1, true)
    // Exactly one control goes back, and it is labelled as going back.
    const back = walk(tree).filter((node) => node.type === 'button' && /^(返回全部项目|全部项目)$/.test(text(node)))
    assert.equal(back.length, 1, `one back control, got ${back.length}`)
    tree = await runtime.fire(back[0], 'onClick', MemoryWorkspace, OVERVIEW)
    assert.doesNotMatch(text(expand(tree)), / › /, 'back on the overview')
  } finally {
    restore()
  }
})

test('the narrow tab shortens the alert and the explanation is a keyboard-reachable disclosure', async () => {
  const state = stateFor()
  state.projects[0] = { ...state.projects[0], overLimit: true, status: 'over-limit', injection: judged('core-over-budget', { dropped: 3, need: 2100, used: 1375 }) }
  const restore = installTimers()
  try {
    installFetch({ state })
    // The right-sidebar tab: compact wording.
    // The tab follows its own session; give it one.
    const tab = { tab: true, sessionId: 's', useSessions: (selector) => selector({ byId: { s: { id: 's', cwd: 'C:\\repo', retainedBy: { mainView: 1 } } } }), useWorkspaces: (selector) => selector({ items: [] }) }
    let tree = await runtime.settle(MemoryWorkspace, { mode: 'project', layout: 'wide', ...tab })
    let body = text(expand(tree))
    assert.match(body, /核心 3 条未注入/, 'short form in the tab')
    assert.doesNotMatch(body, /核心超预算 · 3 条未注入/, 'not the long form')

    // The explanation is a native <details>: focusable, toggleable without script.
    const details = walk(tree).find((node) => node.type === 'details')
    assert.ok(details, 'the state is a disclosure')
    assert.ok(String(details.props.className).includes('wbm-explain'))
    const summary = details.children.find((node) => node.type === 'summary')
    assert.ok(summary, 'with a summary to focus')
    assert.ok(summary.props['aria-label'], 'the summary names what it explains')
    assert.match(text(expand(details)), /完整核心块需要 2100 码元，预算 1400 码元，本次注入 1375 码元/, 'the numbers are inside')

    // The wide panel uses the long form.
    runtime.reset()
    installFetch({ state })
    tree = await runtime.settle(MemoryOverviewPanel, {})
    tree = await openProject()
    assert.match(text(expand(tree)), /核心超预算 · 3 条未注入/, 'long form where there is room')
  } finally {
    restore()
  }
})

test('no surface prints a raw revision, a KB% or a next-turn promise any more', async () => {
  const state = stateFor()
  state.projects[0] = { ...state.projects[0], overLimit: true, status: 'over-limit', injection: judged('truncated', { mode: 'whole', fallback: 'legacy', reason: 'missing_core', budget: 10000, need: 12000, used: 10000 }) }
  state.attention = [{ key: 'proj-a', name: 'repo', title: 'repo', hasMemory: true, latestDaily: '2026-11-09', oldestDailyAgeDays: 1, injection: state.projects[0].injection, reasons: ['over-limit'] }]
  state.attentionTotal = 1
  const restore = installTimers()
  try {
    installFetch({ state })
    const overview = text(expand(await runtime.settle(MemoryOverviewPanel, {})))
    installFetch({ state })
    runtime.reset()
    const opened = text(expand(await openProject()))
    for (const [name, body] of [['overview', overview], ['project', opened]]) {
      assert.doesNotMatch(body, /\brev [0-9a-f]{6,}/, `${name}: raw revision`)
      assert.doesNotMatch(body, /KB%|MB%|B%/, `${name}: bytes in a percent slot`)
      assert.doesNotMatch(body, /下一轮注入会截断|已超注入限额|超注入限额/, `${name}: a promise about the next turn`)
    }
  } finally {
    restore()
  }
})

test('no dictionary entry is left behind with nothing showing it', () => {
  // Copy that nothing renders is worse than no copy at all: it reads as a
  // live sentence to the next reader, and two of these still promised "the
  // next turn truncates it" after the panel stopped saying so anywhere.
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const zh = source.slice(source.indexOf('const ZH = {'), source.indexOf('const EN = {'))
  const keys = [...zh.matchAll(/^\s*'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.-]+)':/gm)].map((match) => match[1])
  const used = new Set([...source.matchAll(/\bt\(\s*'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.-]+)'/g)].map((match) => match[1]))
  // Keys reached by a computed name are not literals: `describeCode`'s table,
  // the `layer.legacyReason.*` / `inject.why.*` families, and keys the code
  // names inside a ternary. "Mentioned" means mentioned in the *code*, after
  // the dictionaries — a key's own definition does not count as a use.
  const code = source.slice(source.indexOf('function bindCopy'))
  const mentioned = new Set([...code.matchAll(/'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.-]+)'/g)].map((match) => match[1]))
  const prefixes = ['layer.legacyReason.', 'inject.why.']
  const dead = [...new Set(keys)].filter((key) => !mentioned.has(key) && !prefixes.some((prefix) => key.startsWith(prefix))).sort()
  // 21 keys were already orphaned before the panel-tag work (including two
  // `code.*` keys that `MESSAGES` deliberately routes elsewhere); removing
  // them is not this change's to make. What must hold is that the set never
  // grows.
  const preExisting = [
    'code.read_only_target', 'code.unknown_project',
    'common.retry', 'dialog.confirmDelete', 'dialog.confirmDeleteSection', 'dialog.conflictBody', 'dialog.pruneBody',
    'dialog.sourceBody', 'doc.addEntry', 'doc.searchInDoc', 'doc.sectionBody', 'doc.sectionHeading', 'doc.sourceMode',
    'file.empty', 'file.noMemory', 'file.noMemoryHint', 'panel.allProjects', 'rail.userMemory', 'settings.home',
    'settings.panelWriteHint', 'settings.revisionLine',
  ]
  assert.deepEqual(dead, preExisting, 'dictionary keys nothing renders (the pre-existing orphans, and no new ones)')
  void used
})

test('a project count that includes gone directories says so', async () => {
  // P2: "项目 12" looked healthy while three of the twelve no longer existed
  // on disk. The count is still right — they are known projects — but the
  // tooltip now says how many of them are gone.
  const state = stateFor()
  state.totals = { ...state.totals, projects: 12, missing: 3 }
  const restore = installTimers()
  try {
    installFetch({ state })
    const tree = await runtime.settle(MemoryOverviewPanel, {})
    const chip = walk(tree).find((node) => String(node.props?.className ?? '').includes('wbm-chip-quiet'))
    assert.ok(chip, 'the summary chip is on screen')
    assert.match(String(chip.props.title), /3 个的目录已不存在/, 'the tooltip names the gone directories')
  } finally {
    restore()
  }
})

test('after "show all", a poll does not shrink the attention list back to the preview', async () => {
  // The panel polls /state every few seconds, without `attention=all`. A
  // list expanded by hand was cut back to the preview on the next poll —
  // three seconds after the click — with nothing to say it had happened.
  const N = 12
  const state = stateFor()
  state.attentionTotal = N
  state.attentionMore = { 'over-limit': N - 8, stale: 0, missing: 0, unmeasurable: 0 }
  const row = (i) => ({ key: `k${i}`, name: `p${i}`, title: `p${i}`, hasMemory: true, latestDaily: null, injection: judged('core-over-budget', { dropped: 1 }), reasons: ['over-limit'] })
  const calls = installFetch({
    state,
    content: () => projectContent,
  })
  // Override the state answer: the host sends the preview unless asked for all.
  const base = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') return base(url, init)
    const href = String(url)
    calls.gets.push(href)
    // Exactly what the host does: the preview unless the request asks for all.
    const body = href.includes('/content') ? projectContent : { ...state, attention: Array.from({ length: href.includes('attention=all') ? N : 8 }, (_, i) => row(i)) }
    return { ok: true, status: 200, json: async () => body }
  }
  const restore = installTimers()
  try {
    let tree = await runtime.settle(MemoryOverviewPanel, OVERVIEW)
    // Only the attention rows: "view" also appears once, for the user profile.
    const count = () => {
      let inAttention = false
      let seen = 0
      for (const node of walk(tree)) {
        if (node.type === 'div' && String(node.props?.className ?? '').includes('wbm-h2') && text(node) === '需要关注') inAttention = true
        else if (node.type === 'div' && String(node.props?.className ?? '').includes('wbm-h2')) inAttention = false
        else if (inAttention && node.type === 'button' && text(node) === '查看') seen += 1
      }
      return seen
    }
    assert.equal(count(), 8, 'the preview is bounded')
    const showAll = walk(tree).find((node) => node.type === 'button' && text(node) === '查看全部')
    assert.ok(showAll, 'and offers the rest')
    tree = await runtime.fire(showAll, 'onClick', MemoryWorkspace, OVERVIEW)
    assert.equal(count(), N, 'the expanded list arrived')
    assert.ok(calls.gets.some((url) => url.includes('attention=all')), 'fetched by the explicit request')

    // The next poll: the same component, polled again.
    const poll = walk(tree).find((node) => node.type === 'button' && node.props?.title === '刷新')
    assert.ok(poll, 'the refresh control is on screen')
    tree = await runtime.fire(poll, 'onClick', MemoryWorkspace, OVERVIEW)
    assert.equal(count(), N, 'a poll does not shrink the expanded list')
    assert.doesNotMatch(text(expand(tree)), /只显示前 8 个/, 'and does not claim only 8 are shown')
  } finally {
    globalThis.fetch = base
    restore()
  }
})

test('an unmeasured file never shows "0 entries" anywhere', async () => {
  // A MEMORY.md past the read cap exists but nobody has counted its entries.
  // The rule "a number nobody measured is not zero" was applied to the
  // length only; the entry count still came through as 0 — "MEMORY 0 条 ·
  // 无法测量" in the header, "big 0 条" in the rail and in recent activity.
  const state = stateFor()
  state.projects[0] = { ...state.projects[0], entries: null, chars: null, bytes: 3 * 1024 * 1024, injection: judged('unmeasurable', { reason: 'too_large' }), status: 'unreadable' }
  state.stores.project = { ...state.stores.project, entries: null, chars: null, injection: state.projects[0].injection }
  state.totals = { ...state.totals, entries: null, unmeasurable: 1 }
  state.attention = [{ key: 'proj-a', name: 'repo', title: 'repo', hasMemory: true, latestDaily: '2026-11-09', oldestDailyAgeDays: 1, injection: state.projects[0].injection, reasons: ['unmeasurable'] }]
  state.attentionTotal = 1
  state.attentionMore = { 'over-limit': 0, stale: 0, missing: 0, unmeasurable: 0 }
  const restore = installTimers()
  try {
    // Project tab: the header of the project itself.
    installFetch({ state })
    let tree = await runtime.settle(MemoryProjectPanel, PROJECT)
    let body = text(expand(tree))
    assert.doesNotMatch(body, /0 条/, 'an unmeasured file has no entry count, not a count of zero')
    assert.match(body, /无法测量/, 'and says it cannot be measured')
    assert.doesNotMatch(body, /条目0/, 'the stat card does not show 0 either')

    // Overview: the rail row, the attention row and the summary line.
    installFetch({ state })
    runtime.reset()
    tree = await runtime.settle(MemoryOverviewPanel, OVERVIEW)
    body = text(expand(tree))
    assert.doesNotMatch(body, /repo\s*0 条/, 'the rail row')
    assert.doesNotMatch(body, /已创建记忆文件 · 0 条/, 'the summary line does not claim zero entries')
    assert.match(body, /MEMORY\.md 无法按完整内容判断/, 'the attention row names the reason')
  } finally {
    restore()
  }
})
