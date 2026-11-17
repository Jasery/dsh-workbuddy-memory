/**
 * Produce the release body (and title) for one version, for `gh release create`.
 *
 * Two sources, in order:
 *
 * 1. `.release-notes/v<version>.md`, when a hand-written note exists. The
 *    release body is the one place where "what changed and why" reads like prose
 *    instead of a changelog line, so a hand-written file wins. An optional
 *    leading `# Title` line becomes the release title.
 * 2. The `## <version>` section of `CHANGELOG.zh.md` (or `CHANGELOG.md` with
 *    `--lang en`), so a release never ships with an empty body.
 *
 * A compare link is appended either way. The previous tag comes from git, which
 * is why the workflow checks out with `fetch-depth: 0`.
 *
 * Usage:
 *   node scripts/release-notes.mjs <version> [--lang zh|en] [--out file] [--title-out file]
 *
 * Without `--out` the body goes to stdout and the title to stderr, so a single
 * run can be read either way.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('./', import.meta.url)))
const args = process.argv.slice(2)
const version = (args.find((value) => !value.startsWith('--')) ?? '').replace(/^v/, '')
const lang = option('--lang') === 'en' ? 'en' : 'zh'
const out = option('--out')
const titleOut = option('--title-out')

if (!/^\d+\.\d+\.\d+/.test(version)) {
  fail('usage: node scripts/release-notes.mjs <version> [--lang zh|en] [--out file] [--title-out file]')
}

const tag = `v${version}`
const handWritten = join(ROOT, '.release-notes', `${tag}.md`)
const source = existsSync(handWritten) ? fromFile(handWritten) : { title: '', body: fromChangelog() }
const title = source.title || tag
const footer = compareFooter()
const notes = footer ? `${source.body}\n\n${footer}\n` : `${source.body}\n`

if (out) writeFileSync(out, notes, 'utf8')
else process.stdout.write(notes)
if (titleOut) writeFileSync(titleOut, `${title}\n`, 'utf8')
else process.stderr.write(`title: ${title}\n`)

// ── sources ──────────────────────────────────────────────────────────────────

/** A hand-written note: optional `# Title`, then the body. */
function fromFile(file) {
  const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const heading = /^#\s+(.+)$/.exec(lines[0] ?? '')
  if (!heading) return { title: '', body: lines.join('\n').trim() }
  return { title: heading[1].trim(), body: lines.slice(1).join('\n').trim() }
}

/** The changelog section for this version, heading stripped. */
function fromChangelog() {
  const file = join(ROOT, lang === 'en' ? 'CHANGELOG.md' : 'CHANGELOG.zh.md')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escape(version)}(\\s|$)`).test(line))
  if (start === -1) fail(`${file} has no "## ${version}" section`)

  const end = lines.findIndex((line, at) => at > start && /^##\s/.test(line))
  const text = lines.slice(start + 1, end === -1 ? lines.length : end).join('\n').trim()
  if (!text) fail(`${file} has an empty "## ${version}" section`)
  return text
}

/** `**完整变更**: …/compare/vPREV...vTAG`, when the previous tag is known. */
function compareFooter() {
  const url = repositoryUrl()
  const previous = previousTag()
  if (!url || !previous) return ''
  const label = lang === 'en' ? '**Full changelog**' : '**完整变更**'
  return `${label}：${url}/compare/${previous}...${tag}`
}

/** The tag before this one, by commit distance. Empty outside a git checkout. */
function previousTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', `${tag}^`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/** `https://github.com/owner/repo`, from the package manifest. */
function repositoryUrl() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? ''
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(raw)
  return match ? `https://github.com/${match[1]}/${match[2]}` : ''
}

// ── helpers ──────────────────────────────────────────────────────────────────

function option(name) {
  const at = args.indexOf(name)
  return at === -1 ? '' : args[at + 1] ?? ''
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
