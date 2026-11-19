const CORE_HEADINGS = new Set(['常驻记忆', 'core memory'])

/**
 * Parse one memory file without changing its original text.
 *
 * Only the core section has to be a list of entries. It is the part that is
 * injected every turn and cut to a budget, so it has to be measurable and
 * trimmable entry by entry. A topic section is read whole through
 * `memory_read(section=…)` and only its heading reaches the prompt, so prose,
 * `###` sub-headings and fenced code inside one are *content*, not a structural
 * defect. Requiring topics to be bullet-only made one code block in one section
 * force the entire file back to whole-file injection — the split a person had
 * already written was ignored because of a detail that only affects how the
 * section is read, not whether it can be.
 *
 * What still counts as unsplit: no core heading, more than one, or a core that
 * is not entries. Those are the cases where the always-on half genuinely cannot
 * be determined, and they report where the file went wrong so the person is not
 * left hunting for it.
 *
 * The result shape is stable — `analyzeMemory` returns `problem: null` when
 * nothing is wrong — because tests and the panel read it as one record.
 *
 * @param {string} text - the file's current text.
 * @returns {{ mode: 'layered'|'legacy', reason: string|null, coreHeading: string|null, coreEntries: Array<{text: string}>, topics: Array<{heading: string|null, entries: Array<{text: string}>}>, problem: {section?: string|null, line?: number, lines?: number[]}|null }}
 */
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
  if (cores.length === 0) return legacy('missing_core')
  if (cores.length > 1) {
    // Every position, not just the first: with two candidates the reader's job
    // is to decide which one to keep, and that needs both addresses.
    const numbered = cores.map((item) => item.line + 1)
    return legacy('ambiguous_core', { section: cores[0].heading, line: numbered[0], lines: numbered })
  }

  const sections = headings.map((heading, index) => ({ ...heading, end: headings[index + 1]?.line ?? lines.length }))
  const core = sections.find((item) => item.line === cores[0].line)
  const parsedCore = parseEntries(lines.slice(core.bodyStart, core.end))
  if (!parsedCore.ok) {
    return legacy('invalid_core', { section: core.heading, line: core.bodyStart + parsedCore.badLine + 1 })
  }
  const topics = []
  const preamble = lines.slice(0, sections[0]?.line ?? lines.length).filter((line) => !/^#\s+/.test(line) && line.trim())
  if (preamble.length) topics.push({ heading: null, entries: [{ text: preamble.join('\n') }] })
  for (const section of sections) {
    if (section === core || CORE_HEADINGS.has(section.heading.toLocaleLowerCase())) continue
    const body = lines.slice(section.bodyStart, section.end)
    // An empty heading is not a topic: it has nothing to read and nothing to
    // count, and listing it in the directory would be a name pointing at air.
    if (!body.some((line) => line.trim())) continue
    const parsed = parseEntries(body)
    // A body that is not entries stays one block: the text is kept exactly as
    // written (minus the blank lines at either end) so the size the panel
    // reports is the size the section really carries.
    topics.push({ heading: section.heading, entries: parsed.ok ? parsed.entries : [{ text: body.join('\n').trim() }] })
  }
  return { mode: 'layered', reason: null, coreHeading: core.heading, coreEntries: parsedCore.entries, topics, problem: null }
}

/**
 * Read a section body as entries, and say where it stopped being one.
 *
 * The line number is what makes the failure actionable, so the caller needs the
 * index of the offending line rather than a bare false.
 *
 * @param {string[]} lines - the section body, without its heading.
 * @returns {{ ok: true, entries: Array<{text: string}> } | { ok: false, entries: [], badLine: number }}
 */
function parseEntries(lines) {
  const entries = []
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    if (/^\s*-\s+\S/.test(line)) {
      if (current) entries.push(current)
      current = { text: line.replace(/^\s*-\s+/, '') }
    } else if (current && /^\s{2,}\S/.test(line)) {
      current.text += `\n${line.trim()}`
    } else {
      return { ok: false, entries: [], badLine: index }
    }
  }
  if (current) entries.push(current)
  return { ok: true, entries }
}

function legacy(reason, problem = null) {
  return { mode: 'legacy', reason, coreHeading: null, coreEntries: [], topics: [], problem }
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
 * become on-demand. `problem` is the only piece of the parse kept beyond those
 * counts: a section heading and a line number are what the panel needs to point
 * at the place the file went wrong, and a heading is not the memory.
 *
 * @param {string} text - the file's current text.
 * @returns {{ mode: 'layered'|'legacy', reason: string|null, problem: {section?: string|null, line?: number, lines?: number[]}|null, coreEntries: number, topics: number, coreChars: number, topicChars: number }}
 */
export function summarizeMemory(text) {
  const source = String(text ?? '')
  const parsed = analyzeMemory(source)
  if (parsed.mode === 'legacy') {
    // Nothing is split, so the whole file is always-on and nothing is on demand.
    return { mode: 'legacy', reason: parsed.reason, problem: parsed.problem, coreEntries: 0, topics: 0, coreChars: source.length, topicChars: 0 }
  }
  const coreChars = parsed.coreEntries.reduce((sum, entry) => sum + entry.text.length + 3, 0)
  const topicChars = parsed.topics.reduce(
    (sum, topic) => sum + topic.entries.reduce((inner, entry) => inner + entry.text.length + 3, 0),
    0,
  )
  return { mode: 'layered', reason: null, problem: null, coreEntries: parsed.coreEntries.length, topics: parsed.topics.length, coreChars, topicChars }
}
