/** Panel routes: shape of the JSON and the guards in front of it. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { registerRoutes } from '../src/host/routes.js'
import { createStore } from '../src/write/store.js'

/** Capture the registered route and answer one request against it. */
async function harness({ readOnly = false, allowWriteActions = false, recent = { cwd: null } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wbm-routes-'))
  const home = join(root, 'home')
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'MEMORY.md'), '## 偏好\n- 用简体中文\n', 'utf8')

  const stateDir = join(root, 'state')
  const cfg = normalizeConfig({ workbuddyHome: home, stateDir, readOnly, ui: { allowWriteActions } })
  const store = createStore({ cfg, stateDir })
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
  }

  const registered = registerRoutes(ctx, { cfg, recent, stateDir, version: 'test', store })
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
