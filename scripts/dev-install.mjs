/**
 * Install this package into a DSH profile for local development.
 *
 * `dsh plugin add` normally does this through pnpm, but a profile created by a
 * different pnpm major refuses to relink against the other store. This script
 * does the same thing without touching the store, so an already-working profile
 * keeps working.
 *
 * Two things make the plugin a first-class entry rather than a loose insert:
 *
 * 1. it is linked into the profile's `node_modules`;
 * 2. it is listed in the profile's `dsh.profile.bundles` and in `dependencies`.
 *
 * Bundles matter for more than loading: the bundle layer inserts the entry, and
 * the user patch layer then targets it by id. Writing the insert straight into
 * the user patch instead makes settings writes append a *second* entry with the
 * same id, so the config card writes somewhere the loader never merges.
 *
 * ## Why a link and not a copy
 *
 * A copy is a snapshot: every source edit — and every version bump — needs this
 * script re-run, and forgetting is silent. The profile keeps loading last
 * week's code with no indication that it is stale. A link makes the profile and
 * the checkout the same bytes, so a restart is the only step left.
 *
 * The tradeoff is real and worth stating: the profile now depends on this
 * checkout staying where it is. Moving or deleting the repo breaks the profile.
 * `--copy` restores the old self-contained behaviour when that matters.
 *
 * Usage:
 *   node scripts/dev-install.mjs [profile]          link (default: web)
 *   node scripts/dev-install.mjs [profile] --copy   copy instead of linking
 */

import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('./', import.meta.url)))
const args = process.argv.slice(2)
const COPY = args.includes('--copy')
const PROFILE = args.find((value) => !value.startsWith('--')) ?? 'web'
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const TARGET = join(PROFILE_DIR, 'node_modules', 'dsh-workbuddy-memory')

const FILES = ['package.json', 'cordis.patch.yml', 'src', 'locale', 'README.md', 'README.zh.md', 'LICENSE']
const NAME = 'dsh-workbuddy-memory'

if (!statSafe(PROFILE_DIR)) {
  process.stderr.write(`no such profile: ${PROFILE_DIR}\n`)
  process.exit(1)
}

// ── replace whatever is already installed ────────────────────────────────────

/**
 * Remove the existing entry without touching what a link points at.
 *
 * This is the one dangerous step in the script. `rmSync(recursive)` on a
 * junction or symlink is not guaranteed to stop at the link: a mistake here
 * deletes the checkout's own files through the profile's path. So links are
 * unlinked, never recursed into.
 */
function removeExisting(target) {
  let stat
  try {
    stat = lstatSync(target)
  } catch {
    return 'nothing'
  }
  if (stat.isSymbolicLink()) {
    // Junctions report as symlinks. unlink works for symlinks; rmdir is what
    // Windows accepts for a junction.
    try {
      unlinkSync(target)
      return 'replaced link'
    } catch {
      try {
        rmdirSync(target)
        return 'replaced junction'
      } catch {
        // Fall through to the recursive path below.
      }
    }
  }
  rmSync(target, { recursive: true, force: true })
  return stat.isSymbolicLink() ? 'replaced link' : 'replaced copy'
}

mkdirSync(join(PROFILE_DIR, 'node_modules'), { recursive: true })
const removed = removeExisting(TARGET)

// ── install ──────────────────────────────────────────────────────────────────

/** Link `target` to `source`, preferring a junction. */
function linkDir(target, source) {
  // A junction needs no privilege on Windows and resolves to the same inode
  // Node would see through a directory symlink.
  try {
    symlinkSync(source, target, 'junction')
    return 'junction'
  } catch (error) {
    if (process.platform === 'win32') throw error
  }
  try {
    symlinkSync(source, target, 'dir')
    return 'symlink'
  } catch {
    return null
  }
}

let mode
let copied = []
if (COPY) {
  mkdirSync(TARGET, { recursive: true })
  for (const name of FILES) {
    const from = join(ROOT, name)
    if (!statSafe(from)) continue
    cpSync(from, join(TARGET, name), { recursive: true })
    copied.push(name)
  }
  mode = 'copy'
} else {
  const kind = linkDir(TARGET, ROOT)
  if (kind) {
    mode = kind
  } else {
    // No privilege and no developer mode: a copy still works, it just needs
    // re-running after every edit. Say so instead of failing outright.
    mkdirSync(TARGET, { recursive: true })
    for (const name of FILES) {
      const from = join(ROOT, name)
      if (!statSafe(from)) continue
      cpSync(from, join(TARGET, name), { recursive: true })
      copied.push(name)
    }
    mode = 'copy (linking was refused; re-run after each edit)'
  }
}

// ── register in the profile ──────────────────────────────────────────────────

// Both edits are idempotent. The dependency stays a `file:` spec either way:
// that is what pnpm writes, and it survives `pnpm install` re-running.
const manifestPath = join(PROFILE_DIR, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
const registered = !manifest.dsh.profile.bundles.includes(NAME)
if (registered) manifest.dsh.profile.bundles.push(NAME)
manifest.dependencies ??= {}
const wanted = `file:${ROOT.replaceAll('\\', '/')}`
const declared = !manifest.dependencies[NAME]
const rewrote = !declared && manifest.dependencies[NAME] !== wanted
if (declared || rewrote) manifest.dependencies[NAME] = wanted
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

// ── report ───────────────────────────────────────────────────────────────────

const version = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '?'
  }
})()

process.stdout.write(`${mode}: ${TARGET}\n`)
if (mode === 'copy' || mode.startsWith('copy')) process.stdout.write(`copied: ${copied.join(', ')}\n`)
else process.stdout.write(`source: ${ROOT} (version ${version})\n`)
process.stdout.write(`${removed === 'nothing' ? 'no previous install' : removed}\n`)
process.stdout.write(
  `profile ${PROFILE}: bundle ${registered ? 'added' : 'already listed'}, dependency ${
    declared ? 'added' : rewrote ? 'updated' : 'already listed'
  }\n`,
)
process.stdout.write('restart the profile to mount it; no insert block is needed in cordis.patch.yml\n')

/** `stat` that answers null instead of throwing. */
function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}
