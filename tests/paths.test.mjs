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
import { truncateChars, truncateHead } from '../src/fsx.js'
import { redact } from '../src/render.js'

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
