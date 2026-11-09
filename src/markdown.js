/**
 * Markdown surgery that touches only the lines it means to.
 *
 * Everything here preserves the original bytes: line endings, blank lines,
 * trailing whitespace outside the edited span. Memory files are shared with
 * another editor, so a rewrite that "normalizes" the file is a merge conflict
 * waiting to happen.
 */

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/

/** Dominant line ending of a document. */
export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/**
 * Split into lines, keeping each line's terminator.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (!text) return []
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * Locate level-2..6 headings, ignoring anything inside a fenced code block.
 *
 * @param {string} text
 * @returns {{ heading: string, level: number, line: number, endLine: number, start: number, end: number }[]}
 */
export function parseSections(text) {
  const lines = splitLines(text)
  const sections = []
  let fence = null
  let offset = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const body = line.replace(/\r?\n$/, '')

    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(body)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0].repeat(3)
      else if (fenceMatch[1].startsWith(fence)) fence = null
      offset += line.length
      continue
    }

    if (!fence) {
      const match = HEADING.exec(body)
      if (match && match[1].length >= 2) {
        sections.push({
          heading: match[2].trim(),
          level: match[1].length,
          line: index,
          endLine: lines.length - 1,
          start: offset,
          end: text.length,
        })
      }
    }
    offset += line.length
  }

  for (let index = 0; index < sections.length; index += 1) {
    const current = sections[index]
    const next = sections.slice(index + 1).find((candidate) => candidate.level <= current.level)
    if (next) {
      current.endLine = next.line - 1
      current.end = next.start
    }
  }

  return sections
}

/** Find one section by heading text (exact, then case-insensitive). */
export function findSection(text, heading) {
  const sections = parseSections(text)
  const wanted = String(heading ?? '').trim()
  return sections.find((section) => section.heading === wanted) ?? sections.find((section) => section.heading.toLowerCase() === wanted.toLowerCase()) ?? null
}

/**
 * Append one bullet to a section, creating the section when missing.
 *
 * @param {string} text - current document.
 * @param {string} heading - section heading without `##`.
 * @param {string} line - entry text without the leading `- `.
 * @returns {{ text: string, created: boolean }}
 */
export function appendToSection(text, heading, line) {
  const eol = detectEol(text)
  const entry = `- ${line.trim()}`
  const section = findSection(text, heading)

  if (!section) {
    const head = text.length === 0 ? '' : text.endsWith('\n') ? text : text + eol
    const spacer = head.length === 0 ? '' : eol
    return { text: `${head}${spacer}## ${heading}${eol}${eol}${entry}${eol}`, created: true }
  }

  const lines = splitLines(text)
  let insertAt = section.endLine

  // Walk back over trailing blank lines so the entry joins the list.
  while (insertAt > section.line) {
    const body = lines[insertAt].replace(/\r?\n$/, '')
    if (body.trim() !== '') break
    insertAt -= 1
  }

  const target = lines[insertAt] ?? ''
  const withEol = target.endsWith('\n') ? target : target + eol
  lines[insertAt] = withEol
  lines.splice(insertAt + 1, 0, `${entry}${eol}`)

  return { text: lines.join(''), created: false }
}

/**
 * Replace or remove the one entry matching `match`.
 *
 * @param {string} text
 * @param {string} heading
 * @param {string} match - literal text (or `literal`, see options) identifying the entry.
 * @param {{ replacement?: string, mode?: 'replace'|'remove', all?: boolean }} options
 * @returns {{ text: string, replaced: number, lines: number[] }}
 */
export function editEntry(text, heading, match, options = {}) {
  const mode = options.mode ?? 'replace'
  const section = findSection(text, heading)
  if (!section) return { text, replaced: 0, lines: [], reason: 'no_section' }

  const lines = splitLines(text)
  const hits = []
  for (let index = section.line + 1; index <= section.endLine; index += 1) {
    const body = lines[index].replace(/\r?\n$/, '')
    if (!body.trim()) continue
    if (body.includes(match)) hits.push(index)
  }

  if (hits.length === 0) return { text, replaced: 0, lines: [], reason: 'no_match' }
  if (hits.length > 1 && options.all !== true) return { text, replaced: 0, lines: hits, reason: 'ambiguous' }

  const eol = detectEol(text)
  const targets = options.all === true ? hits : [hits[0]]

  for (const index of targets) {
    if (mode === 'remove') {
      // Keep the terminator so a removal shrinks the line, not the file's shape.
      lines[index] = lines[index].endsWith('\n') ? eol : ''
    } else {
      const body = lines[index].replace(/\r?\n$/, '')
      const indent = /^([ \t]*)/.exec(body)[1]
      const replacement = String(options.replacement ?? '').trim()
      lines[index] = `${indent}${replacement}${eol}`
    }
  }

  return { text: lines.join(''), replaced: targets.length, lines: targets }
}

/** Ensure a document ends with exactly one line ending, for append-only files. */
export function ensureTrailingEol(text) {
  if (!text) return ''
  return text.endsWith('\n') ? text : text + detectEol(text)
}

/** Count `- ` entries under one section. */
export function countEntries(text, heading) {
  const section = findSection(text, heading)
  if (!section) return 0
  const lines = splitLines(text).slice(section.line + 1, section.endLine + 1)
  return lines.filter((line) => /^[ \t]*[-*][ \t]+\S/.test(line)).length
}
