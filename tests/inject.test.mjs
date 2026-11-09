/** Section registration, the refresh modes, and the caches behind them. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { createAssemblyCache, createFileCache, createFrozenStore } from '../src/cache.js'
import { registerSections, resolveCwd } from '../src/inject.js'
import { createTranslator } from '../src/locale.js'

const t = createTranslator('zh')

/** Context that records section registrations instead of mounting the service. */
function fakeCtx() {
  const sections = new Map()
  return {
    sections,
    ctx: {
      systemPrompt: {
        section(definition) {
          sections.set(definition.name, definition)
          return () => sections.delete(definition.name)
        },
      },
      effect(fn) {
        return fn()
      },
      logger: { warn() {} },
    },
  }
}

function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wbm-inject-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  const dir = join(cwd, '.workbuddy', 'memory')
  mkdirSync(join(home, 'memory'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '## 偏好\n- 第一版\n', 'utf8')
  writeFileSync(join(home, 'MEMORY.md'), '- 全局\n', 'utf8')

  const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(root, 'state'), ...config })
  return { root, home, cwd, dir, cfg }
}

const contextFor = (cwd) => ({ agent: { session: { header: { cwd } } }, scope: {} })
const textOf = (definition, context) => definition.text(context)

test('four sections are registered once with stable names and orders', () => {
  const { cfg, cwd } = fixture()
  const { ctx, sections } = fakeCtx()
  registerSections(ctx, { cfg, t })

  assert.deepEqual([...sections.keys()], [
    'workbuddy-memory:project',
    'workbuddy-memory:rules',
    'workbuddy-memory:user',
    'workbuddy-memory:profile',
  ])
  assert.deepEqual(
    [...sections.values()].map((definition) => definition.order),
    [200, 210, 220, 230],
  )
  assert.equal([...sections.values()].every((definition) => definition.interpolate === false), true)
  assert.equal(typeof textOf(sections.get('workbuddy-memory:project'), contextFor(cwd)), 'string')
})

test('each provider returns its own block', () => {
  const { cfg, cwd } = fixture()
  const { ctx, sections } = fakeCtx()
  registerSections(ctx, { cfg, t })
  const context = contextFor(cwd)

  assert.match(textOf(sections.get('workbuddy-memory:project'), context), /第一版/)
  assert.match(textOf(sections.get('workbuddy-memory:rules'), context), /memory_append/)
  assert.match(textOf(sections.get('workbuddy-memory:user'), context), /全局/)
  assert.equal(textOf(sections.get('workbuddy-memory:profile'), context), '')
})

test('no working directory means no project block', () => {
  const { cfg } = fixture()
  const { ctx, sections } = fakeCtx()
  registerSections(ctx, { cfg, t })

  const context = { agent: {}, scope: {} }
  assert.equal(resolveCwd(context), null)
  assert.equal(textOf(sections.get('workbuddy-memory:project'), context), '')
  assert.match(textOf(sections.get('workbuddy-memory:user'), context), /全局/)
})

test('resolveCwd only accepts a non-empty string', () => {
  assert.equal(resolveCwd({ agent: { session: { header: { cwd: '/repo' } } } }), '/repo')
  assert.equal(resolveCwd({ agent: { session: { header: { cwd: '' } } } }), null)
  assert.equal(resolveCwd({ agent: { session: { header: {} } } }), null)
  assert.equal(resolveCwd({}), null)
  assert.equal(resolveCwd(null), null)
})

test('one assembly reads the disk once, the next one sees the change', () => {
  const { cfg, cwd, dir } = fixture()
  const { ctx, sections } = fakeCtx()
  registerSections(ctx, { cfg, t })
  const project = sections.get('workbuddy-memory:project')

  const first = contextFor(cwd)
  assert.match(textOf(project, first), /第一版/)

  // Same assembly object: the cached render is reused even though the file moved.
  writeFileSync(join(dir, 'MEMORY.md'), '## 偏好\n- 第二版\n', 'utf8')
  assert.match(textOf(project, first), /第一版/)

  // A new assembly re-probes, which is what `on-change` promises.
  assert.match(textOf(project, contextFor(cwd)), /第二版/)
})

test('first-turn freezes the text for the same workspace', () => {
  const { cfg, cwd, dir } = fixture({ inject: { refresh: 'first-turn' } })
  const { ctx, sections } = fakeCtx()
  const injected = registerSections(ctx, { cfg, t })
  const project = sections.get('workbuddy-memory:project')

  assert.match(textOf(project, contextFor(cwd)), /第一版/)
  writeFileSync(join(dir, 'MEMORY.md'), '## 偏好\n- 第二版\n', 'utf8')
  assert.match(textOf(project, contextFor(cwd)), /第一版/, 'a frozen block must not change mid-session')

  injected.invalidate()
  assert.match(textOf(project, contextFor(cwd)), /第二版/, 'invalidate() is the escape hatch')
})

test('turning injection off yields empty blocks without unregistering', () => {
  const { cfg, cwd } = fixture({ inject: { enabled: false } })
  const { ctx, sections } = fakeCtx()
  registerSections(ctx, { cfg, t })
  const context = contextFor(cwd)

  for (const name of sections.keys()) assert.equal(textOf(sections.get(name), context), '', `${name} should stay empty`)
})

test('a failing provider never breaks the turn', () => {
  const { cfg } = fixture()
  const { ctx, sections } = fakeCtx()
  registerSections(ctx, { cfg, t })

  // An agent whose header throws is the cheapest way to make the provider fail.
  const hostile = {
    get agent() {
      throw new Error('boom')
    },
  }
  assert.equal(textOf(sections.get('workbuddy-memory:project'), hostile), '')
})

test('onProbe reports the working directory it saw', () => {
  const { cfg, cwd } = fixture()
  const seen = []
  const { ctx, sections } = fakeCtx()
  registerSections(ctx, { cfg, t, onProbe: (probe, seenCwd) => seen.push([probe.hasAnyMemory, seenCwd]) })

  assert.equal(seen.length, 0, 'probing happens when a provider runs, not at registration')
  sections.get('workbuddy-memory:user').text(contextFor(cwd))
  assert.deepEqual(seen.at(-1), [true, cwd])
})

test('the file cache reuses text until the stat changes', () => {
  const { dir } = fixture()
  const path = join(dir, 'MEMORY.md')
  const cache = createFileCache()

  assert.match(cache.read(path), /第一版/)
  assert.equal(cache.size, 1)

  writeFileSync(path, '## 偏好\n- 第二版和第二版\n', 'utf8')
  // Same size is possible; a different size must invalidate.
  assert.match(cache.read(path), /第二版/)

  cache.invalidate(path)
  assert.equal(cache.size, 0)
  assert.equal(cache.read(join(dir, 'nope.md')), '')
  assert.equal(cache.read(''), '')
})

test('the assembly cache keys on the context object', () => {
  const cache = createAssemblyCache()
  let calls = 0
  const compute = () => {
    calls += 1
    return calls
  }

  const context = {}
  assert.equal(cache.get(context, compute), 1)
  assert.equal(cache.get(context, compute), 1)
  assert.equal(cache.get({}, compute), 2)
  assert.equal(cache.get(null, compute), 3)
  assert.equal(cache.get(undefined, compute), 4)
})

test('the frozen store keeps one value per key and clears on demand', () => {
  const frozen = createFrozenStore()
  let calls = 0
  const compute = () => {
    calls += 1
    return calls
  }

  assert.equal(frozen.get('a', compute), 1)
  assert.equal(frozen.get('a', compute), 1)
  assert.equal(frozen.get('b', compute), 2)

  frozen.invalidate('a')
  assert.equal(frozen.get('a', compute), 3)

  frozen.clear()
  assert.equal(frozen.get('b', compute), 4)
})
