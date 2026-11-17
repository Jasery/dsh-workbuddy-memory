const CORE_HEADINGS = new Set(['常驻记忆', 'core memory'])

/** Parse one memory file without changing its original text. */
export function analyzeMemory(text) {
  const source = String(text ?? '')
  const headings = []
  const lines = source.split(/\r?\n/)
  let fence = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = null
    } else if (!fence) {
      const heading = /^(#{2})\s+(.+?)\s*#*\s*$/.exec(line)
      if (heading) headings.push({ heading: heading[2].trim(), line: index, bodyStart: index + 1 })
    }
  }
  const cores = headings.filter((item) => CORE_HEADINGS.has(item.heading.toLocaleLowerCase()))
  if (cores.length !== 1) return legacy(cores.length ? 'ambiguous_core' : 'missing_core')

  const sections = headings.map((heading, index) => ({ ...heading, end: headings[index + 1]?.line ?? lines.length }))
  const core = sections.find((item) => item.line === cores[0].line)
  const coreBody = lines.slice(core.bodyStart, core.end)
  const parsedCore = parseEntries(coreBody)
  if (!parsedCore.ok) return legacy('invalid_core')
  const topics = []
  const preamble = lines.slice(0, sections[0]?.line ?? lines.length).filter((line) => !/^#\s+/.test(line) && line.trim())
  if (preamble.length) topics.push({ heading: null, entries: [{ text: preamble.join('\n') }] })
  for (const section of sections) {
    if (section === core || CORE_HEADINGS.has(section.heading.toLocaleLowerCase())) continue
    const body = lines.slice(section.bodyStart, section.end)
    const parsed = parseEntries(body)
    if (!parsed.ok) return legacy('non_entry_content')
    if (parsed.entries.length) topics.push({ heading: section.heading, entries: parsed.entries })
  }
  return { mode: 'layered', reason: null, coreHeading: core.heading, coreEntries: parsedCore.entries, topics }
}

function parseEntries(lines) {
  const entries = []
  let current = null
  for (const line of lines) {
    if (!line.trim()) continue
    if (/^\s*-\s+\S/.test(line)) {
      if (current) entries.push(current)
      current = { text: line.replace(/^\s*-\s+/, '') }
    } else if (current && /^\s{2,}\S/.test(line)) {
      current.text += `\n${line.trim()}`
    } else {
      return { ok: false, entries: [] }
    }
  }
  if (current) entries.push(current)
  return { ok: true, entries }
}

function legacy(reason) {
  return { mode: 'legacy', reason, coreEntries: [], topics: [] }
}

/**
 * A one-line summary of how a memory file is injected, for the panel.
 *
 * `analyzeMemory` already answers this, but its result carries every core entry
 * and topic name — sending that to the panel per file per poll would ship the
 * whole memory through `/state` on a three-second timer. This keeps the shape
 * and drops the content: the panel needs to know *whether* a file is split and
 * *how much* it carries, not what it says.
 *
 * `coreChars`/`topicChars` are the numbers a person needs to decide whether the
 * split is worth doing: they are the always-on part and the part that would
 * become on-demand.
 *
 * @param {string} text - the file's current text.
 * @returns {{ mode: 'layered'|'legacy', reason: string|null, coreEntries: number, topics: number, coreChars: number, topicChars: number }}
 */
export function summarizeMemory(text) {
  const source = String(text ?? '')
  const parsed = analyzeMemory(source)
  if (parsed.mode === 'legacy') {
    // Nothing is split, so the whole file is always-on and nothing is on demand.
    return { mode: 'legacy', reason: parsed.reason, coreEntries: 0, topics: 0, coreChars: source.length, topicChars: 0 }
  }
  const coreChars = parsed.coreEntries.reduce((sum, entry) => sum + entry.text.length + 3, 0)
  const topicChars = parsed.topics.reduce(
    (sum, topic) => sum + topic.entries.reduce((inner, entry) => inner + entry.text.length + 3, 0),
    0,
  )
  return { mode: 'layered', reason: null, coreEntries: parsed.coreEntries.length, topics: parsed.topics.length, coreChars, topicChars }
}

