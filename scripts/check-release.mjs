/**
 * Refuse a release whose pieces disagree, before anything is published.
 *
 * A tag-triggered release has one failure mode that matters: the tag, the
 * manifest and the changelog are three separate statements about "which version
 * is this", and nothing in npm or git compares them. When they drift, npm
 * quietly publishes a version whose notes describe a different one.
 *
 * Checks, all fatal:
 *
 * 1. `package.json` version === the tag being released.
 * 2. `package.json` is not private.
 * 3. `CHANGELOG.md` and `CHANGELOG.zh.md` both have a `## <version>` section —
 *    a release with notes in one language and nothing in the other is the
 *    drift this catches.
 * 4. The version is not already on the registry. Re-running a publish job must
 *    not fail the release, so the workflow asks for `--allow-published`; then
 *    this check reports the state instead of failing.
 *
 * Network access is optional: `--offline` skips check 4. The workflow runs it
 * online, because "already published" is exactly the case it needs to know.
 *
 * Usage:
 *   node scripts/check-release.mjs <version> [--allow-published] [--offline]
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('./', import.meta.url)))
const args = process.argv.slice(2)
const version = (args.find((value) => !value.startsWith('--')) ?? '').replace(/^v/, '')
const allowPublished = args.includes('--allow-published')
const offline = args.includes('--offline')

const problems = []
const notes = []

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  problems.push(`"${version}" is not a version number`)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (manifest.version !== version) {
  problems.push(`package.json says ${manifest.version}, the tag says ${version}`)
}
if (manifest.private === true) {
  problems.push('package.json is private, so npm will refuse to publish it')
}

for (const file of ['CHANGELOG.md', 'CHANGELOG.zh.md']) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  if (!new RegExp(`^##\\s+${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(text)) {
    problems.push(`${file} has no "## ${version}" section`)
  }
}

let published = false
if (problems.length === 0) {
  const state = offline ? 'skipped' : await publishedState()
  if (state === 'published') {
    published = true
    if (allowPublished) notes.push(`${version} is already on the registry; skipping the publish step`)
    else problems.push(`${version} is already on the registry`)
  } else if (state === 'absent') {
    notes.push(`${version} is not on the registry yet`)
  } else if (state === 'unknown') {
    notes.push('could not reach the registry; the publish step decides')
  }
}

for (const note of notes) process.stdout.write(`note: ${note}\n`)

// Machine-readable, for the workflow: a re-run of a release that already
// published must not fail on the version it published.
process.stdout.write(`already-published: ${published}\n`)
if (problems.length) {
  for (const problem of problems) process.stderr.write(`error: ${problem}\n`)
  process.exit(1)
}

process.stdout.write(`ok: ${version} is consistent across tag, manifest and changelog\n`)

// ── registry ─────────────────────────────────────────────────────────────────

/**
 * Whether this exact version is on the registry.
 *
 * Only the single-version endpoint is consulted: the packument lists versions
 * for the whole package, which grows without bound. A network failure answers
 * `unknown` rather than `absent`, because "the registry did not answer" is not
 * evidence that a version is free.
 *
 * @returns {Promise<'published'|'absent'|'unknown'>}
 */
async function publishedState() {
  const registry = (manifest.publishConfig?.registry ?? 'https://registry.npmjs.org/').replace(/\/$/, '')
  const url = `${registry}/${manifest.name.replace('/', '%2f')}/${version}`
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (response.status === 200) return 'published'
    if (response.status === 404) return 'absent'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
