/**
 * The two scripts the release workflow depends on.
 *
 * These checks stand between a tag and an irreversible `npm publish`, so they
 * are tested like production code rather than trusted because they ran once by
 * hand. Everything runs in a temporary directory: neither script may read this
 * checkout's own version, or a test would pass on the day the version happens
 * to match.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = dirname(fileURLToPath(new URL('./', import.meta.url)))
const SCRIPTS = join(ROOT, 'scripts')

/**
 * A throwaway package: a manifest and both changelogs.
 *
 * The scripts resolve their paths from their own location, so the copies under
 * test are the ones inside this fixture.
 */
function sandbox({ version = '1.2.3', isPrivate = false, changelog = {}, notes, registry } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wbm-release-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })

  for (const name of ['check-release.mjs', 'release-notes.mjs']) {
    writeFileSync(join(dir, 'scripts', name), readFileSync(join(SCRIPTS, name)), 'utf8')
  }

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-pkg',
        version,
        private: isPrivate,
        repository: { type: 'git', url: 'git+https://github.com/owner/fixture-pkg.git' },
        publishConfig: { registry: registry ?? 'https://registry.npmjs.org/' },
      },
      null,
      2,
    ),
    'utf8',
  )

  const zh = changelog.zh ?? `## ${version} — today\n\n- 中文说明\n`
  const en = changelog.en ?? `## ${version} — today\n\n- English note\n`
  writeFileSync(join(dir, 'CHANGELOG.zh.md'), `# 更新日志\n\n${zh}\n## 1.0.0\n\n- 旧版本\n`, 'utf8')
  writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n${en}\n## 1.0.0\n\n- older\n`, 'utf8')

  if (notes !== undefined) {
    mkdirSync(join(dir, '.release-notes'), { recursive: true })
    writeFileSync(join(dir, '.release-notes', `v${version}.md`), notes, 'utf8')
  }

  return dir
}

/**
 * Run one script in the sandbox; returns stdout, stderr and the exit code.
 *
 * Asynchronous on purpose: one test answers from a registry server running in
 * this process, and a synchronous child would block the event loop that has to
 * serve it.
 */
async function run(dir, script, args = []) {
  const child = spawn(process.execPath, [join(dir, 'scripts', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const [stdout, stderr, code] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    new Promise((resolve) => child.on('close', resolve)),
  ])
  return { stdout, stderr, code }
}

/** Read a stream to a string. */
function collect(stream) {
  return new Promise((resolve) => {
    let text = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      text += chunk
    })
    stream.on('end', () => resolve(text))
  })
}

// ── check-release ────────────────────────────────────────────────────────────

test('a consistent tag passes and reports the publish state', async () => {
  const dir = sandbox()
  const { stdout, code } = await run(dir, 'check-release.mjs', ['1.2.3', '--offline'])
  assert.equal(code, 0, 'the fixture is consistent, so the check must pass')
  assert.match(stdout, /^ok: 1\.2\.3 is consistent/m)
  assert.match(stdout, /^already-published: false$/m, 'the workflow reads this line')
})

test('a tag that disagrees with the manifest fails, and says which side is which', async () => {
  const dir = sandbox()
  const { stderr, code } = await run(dir, 'check-release.mjs', ['1.2.4', '--offline'])
  assert.equal(code, 1)
  assert.match(stderr, /package\.json says 1\.2\.3, the tag says 1\.2\.4/)
})

test('a version missing from either changelog fails', async () => {
  const dir = sandbox({ version: '2.0.0', changelog: { en: '## 1.9.0\n\n- older\n', zh: '## 2.0.0\n\n- 中文\n' } })
  const { stderr, code } = await run(dir, 'check-release.mjs', ['2.0.0', '--offline'])
  assert.equal(code, 1)
  assert.match(stderr, /CHANGELOG\.md has no "## 2\.0\.0" section/)
  assert.doesNotMatch(stderr, /CHANGELOG\.zh\.md/, 'the Chinese changelog does have it')
})

test('a private manifest fails instead of failing at the publish step', async () => {
  const dir = sandbox({ isPrivate: true })
  const { stderr, code } = await run(dir, 'check-release.mjs', ['1.2.3', '--offline'])
  assert.equal(code, 1)
  assert.match(stderr, /private/)
})

test('a tag is accepted with or without its leading v', async () => {
  const dir = sandbox()
  assert.equal((await run(dir, 'check-release.mjs', ['v1.2.3', '--offline'])).code, 0)
  assert.equal((await run(dir, 'check-release.mjs', ['1.2.3', '--offline'])).code, 0)
})

test('a nonsensical version is refused before any comparison', async () => {
  const dir = sandbox()
  const { stderr, code } = await run(dir, 'check-release.mjs', ['not-a-version', '--offline'])
  assert.equal(code, 1)
  assert.match(stderr, /is not a version number/)
})

test('a version already on the registry fails unless the re-run allows it', async (t) => {
  // A local registry makes the answers deterministic. Pointing the fixture at
  // the real one would tie the test to the network and to whether some
  // unrelated package happens to own the version.
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"name":"fixture-pkg","version":"1.2.3"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const registry = `http://127.0.0.1:${server.address().port}/`

  const dir = sandbox({ registry })
  const refused = await run(dir, 'check-release.mjs', ['1.2.3'])
  assert.equal(refused.code, 1, 'publishing over an existing version must be refused')
  assert.match(refused.stderr, /already on the registry/)

  const allowed = await run(dir, 'check-release.mjs', ['1.2.3', '--allow-published'])
  assert.equal(allowed.code, 0, 'a re-run of a release must not fail on the version it published')
  assert.match(allowed.stdout, /^already-published: true$/m)

  // The single-version endpoint, not the packument: the packument grows with
  // every release.
  assert.deepEqual(requests, ['/fixture-pkg/1.2.3', '/fixture-pkg/1.2.3'])
})

test('a version absent from the registry is reported as free', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const dir = sandbox({ registry: `http://127.0.0.1:${server.address().port}/` })
  const { stdout, code } = await run(dir, 'check-release.mjs', ['1.2.3'])
  assert.equal(code, 0)
  assert.match(stdout, /not on the registry yet/)
  assert.match(stdout, /^already-published: false$/m)
})

test('an unreachable registry reads as unknown, not as free', async () => {
  // Nothing listens on port 9, so the lookup cannot answer. That is not
  // evidence the version is available — but it must not block a release
  // either, so the check passes and says what it saw.
  const dir = sandbox({ registry: 'http://127.0.0.1:9/' })
  const { stdout, code } = await run(dir, 'check-release.mjs', ['1.2.3'])
  assert.equal(code, 0, 'an unreachable registry must not block the release')
  assert.match(stdout, /could not reach the registry/)
  assert.match(stdout, /^already-published: false$/m)
})

// ── release-notes ────────────────────────────────────────────────────────────

test('the notes come from the changelog section and stop at the next version', async () => {
  const dir = sandbox()
  const { stdout, code } = await run(dir, 'release-notes.mjs', ['1.2.3'])
  assert.equal(code, 0)
  assert.match(stdout, /中文说明/)
  assert.doesNotMatch(stdout, /旧版本/, 'the previous section must not leak in')
  assert.doesNotMatch(stdout, /^## /m, 'the version heading is the title, not body text')
})

test('--lang en reads the English changelog', async () => {
  const dir = sandbox()
  const { stdout } = await run(dir, 'release-notes.mjs', ['1.2.3', '--lang', 'en'])
  assert.match(stdout, /English note/)
})

test('a hand-written note wins over the changelog and supplies the title', async () => {
  const dir = sandbox({ notes: '# v1.2.3 — 手写标题\n\n正文段落。\n' })
  const { stdout, code } = await run(dir, 'release-notes.mjs', ['1.2.3', '--out', join(dir, 'notes.md'), '--title-out', join(dir, 'title.txt')])
  assert.equal(code, 0)
  assert.equal(stdout, '', 'writing to files means nothing goes to stdout')

  assert.equal(readFileSync(join(dir, 'title.txt'), 'utf8').trim(), 'v1.2.3 — 手写标题')
  const body = readFileSync(join(dir, 'notes.md'), 'utf8')
  assert.match(body, /正文段落/)
  assert.doesNotMatch(body, /中文说明/, 'the changelog is not mixed in')
})

test('the title falls back to the tag when nothing supplies one', async () => {
  const dir = sandbox()
  await run(dir, 'release-notes.mjs', ['1.2.3', '--out', join(dir, 'notes.md'), '--title-out', join(dir, 'title.txt')])
  assert.equal(readFileSync(join(dir, 'title.txt'), 'utf8').trim(), 'v1.2.3')
})

test('a version with no changelog section fails instead of publishing an empty body', async () => {
  const dir = sandbox()
  const { stderr, code } = await run(dir, 'release-notes.mjs', ['9.9.9'])
  assert.equal(code, 1)
  assert.match(stderr, /has no "## 9\.9\.9" section/)
})

test('the compare link is omitted when the checkout has no previous tag', async () => {
  // The sandbox is not a git repository, so `git describe` fails and the footer
  // is dropped rather than emitting a broken URL.
  const dir = sandbox()
  const { stdout } = await run(dir, 'release-notes.mjs', ['1.2.3'])
  assert.doesNotMatch(stdout, /compare/)
})
