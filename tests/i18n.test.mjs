/**
 * The panel against a real locale service.
 *
 * The host's `LocaleRuntime` is reimplemented here in miniature — register,
 * bind, subscribe, setLocale — because the defect being guarded against was not
 * "the wrong string" but "the panel never asked the host at all". A test that
 * stubs `ctx.locale` away cannot catch that.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntime, text } from './helpers/react.mjs'

const runtime = createRuntime()

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
const { MemoryWorkspace, bindCopy, ZH, EN } = client.__internals

/**
 * A miniature LocaleRuntime with the host's documented semantics: dictionaries
 * per namespace, a fallback chain ending at English, and a subscribable
 * snapshot whose revision bumps on both switches and registrations.
 */
function createLocaleService(initial = 'en') {
  const dicts = new Map()
  const bound = new Map()
  const listeners = new Set()
  let active = initial
  let revision = 0

  const lookup = (ns, key) => {
    const table = dicts.get(ns)
    if (!table) return undefined
    // Fallback chain: active language, then English.
    for (const locale of [active, 'en']) {
      const value = table[locale]?.[key]
      if (typeof value === 'string') return value
    }
    return undefined
  }

  return {
    get active() {
      return active
    },
    get revision() {
      return revision
    },
    registered: () => [...dicts.keys()],
    register(ns, dictionaries) {
      const table = dicts.get(ns) ?? {}
      for (const [locale, dict] of Object.entries(dictionaries)) table[locale] = dict
      dicts.set(ns, table)
      revision += 1
      for (const fn of listeners) fn()
      return () => {
        const current = dicts.get(ns)
        if (!current) return
        for (const locale of Object.keys(dictionaries)) delete current[locale]
        revision += 1
        for (const fn of listeners) fn()
      }
    },
    bind(ns) {
      let fn = bound.get(ns)
      if (fn) return fn
      fn = (key, params) => {
        const template = lookup(ns, key) ?? key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
      bound.set(ns, fn)
      return fn
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setLocale(id) {
      active = id
      revision += 1
      for (const fn of listeners) fn()
    },
  }
}

/** A context whose `locale` service is present, like a real host. */
function contextWith(locale) {
  const ctx = {
    locale,
    effect: (fn) => fn(),
    // `apply` mounts the surfaces through child scopes; a no-op scope is enough
    // for the copy assertions here, which read the panel directly.
    inject: (_services, callback) => callback(ctx),
    slots: { register: () => () => {}, inject: (_slot, fn) => fn() },
  }
  return ctx
}

const state = {
  ok: true,
  version: '0.1.3',
  cwd: 'C:\\repo',
  readOnly: false,
  writeEnabled: true,
  allowWriteActions: true,
  allowFullTextEdit: true,
  limits: { project: 10000, user: 8000, profile: 2000, rules: 2000 },
  dataFolderName: '.workbuddy',
  home: { path: 'C:\\Users\\me\\.workbuddy', source: 'env', detail: 'WORKBUDDY_CONFIG_DIR' },
  projects: [
    {
      key: 'p1',
      path: 'C:\\repo',
      name: 'repo',
      title: 'repo',
      source: 'workspace',
      current: true,
      hasMemory: true,
      daily: 2,
      entries: 5,
      bytes: 900,
      chars: 800,
      revision: 'rev-1',
      mtime: 1,
      latestDaily: '2026-11-12',
      oldestDailyAgeDays: 2,
      overLimit: false,
      stale: false,
      status: 'ok',
    },
  ],
  totals: { projects: 1, withMemory: 1, entries: 5, dailyFiles: 2, overLimit: 0, stale: 0 },
  stores: {
    project: {
      target: 'project-memory',
      dir: 'C:\\repo\\.workbuddy\\memory',
      memory: 'C:\\repo\\.workbuddy\\memory\\MEMORY.md',
      exists: true,
      memoryExists: true,
      bytes: 900,
      chars: 800,
      writable: true,
      entries: 5,
      revision: 'rev-1',
      daily: [],
    },
    user: {
      target: 'user-memory',
      memory: 'C:\\Users\\me\\.workbuddy\\MEMORY.md',
      exists: true,
      memoryExists: true,
      bytes: 500,
      chars: 450,
      writable: true,
      entries: 3,
      revision: 'rev-u',
    },
    profile: { target: 'profile', path: null, exists: false, bytes: 0, ambiguous: false, readOnly: true, entries: 0 },
  },
  backups: { count: 0, latest: null },
  operations: { total: 0, conflicts: 0, lastConflictAt: null, lastCommitAt: null },
}

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    const body = String(url).includes('/content') ? { ok: false, code: 'not_found' } : state
    return { ok: true, status: 200, json: async () => body }
  }
}

function installTimers() {
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  // `apply` injects a stylesheet, so the stub needs the two document calls it
  // makes — nothing else is touched by the code under test.
  globalThis.document = {
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {} }),
    head: { appendChild() {} },
  }
  return () => {
    globalThis.setInterval = realSetInterval
    delete globalThis.document
  }
}

const CJK = /[\u4e00-\u9fff]/

test('the module declares the locale service it needs', () => {
  // A missing name here is the whole defect: `ctx.locale` is then undefined and
  // every string silently comes from the panel's own dictionary.
  assert.ok(client.inject.includes('locale'), `inject must name the locale service, got ${JSON.stringify(client.inject)}`)
  assert.ok(client.inject.includes('slots'))
})

test('registering with the host makes the panel follow its language', () => {
  const locale = createLocaleService('zh')
  const ctx = contextWith(locale)
  const t = bindCopy(ctx)

  // Before registration the panel has its own copy; after it, the host answers.
  locale.register('dsh-workbuddy-memory', { zh: { 'panel.memory': '记忆' }, en: { 'panel.memory': 'Memory' } })
  assert.equal(t('panel.memory'), '记忆')

  locale.setLocale('en')
  assert.equal(t('panel.memory'), 'Memory', 'a host switch is reflected on the next call')

  locale.setLocale('zh')
  assert.equal(t('panel.memory'), '记忆')
})

test('a locale service that arrives late is still picked up', () => {
  // The service can activate after `apply` runs; a binding captured once would
  // stay null for the rest of the session.
  const holder = { locale: undefined }
  const t = bindCopy(holder)
  assert.ok(typeof t('panel.memory') === 'string')

  const locale = createLocaleService('en')
  locale.register('dsh-workbuddy-memory', { zh: { 'panel.memory': '记忆' }, en: { 'panel.memory': 'Memory' } })
  holder.locale = locale
  assert.equal(t('panel.memory'), 'Memory')
})

test('a mounted panel re-renders in the new language', async () => {
  const locale = createLocaleService('en')
  // Register the module's real dictionaries, exactly as `apply` does. A partial
  // dictionary would leave the missing keys on the local fallback, which is a
  // different path than the one this test is about.
  locale.register('dsh-workbuddy-memory', { zh: ZH, en: EN })

  // Point the module's runtime at this service the way `apply` does, without
  // mounting the host surfaces (those need a whole client composition).
  const restore = installTimers()
  const { runtime: moduleRuntime } = client.__internals
  moduleRuntime.ctx = contextWith(locale)
  moduleRuntime.t = bindCopy(moduleRuntime.ctx)
  installFetch()
  try {
    runtime.reset()
    const english = text(await runtime.settle(MemoryWorkspace, { mode: 'overview', layout: 'wide' }))
    assert.doesNotMatch(english, CJK, 'English first')

    // The host switches language while the panel is mounted. The bound `t`
    // reads the host on every call, so the next render is already Chinese.
    locale.setLocale('zh')
    const chinese = text(await runtime.settle(MemoryWorkspace, { mode: 'overview', layout: 'wide' }))
    assert.match(chinese, CJK, 'the mounted panel picked up the switch')
  } finally {
    restore()
    moduleRuntime.ctx = null
  }
})

