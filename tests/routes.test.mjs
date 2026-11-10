/** Panel routes: shape of the JSON and the guards in front of it. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { registerRoutes } from '../src/host/routes.js'
import { createStore } from '../src/write/store.js'

/** Capture the registered route and answer one request against it. */
async function harness({ readOnly = false, allowWriteActions = false } = {}) {
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

  const registered = registerRoutes(ctx, { cfg, recent: { cwd: null }, stateDir, version: 'test', store })
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
