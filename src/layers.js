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
