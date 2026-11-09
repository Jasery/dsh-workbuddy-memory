/**
 * Environment probe: what exists, what is writable, what is ambiguous.
 *
 * The probe is synchronous and cheap (a handful of `stat` calls), because the
 * injected section provider runs on every assembly and cannot await.
 */

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isWritable, statSafe } from './fsx.js'
import {
  listProfileCandidates,
  memoryLayout,
  resolveDataFolderName,
  resolveStateDir,
  resolveWorkbuddyHome,
  uidFromPersonalDir,
} from './paths.js'

const DAY_MS = 86400000

/**
 * @typedef {object} ProbeInput
 * @property {object} cfg - normalized config.
 * @property {string|null} cwd - the session working directory.
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [home]
 * @property {boolean} [detail] - list daily files too (status/tools only; the
 *   inject path skips the extra directory read).
 */

/**
 * Describe the WorkBuddy stores this session can see.
 *
 * @param {ProbeInput} input
 */
export function probeEnvironment({ cfg, cwd, env = process.env, home = homedir(), detail = false }) {
  const homeInfo = resolveWorkbuddyHome(cfg.workbuddyHome, env, home)
  const dataFolderName = resolveDataFolderName(cfg.dataFolderName, env)
  const state = resolveStateDir(cfg.stateDir, env, home)
  const layout = memoryLayout({ home: homeInfo.path, cwd: cwd ?? null, dataFolderName })

  const homeDir = statSafe(layout.home)
  const projectDir = statSafe(layout.projectMemoryDir)
  const projectMemory = statSafe(layout.projectMemory)
  const userMemory = statSafe(layout.userMemory)
  const userProfile = statSafe(layout.userProfile)

  const candidates = listProfileCandidates(layout.home)
  const profile = resolveProfile({ cfg, candidates, layout })

  const project = {
    dir: layout.projectMemoryDir,
    memoryPath: layout.projectMemory,
    exists: Boolean(projectDir),
    memoryExists: Boolean(projectMemory),
    memoryBytes: projectMemory?.size ?? 0,
    writable: Boolean(projectDir) && isWritable(layout.projectMemoryDir),
    dailyFiles: detail ? listDailyFiles(layout.projectMemoryDir) : [],
  }

  const user = {
    memoryPath: layout.userMemory,
    memoryExists: Boolean(userMemory),
    memoryBytes: userMemory?.size ?? 0,
    profilePath: layout.userProfile,
    profileExists: Boolean(userProfile),
    profileBytes: userProfile?.size ?? 0,
    writable: isWritable(layout.home),
  }

  const writable = !cfg.readOnly && (project.writable || user.writable)
  const hasAnyMemory = project.exists || user.memoryExists || profile.exists

  return {
    home: homeInfo,
    dataFolderName,
    state,
    layout,
    project,
    user,
    profile,
    writable,
    hasAnyMemory,
    status: hasAnyMemory ? (writable ? 'ok' : 'read_only') : 'no_store',
  }
}

/**
 * Pick the profile file to inject.
 *
 * Explicit config wins, then a single candidate, then the one whose uid matches
 * `profileUid`. Anything else is ambiguity and injects nothing — guessing would
 * show one account's profile to another.
 */
function resolveProfile({ cfg, candidates, layout }) {
  const explicit = cfg.inject.profileFile
  if (explicit) {
    const stat = statSafe(explicit)
    return { path: explicit, exists: Boolean(stat), bytes: stat?.size ?? 0, source: 'config', ambiguous: false }
  }

  if (candidates.length === 0) {
    return { path: null, exists: false, bytes: 0, source: 'none', ambiguous: false }
  }

  if (candidates.length === 1) {
    const stat = statSafe(candidates[0])
    return { path: candidates[0], exists: true, bytes: stat?.size ?? 0, source: 'single', ambiguous: false, uid: uidFromPersonalDir(candidates[0]) }
  }

  if (cfg.inject.profileUid) {
    const wanted = cfg.inject.profileUid
    const match = candidates.find((path) => {
      const uid = uidFromPersonalDir(path)
      return uid === wanted || path.includes(wanted)
    })
    if (match) {
      const stat = statSafe(match)
      return { path: match, exists: true, bytes: stat?.size ?? 0, source: 'uid', ambiguous: false, uid: wanted }
    }
  }

  return { path: null, exists: false, bytes: 0, source: 'ambiguous', ambiguous: true, candidates: candidates.map((path) => path.slice(layout.home.length + 1)) }
}

/** List `YYYY-MM-DD.md` daily files, newest first. */
function listDailyFiles(dir) {
  if (!dir) return []
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, date: name.slice(0, 10) }))
}

/** Days between a `YYYY-MM-DD` file date and now. */
export function ageInDays(date, now = Date.now()) {
  const parsed = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  return Math.floor((now - parsed) / DAY_MS)
}
