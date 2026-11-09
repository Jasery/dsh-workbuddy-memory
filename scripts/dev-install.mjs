/**
 * Copy this package into a DSH profile's node_modules for local development.
 *
 * `dsh plugin add` normally does this through pnpm, but a profile created by a
 * different pnpm major refuses to relink against the other store. This script
 * does the same file copy without touching the store, so an already-working
 * profile keeps working.
 *
 * It does not edit `cordis.patch.yml` — add the entry there once:
 *
 *   - insert:
 *       - id: workbuddy-memory
 *         name: dsh-workbuddy-memory
 *
 * Usage: node scripts/dev-install.mjs [profile]   (default: web)
 */

import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('./', import.meta.url)))
const PROFILE = process.argv[2] ?? 'web'
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const TARGET = join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dsh-workbuddy-memory')

const FILES = ['package.json', 'cordis.patch.yml', 'src', 'locale', 'README.md', 'README.zh.md', 'LICENSE']

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

process.stdout.write(`installed into ${TARGET}\n`)
process.stdout.write(`copied: ${copied.join(', ')}\n`)
process.stdout.write(`ensure the profile patch contains:\n  - insert:\n      - id: workbuddy-memory\n        name: dsh-workbuddy-memory\n`)
