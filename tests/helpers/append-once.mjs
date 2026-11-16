/**
 * One process, one append, for the cross-process idempotency test.
 *
 * Kept deliberately dumb: it imports the real store and prints the real result
 * as one JSON line, so the parent test is measuring the filesystem locks and
 * receipts rather than a mock.
 */

import { normalizeConfig } from '../../src/config.js'
import { probeEnvironment } from '../../src/env.js'
import { createStore } from '../../src/write/store.js'

const [stateDir, cwd, home, root, operationId, target, text] = process.argv.slice(2)

const cfg = normalizeConfig({ workbuddyHome: home, stateDir })
const env = { WORKBUDDY_CONFIG_DIR: home }
const probe = probeEnvironment({ cfg, cwd, env, home: root })
const store = createStore({ cfg, stateDir })
const result = await store.append(
  {
    target: target ?? 'project-memory',
    section: 'A',
    text: text ?? '跨进程一次',
    operationId,
  },
  probe,
)
process.stdout.write(`${JSON.stringify(result)}\n`)
