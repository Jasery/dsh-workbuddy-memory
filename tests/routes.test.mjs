/** Panel routes: shape of the JSON and the guards in front of it. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { createProjectCatalog } from '../src/host/catalog.js'
import { createTranslator } from '../src/locale.js'
import { registerRoutes } from '../src/host/routes.js'
import { createStore } from '../src/write/store.js'

/** Capture the registered route and answer one request against it. */
async function harness({ readOnly = false, allowWriteActions = false, recent = { cwd: null }, connection, config = {}, catalog: withCatalog = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wbm-routes-'))
  const home = join(root, 'home')
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'MEMORY.md'), '## 偏好\n- 用简体中文\n', 'utf8')

  const stateDir = join(root, 'state')
  const cfg = normalizeConfig({ workbuddyHome: home, stateDir, readOnly, ui: { allowWriteActions }, ...config })
  const store = createStore({ cfg, stateDir })
  // Wired the way pply wires it when asked: the same recent list, the same translator.
  const catalog = withCatalog ? createProjectCatalog({ cfg, recent, registry: () => [], t: createTranslator('zh') }) : undefined
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    logger: { warn() {} },
    get(name) {
      return name === 'connection' ? connection : undefined
    },
  }

  const registered = registerRoutes(ctx, { cfg, recent, stateDir, version: 'test', store, catalog })
  assert.equal(registered, true)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/workbuddy-memory')

  const call = (url, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve) => {
      const res = {
        status: 0,
        headers: null,
        body: '',
        writeHead(status, responseHeaders) {
          this.status = status
          this.headers = responseHeaders
        },
        end(payload) {
          this.body = payload ?? ''
          resolve({ status: this.status, headers: this.headers, body: this.body })
        },
      }
      const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
      req.url = url
      req.method = method
      req.headers = headers
      void routes[0].handler(req, res)
    })

  return { call, home, cfg, store }
}

test('state reports the stores it can see', async () => {
  const { call, home } = await harness()
  const response = await call('/workbuddy-memory/state')
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')

  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.home.path, home)
  assert.equal(body.stores.user.memory, join(home, 'MEMORY.md'))
  assert.equal(body.stores.user.bytes > 0, true)
  assert.equal(body.readOnly, false)
})

test('content returns text, revision and sections', async () => {
  const { call } = await harness()
  const body = JSON.parse((await call('/workbuddy-memory/content?target=user-memory')).body)
  assert.equal(body.ok, true)
  assert.match(body.text, /用简体中文/)
  assert.equal(body.sections.length, 1)
  assert.equal(body.sections[0].heading, '偏好')
  assert.equal(typeof body.revision, 'string')
})

test('content refuses anything that is not an enum target', async () => {
  const { call } = await harness()
  const unknown = await call('/workbuddy-memory/content?target=../..%2Fetc%2Fpasswd')
  assert.equal(unknown.status, 404)
  assert.equal(JSON.parse(unknown.body).code, 'unknown_target')

  const badDate = await call('/workbuddy-memory/content?target=project-daily&date=nope')
  assert.equal(badDate.status, 400)
  assert.equal(JSON.parse(badDate.body).code, 'bad_date')
})

test('read routes only answer GET, and only the panel may write', async () => {
  const { call } = await harness()
  const write = await call('/workbuddy-memory/state', { method: 'POST' })
  assert.equal(write.status, 405)
  assert.equal(JSON.parse(write.body).code, 'method_not_allowed')

  // `/action` exists but is refused while `ui.allowWriteActions` is off.
  const off = await call('/workbuddy-memory/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'remove', target: 'project-memory', section: 'x', line: 1 }),
  })
  assert.equal(off.status, 403)
  assert.equal(JSON.parse(off.body).code, 'write_actions_disabled')

  const cross = await call('/workbuddy-memory/state', { headers: { origin: 'https://evil.example', host: '127.0.0.1:1' } })
  assert.equal(cross.status, 403)
  assert.equal(JSON.parse(cross.body).code, 'cross_origin')

  const same = await call('/workbuddy-memory/state', { headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' } })
  assert.equal(same.status, 200)
})

test('the connection trust fence decides before any routing', async () => {
  // A DNS-rebinding page sends a matching Host and Origin, so the local origin
  // check cannot see it. The host's own fence can, and it is asked first.
  const rejected = await harness({ connection: { requestRejection: () => 403 } })
  const blocked = await rejected.call('/workbuddy-memory/state', {
    headers: { origin: 'http://evil.tld:1234', host: 'evil.tld:1234' },
  })
  assert.equal(blocked.status, 403)
  assert.equal(JSON.parse(blocked.body).code, 'untrusted')

  const unauthenticated = await harness({ connection: { requestRejection: () => 401 } })
  const anonymous = await unauthenticated.call('/workbuddy-memory/content?target=user-memory')
  assert.equal(anonymous.status, 401)

  // A fence that throws must fail closed, not open.
  const broken = await harness({
    connection: {
      requestRejection() {
        throw new Error('connection torn down')
      },
    },
  })
  assert.equal((await broken.call('/workbuddy-memory/state')).status, 403)

  // An admitted request passes through to the normal routing.
  const admitted = await harness({ connection: { requestRejection: () => undefined } })
  assert.equal((await admitted.call('/workbuddy-memory/state')).status, 200)
})

test('read-only config is reported', async () => {
  const { call } = await harness({ readOnly: true })
  const body = JSON.parse((await call('/workbuddy-memory/state')).body)
  assert.equal(body.readOnly, true)
})

test('the panel can switch between the workspaces it has seen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wbm-multi-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'MEMORY.md'), '## 偏好\n- 简体中文\n', 'utf8')

  const first = join(root, 'alpha')
  const second = join(root, 'beta')
  for (const [dir, text] of [
    [first, '## 甲\n- 来自 alpha\n'],
    [second, '## 乙\n- 来自 beta\n'],
  ]) {
    mkdirSync(join(dir, '.workbuddy', 'memory'), { recursive: true })
    writeFileSync(join(dir, '.workbuddy', 'memory', 'MEMORY.md'), text, 'utf8')
    writeFileSync(join(dir, '.workbuddy', 'memory', '2026-11-09.md'), '- 一天\n', 'utf8')
  }

  const seen = new Map([
    [first, Date.now() - 1000],
    [second, Date.now()],
  ])
  const { call } = await harness({ recent: { cwd: second, seen } })

  const keyOf = (cwd) => createHash('sha1').update(cwd).digest('hex').slice(0, 8)

  const state = JSON.parse((await call('/workbuddy-memory/state')).body)
  assert.equal(state.projects.length, 2)
  assert.equal(state.cwd, second)
  assert.equal(state.projects.find((row) => row.current).path, second)
  assert.equal(state.projects.find((row) => row.path === first).hasMemory, true)
  assert.equal(state.projects.find((row) => row.path === first).daily, 1)

  // Pinning a workspace moves every read to that project.
  const pinned = JSON.parse((await call(`/workbuddy-memory/state?project=${keyOf(first)}`)).body)
  assert.equal(pinned.cwd, first)
  assert.match(pinned.stores.project.memory, /alpha/)

  const content = JSON.parse((await call(`/workbuddy-memory/content?target=project-memory&project=${keyOf(first)}`)).body)
  assert.equal(content.ok, true)
  assert.match(content.text, /来自 alpha/)

  const daily = JSON.parse((await call(`/workbuddy-memory/content?target=project-daily&date=2026-11-09&project=${keyOf(first)}`)).body)
  assert.equal(daily.ok, true)

  // A key this plugin never saw is refused: the route is not a path reader.
  const unknown = await call('/workbuddy-memory/content?target=project-memory&project=deadbeef')
  assert.equal(unknown.status, 404)
  assert.equal(JSON.parse(unknown.body).code, 'unknown_project')

  const crossRead = await call(`/workbuddy-memory/content?target=project-memory&project=${'0'.repeat(8)}`)
  assert.equal(crossRead.status, 404)
})

test('a project target without a workspace says so, rather than blaming the target', async () => {
  const { call } = await harness()
  const project = await call('/workbuddy-memory/content?target=project-memory')
  assert.equal(project.status, 404)
  assert.equal(JSON.parse(project.body).code, 'no_project')

  const daily = await call('/workbuddy-memory/content?target=project-daily&date=2026-11-09')
  assert.equal(JSON.parse(daily.body).code, 'no_project')

  // An actually unknown target still reports as one.
  const bogus = await call('/workbuddy-memory/content?target=../etc/passwd')
  assert.equal(JSON.parse(bogus.body).code, 'unknown_target')
})

/** A workspace with one old daily file, so an archive plan has a candidate. */
async function archiveHarness() {
  const root = mkdtempSync(join(tmpdir(), 'wbm-routes-prune-'))
  const home = join(root, 'home')
  const proj = join(root, 'proj')
  const memDir = join(proj, '.workbuddy', 'memory')
  mkdirSync(join(home, 'memory'), { recursive: true })
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(home, 'MEMORY.md'), '## 偏好\n- 简体中文\n', 'utf8')
  writeFileSync(join(memDir, 'MEMORY.md'), '## 环境\n- Node 22\n', 'utf8')
  writeFileSync(join(memDir, '2020-01-02.md'), '- 很久以前\n', 'utf8')

  const stateDir = join(root, 'state')
  const cfg = normalizeConfig({ workbuddyHome: home, stateDir, ui: { allowWriteActions: true } })
  const store = createStore({ cfg, stateDir })
  const routes = []
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => fn(),
    logger: { warn() {} },
    get: () => undefined,
  }
  registerRoutes(ctx, { cfg, recent: { cwd: proj }, stateDir, version: 'test', store })

  const post = (payload) =>
    new Promise((resolve) => {
      const res = {
        status: 0,
        headers: null,
        body: '',
        writeHead(status, headers) { this.status = status; this.headers = headers },
        end(payload) { this.body = payload ?? ''; resolve({ status: this.status, body: this.body }) },
      }
      const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')])
      req.url = '/workbuddy-memory/action'
      req.method = 'POST'
      req.headers = { 'content-type': 'application/json' }
      void routes[0].handler(req, res)
    })

  return { post, memDir }
}

test('the archive route forwards planId, so an apply lands on the previewed set', async () => {
  // Without the passthrough the store sees no plan and refuses every apply with
  // plan_required — the preview would be a dead end.
  const { post, memDir } = await archiveHarness()

  const planned = JSON.parse((await post({ type: 'prune', dryRun: true, beforeDays: 30 })).body)
  assert.equal(planned.ok, true)
  assert.equal(typeof planned.planId, 'string')
  assert.deepEqual(planned.candidates.map((row) => row.date), ['2020-01-02'])

  const applied = JSON.parse(
    (await post({ type: 'prune', dryRun: false, planId: planned.planId, dates: ['2020-01-02'], operationId: 'op-route-plan' })).body,
  )
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.deepEqual(applied.pruned.map((row) => row.date), ['2020-01-02'])
  assert.equal(existsSync(join(memDir, '2020-01-02.md')), false)
  assert.equal(existsSync(join(memDir, 'archive', '2020-01-02.md')), true)
})

test('an archive retry replays the same plan instead of re-enumerating it', async () => {
  const { post, memDir } = await archiveHarness()
  const planned = JSON.parse((await post({ type: 'prune', dryRun: true, beforeDays: 30 })).body)

  const payload = { type: 'prune', dryRun: false, planId: planned.planId, dates: ['2020-01-02'], operationId: 'op-route-replay' }
  const first = JSON.parse((await post(payload)).body)
  assert.equal(first.ok, true)

  // A timeout retry of the same click: the store recognises the receipt.
  const again = JSON.parse((await post(payload)).body)
  assert.equal(again.ok, true)
  assert.equal(again.duplicate, true)
  assert.equal(existsSync(join(memDir, 'archive', '2020-01-02.md')), true)
})

test('a plan the store never issued is refused, and nothing moves', async () => {
  const { post, memDir } = await archiveHarness()
  const refused = JSON.parse(
    (await post({ type: 'prune', dryRun: false, planId: 'plan-not-minted-here', dates: ['2020-01-02'], operationId: 'op-route-bogus' })).body,
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'plan_required')
  assert.equal(refused.reason, 'unknown_plan')
  assert.equal(existsSync(join(memDir, '2020-01-02.md')), true)
})

test('state reports how each memory file is injected, so the panel can say "whole file"', async () => {
  // Without this the panel cannot tell a split file from one injected whole: the
  // bytes look identical, and whole-file injection is exactly the state that
  // pushes the always-on prefix toward its limit.
  const { call, home } = await harness()
  const body = JSON.parse((await call('/workbuddy-memory/state')).body)

  // The fixture's user memory has no core section, so it is legacy and its whole
  // length is always-on.
  assert.equal(body.stores.user.layering.mode, 'legacy')
  assert.equal(body.stores.user.layering.reason, 'missing_core')
  assert.equal(body.stores.user.layering.coreChars, body.stores.user.chars)
  assert.equal(body.stores.user.layering.topicChars, 0)

  // No project memory exists in this fixture, so there is nothing to describe.
  assert.equal(body.stores.project.layering, null)
  void home
})

test('a split file is reported as layered with both halves measured', async () => {
  const { call, home } = await harness()
  writeFileSync(join(home, 'MEMORY.md'), '# User\n\n## 常驻记忆\n- core\n\n## Alpha\n- a\n', 'utf8')
  const body = JSON.parse((await call('/workbuddy-memory/state')).body)

  assert.equal(body.stores.user.layering.mode, 'layered')
  assert.equal(body.stores.user.layering.reason, null)
  assert.equal(body.stores.user.layering.coreEntries, 1)
  assert.equal(body.stores.user.layering.topics, 1)
  assert.ok(body.stores.user.layering.coreChars > 0)
  assert.ok(body.stores.user.layering.topicChars > 0)
})

test('a refused core reaches /state with the section and line to open', async () => {
  // The panel banner is only actionable if the position survives the route: the
  // reason alone sent people scanning a long file for the one line that failed.
  const { call, home } = await harness()
  writeFileSync(join(home, 'MEMORY.md'), '# User\n\n## 常驻记忆\n- fine\nprose is not a bullet\n', 'utf8')
  const body = JSON.parse((await call('/workbuddy-memory/state')).body)
  assert.equal(body.stores.user.layering.mode, 'legacy')
  assert.equal(body.stores.user.layering.reason, 'invalid_core')
  assert.deepEqual(body.stores.user.layering.problem, { section: '常驻记忆', line: 5 })
})

test('the layering summary never carries entry text into /state', async () => {
  // `/state` is polled every three seconds; shipping the memory body through it
  // would put the whole file on the wire on a timer.
  const { call, home } = await harness()
  const secret = 'SUPER-SECRET-ENTRY-TEXT'
  writeFileSync(join(home, 'MEMORY.md'), `# User\n\n## 常驻记忆\n- ${secret}\n\n## Alpha\n- also ${secret}\n`, 'utf8')
  const response = await call('/workbuddy-memory/state')
  assert.equal(response.body.includes(secret), false, 'no entry text appears in the state payload')
  const body = JSON.parse(response.body)
  assert.equal(body.stores.user.layering.mode, 'layered')
})

test('a daily note written as bare bullets is not reported as empty', async () => {
  // The panel called a 1.5 KB daily note "still empty": `describe` counted
  // entries only inside `parseSections` ranges, and a file with no `##` heading
  // has none — so `entries === 0 && sections.length === 0` matched the empty-file
  // branch. Daily notes are exactly the file most likely to be written that way.
  //
  // A daily note lives under the *project* directory, so the harness needs a cwd:
  // with `recent.cwd: null` the project target resolves to no path at all.
  const cwd = mkdtempSync(join(tmpdir(), 'wbm-daily-'))
  const { call } = await harness({ recent: { cwd } })
  const memDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memDir, { recursive: true })

  const shapes = {
    '- one\n- two\n- three\n': 3,
    '# 2026-11-17\n\n- one\n- two\n': 2,
    '## Progress\n- one\n- two\n': 2,
    '- above\n\n## Progress\n- below\n': 2,
    '': 0,
  }
  for (const [body, expected] of Object.entries(shapes)) {
    writeFileSync(join(memDir, '2026-11-17.md'), body, 'utf8')
    const parsed = JSON.parse((await call('/workbuddy-memory/content?target=project-daily&date=2026-11-17')).body)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.entries, expected, `body ${JSON.stringify(body.slice(0, 30))} should have ${expected} entries, got ${parsed.entries}`)
  }
})

test('the region above the first heading is a section the panel can address', async () => {
  // It is reported with `top: true` and the `(top)` heading the tools already use,
  // so the panel renders those rows instead of dropping them.
  const cwd = mkdtempSync(join(tmpdir(), 'wbm-daily-'))
  const { call } = await harness({ recent: { cwd } })
  const memDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, '2026-11-17.md'), '- first\n- second\n\n## Later\n- third\n', 'utf8')

  const parsed = JSON.parse((await call('/workbuddy-memory/content?target=project-daily&date=2026-11-17')).body)
  const top = parsed.sections.find((section) => section.top)
  assert.ok(top, 'the top region is reported')
  assert.equal(top.heading, '(top)', 'with the same pseudo-heading the tools use')
  assert.equal(top.entries.length, 2)
  assert.equal(parsed.sections.find((section) => section.heading === 'Later').entries.length, 1)
  // Line numbers must still point at the real rows: the section editor and the
  // per-entry editor address rows by line.
  assert.deepEqual(top.entries.map((entry) => entry.line), [0, 1])
})

test('an actually empty daily note still reports zero entries', async () => {
  // The fix must not turn "nothing there" into a phantom section: the empty-state
  // branch in the panel depends on this staying 0.
  const cwd = mkdtempSync(join(tmpdir(), 'wbm-daily-'))
  const { call } = await harness({ recent: { cwd } })
  const memDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, '2026-11-17.md'), '', 'utf8')
  const parsed = JSON.parse((await call('/workbuddy-memory/content?target=project-daily&date=2026-11-17')).body)
  assert.equal(parsed.entries, 0)
  assert.equal(parsed.sections.length, 0)
})


/** The core of an over-budget split file: six entries, far past a 1400 share. */
const OVER_CORE = `# M\n\n## 常驻记忆\n${Array.from({ length: 6 }, (_, index) => `- 核心条目 ${index} ${'重要'.repeat(140)}`).join('\n')}\n`
const FITS = '# M\n\n## 常驻记忆\n- one\n'

/** `count` projects under one root; `over` names the indexes that are over budget. */
function manyProjects(root, count, over = []) {
  const seen = new Map()
  let clock = Date.now() - 3_600_000
  const old = new Date(clock - 3_600_000)
  for (let index = 0; index < count; index += 1) {
    const cwd = join(root, `p${String(index).padStart(2, '0')}`)
    const dir = join(cwd, '.workbuddy', 'memory')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'MEMORY.md')
    writeFileSync(file, over.includes(index) ? OVER_CORE : FITS, 'utf8')
    // The seen stamps own the activity order; a file written "now" would not.
    utimesSync(file, old, old)
    clock += 1000
    seen.set(cwd, clock)
  }
  return seen
}

test('state totals cover every project, and one past the display bound can still be opened', async () => {
  // Acceptance 7: 60 projects, a display bound of 50, and the only over-budget
  // project is the 51st by activity. The totals used to be summed over the 50
  // rows returned, and the attention list could not hold that one at all.
  const root = mkdtempSync(join(tmpdir(), 'wbm-routes-many-'))
  const seen = manyProjects(root, 60, [9])
  const { call } = await harness({ recent: { cwd: null, seen }, config: { ui: { maxProjects: 50 } }, catalog: true })

  const state = JSON.parse((await call('/workbuddy-memory/state')).body)
  assert.equal(state.projects.length, 50, 'the display bound still holds')
  assert.equal(state.projectsTotal, 60)
  assert.equal(state.projects.some((row) => row.name === 'p09'), false)
  assert.equal(state.totals.projects, 60)
  assert.equal(state.totals.withMemory, 60)
  assert.equal(state.totals.overLimit, 1, 'one project lost core entries')
  assert.equal(state.attentionTotal, 1)
  assert.equal(state.attention[0].name, 'p09', 'the preview is not limited to the listed rows')
  assert.equal(state.attention[0].injection.status, 'core-over-budget')
  assert.equal(state.project, null, 'nothing is selected')

  const key = state.attention[0].key
  const opened = JSON.parse((await call(`/workbuddy-memory/state?project=${key}`)).body)
  assert.equal(opened.project.name, 'p09', 'the selected project resolves on its own')
  assert.equal(opened.project.overLimit, true)
  assert.equal(opened.projects.some((row) => row.key === key), false, 'and the list is unchanged by selecting it')
  assert.equal(opened.stores.project.injection.status, 'core-over-budget', 'the store view and the row agree')
  assert.equal(opened.stores.project.layering.mode, 'layered')

  const content = JSON.parse((await call(`/workbuddy-memory/content?target=project-memory&project=${key}`)).body)
  assert.equal(content.ok, true)
  assert.match(content.text, /核心条目 0/)
})

test('the attention preview is bounded by default and complete on request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wbm-routes-attention-'))
  const seen = manyProjects(root, 12, Array.from({ length: 12 }, (_, index) => index))
  const { call } = await harness({ recent: { cwd: null, seen }, catalog: true })

  const page = JSON.parse((await call('/workbuddy-memory/state')).body)
  assert.equal(page.attentionTotal, 12)
  assert.equal(page.attention.length, 8, 'the preview carries the first few')
  assert.equal(page.attentionMore['over-limit'], 4, 'and says how many more there are')
  assert.equal(page.totals.overLimit, 12, 'the total was never limited to the preview')

  const all = JSON.parse((await call('/workbuddy-memory/state?attention=all')).body)
  assert.equal(all.attention.length, 12)
  assert.equal(all.attentionMore['over-limit'], 0)

  // An unusable value falls back to the default bound rather than to nothing.
  const bogus = JSON.parse((await call('/workbuddy-memory/state?attention=not-a-number')).body)
  assert.equal(bogus.attention.length, 8)
})
test('the archive default comes from one place, and the action falls back to it', async () => {
  // Acceptance 8, through the route: with `beforeDays` omitted, a preview must
  // cover exactly the files the overview flagged — 30 and 31 days, not 29.
  const cwd = mkdtempSync(join(tmpdir(), 'wbm-routes-age-'))
  const memDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memDir, { recursive: true })
  const date = (days) => {
    const day = new Date()
    day.setDate(day.getDate() - days)
    return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-')
  }
  for (const days of [29, 30, 31]) writeFileSync(join(memDir, `${date(days)}.md`), '- 一天\n', 'utf8')

  const { call } = await harness({ recent: { cwd }, config: { ui: { allowWriteActions: true } }, catalog: true })
  const state = JSON.parse((await call('/workbuddy-memory/state')).body)
  assert.equal(state.archiveAfterDays, 30, 'the panel reads the default from /state')
  assert.equal(state.totals.stale, 1)
  assert.equal(state.projects[0].stale, true)

  const preview = JSON.parse(
    (await call('/workbuddy-memory/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'prune', dryRun: true }),
    })).body,
  )
  assert.equal(preview.ok, true)
  assert.equal(preview.beforeDays, 30)
  assert.deepEqual(preview.candidates.map((row) => row.date).sort(), [date(30), date(31)].sort(), 'the same two files the warning is about')
})

test('content gives the whole file length in code units, or none when it only read a prefix', async () => {
  // Acceptance 6: the header shows one number for "how long is this file", in
  // the unit the injection limit is stated in. When only a prefix was read
  // there is no such number, and inventing the prefix's length is a lie.
  const cwd = mkdtempSync(join(tmpdir(), 'wbm-routes-length-'))
  const memDir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(memDir, { recursive: true })
  const memory = join(memDir, 'MEMORY.md')
  const { call } = await harness({ recent: { cwd }, catalog: true })
  const read = async () => JSON.parse((await call('/workbuddy-memory/content?target=project-memory')).body)

  const small = '# T\n\n- 顶部\n\n## 小节\n- 中文😀\n'
  writeFileSync(memory, small, 'utf8')
  const whole = await read()
  assert.equal(whole.chars, small.length, 'UTF-16 units: the emoji counts as two')
  assert.equal(whole.truncated, false)
  assert.equal(whole.entries, 2, 'the bullet above the first heading is an entry')

  // Display-truncated: the whole file was read, so its length is known, but
  // only the first slice is sent.
  writeFileSync(memory, `# T\n\n${'- 条目\n'.repeat(70000)}`, 'utf8')
  const cut = await read()
  assert.equal(cut.truncated, true, 'what is shown is part of the file')
  assert.equal(cut.text.length, 262144)
  assert.equal(cut.chars, '# T\n\n'.length + 5 * 70000, 'the whole file length is still known')
  assert.equal(cut.revision, null)

  // Prefix only: the file is past the read cap, so no length is known at all.
  writeFileSync(memory, 'x'.repeat(2 * 1024 * 1024 + 10), 'utf8')
  const prefix = await read()
  assert.equal(prefix.truncated, true)
  assert.equal(prefix.chars, null, 'not the prefix length')
  assert.equal(prefix.bytes, 2 * 1024 * 1024 + 10, 'the size on disk is still reported')
  assert.equal(prefix.revision, null)

  const state = JSON.parse((await call('/workbuddy-memory/state')).body)
  assert.equal(state.projects[0].chars, null, 'the row does not invent a length either')
  assert.equal(state.projects[0].injection.status, 'unmeasurable')
  assert.equal(state.stores.project.chars, null)
})
