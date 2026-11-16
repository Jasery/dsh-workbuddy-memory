/** Receipt store limits: bounded, non-overwriting, and unmistakable. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RECEIPT_LIMITS, createReceiptStore } from '../src/write/receipts.js'

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'wbm-receipts-'))
  return { root, stateDir: join(root, 'state') }
}

function record(id, patch = {}) {
  return {
    version: 1,
    id,
    fingerprint: 'fingerprint',
    action: 'append',
    target: 'project-memory',
    path: '/tmp/MEMORY.md',
    before: 'before-revision',
    after: 'after-revision',
    status: 'applying',
    result: { ok: true, revision: 'after-revision', path: '/tmp/MEMORY.md' },
    createdAt: Date.now(),
    ...patch,
  }
}

/** Age one receipt past the retention window without waiting 24 hours. */
function age(file, ms = RECEIPT_LIMITS.terminalMs + 60_000) {
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  stored.updatedAt = Date.now() - ms
  writeFileSync(file, JSON.stringify(stored), 'utf8')
}

test('a receipt larger than the cap is refused before it is written', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  const huge = record('op-too-large', { blob: 'x'.repeat(RECEIPT_LIMITS.maxBytes) })
  const result = await store.begin(huge)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'receipt_capacity')
  assert.equal(result.reason, 'record_too_large')
  assert.equal(existsSync(store.fileFor('op-too-large')), false)
})

test('more than the pending cap refuses a new receipt without touching an old one', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  for (let index = 0; index < RECEIPT_LIMITS.maxPending; index += 1) {
    const begun = await store.begin(record(`op-pending-${index}`))
    assert.equal(begun.ok, true, `receipt ${index}: ${JSON.stringify(begun)}`)
  }
  const refused = await store.begin(record('op-pending-overflow'))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'receipt_capacity')
  assert.equal(refused.reason, 'pending')
  assert.equal(existsSync(store.fileFor('op-pending-overflow')), false)
  assert.equal((await store.read('op-pending-0')).ok, true, 'no pending record is evicted to make room')
})

test('a corrupt receipt is refused, not overwritten', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  const seeded = await store.begin(record('op-corrupt'))
  assert.equal(seeded.ok, true)
  writeFileSync(store.fileFor('op-corrupt'), '{not json', 'utf8')

  const read = await store.read('op-corrupt')
  assert.equal(read.ok, false)
  assert.equal(read.code, 'receipt_capacity')
  const begun = await store.begin(record('op-corrupt', { fingerprint: 'second' }))
  assert.equal(begun.ok, false)
  assert.equal(begun.reason, 'duplicate_id')
})

test('parseable receipts with invalid or incomplete schemas are retained and refused', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  mkdirSync(join(stateDir, 'receipts'), { recursive: true })
  const old = Date.now() - RECEIPT_LIMITS.terminalMs - 60_000
  const cases = [
    ['op-missing-fingerprint', { fingerprint: undefined }],
    ['op-illegal-status', { status: 'finished' }],
    ['op-missing-result', { status: 'committed', result: undefined, updatedAt: old }],
    ['op-missing-terminal-time', { status: 'committed', updatedAt: undefined }],
  ]

  for (const [id, patch] of cases) {
    const malformed = { ...record(id), updatedAt: old, ...patch }
    for (const [key, value] of Object.entries(malformed)) {
      if (value === undefined) delete malformed[key]
    }
    writeFileSync(store.fileFor(id), JSON.stringify(malformed), 'utf8')

    const read = await store.read(id)
    assert.equal(read.ok, false, `${id} must be treated as unknown evidence`)
    assert.equal(read.code, 'receipt_capacity')
    assert.equal(existsSync(store.fileFor(id)), true, `${id} must not be removed`)
    const replay = await store.begin(record(id, { fingerprint: 'replacement' }))
    assert.equal(replay.ok, false, `${id} cannot be reused`)
    assert.equal(existsSync(store.fileFor(id)), true)
  }
})

test('a parseable invalid terminal receipt is not expired during capacity maintenance', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  for (let index = 0; index < RECEIPT_LIMITS.maxPending - 1; index += 1) {
    assert.equal((await store.begin(record(`op-fill-invalid-${index}`))).ok, true)
  }
  const id = 'op-old-invalid-terminal'
  const old = Date.now() - RECEIPT_LIMITS.terminalMs - 60_000
  const malformed = { ...record(id, { status: 'committed' }), updatedAt: old }
  delete malformed.result
  writeFileSync(store.fileFor(id), JSON.stringify(malformed), 'utf8')

  const refused = await store.begin(record('op-invalid-capacity-overflow'))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'receipt_capacity')
  assert.equal(refused.reason, 'pending')
  assert.equal(existsSync(store.fileFor(id)), true, 'schema-invalid evidence must occupy a pending slot')
})

test('a terminal receipt older than the retention window is expired', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  const begun = await store.begin(record('op-old', { status: 'committed' }))
  assert.equal(begun.ok, true)
  age(store.fileFor('op-old'))

  const read = await store.read('op-old')
  assert.equal(read.ok, true)
  assert.equal(read.record, null, 'deduplication is not promised past the retention window')
  assert.equal(existsSync(store.fileFor('op-old')), false)

  const next = await store.begin(record('op-new'))
  assert.equal(next.ok, true)
})

test('an old unresolved receipt is retained and still counts against the pending cap', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  const unresolved = [
    ['op-old-applying', 'applying'],
    ['op-old-partial', 'partial'],
    ['op-old-unknown', 'outcome_unknown'],
  ]
  for (const [id, status] of unresolved) {
    const extra = status === 'partial' ? { manifest: [], result: { ok: false, code: 'partial' } } : {}
    assert.equal((await store.begin(record(id, { status, ...extra }))).ok, true)
    age(store.fileFor(id))
    const read = await store.read(id)
    assert.equal(read.ok, true)
    assert.equal(read.record?.status, status, `${status} is unresolved and must not expire`)
    assert.equal(existsSync(store.fileFor(id)), true)
  }

  for (let index = 0; index < RECEIPT_LIMITS.maxPending - unresolved.length; index += 1) {
    assert.equal((await store.begin(record(`op-fill-${index}`))).ok, true)
  }
  const refused = await store.begin(record('op-fill-overflow'))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'receipt_capacity')
  assert.equal(refused.reason, 'pending', 'all three stale records still hold their slots')
  assert.equal(existsSync(store.fileFor('op-fill-overflow')), false)
})

test('an unreadable receipt is kept and still holds a pending slot', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  assert.equal((await store.begin(record('op-broken'))).ok, true)
  writeFileSync(store.fileFor('op-broken'), '{not json', 'utf8')
  const old = new Date(Date.now() - RECEIPT_LIMITS.terminalMs - 60_000)
  utimesSync(store.fileFor('op-broken'), old, old)
  for (let index = 0; index < RECEIPT_LIMITS.maxPending - 1; index += 1) {
    assert.equal((await store.begin(record(`op-valid-${index}`))).ok, true)
  }

  const refused = await store.begin(record('op-broken-overflow'))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'receipt_capacity')
  assert.equal(refused.reason, 'pending')
  assert.equal(existsSync(store.fileFor('op-broken')), true, 'an unreadable record is evidence, not garbage')
})
