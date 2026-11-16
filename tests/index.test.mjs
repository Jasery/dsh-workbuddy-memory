/** Wiring: what `apply` mounts, and what it survives. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../src/index.js'
import { Config } from '../src/config.js'

/** Context that records every registration instead of mounting a real host. */
function fakeCtx({ withWebServer = true, withGuard = true, withSlots = false, withEvents = false } = {}) {
  const record = { sections: [], tools: [], routes: [], injected: [], guards: 0, toolDefs: [], sectionDefs: [], handlers: {} }

  /** Remove one value from a list the way the host disposes a registration. */
  const remove = (list, value) => {
    const at = list.indexOf(value)
    if (at >= 0) list.splice(at, 1)
  }

  const ctx = {
    logger: { warn() {} },
    effect(fn) {
      return fn()
    },
    ...(withEvents
      ? {
          on(event, handler) {
            record.handlers[event] = handler
            return () => {
              if (record.handlers[event] === handler) delete record.handlers[event]
            }
          },
        }
      : {}),
    systemPrompt: {
      section(definition) {
        record.sections.push(definition.name)
        record.sectionDefs.push(definition)
        return () => {
          remove(record.sections, definition.name)
          remove(record.sectionDefs, definition)
        }
      },
    },
    tools: {
      register(tool) {
        record.tools.push(tool.name)
        record.toolDefs.push(tool)
        return () => {
          remove(record.tools, tool.name)
          remove(record.toolDefs, tool)
        }
      },
      ...(withGuard
        ? {
            guard() {
              record.guards += 1
              return () => {
                record.guards -= 1
              }
            },
          }
        : {}),
    },
    inject(services, callback) {
      record.injected.push(services.join(','))
      if (services.includes('webServer') && !withWebServer) return
      if (services.includes('configForms') && !withSlots) return
      const before = record.routes.length
      callback({
        ...ctx,
        webServer: withWebServer
          ? {
              register(route) {
                record.routes.push(route.path)
                return () => remove(record.routes, route.path)
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
      // The fake's callback runs synchronously, so the routes it added can be
      // removed by the same kind of disposer a real fiber would provide.
      return () => {
        record.routes.splice(before)
      }
    },
  }

  return { ctx, record }
}

/** Raw config through the real schema, the way the loader delivers it. */
function fromSchema(raw) {
  const result = Config['~standard'].validate(raw)
  assert.equal(result.issues, undefined)
  return result.value
}

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

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

/** The five tools this build ships to the model, in registration order. */
const FIVE = ['memory_status', 'memory_read', 'memory_search', 'memory_append', 'memory_edit']

/** The management tools the panel took over; none of them may be registered. */
const RETIRED = ['memory_prune', 'memory_replace_section', 'memory_list_revisions', 'memory_restore']

test('apply mounts four sections, the five model tools, one guard and the panel routes', () => {
  const { home, root, config } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, config)

  assert.deepEqual(record.sections, [
    'workbuddy-memory:project',
    'workbuddy-memory:rules',
    'workbuddy-memory:user',
    'workbuddy-memory:profile',
  ])
  assert.deepEqual(record.tools, FIVE)
  assert.equal(record.guards, 1)
  assert.deepEqual(record.routes, ['/workbuddy-memory'])
  assert.deepEqual(record.injected, ['webServer'])
  void home
  void root
})

test('the retired management tools are not in the catalog under any name', () => {
  // Bulk tidy-up moved to the panel: a section rewrite, a backup restore and an
  // archive all need a person looking at a preview. Leaving the definitions
  // registered — even as stubs that only refuse — would advertise an ability the
  // model does not have.
  const { config } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, config)

  for (const name of RETIRED) {
    assert.equal(record.tools.includes(name), false, `${name} is still registered`)
    assert.equal(record.toolDefs.some((tool) => tool.name === name), false, `${name} is still in the schema`)
  }
  assert.equal(record.tools.length, 5)
})

test('search.enabled: false leaves memory_search out of the catalog', () => {
  const { config } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, { ...config, search: { enabled: false } })

  // A definition that only ever returns a refusal is worse than an absent one:
  // the model should not see a tool it cannot use.
  assert.equal(record.tools.includes('memory_search'), false)
  assert.equal(record.tools.includes('memory_append'), true)
  assert.equal(record.tools.length, 4)
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

  // No UI does not bring the management tools back: the answer to "this host has
  // no panel" is to say so, not to hand the model a write path nobody previewed.
  assert.equal(record.tools.length, 5)
  assert.deepEqual(record.tools, FIVE)
  assert.deepEqual(record.routes, [])
})

test('ui.enabled: false keeps exactly the five model tools', () => {
  const { config } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, { ...config, ui: { enabled: false } })

  assert.deepEqual(record.routes, [])
  assert.deepEqual(record.tools, FIVE)
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

test('a tool write reaches the prompt even with a frozen snapshot', async () => {
  // `refresh: first-turn` freezes the injected text. The model must still see
  // what it just wrote, so a committed write has to invalidate that snapshot.
  const { home, root, cwd, config } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, { ...config, inject: { refresh: 'first-turn' } })

  const projectSection = record.sectionDefs.find((definition) => definition.name === 'workbuddy-memory:project')
  const session = { header: { cwd } }
  const context = { agent: { session } }
  const before = projectSection.text(context)
  assert.match(before, /- a/)

  const append = record.toolDefs.find((tool) => tool.name === 'memory_append')
  const result = await append.execute({ target: 'project-memory', section: '偏好', text: 'b' }, { agent: { session } })
  assert.equal(result.ok, true)

  const after = projectSection.text(context)
  assert.match(after, /- b/)
  const status = record.toolDefs.find((tool) => tool.name === 'memory_status')
  const report = await status.execute({}, { agent: { session } })
  assert.equal(report.lastAssembly.measuredAs, 'plugin-contribution')
  assert.equal(report.lastAssembly.totalChars, report.lastAssembly.blocks.reduce((sum, block) => sum + block.chars, 0))
  void home
  void root
})

test('a read does not invalidate the frozen snapshot', async () => {
  const { cwd, config } = workspace()
  const { ctx, record } = fakeCtx()
  apply(ctx, { ...config, inject: { refresh: 'first-turn' } })

  const projectSection = record.sectionDefs.find((definition) => definition.name === 'workbuddy-memory:project')
  const session = { header: { cwd } }
  const context = { agent: { session } }
  const before = projectSection.text(context)

  const read = record.toolDefs.find((tool) => tool.name === 'memory_read')
  await read.execute({ target: 'project-memory' }, { agent: { session } })

  // Reading changes nothing on disk, so the frozen text is still the same object.
  assert.equal(projectSection.text(context), before)
})

test('values validated by the real schema reach the tools and the probe', async () => {
  const { home, cwd, config, root } = workspace()
  const raw = fromSchema({
    readOnly: true,
    workbuddyHome: home,
    stateDir: config.stateDir,
    search: { enabled: false },
  })
  const { ctx, record } = fakeCtx()
  apply(ctx, raw)

  const exec = { agent: { session: { header: { cwd } } } }
  assert.equal(record.tools.includes('memory_search'), false)

  const status = record.toolDefs.find((tool) => tool.name === 'memory_status')
  const state = await status.execute({}, exec)
  assert.equal(state.writable, false)
  assert.equal(state.paths.source, 'config')
  assert.equal(state.paths.user.includes(home), true, 'workbuddyHome was ignored, so the probe fell back')
  assert.equal('config' in state, false)

  const append = record.toolDefs.find((tool) => tool.name === 'memory_append')
  const refused = await append.execute({ target: 'user-memory', text: 'no' }, exec)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'read_only')
  void root
})

test('a volatile update deep-updates the same config and remounts changed tools', async () => {
  const { home, cwd, config } = workspace()
  const raw = fromSchema({ workbuddyHome: home, stateDir: config.stateDir, search: { enabled: false } })
  const { ctx, record } = fakeCtx({ withEvents: true })
  apply(ctx, raw)

  assert.equal(record.tools.includes('memory_search'), false)
  assert.equal(typeof record.handlers['loader/volatile-update'], 'function')

  // The host commits the reference values first, then emits the paths it changed.
  raw.readOnly[VOLATILE_WRITE](true)
  raw.search.enabled[VOLATILE_WRITE](true)
  record.handlers['loader/volatile-update']([['readOnly'], ['search', 'enabled']])

  assert.equal(record.tools.includes('memory_search'), true)
  assert.equal(record.tools.length, 5)
  assert.equal(new Set(record.tools).size, record.tools.length, 'a remount accumulated registrations')

  const exec = { agent: { session: { header: { cwd } } } }
  const append = record.toolDefs.find((tool) => tool.name === 'memory_append')
  const refused = await append.execute({ target: 'user-memory', text: 'no' }, exec)
  assert.equal(refused.code, 'read_only', 'the existing tool closure did not see the new flag')
})

test('guard and panel registrations follow their switches without piling up', async () => {
  const { home, config } = workspace()
  const raw = fromSchema({ workbuddyHome: home, stateDir: config.stateDir })
  const { ctx, record } = fakeCtx({ withEvents: true })
  apply(ctx, raw)

  assert.equal(record.guards, 1)
  assert.deepEqual(record.routes, ['/workbuddy-memory'])

  raw.guard.enabled[VOLATILE_WRITE](false)
  raw.ui.enabled[VOLATILE_WRITE](false)
  record.handlers['loader/volatile-update']([['guard', 'enabled'], ['ui', 'enabled']])
  assert.equal(record.guards, 0)
  assert.deepEqual(record.routes, [])

  raw.guard.enabled[VOLATILE_WRITE](true)
  raw.ui.enabled[VOLATILE_WRITE](true)
  record.handlers['loader/volatile-update']([['guard', 'enabled'], ['ui', 'enabled']])
  assert.equal(record.guards, 1)
  assert.deepEqual(record.routes, ['/workbuddy-memory'])
})

test('an inject change remounts the sections with exactly four registrations', () => {
  const { home, config } = workspace()
  const raw = fromSchema({ workbuddyHome: home, stateDir: config.stateDir })
  const { ctx, record } = fakeCtx({ withEvents: true })
  apply(ctx, raw)

  raw.inject.limits[VOLATILE_WRITE]({ project: 1234, rules: 0, user: 4321, profile: 0 })
  record.handlers['loader/volatile-update']([['inject', 'limits']])

  assert.equal(record.sections.length, 4)
  assert.deepEqual(record.sections, [
    'workbuddy-memory:project',
    'workbuddy-memory:rules',
    'workbuddy-memory:user',
    'workbuddy-memory:profile',
  ])
})

test('a host without the volatile event still starts instead of faking a reload', () => {
  const { home, config } = workspace()
  const { ctx, record } = fakeCtx()
  assert.doesNotThrow(() => apply(ctx, fromSchema({ workbuddyHome: home, stateDir: config.stateDir })))
  assert.equal(record.tools.length, 5)
  assert.equal(record.sections.length, 4)
})

test('a purely read-only session creates no state directory', async () => {
  const { home, cwd, config, root } = workspace()
  const stateDir = join(root, 'never-created')
  const { ctx, record } = fakeCtx()
  apply(ctx, fromSchema({ readOnly: true, workbuddyHome: home, stateDir }))

  const exec = { agent: { session: { header: { cwd } } } }
  await record.toolDefs.find((tool) => tool.name === 'memory_status').execute({}, exec)
  await record.toolDefs.find((tool) => tool.name === 'memory_read').execute({ target: 'project-memory' }, exec)

  assert.equal(existsSync(stateDir), false)
})
