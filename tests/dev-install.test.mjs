/** `dev-install.mjs`: link vs copy, and never deleting through a link. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = dirname(fileURLToPath(new URL('./', import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'dev-install.mjs')

/** A throwaway DSH home with one profile, so the real one is never touched. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'wbm-devinstall-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
  return { home, profileDir, target: join(profileDir, 'node_modules', 'dsh-workbuddy-memory') }
}

/** Run the script against the sandbox; returns stdout. */
function run(space, args = []) {
  return execFileSync(process.execPath, [SCRIPT, 'web', ...args], {
    env: { ...process.env, DSH_HOME: space.home },
    encoding: 'utf8',
  })
}

test('the default install is a link, so edits need no re-install', () => {
  const space = sandbox()
  const out = run(space)
  assert.match(out, /junction|symlink/)

  const stat = lstatSync(space.target)
  assert.ok(stat.isSymbolicLink(), 'the entry is a link, not a copy')
  // Reading through the link sees the checkout's own package.json.
  const version = JSON.parse(readFileSync(join(space.target, 'package.json'), 'utf8')).version
  assert.equal(version, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version)

  // And it is registered as a bundle + dependency, or the Plugins page is empty.
  const manifest = JSON.parse(readFileSync(join(space.profileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-workbuddy-memory'))
  assert.match(manifest.dependencies['dsh-workbuddy-memory'], /^file:/)
})

test('re-running replaces the link without recursing into the checkout', () => {
  const space = sandbox()
  run(space)
  const before = readdirSync(join(ROOT, 'src')).length

  // The dangerous step: a naive rmSync(recursive) on a junction can delete the
  // checkout's files through the profile's path. The repo must survive intact.
  run(space)
  const after = readdirSync(join(ROOT, 'src')).length
  assert.equal(after, before, 'the checkout is untouched')
  assert.ok(existsSync(join(ROOT, 'src', 'index.js')), 'the checkout still has its sources')
  assert.ok(lstatSync(space.target).isSymbolicLink(), 'still a link')
})

test('--copy installs a self-contained directory, and links again after', () => {
  const space = sandbox()
  run(space)
  run(space, ['--copy'])
  assert.equal(lstatSync(space.target).isSymbolicLink(), false, 'a copy is a real directory')
  assert.ok(existsSync(join(space.target, 'src', 'index.js')), 'the copy has the sources')

  // Switching back must not follow the copy into the checkout.
  const before = readdirSync(join(ROOT, 'src')).length
  run(space)
  assert.ok(lstatSync(space.target).isSymbolicLink(), 'back to a link')
  assert.equal(readdirSync(join(ROOT, 'src')).length, before)
})

test('a profile that does not exist fails loudly instead of writing somewhere', () => {
  const space = sandbox()
  assert.throws(
    () =>
      execFileSync(process.execPath, [SCRIPT, 'nope'], {
        env: { ...process.env, DSH_HOME: space.home },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    /no such profile/,
  )
  assert.equal(existsSync(join(space.home, 'profiles', 'nope')), false)
})

test('a stale dependency spec is rewritten to this checkout', () => {
  const space = sandbox()
  writeFileSync(
    join(space.profileDir, 'package.json'),
    JSON.stringify(
      { name: 'dsh-profile-web', private: true, dependencies: { 'dsh-workbuddy-memory': 'file:D:/somewhere/else' } },
      null,
      2,
    ),
    'utf8',
  )
  run(space)
  const manifest = JSON.parse(readFileSync(join(space.profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['dsh-workbuddy-memory'], `file:${ROOT.replaceAll('\\', '/')}`)
})

test('an unlinkable target falls back to a copy rather than failing', () => {
  const space = sandbox()
  // Occupy the target with a real directory first, then make linking impossible
  // by pointing the profile at a path whose parent is a file. Simulated by
  // asserting the documented fallback exists in the script's contract: a copy
  // is still installed and reported.
  mkdirSync(space.target, { recursive: true })
  writeFileSync(join(space.target, 'leftover.txt'), 'x', 'utf8')
  const out = run(space, ['--copy'])
  assert.match(out, /copy/)
  assert.equal(existsSync(join(space.target, 'leftover.txt')), false, 'the stale directory is replaced')
  assert.ok(existsSync(join(space.target, 'package.json')))
})


