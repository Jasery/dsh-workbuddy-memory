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

/**
 * Rewrite or delete exactly one line, addressed by position.
 *
 * The panel renders entries with the line number it read, so it can name the
 * row it means instead of quoting text that may occur twice in a section. The
 * heading is still checked: a line number from a stale render must not land in
 * a different section after the file shifted.
 *
 * @param {string} text
 * @param {string} heading
 * @param {number} line - 0-based line index of the entry.
 * @param {{ replacement?: string, mode?: 'replace'|'remove' }} options
 * @returns {{ text: string, replaced: number, reason?: string, lines: number[] }}
 */
export function editEntryAt(text, heading, line, options = {}) {
  const section = findSection(text, heading)
  if (!section) return { text, replaced: 0, lines: [], reason: 'no_section' }
  if (!Number.isInteger(line) || line <= section.line || line > section.endLine) {
    return { text, replaced: 0, lines: [], reason: 'stale_line' }
  }

  const lines = splitLines(text)
  const body = lines[line]?.replace(/\r?\n$/, '') ?? ''
  if (!/^[ \t]*[-*][ \t]+\S/.test(body)) return { text, replaced: 0, lines: [line], reason: 'not_an_entry' }

  const eol = detectEol(text)
  if ((options.mode ?? 'replace') === 'remove') {
    lines[line] = lines[line].endsWith('\n') ? eol : ''
  } else {
    const indent = /^([ \t]*)/.exec(body)[1]
    const next = String(options.replacement ?? '').trim()
    if (!next) return { text, replaced: 0, lines: [line], reason: 'empty_text' }
    lines[line] = `${indent}${next}${eol}`
  }
  return { text: lines.join(''), replaced: 1, lines: [line] }
}

/** Bullet entries of a section with their line numbers, in document order. */
export function sectionEntries(text, heading) {
  const section = findSection(text, heading)
  if (!section) return []
  const lines = splitLines(text)
  const out = []
  for (let index = section.line + 1; index <= section.endLine; index += 1) {
    const body = (lines[index] ?? '').replace(/\r?\n$/, '')
    const match = /^([ \t]*)[-*][ \t]+(\S.*)$/.exec(body)
    if (match) out.push({ line: index, indent: match[1].length, text: match[2].trim() })
  }
  return out
}

/** Every bullet entry in the document, ignoring headings and prose. */
export function allEntries(text) {
  return splitLines(text)
    .map((raw, index) => {
      const body = raw.replace(/\r?\n$/, '')
      const match = /^([ \t]*)[-*][ \t]+(\S.*)$/.exec(body)
      return match ? { line: index, indent: match[1].length, text: match[2].trim() } : null
    })
    .filter(Boolean)
}

/**
 * Drop the given 0-based line numbers, highest first so earlier indices stay
 * valid. Blank lines left behind by a removal are dropped, and the file keeps
 * exactly one trailing newline.
 */
export function removeLines(text, lineNumbers) {
  const eol = detectEol(text)
  const lines = splitLines(text)
  for (const index of [...lineNumbers].sort((a, b) => b - a)) {
    if (index < 0 || index >= lines.length) continue
    const body = lines[index].replace(/\r?\n$/, '')
    if (body.trim() === '') continue
    lines.splice(index, 1)
  }
  // Collapse the blank runs a removal can leave between list items, and drop
  // any that end up leading the file.
  const squeezed = []
  for (const line of lines) {
    const blank = line.replace(/\r?\n$/, '').trim() === ''
    if (blank && (squeezed.length === 0 || squeezed[squeezed.length - 1].trim() === '')) continue
    squeezed.push(line.replace(/\r?\n$/, ''))
  }
  while (squeezed.length > 0 && squeezed[squeezed.length - 1].trim() === '') squeezed.pop()
  return squeezed.length === 0 ? '' : `${squeezed.join(eol)}${eol}`
}

/** Count `- ` entries under one section. */
export function countEntries(text, heading) {
  const section = findSection(text, heading)
  if (!section) return 0
  const lines = splitLines(text).slice(section.line + 1, section.endLine + 1)
  return lines.filter((line) => /^[ \t]*[-*][ \t]+\S/.test(line)).length
}
