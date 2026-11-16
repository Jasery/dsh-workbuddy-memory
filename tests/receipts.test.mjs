/** Receipt store limits: bounded, non-overwriting, and unmistakable. */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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
    status: 'applying',
    createdAt: Date.now(),
    ...patch,
  }
}

test('a receipt larger than the cap is refused before it is written', () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  const huge = record('op-too-large', { blob: 'x'.repeat(RECEIPT_LIMITS.maxBytes) })
  const result = store.begin(huge)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'receipt_capacity')
  assert.equal(result.reason, 'record_too_large')
  assert.equal(existsSync(store.fileFor('op-too-large')), false)
})

test('more than the pending cap refuses a new receipt without touching an old one', () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  for (let index = 0; index < RECEIPT_LIMITS.maxPending; index += 1) {
    const begun = store.begin(record(`op-pending-${index}`))
    assert.equal(begun.ok, true, `receipt ${index}: ${JSON.stringify(begun)}`)
  }
  const refused = store.begin(record('op-pending-overflow'))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'receipt_capacity')
  assert.equal(refused.reason, 'pending')
  assert.equal(existsSync(store.fileFor('op-pending-overflow')), false)
  assert.equal(store.read('op-pending-0').ok, true, 'no pending record is evicted to make room')
})

test('a corrupt receipt is refused, not overwritten', async () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  const seeded = store.begin(record('op-corrupt'))
  assert.equal(seeded.ok, true)
  writeFileSync(store.fileFor('op-corrupt'), '{not json', 'utf8')

  const read = store.read('op-corrupt')
  assert.equal(read.ok, false)
  assert.equal(read.code, 'receipt_capacity')
  const begun = store.begin(record('op-corrupt', { fingerprint: 'second' }))
  assert.equal(begun.ok, false)
  assert.equal(begun.reason, 'duplicate_id')
})

test('a terminal receipt older than the retention window is expired', () => {
  const { stateDir } = fresh()
  const store = createReceiptStore({ stateDir })
  const begun = store.begin(record('op-old', { status: 'committed' }))
  assert.equal(begun.ok, true)
  const old = {
    ...record('op-old', { status: 'committed' }),
    updatedAt: Date.now() - RECEIPT_LIMITS.terminalMs - 1000,
  }
  writeFileSync(store.fileFor('op-old'), JSON.stringify(old), 'utf8')

  const read = store.read('op-old')
  assert.equal(read.ok, true)
  assert.equal(read.record, null, 'deduplication is not promised past the retention window')
  assert.equal(existsSync(store.fileFor('op-old')), false)

  const next = store.begin(record('op-new'))
  assert.equal(next.ok, true)
})
