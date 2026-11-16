/**
 * Cross-process receipt races.
 *
 * `admit`: two writers meet a store that already holds the last unresolved
 * slot. Each pauses inside the receipts directory listing so both would count
 * 99 before either creates anything — unless admission is serialized across
 * processes. After the barrier each fails its source open, which leaves the
 * receipt it created behind as a real `applying` record.
 *
 * `sweep`: a writer's expiry sweep pauses just before removing an old committed
 * receipt. The parent then creates a *new* committed receipt with the same id.
 * The sweep must not delete it when it resumes.
 *
 * Prints one JSON line: `{ result }`.
 */

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

import { normalizeConfig } from '../../src/config.js'
import { probeEnvironment } from '../../src/env.js'
import { createReceiptStore } from '../../src/write/receipts.js'
import { createStore } from '../../src/write/store.js'

const [mode, stateDir, cwd, home, root, suffix] = process.argv.slice(2)
const cfg = normalizeConfig({ workbuddyHome: home, stateDir, write: { lockWaitMs: 15000 } })
const probe = probeEnvironment({ cfg, cwd, env: { WORKBUDDY_CONFIG_DIR: home }, home: root })
const store = createStore({ cfg, stateDir })
const buffer = new Int32Array(new SharedArrayBuffer(4))

/** Wait until every named file exists, or the deadline passes. */
function waitFor(names, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (!names.every((name) => fs.existsSync(join(root, name)))) {
    if (Date.now() >= deadline) return false
    Atomics.wait(buffer, 0, 0, 10)
  }
  return true
}

if (mode === 'admit') {
  const originalReaddir = fs.readdirSync
  fs.readdirSync = (path, ...args) => {
    const names = originalReaddir(path, ...args)
    if (String(path) === join(stateDir, 'receipts')) {
      fs.writeFileSync(join(root, `inside-${suffix}`), 'ready')
      waitFor(['inside-a', 'inside-b'])
    }
    return names
  }
  const originalOpen = fs.openSync
  fs.openSync = (path, flags, ...args) => {
    if (String(path).endsWith('.md') && flags === 'a') {
      throw Object.assign(new Error('deterministic source EACCES after begin'), { code: 'EACCES' })
    }
    return originalOpen(path, flags, ...args)
  }
  syncBuiltinESMExports()
  const result = await store.append(
    {
      target: 'project-daily',
      date: suffix === 'a' ? '2026-09-01' : '2026-09-02',
      text: `writer-${suffix}`,
      operationId: `admit-${suffix}`,
    },
    probe,
  )
  process.stdout.write(`${JSON.stringify({ result })}\n`)
} else if (mode === 'sweep') {
  const receipts = createReceiptStore({ stateDir })
  const oldFile = receipts.fileFor('old-id')
  const originalRm = fs.rmSync
  fs.rmSync = (path, ...args) => {
    if (String(path) === oldFile) {
      fs.writeFileSync(join(root, 'sweep-paused'), 'ready')
      waitFor(['parent-done'])
    }
    return originalRm(path, ...args)
  }
  syncBuiltinESMExports()
  const result = await store.append(
    { target: 'project-daily', date: '2026-09-03', text: 'sweeper', operationId: 'sweeper-id' },
    probe,
  )
  process.stdout.write(`${JSON.stringify({ result })}\n`)
}
