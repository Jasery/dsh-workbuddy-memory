/**
 * Configuration as the host actually hands it over.
 *
 * A schema field declared `.volatile()` reaches `apply` as a reference whose
 * value lives behind `.get()`; testing with a plain object hides that entirely,
 * because a plain object never looks like a reference and every key silently
 * falls back to its default. These tests go through the real schema so a
 * regression cannot hide behind the same shortcut again.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, normalizeConfig } from '../src/config.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Validate a raw config the way the loader does before `apply`. */
function validated(raw) {
  const result = Config['~standard'].validate(raw)
  assert.equal(result.issues, undefined)
  return result.value
}

test('a real schema validation keeps the values a person set', () => {
  const raw = validated({
    readOnly: true,
    workbuddyHome: 'C:\\fixture\\home',
    search: { enabled: false },
    inject: { limits: { user: 3000 } },
  })

  const cfg = normalizeConfig(raw)

  assert.equal(cfg.readOnly, true)
  assert.equal(cfg.workbuddyHome, 'C:\\fixture\\home')
  assert.equal(cfg.search.enabled, false)
  assert.equal(cfg.inject.limits.user, 3000)
  // The unsupplied keys in the same object schema still get their defaults.
  assert.equal(cfg.inject.limits.project, 10000)
  assert.equal(cfg.inject.limits.rules, 2000)
  assert.equal(cfg.inject.limits.profile, 2000)
  assert.equal(cfg.inject.refresh, 'on-change')
  assert.equal(cfg.inject.mode, 'layered')
  assert.equal(cfg.inject.coreBudget, 4000)
  assert.equal(cfg.write.ensureLayout, true)
})

test('a volatile whole-object reference is read before normalizing', () => {
  const cfg = normalizeConfig(validated({ inject: { limits: { project: 12345, rules: 0, user: 5000, profile: 1 } } }))

  assert.deepEqual(cfg.inject.limits, { project: 12345, rules: 0, user: 5000, profile: 1 })
})

test('normalizing does not consume or rewrite the original references', () => {
  const raw = validated({ readOnly: true })
  const reference = raw.readOnly
  assert.equal(reference.get(), true)

  const cfg = normalizeConfig(raw)
  cfg.readOnly = false

  // The same reference is still there and still reports what the host holds.
  assert.equal(raw.readOnly, reference)
  assert.equal(raw.readOnly.get(), true)
})

test('only a real volatile reference is followed', () => {
  // A user-supplied object that merely has a `get` key is data, not a config
  // reference; calling it would execute arbitrary input and could make an
  // unsupported value look supported.
  let called = false
  const cfg = normalizeConfig({ search: { enabled: { get: () => {
    called = true
    return false
  } } } })

  assert.equal(called, false)
  assert.equal(cfg.search.enabled, true)
})

test('the reference protocol is the write symbol, not just a getter', () => {
  const ref = {
    get: () => false,
    [VOLATILE_WRITE]: () => {},
  }
  const cfg = normalizeConfig({ readOnly: ref })
  assert.equal(cfg.readOnly, false)
})

test('layered injection and lazy first-write defaults are normalized', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.inject.mode, 'layered')
  assert.equal(cfg.inject.coreBudget, 4000)
  assert.equal(cfg.write.ensureLayout, true)
  assert.equal(normalizeConfig({ inject: { mode: 'full', coreBudget: 9000 } }).inject.coreBudget, 9000)
  assert.equal(normalizeConfig({ inject: { mode: 'bad', coreBudget: 100 } }).inject.mode, 'layered')
  assert.equal(normalizeConfig({ inject: { mode: 'full', coreBudget: 100 } }).inject.coreBudget, 4000)
})
