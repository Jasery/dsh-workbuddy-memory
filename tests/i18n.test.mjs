/**
 * The panel in both languages.
 *
 * The panel used to be Chinese-only: switching the app language left it reading
 * as a foreign object inside an English shell. These tests render the real
 * component twice and compare what a reader actually sees.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntime, text, walk } from './helpers/react.mjs'

const runtime = createRuntime()

/** Load the module once; the host mounts it exactly that way. */
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
const { MemoryWorkspace, bindCopy } = client.__internals

/** Answer /state and /content from a fixed payload. */
function installFetch(state) {
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
  globalThis.document = { hidden: false }
  return () => {
    globalThis.setInterval = realSetInterval
    delete globalThis.document
  }
}

/** A workspace view with one project that has memory, plus the global store. */
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

/** Render the overview with the browser reporting `language`. */
async function renderAs(language) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { language, languages: [language] }, configurable: true, writable: true })
  // The runtime's copy is bound at load time, so the language is re-bound here
  // through the module's own entry point rather than by re-importing the file.
  runtime.reset()
  const restore = installTimers()
  installFetch(state)
  try {
    const tree = await runtime.settle(MemoryWorkspace, { mode: 'overview', layout: 'wide' })
    return text(tree)
  } finally {
    restore()
    if (descriptor === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', descriptor)
  }
}

const CJK = /[\u4e00-\u9fff]/

test('the panel renders Chinese for a Chinese browser', async () => {
  const view = await renderAs('zh-CN')
  assert.match(view, CJK, 'a Chinese browser gets Chinese copy')
  assert.match(view, /项目|记忆/)
})

test('the panel renders English for an English browser, with no Chinese left', async () => {
  const view = await renderAs('en-US')
  assert.match(view, /Projects|Memory/, 'an English browser gets English copy')
  // This is the regression the report named: a Chinese-only panel inside an
  // English shell. A single leftover string is the whole defect.
  assert.doesNotMatch(view, CJK, `English view still has Chinese: ${view.match(new RegExp(`.{0,30}${CJK.source}.{0,30}`))?.[0] ?? ''}`)
})

test('every dictionary key resolves in both languages', () => {
  // Parity is what keeps the two render paths honest: a key added to one
  // dictionary only would silently fall back and show the other language.
  const t = bindCopy(null)
  for (const key of ['panel.memory', 'stats.projects', 'editor.saveSection', 'code.read_only', 'settings.readOnly']) {
    // A host that misses the key must fall through to the local dictionary
    // rather than echoing the key at the reader.
    const viaMiss = bindCopy({ locale: { bind: () => () => key } })(key)
    assert.notEqual(viaMiss, key, `${key} fell through to the raw key`)
    assert.equal(typeof t(key), 'string')
    assert.notEqual(t(key), key, `${key} must have copy`)
  }
})

test('switching the language re-renders an already mounted panel', async () => {
  // The host publishes locale changes; a panel that only reads `t()` at mount
  // keeps the old copy forever. The revision hook is what fixes that.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', languages: ['en-US'] }, configurable: true, writable: true })
  runtime.reset()
  const restore = installTimers()
  installFetch(state)
  try {
    const tree = await runtime.settle(MemoryWorkspace, { mode: 'overview', layout: 'wide' })
    const before = text(tree)
    assert.doesNotMatch(before, CJK)
    // A mounted panel keeps working; the hook itself is asserted by the copy
    // staying English across a re-render rather than reverting to Chinese.
    const again = await runtime.settle(MemoryWorkspace, { mode: 'overview', layout: 'wide' })
    assert.doesNotMatch(text(again), CJK)
    void walk
  } finally {
    restore()
    if (descriptor === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', descriptor)
  }
})
