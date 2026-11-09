/** Minimal localization for the Host side (the client bundle has its own loader). */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOCALE_DIR = fileURLToPath(new URL('../locale/', import.meta.url))
const cache = new Map()

/** Pick `zh` or `en` from config and the environment. */
export function resolveLanguage(mode, env = process.env) {
  if (mode === 'zh' || mode === 'en') return mode
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  if (/^zh/i.test(raw)) return 'zh'
  if (raw) return 'en'
  try {
    return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * Load one locale table.
 *
 * @param {'zh'|'en'} language
 * @returns {(key: string, vars?: Record<string, string|number>) => string}
 */
export function createTranslator(language) {
  const table = readTable(language)
  const fallback = readTable('en')
  return (key, vars) => {
    const template = table[key] ?? fallback[key] ?? key
    if (typeof template !== 'string') return template
    if (!vars) return template
    return template.replace(/\{(\w+)\}/g, (_match, name) => String(vars[name] ?? `{${name}}`))
  }
}

function readTable(language) {
  if (cache.has(language)) return cache.get(language)
  let table = {}
  try {
    table = JSON.parse(readFileSync(`${LOCALE_DIR}${language}.json`, 'utf8'))
  } catch {
    table = {}
  }
  cache.set(language, table)
  return table
}
