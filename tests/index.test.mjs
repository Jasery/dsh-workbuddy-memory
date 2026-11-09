/** Wiring: what `apply` mounts, and what it survives. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../src/index.js'

/** Context that records every registration instead of mounting a real host. */
function fakeCtx({ withWebServer = true, withGuard = true, withSlots = false } = {}) {
  const record = { sections: [], tools: [], routes: [], injected: [], guards: 0 }

  const ctx = {
    logger: { warn() {} },
    effect(fn) {
      return fn()
    },
    systemPrompt: {
      section(definition) {
        record.sections.push(definition.name)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        record.tools.push(tool.name)
        return () => {}
      },
      ...(withGuard
        ? {
            guard() {
              record.guards += 1
              return () => {}
            },
          }
        : {}),
    },
    inject(services, callback) {
      record.injected.push(services.join(','))
      if (services.includes('webServer') && !withWebServer) return
      if (services.includes('configForms') && !withSlots) return
      callback({
        ...ctx,
        webServer: withWebServer
          ? {
              register(route) {
                record.routes.push(route.path)
                return () => {}
              },
            }
          : undefined,
        slots: withSlots
          ? {
              register() {
                return () => {}
              },
              inject(_slot, fn) {
                return fn()
              },
            }
          : undefined,
      })
    },
  }

  return { ctx, record }
}

function workspace(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wbm-index-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  mkdirSync(join(home, 'memory'), { recursive: true })
  mkdirSync(join(cwd, '.workbuddy', 'memory'), { recursive: true })
  writeFileSync(join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), '## 偏好\n- a\n', 'utf8')
  writeFileSync(join(home, 'MEMORY.md'), '- 全局\n', 'utf8')
  return { root, home, cwd, config: { workbuddyHome: home, stateDir: join(root, 'state'), ...config } }
}

test('the plugin declares only the two services it cannot live without', () => {
  assert.deepEqual(inject, ['systemPrompt', 'tools'])
  assert.equal(name, 'dsh-workbuddy-memory')
})

test('apply mounts four sections, five tools, one guard and the panel routes', () => {
  const { home, root, config } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, config)

  assert.deepEqual(record.sections, [
    'workbuddy-memory:project',
    'workbuddy-memory:rules',
    'workbuddy-memory:user',
    'workbuddy-memory:profile',
  ])
  assert.deepEqual(record.tools, ['memory_status', 'memory_read', 'memory_search', 'memory_append', 'memory_edit'])
  assert.equal(record.guards, 1)
  assert.deepEqual(record.routes, ['/workbuddy-memory'])
  assert.deepEqual(record.injected, ['webServer'])
  void home
  void root
})

test('an invalid config degrades to defaults instead of throwing', () => {
  const { ctx, record } = fakeCtx()
  assert.doesNotThrow(() => apply(ctx, 'not-an-object'))
  assert.equal(record.tools.length, 5)
  assert.equal(record.sections.length, 4)
})

test('a headless host still gets tools, it just has no panel', () => {
  const { config } = workspace()
  const { ctx, record } = fakeCtx({ withWebServer: false })
  apply(ctx, config)

  assert.equal(record.tools.length, 5)
  assert.deepEqual(record.routes, [])
})

test('a host without tools.guard does not lose the rest', () => {
  const { config } = workspace()
  const { ctx, record } = fakeCtx({ withGuard: false })
  apply(ctx, config)

  assert.equal(record.guards, 0)
  assert.equal(record.tools.length, 5)
})

test('ui.enabled: false leaves the routes unregistered', () => {
  const { config, root } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, { ...config, ui: { enabled: false } })

  assert.deepEqual(record.routes, [])
  assert.deepEqual(record.injected, [])
  void root
})

test('read-only mode still mounts the tools that can explain it', () => {
  const { config } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, { ...config, readOnly: true })

  assert.equal(record.tools.includes('memory_append'), true)
  assert.equal(record.tools.includes('memory_status'), true)
})
