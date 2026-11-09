/**
 * Where WorkBuddy keeps its memory, and where this plugin keeps its own state.
 *
 * WorkBuddy resolves its home itself, in this order: an explicit value, then
 * `WORKBUDDY_CONFIG_DIR`, then `CODEBUDDY_CONFIG_DIR`, then
 * `<homedir>/<WORKBUDDY_DATA_FOLDER_NAME or .workbuddy>`. Multi-instance
 * launches append `-<WORKBUDDY_INSTANCE_NUMBER>`. The workspace memory folder
 * is `<cwd>/<WORKBUDDY_DATA_FOLDER_NAME or .workbuddy>/memory` — not a fixed
 * `.workbuddy`, which is why the folder name is configurable here too.
 *
 * The environment is read on every call rather than captured at load time: DSH
 * is long-lived, and a user who changes an environment variable expects the
 * next probe to see it.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const DEFAULT_DATA_FOLDER = '.workbuddy'
export const PROJECT_MEMORY_FOLDER = 'memory'

/** Expand a leading `~` or `~/`, leaving every other form untouched. */
export function expandHome(value, home = homedir()) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return trimmed
}

/** Resolve an absolute path without requiring it to exist. */
export function absolute(value, base) {
  const expanded = expandHome(value)
  if (!expanded) return ''
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

/** The workspace memory folder name, with its own fallback chain. */
export function resolveDataFolderName(configured, env = process.env) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit) return explicit
  const fromEnv = typeof env.WORKBUDDY_DATA_FOLDER_NAME === 'string' ? env.WORKBUDDY_DATA_FOLDER_NAME.trim() : ''
  return fromEnv || DEFAULT_DATA_FOLDER
}

/** The `-N` suffix multi-instance WorkBuddy launches add to its home directory. */
export function resolveInstanceSuffix(env = process.env) {
  if (env.WORKBUDDY_FORCE_NO_INSTANCE_NUMBER) return ''
  const raw = typeof env.WORKBUDDY_INSTANCE_NUMBER === 'string' ? env.WORKBUDDY_INSTANCE_NUMBER.trim() : ''
  return raw ? `-${raw}` : ''
}

/**
 * Resolve the WorkBuddy home directory and report how it was decided.
 *
 * @param {string} configured - the `workbuddyHome` config value.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @param {string} [home] - the user's home directory.
 * @returns {{ path: string, source: 'config'|'env'|'default', detail: string }}
 */
export function resolveWorkbuddyHome(configured, env = process.env, home = homedir()) {
  const explicit = absolute(configured, home)
  if (explicit) return { path: explicit, source: 'config', detail: 'workbuddyHome' }

  for (const key of ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR']) {
    const value = typeof env[key] === 'string' ? env[key].trim() : ''
    if (value) return { path: absolute(value, home), source: 'env', detail: key }
  }

  const suffix = resolveInstanceSuffix(env)
  const folder = `${resolveDataFolderName('', env)}${suffix}`
  return { path: join(home, folder), source: 'default', detail: suffix ? `~/${folder} (instance ${suffix.slice(1)})` : `~/${folder}` }
}

/** Where this plugin keeps derived state (never memory content). */
export function resolveStateDir(configured, env = process.env, home = homedir()) {
  const explicit = absolute(configured, home)
  if (explicit) return { path: explicit, source: 'config', detail: 'stateDir' }
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? absolute(env.DSH_HOME, home) : join(home, '.dsh')
  return { path: join(dshHome, 'workbuddy-memory'), source: 'default', detail: '~/.dsh/workbuddy-memory' }
}

/**
 * Every memory file this plugin may touch, given one workspace.
 *
 * `cwd` may be empty: callers without a session directory still get the
 * user-level paths, and the project paths come back as `null` rather than
 * pointing at the plugin's own process directory.
 *
 * @param {{ home: string, cwd?: string|null, dataFolderName: string }} input
 */
export function memoryLayout({ home, cwd, dataFolderName }) {
  const folder = dataFolderName || DEFAULT_DATA_FOLDER
  const projectRoot = cwd ? join(cwd, folder) : null
  const projectMemoryDir = projectRoot ? join(projectRoot, PROJECT_MEMORY_FOLDER) : null

  return {
    home,
    userMemory: join(home, 'MEMORY.md'),
    userProfile: join(home, 'USER.md'),
    identity: join(home, 'IDENTITY.md'),
    soul: join(home, 'SOUL.md'),
    cloudMemoryDir: join(home, PROJECT_MEMORY_FOLDER),
    projectRoot,
    projectMemoryDir,
    projectMemory: projectMemoryDir ? join(projectMemoryDir, 'MEMORY.md') : null,
  }
}

/**
 * Candidate profile files (`USER.md`-shaped) a WorkBuddy account may own.
 *
 * WorkBuddy keeps a copy at the home root and another under
 * `user-<uid>-personal/`. More than one candidate without an explicit choice is
 * ambiguity, not a hint to guess.
 *
 * @param {string} home - WorkBuddy home.
 * @returns {string[]} absolute candidate paths, sorted.
 */
export function listProfileCandidates(home) {
  const candidates = []
  const rootProfile = join(home, 'USER.md')
  if (existsSync(rootProfile)) candidates.push(rootProfile)

  let entries = []
  try {
    entries = readdirSync(home, { withFileTypes: true })
  } catch {
    return candidates
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('user-') || !entry.name.endsWith('-personal')) continue
    const profile = join(home, entry.name, 'USER.md')
    if (existsSync(profile)) candidates.push(profile)
  }

  return candidates.sort()
}

/** Extract the account uid from a `user-<uid>-personal` directory name. */
export function uidFromPersonalDir(dir) {
  const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const match = /^user-(.+)-personal$/.exec(name)
  return match ? match[1] : ''
}
