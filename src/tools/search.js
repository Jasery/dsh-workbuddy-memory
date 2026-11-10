/** `memory_search`: find lines across the memory files without loading them all into context. */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { probeEnvironment } from '../env.js'
import { readTextSafe } from '../fsx.js'
import { resolveCwd } from '../inject.js'
import { parseSections } from '../markdown.js'

/**
 * @param {object} deps
 * @param {object} deps.cfg
 */
export function searchTool({ cfg }) {
  return defineTool({
    name: 'memory_search',
    description:
      'Search WorkBuddy memory files for a literal string (case-insensitive) and return matching lines with their file, section and line number. Use this before reading a whole file.',
    parameters: {
      query: { type: 'string', required: true, description: 'literal text to look for' },
      scope: { type: 'string', description: 'project (default) | user | all' },
      limit: { type: 'number', description: 'maximum hits (default from config, 8)' },
      includeDaily: { type: 'boolean', description: 'also search daily notes (default true)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      // The config card says this switch decides whether memory_search works, so
      // it has to be read here: a key that changes nothing is worse than no key.
      if (!cfg.search.enabled) return { ok: false, code: 'search_disabled' }

      const probe = probeEnvironment({ cfg, cwd: resolveCwd({ agent: exec?.agent }) ?? null, detail: true })
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, code: 'empty_query' }

      const scope = ['project', 'user', 'all'].includes(String(args.scope)) ? String(args.scope) : 'project'
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Number(args.limit))) : cfg.search.maxResults
      const includeDaily = args.includeDaily !== false

      const files = collectFiles(probe, scope, includeDaily)
      const hits = []
      const needle = query.toLowerCase()

      for (const file of files) {
        const read = readTextSafe(file.path, { maxBytes: cfg.search.indexMaxFileBytes })
        if (!read.ok) continue
        const sections = parseSections(read.text)
        const lines = read.text.split(/\r?\n/)
        let sectionIndex = -1

        for (let index = 0; index < lines.length; index += 1) {
          while (sectionIndex + 1 < sections.length && sections[sectionIndex + 1].line <= index) sectionIndex += 1
          const line = lines[index]
          if (!line.toLowerCase().includes(needle)) continue
          hits.push({
            file: file.label,
            path: file.path,
            line: index + 1,
            section: sectionIndex >= 0 ? sections[sectionIndex].heading : null,
            text: line.trim(),
          })
          if (hits.length >= limit) break
        }
        if (hits.length >= limit) break
      }

      return { ok: true, query, files: files.length, hits, truncated: hits.length >= limit }
    },
  })
}

/** Files to scan, most specific first. */
function collectFiles(probe, scope, includeDaily) {
  const files = []

  if (scope === 'project' || scope === 'all') {
    if (probe.project.memoryExists) {
      files.push({ path: probe.project.memoryPath, label: 'project/MEMORY.md' })
    }
    if (includeDaily) {
      for (const daily of probe.project.dailyFiles) {
        if (daily.name === 'MEMORY.md') continue
        files.push({ path: join(probe.project.dir, daily.name), label: `project/${daily.name}` })
      }
    }
  }

  if (scope === 'user' || scope === 'all') {
    if (probe.user.memoryExists) files.push({ path: probe.user.memoryPath, label: 'user/MEMORY.md' })
    if (probe.profile.exists && !probe.profile.ambiguous) files.push({ path: probe.profile.path, label: 'user/PROFILE.md' })
    const cloudDir = probe.layout.cloudMemoryDir
    if (existsSync(cloudDir)) {
      try {
        for (const name of readdirSync(cloudDir)) {
          if (!name.endsWith('_memory.md')) continue
          files.push({ path: join(cloudDir, name), label: `user/${name}` })
        }
      } catch {
        // A missing or unreadable directory just means fewer hits.
      }
    }
  }

  return files
}
