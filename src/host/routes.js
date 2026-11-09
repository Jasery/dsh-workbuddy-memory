/**
 * Read-only HTTP routes for the browser panel.
 *
 * The panel is a separate surface from the tools: it has no execution context,
 * so it cannot ask "which project". It reads whatever working directory the last
 * prompt assembly saw, which is the same project the chat is talking about.
 *
 * Everything here is read-only. Nothing accepts a path: targets are an enum and
 * dates are `YYYY-MM-DD`, so a stale panel or a hostile page cannot turn this
 * into a file browser.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { probeEnvironment, ageInDays } from '../env.js'
import { parseSections } from '../markdown.js'
import { readTextSafe } from '../fsx.js'
import { contentRevision } from '../write/fslock.js'
import { resolveTarget, TARGETS } from '../write/store.js'

const PREFIX = '/workbuddy-memory'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 262144

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

/** Backup files, newest first, so the panel can offer a restore hint. */
function listBackups(stateDir) {
  const dir = join(stateDir, 'backups')
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .map((name) => ({ name, stat: statSafe(join(dir, name)) }))
    .filter((row) => row.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, 20)
    .map((row) => ({ name: row.name, bytes: row.stat.size, mtime: row.stat.mtimeMs }))
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
 * @returns {boolean} whether routes were registered.
 */
export function registerRoutes(ctx, { cfg, recent, stateDir, version }) {
  const server = ctx.webServer
  if (!server || typeof server.register !== 'function') return false

  const probeNow = () => probeEnvironment({ cfg, cwd: recent.cwd ?? null, detail: true })

  const state = () => {
    const probe = probeNow()
    return {
      ok: true,
      version,
      cwd: recent.cwd ?? null,
      readOnly: cfg.readOnly,
      writeEnabled: cfg.write.enabled,
      limits: cfg.inject.limits,
      home: { path: probe.home.path, source: probe.home.source, detail: probe.home.detail },
      stores: {
        project: {
          dir: probe.layout.projectMemoryDir,
          memory: probe.project.memoryPath,
          exists: probe.project.exists,
          memoryExists: probe.project.memoryExists,
          bytes: probe.project.memoryBytes,
          writable: probe.project.writable,
          daily: listDaily(probe.layout.projectMemoryDir),
        },
        user: {
          memory: probe.user.memoryPath,
          exists: probe.user.memoryExists,
          memoryExists: probe.user.memoryExists,
          bytes: probe.user.memoryBytes,
        },
        profile: {
          path: probe.profile.path,
          exists: probe.profile.exists,
          bytes: probe.profile.bytes,
          ambiguous: Boolean(probe.profile.ambiguous),
        },
      },
      backups: listBackups(stateDir),
    }
  }

  const content = (target, date) => {
    const probe = probeNow()
    // The profile file is read-only in this plugin (a distillation pass owns
    // it), so it is not one of the write targets. It still needs to be viewable.
    const resolved =
      target === 'profile'
        ? probe.profile.path
          ? { path: probe.profile.path }
          : { path: null, error: probe.profile.ambiguous ? 'ambiguous_profile' : 'no_profile' }
        : resolveTarget(target, probe, date)
    if (!resolved.path) return { ok: false, code: resolved.error ?? 'unknown_target', targets: TARGETS }
    if (!existsSync(resolved.path)) return { ok: false, code: 'not_found', path: resolved.path }

    const file = readTextSafe(resolved.path, { maxBytes: MAX_BODY_BYTES })
    if (!file.ok) return { ok: false, code: 'unreadable', path: resolved.path, error: file.error }

    const truncated = file.text.length > MAX_TEXT_CHARS
    const text = truncated ? file.text.slice(0, MAX_TEXT_CHARS) : file.text
    const sections = parseSections(text).map((section) => ({
      heading: section.heading,
      level: section.level,
      line: section.line + 1,
      entries: text
        .slice(section.start, section.end)
        .split(/\r?\n/)
        .filter((line) => /^[ \t]*[-*][ \t]+\S/.test(line)).length,
    }))

    return {
      ok: true,
      target,
      path: resolved.path,
      bytes: file.bytes,
      revision: contentRevision(file.text),
      truncated,
      sections,
      text,
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

            if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'read_only_surface' })

            if (route === '/state') return send(res, 200, state())

            if (route === '/content') {
              const target = url.searchParams.get('target') ?? ''
              const date = url.searchParams.get('date') ?? undefined
              if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return send(res, 400, { ok: false, code: 'bad_date' })
              }
              const body = content(target, date)
              return send(res, body.ok ? 200 : 404, body)
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
