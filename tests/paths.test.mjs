import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { sep } from 'node:path'
import test from 'node:test'

const sepChar = () => sep

import {
  expandHome,
  memoryLayout,
  resolveDataFolderName,
  resolveInstanceSuffix,
  resolveStateDir,
  resolveWorkbuddyHome,
  uidFromPersonalDir,
} from '../src/paths.js'
import { truncateChars, truncateHead, readTextSafe } from '../src/fsx.js'
import { redact } from '../src/render.js'
import { pathKey } from '../src/write/fslock.js'
import fs, { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'

const HOME = resolve('/home/tester')

test('data folder falls back env then default', () => {
  assert.equal(resolveDataFolderName('', {}), '.workbuddy')
  assert.equal(resolveDataFolderName('', { WORKBUDDY_DATA_FOLDER_NAME: '.wbdata' }), '.wbdata')
  assert.equal(resolveDataFolderName('.mine', { WORKBUDDY_DATA_FOLDER_NAME: '.wbdata' }), '.mine')
  assert.equal(resolveDataFolderName('  ', {}), '.workbuddy')
})

test('instance suffix follows the env pair', () => {
  assert.equal(resolveInstanceSuffix({}), '')
  assert.equal(resolveInstanceSuffix({ WORKBUDDY_INSTANCE_NUMBER: '2' }), '-2')
  assert.equal(resolveInstanceSuffix({ WORKBUDDY_INSTANCE_NUMBER: '2', WORKBUDDY_FORCE_NO_INSTANCE_NUMBER: '1' }), '')
})

test('home resolves config, then env, then default', () => {
  const fromConfig = resolveWorkbuddyHome(join(HOME, 'custom', 'wb'), { WORKBUDDY_CONFIG_DIR: join(HOME, 'env') }, HOME)
  assert.equal(fromConfig.path, resolve(HOME, 'custom', 'wb'))
  assert.equal(fromConfig.source, 'config')

  const fromEnv = resolveWorkbuddyHome('', { WORKBUDDY_CONFIG_DIR: join(HOME, 'env', 'wb') }, HOME)
  assert.equal(fromEnv.path, resolve(HOME, 'env', 'wb'))
  assert.equal(fromEnv.source, 'env')
  assert.equal(fromEnv.detail, 'WORKBUDDY_CONFIG_DIR')

  const fromCodebuddy = resolveWorkbuddyHome('', { CODEBUDDY_CONFIG_DIR: join(HOME, 'env', 'cb') }, HOME)
  assert.equal(fromCodebuddy.path, resolve(HOME, 'env', 'cb'))

  const fallback = resolveWorkbuddyHome('', {}, HOME)
  assert.equal(fallback.path, join(HOME, '.workbuddy'))
  assert.equal(fallback.source, 'default')

  const instanced = resolveWorkbuddyHome('', { WORKBUDDY_INSTANCE_NUMBER: '3' }, HOME)
  assert.equal(instanced.path, join(HOME, '.workbuddy-3'))
})

test('state dir defaults under the dsh home', () => {
  assert.equal(resolveStateDir('', {}, HOME).path, join(HOME, '.dsh', 'workbuddy-memory'))
  assert.equal(resolveStateDir('', { DSH_HOME: join(HOME, 'dshhome') }, HOME).path, join(HOME, 'dshhome', 'workbuddy-memory'))
  assert.equal(resolveStateDir(join(HOME, 'state'), {}, HOME).path, resolve(HOME, 'state'))
})

test('layout keeps project paths null without a workspace', () => {
  const wb = join(HOME, 'wb')
  const repo = join(HOME, 'repo')
  const missing = memoryLayout({ home: wb, cwd: null, dataFolderName: '.workbuddy' })
  assert.equal(missing.projectMemoryDir, null)
  assert.equal(missing.projectMemory, null)
  assert.equal(missing.userMemory, join(wb, 'MEMORY.md'))

  const present = memoryLayout({ home: wb, cwd: repo, dataFolderName: '.wbdata' })
  assert.equal(present.projectMemoryDir, join(repo, '.wbdata', 'memory'))
  assert.equal(present.projectMemory, join(repo, '.wbdata', 'memory', 'MEMORY.md'))
})

test('home expansion only touches a leading tilde', () => {
  assert.equal(expandHome('~', HOME), HOME)
  assert.equal(expandHome('~/x', HOME), join(HOME, 'x'))
  assert.equal(expandHome(join(HOME, 'abs', '~x'), HOME), join(HOME, 'abs', '~x'))
})

test('uid comes out of a personal directory name', () => {
  assert.equal(uidFromPersonalDir(join(HOME, 'wb', 'user-abc-123-personal')), 'abc-123')
  assert.equal(uidFromPersonalDir(join(HOME, 'wb', 'memory')), '')
})

test('truncation never splits a surrogate pair', () => {
  const text = 'a😀b'
  assert.equal(truncateChars(text, 2), 'a😀')
  assert.equal(truncateChars(text, 1), 'a')
  assert.equal(truncateChars(text, 0), '')
  // 4 bytes for the emoji: cutting at 3 keeps only 'a'.
  assert.equal(truncateHead(text, 3), 'a')
  assert.equal(truncateHead(text, 5), 'a😀')
})

test('redaction replaces the home prefix in every separator style', () => {
  assert.equal(redact('/home/tester/notes', '/home/tester'), '~/notes')
  assert.equal(redact('C:\\Users\\me\\notes', 'C:\\Users\\me'), '~\\notes')
  assert.equal(redact('nothing here', '/home/tester'), 'nothing here')
})

test('pathKey folds the differences the platform itself ignores', () => {
  // Two spellings of one Windows file must share a lock and a backup directory,
  // or two writers targeting it never serialize.
  if (process.platform === 'win32') {
    assert.equal(pathKey('C:\\x\\MEMORY.md'), pathKey('c:/x/memory.md'))
    assert.notEqual(pathKey('C:\\x\\MEMORY.md'), pathKey('C:\\x\\OTHER.md'))
  } else {
    assert.equal(pathKey('/x/MEMORY.md'), pathKey('/x/MEMORY.md'))
    assert.notEqual(pathKey('/x/MEMORY.md'), pathKey('/x/memory.md'))
  }
})

test('readTextSafe reads at most maxBytes and cuts on a UTF-8 boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'wbm-fsx-'))
  const file = join(root, 'note.md')
  const text = 'a😀b'
  writeFileSync(file, text, 'utf8')

  // Three bytes stop one byte inside the four-byte emoji. The old reader first
  // loaded the whole file and then cut the string, so the "bounded" read was
  // only bounded after the fact.
  const partial = readTextSafe(file, { maxBytes: 3 })
  assert.equal(partial.ok, true)
  assert.equal(partial.text, 'a')
  assert.equal(partial.truncated, true)
  assert.equal(partial.bytes, Buffer.byteLength(text))
  assert.equal(partial.text.includes('\ufffd'), false)

  const whole = readTextSafe(file, { maxBytes: 99 })
  assert.equal(whole.text, text)
  assert.equal(whole.truncated, false)
})

/**
 * Swap named `node:fs` exports for one test. `syncBuiltinESMExports` pushes the
 * patch into the ESM bindings `src/fsx.js` already imported, so the race can be
 * reproduced deterministically instead of hoping a timer lands in a window.
 */
function patchFs(overrides) {
  const saved = {}
  for (const [name, replacement] of Object.entries(overrides)) {
    saved[name] = fs[name]
    fs[name] = replacement
  }
  syncBuiltinESMExports()
  return () => {
    for (const [name, original] of Object.entries(saved)) fs[name] = original
    syncBuiltinESMExports()
  }
}

test('readTextSafe stays bounded when the file grows after the first stat', () => {
  const root = mkdtempSync(join(tmpdir(), 'wbm-race-'))
  const file = join(root, 'grow.md')
  writeFileSync(file, 'x'.repeat(16), 'utf8')
  const grown = 2 * 1024 * 1024 + 16
  const realReadSync = fs.readSync

  let grownOnce = false
  const restore = patchFs({
    readSync(fd, buffer, offset, length, position) {
      if (!grownOnce) {
        grownOnce = true
        appendFileSync(file, 'y'.repeat(grown - 16))
      }
      return realReadSync(fd, buffer, offset, length, position)
    },
  })

  try {
    // Old code chose "bounded" from the 16-byte stat and then read the whole
    // grown file; the cap has to hold no matter what the first stat said.
    const result = readTextSafe(file, { maxBytes: 64 })
    assert.equal(result.ok, true)
    assert.equal(result.truncated, true)
    assert.equal(result.bytes, grown)
    assert.equal(Buffer.byteLength(result.text), 64)
    assert.equal(result.text.includes('\ufffd'), false)
  } finally {
    restore()
  }
})

test('readTextSafe reports a change it saw while reading, not a clean snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'wbm-race-'))
  const file = join(root, 'grow-small.md')
  writeFileSync(file, 'x'.repeat(16), 'utf8')
  const realReadSync = fs.readSync

  let grownOnce = false
  const restore = patchFs({
    readSync(fd, buffer, offset, length, position) {
      if (!grownOnce) {
        grownOnce = true
        appendFileSync(file, '- late\n')
      }
      return realReadSync(fd, buffer, offset, length, position)
    },
  })

  try {
    const result = readTextSafe(file, { maxBytes: 1024 })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'changed')
    assert.equal(result.bytes, 23)
  } finally {
    restore()
  }
})
