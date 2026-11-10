/**
 * HTTP routes for the browser panel.
 *
 * The panel is a separate surface from the tools: it has no execution context,
 * so it cannot ask "which project". It reads whatever working directory the last
 * prompt assembly saw, which is the same project the chat is talking about.
 *
 * Read routes take no path: targets are an enum and dates are `YYYY-MM-DD`, so a
 * stale panel or a hostile page cannot turn this into a file browser.
 *
 * The one write route (`POST /action`) is off unless `ui.allowWriteActions` is
 * on, and it does not write anything itself — every action lands in the same
 * `store` used by the tools, with the same lock, CAS, backup and ledger.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { probeEnvironment, ageInDays } from '../env.js'
import { parseSections } from '../markdown.js'
import { readTextSafe } from '../fsx.js'
import { contentRevision } from '../write/fslock.js'
import { ACTIONS, resolveTarget, TARGETS } from '../write/store.js'

const PREFIX = '/workbuddy-memory'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 262144
/** A panel request is a few hundred bytes; anything larger is not a panel. */
const MAX_ACTION_BYTES = 64 * 1024

/** JSON response with the headers a live panel needs. */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Only answer same-origin pages and non-browser clients that send no Origin. */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Daily file rows with size and age, newest first. */
function listDaily(dir, now = Date.now()) {
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
    .map((name) => {
      const date = name.slice(0, 10)
      const stat = statSafe(join(dir, name))
      return { name, date, bytes: stat?.size ?? 0, ageDays: ageInDays(date, now) }
    })
}

function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/**
 * Shape one document for the panel: section list, entries with line numbers,
 * byte count, revision. The panel renders rows by line, so it can name exactly
 * the row a person clicked instead of quoting text that may repeat.
 */
function describe(path, limit = MAX_TEXT_CHARS) {
  if (!path || !existsSync(path)) return null
  const file = readTextSafe(path, { maxBytes: MAX_BODY_BYTES })
  if (!file.ok) return { path, exists: true, readable: false, error: file.error, bytes: 0, entries: 0, sections: [] }

  const truncated = file.text.length > limit
  const text = truncated ? file.text.slice(0, limit) : file.text
  const lines = text.split(/\r?\n/)
  // Entries are collected from each section's own line range rather than by
  // heading text: two sections can share a heading, and the panel must render
  // the rows that are actually there.
  const sections = parseSections(text).map((section) => {
    const entries = []
    for (let index = section.line + 1; index <= section.endLine; index += 1) {
      const match = /^([ \t]*)[-*][ \t]+(\S.*)$/.exec(lines[index] ?? '')
      if (match) entries.push({ line: index, text: match[2].trim() })
    }
    return { heading: section.heading, level: section.level, line: section.line, endLine: section.endLine, entries }
  })
  return {
    path,
    exists: true,
    readable: true,
    bytes: file.bytes,
    revision: contentRevision(text),
    truncated,
    text,
    entries: sections.reduce((sum, section) => sum + section.entries.length, 0),
    sections,
    mtime: statSafe(path)?.mtimeMs ?? null,
  }
}

/** Read a request body with a hard cap, so a stuck client cannot pin memory. */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        done({ ok: false, code: 'body_too_large' })
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        done({ ok: true, value: raw ? JSON.parse(raw) : {} })
      } catch {
        done({ ok: false, code: 'bad_json' })
      }
    })
    req.on('error', () => done({ ok: false, code: 'bad_request' }))
  })
}

/** HTTP status for a refusal code. */
function statusFor(body) {
  if (body.ok) return 200
  switch (body.code) {
    case 'conflict':
      return 409
    case 'read_only':
    case 'write_disabled':
    case 'write_actions_disabled':
      return 403
    case 'not_found':
    case 'no_store':
    case 'no_revision':
      return 404
    case 'lock_timeout':
      return 423
    default:
      return 400
  }
}

/**
 * Register the panel routes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {{ cwd: string|null }} deps.recent - working directory of the last assembly.
 * @param {string} deps.stateDir
 * @param {string} deps.version
 * @param {object} [deps.store] - the write path; without it `/action` is refused.
 * @returns {boolean} whether routes were registered.
 */
export function registerRoutes(ctx, { cfg, recent, stateDir, version, store }) {
  const server = ctx.webServer
  if (!server || typeof server.register !== 'function') return false

  /** Stable, non-reversible handle for a workspace path. */
  const keyFor = (cwd) => createHash('sha1').update(String(cwd)).digest('hex').slice(0, 8)

  /** Every workspace this plugin has assembled a prompt for, newest first. */
  const projects = () => {
    const seen = recent?.seen instanceof Map ? [...recent.seen.entries()] : []
    if (recent?.cwd && !seen.some(([cwd]) => cwd === recent.cwd)) seen.push([recent.cwd, Date.now()])
    return seen
      .sort((a, b) => b[1] - a[1])
      .map(([cwd, at]) => {
        const memoryDir = join(cwd, cfg.dataFolderName || '.workbuddy', 'memory')
        let daily = 0
        try {
          daily = readdirSync(memoryDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).length
        } catch {
          daily = 0
        }
        return {
          key: keyFor(cwd),
          path: cwd,
          name: basename(cwd) || cwd,
          lastSeenAt: at,
          current: cwd === recent?.cwd,
          hasMemory: existsSync(join(memoryDir, 'MEMORY.md')),
          daily,
        }
      })
  }

  /**
   * Which workspace a request is about.
   *
   * A `project` key is only honoured when this plugin has seen that workspace
   * during a prompt assembly — the set is finite and lived, so it cannot be
   * used to read an arbitrary path.
   */
  const pickCwd = (key) => {
    if (!key) return { ok: true, cwd: recent?.cwd ?? null }
    if (key === keyFor(recent?.cwd ?? '')) return { ok: true, cwd: recent.cwd }
    if (recent?.seen instanceof Map) {
      for (const cwd of recent.seen.keys()) if (keyFor(cwd) === key) return { ok: true, cwd }
    }
    return { ok: false }
  }

  const probeNow = (cwd) => probeEnvironment({ cfg, cwd, detail: true })

  /** Path for a target, without touching the file system. */
  const pathFor = (target, date, probe) =>
    target === 'profile' ? probe.profile.path : resolveTarget(target, probe, date).path

  const backupSummary = (probe) => {
    if (!store?.listRevisions) return { count: 0, latest: null }
    let count = 0
    let latest = null
    for (const target of TARGETS) {
      const path = pathFor(target, undefined, probe)
      if (!path) continue
      const rows = store.listRevisions(path)
      count += rows.length
      if (rows[0]) latest = Math.max(latest ?? 0, rows[0].mtime)
    }
    return { count, latest }
  }

  const state = (cwd) => {
    const probe = probeNow(cwd)
    const project = describe(probe.project.memoryPath)
    const user = describe(probe.user.memoryPath)
    return {
      ok: true,
      version,
      cwd: cwd ?? null,
      projects: projects(),
      readOnly: cfg.readOnly,
      writeEnabled: cfg.write.enabled,
      allowWriteActions: cfg.ui.allowWriteActions,
      allowFullTextEdit: cfg.ui.allowFullTextEdit,
      limits: cfg.inject.limits,
      dailyLimitHint: cfg.write.backupKeep,
      dataFolderName: cfg.dataFolderName || '.workbuddy',
      home: { path: probe.home.path, source: probe.home.source, detail: probe.home.detail },
      stores: {
        project: {
          target: 'project-memory',
          dir: probe.layout.projectMemoryDir,
          memory: probe.project.memoryPath,
          exists: probe.project.exists,
          memoryExists: probe.project.memoryExists,
          bytes: probe.project.memoryBytes,
          writable: probe.project.writable,
          entries: project?.entries ?? 0,
          revision: project?.revision ?? null,
          mtime: project?.mtime ?? null,
          daily: listDaily(probe.layout.projectMemoryDir),
        },
        user: {
          target: 'user-memory',
          memory: probe.user.memoryPath,
          exists: probe.user.memoryExists,
          memoryExists: probe.user.memoryExists,
          bytes: probe.user.memoryBytes,
          writable: probe.user.writable,
          entries: user?.entries ?? 0,
          revision: user?.revision ?? null,
          mtime: user?.mtime ?? null,
        },
        profile: {
          target: 'profile',
          path: probe.profile.path,
          exists: probe.profile.exists,
          bytes: probe.profile.bytes,
          ambiguous: Boolean(probe.profile.ambiguous),
          readOnly: true,
          entries: 0,
        },
      },
      backups: backupSummary(probe),
      operations: store?.operationStats ? store.operationStats() : { total: 0, conflicts: 0, lastConflictAt: null, lastCommitAt: null },
    }
  }

  const content = (target, date, cwd) => {
    const probe = probeNow(cwd)
    // The profile file is read-only in this plugin (a distillation pass owns
    // it), so it is not one of the write targets. It still needs to be viewable.
    const resolved = target === 'profile' ? { path: probe.profile.path } : resolveTarget(target, probe, date)
    if (target === 'profile' && !resolved.path) {
      return { ok: false, code: probe.profile.ambiguous ? 'ambiguous_profile' : 'no_profile' }
    }
    if (!resolved.path) return { ok: false, code: resolved.error ?? 'unknown_target', targets: TARGETS }
    if (!existsSync(resolved.path)) return { ok: false, code: 'not_found', path: resolved.path }

    const described = describe(resolved.path)
    if (!described?.readable) {
      return { ok: false, code: 'unreadable', path: resolved.path, error: described?.error }
    }
    return {
      ok: true,
      target,
      date,
      path: resolved.path,
      bytes: described.bytes,
      revision: described.revision,
      truncated: described.truncated,
      entries: described.entries,
      sections: described.sections,
      text: described.text,
      writable: target === 'profile' ? false : Boolean(cfg.write.enabled && !cfg.readOnly),
    }
  }

  /** One action, dispatched to the same store the tools use. */
  const runAction = async (input, cwd) => {
    if (!cfg.ui.allowWriteActions) return { ok: false, code: 'write_actions_disabled' }
    if (!store) return { ok: false, code: 'no_store' }

    const type = String(input?.type ?? '')
    if (!ACTIONS.includes(type)) return { ok: false, code: 'unknown_action', actions: ACTIONS }

    const probe = probeNow(cwd)
    const target = String(input?.target ?? '')
    const date = typeof input?.date === 'string' ? input.date : undefined
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, code: 'bad_date' }
    if (target && date === undefined && !TARGETS.includes(target) && target !== 'profile') {
      return { ok: false, code: 'unknown_target', targets: TARGETS }
    }
    if (target === 'profile') return { ok: false, code: 'read_only_target' }

    // Server-generated: a panel that retries a request must not look like a
    // deliberate second write of the same text.
    const operationId = `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const expectedRevision = typeof input?.expectedRevision === 'string' ? input.expectedRevision : undefined

    try {
      switch (type) {
        case 'add':
          return await store.append(
            {
              target,
              date,
              section: typeof input.section === 'string' ? input.section : undefined,
              text: String(input.text ?? ''),
              expectedRevision,
              operationId,
            },
            probe,
          )
        case 'edit':
          return await store.editAt(
            {
              target,
              section: String(input.section ?? ''),
              line: Number(input.line),
              replacement: String(input.replacement ?? ''),
              expectedRevision,
              operationId,
            },
            probe,
          )
        case 'remove':
          return await store.remove({ target, section: String(input.section ?? ''), line: Number(input.line), expectedRevision, operationId }, probe)
        case 'restore':
          return await store.restore({ target, name: String(input.name ?? ''), expectedRevision, operationId }, probe)
        case 'consolidate':
          return await store.consolidate(
            {
              beforeDays: Number(input.beforeDays ?? 30),
              dates: Array.isArray(input.dates) ? input.dates : undefined,
              dryRun: input.dryRun !== false,
              expectedRevision,
              operationId,
            },
            probe,
          )
        default:
          return { ok: false, code: 'unknown_action' }
      }
    } catch (error) {
      return { ok: false, code: 'action_failed', error: String(error?.message ?? error) }
    }
  }

  return Boolean(
    ctx.effect(() =>
      server.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (req, res) => {
          try {
            if (!sameOrigin(req)) return send(res, 403, { ok: false, code: 'cross_origin' })
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const route = url.pathname.slice(PREFIX.length) || '/'

            if (route === '/action') {
              if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed' })
              // A browser cannot send this header on a simple form post, so
              // requiring it also blocks the cheapest CSRF shape.
              const type = String(req.headers?.['content-type'] ?? '')
              if (!type.toLowerCase().startsWith('application/json')) {
                return send(res, 415, { ok: false, code: 'json_required' })
              }
              const picked = pickCwd(url.searchParams.get('project') ?? undefined)
              if (!picked.ok) return send(res, 404, { ok: false, code: 'unknown_project' })
              const body = await readBody(req, MAX_ACTION_BYTES)
              if (!body.ok) return send(res, body.code === 'body_too_large' ? 413 : 400, body)
              const result = await runAction(body.value, picked.cwd)
              return send(res, statusFor(result), result)
            }

            if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'method_not_allowed' })

            const picked = pickCwd(url.searchParams.get('project') ?? undefined)
            if (!picked.ok) return send(res, 404, { ok: false, code: 'unknown_project' })

            if (route === '/state') return send(res, 200, state(picked.cwd))

            if (route === '/content') {
              const target = url.searchParams.get('target') ?? ''
              const date = url.searchParams.get('date') ?? undefined
              if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return send(res, 400, { ok: false, code: 'bad_date' })
              }
              const body = content(target, date, picked.cwd)
              return send(res, body.ok ? 200 : 404, body)
            }

            if (route === '/revisions') {
              const target = url.searchParams.get('target') ?? ''
              if (!TARGETS.includes(target)) return send(res, 400, { ok: false, code: 'unknown_target', targets: TARGETS })
              const probe = probeNow(picked.cwd)
              const path = pathFor(target, undefined, probe)
              if (!path) return send(res, 404, { ok: false, code: 'no_store' })
              const rows = store?.listRevisions ? store.listRevisions(path) : []
              return send(res, 200, { ok: true, target, path, revisions: rows })
            }

            if (route === '/revision') {
              const target = url.searchParams.get('target') ?? ''
              const name = url.searchParams.get('name') ?? ''
              if (!TARGETS.includes(target)) return send(res, 400, { ok: false, code: 'unknown_target', targets: TARGETS })
              const probe = probeNow(picked.cwd)
              const path = pathFor(target, undefined, probe)
              if (!path) return send(res, 404, { ok: false, code: 'no_store' })
              const snapshot = store?.readRevision ? store.readRevision(path, name) : { ok: false, code: 'no_revision' }
              if (!snapshot.ok) return send(res, 404, snapshot)
              const current = describe(path)
              return send(res, 200, {
                ok: true,
                target,
                name: snapshot.name,
                text: snapshot.text,
                bytes: snapshot.bytes,
                revision: snapshot.revision,
                mtime: snapshot.mtime,
                current: current ? { text: current.text ?? null, revision: current.revision, bytes: current.bytes } : null,
              })
            }

            return send(res, 404, { ok: false, code: 'no_route' })
          } catch (error) {
            return send(res, 500, { ok: false, code: 'internal', error: String(error?.message ?? error) })
          }
        },
      }),
    ),
  )
}

/** Exported for tests: the prefix this module owns. */
export const ROUTE_PREFIX = PREFIX
