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
 * 1. it is copied into the profile's `node_modules`;
 * 2. it is listed in the profile's `dsh.profile.bundles` and in `dependencies`.
 *
 * Bundles matter for more than loading: the bundle layer inserts the entry, and
 * the user patch layer then targets it by id. Writing the insert straight into
 * the user patch instead makes settings writes append a *second* entry with the
 * same id, so the config card writes somewhere the loader never merges.
 *
 * Usage: node scripts/dev-install.mjs [profile]   (default: web)
 */

import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('./', import.meta.url)))
const PROFILE = process.argv[2] ?? 'web'
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const TARGET = join(PROFILE_DIR, 'node_modules', 'dsh-workbuddy-memory')

const FILES = ['package.json', 'cordis.patch.yml', 'src', 'locale', 'README.md', 'README.zh.md', 'LICENSE']
const NAME = 'dsh-workbuddy-memory'

rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })

const copied = []
for (const name of FILES) {
  const from = join(ROOT, name)
  try {
    if (!statSync(from)) continue
  } catch {
    continue
  }
  cpSync(from, join(TARGET, name), { recursive: true })
  copied.push(name)
}

// Register in the profile so the loader mounts it as a bundle and the Plugins
// page lists it. Both edits are idempotent.
const manifestPath = join(PROFILE_DIR, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
const registered = !manifest.dsh.profile.bundles.includes(NAME)
if (registered) manifest.dsh.profile.bundles.push(NAME)
manifest.dependencies ??= {}
const declared = !manifest.dependencies[NAME]
if (declared) manifest.dependencies[NAME] = `file:${ROOT.replaceAll('\\', '/')}`
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

process.stdout.write(`installed into ${TARGET}\n`)
process.stdout.write(`copied: ${copied.join(', ')}\n`)
process.stdout.write(`profile ${PROFILE}: bundle ${registered ? 'added' : 'already listed'}, dependency ${declared ? 'added' : 'already listed'}\n`)
process.stdout.write('restart the profile to mount it; no insert block is needed in cordis.patch.yml\n')
