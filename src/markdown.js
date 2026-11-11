/**
 * Markdown surgery that touches only the lines it means to.
 *
 * Everything here preserves the original bytes: line endings, blank lines,
 * trailing whitespace outside the edited span. Memory files are shared with
 * another editor, so a rewrite that "normalizes" the file is a merge conflict
 * waiting to happen.
 */

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/
/** One bullet entry: indent, marker, spacing, body. Prose and headings do not match. */
const BULLET = /^([ \t]*)([-*])([ \t]+)(\S.*)$/

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
 * Drop one bullet line without piling up blank lines.
 *
 * A single removal keeps the line's terminator, so the file's shape survives.
 * But a second removal next to it would leave a second blank line, and a few
 * edits later the section is mostly whitespace. So a removal splices the whole
 * line out when the row above it is already blank (or it is the first line);
 * otherwise it blanks the line as before.
 *
 * @param {string[]} lines - mutable line array, terminators kept.
 * @param {number} index - 0-based line index.
 * @param {string} eol - the document's line ending.
 * @returns {string[]} the array to keep using (splicing shortens it).
 */
function removeBulletLine(lines, index, eol) {
  const previous = index > 0 ? lines[index - 1].replace(/\r?\n$/, '') : ''
  if (index === 0 || previous.trim() === '') {
    lines.splice(index, 1)
    return lines
  }
  lines[index] = lines[index].endsWith('\n') ? eol : ''
  return lines
}

/**
 * Tidy the blank lines a removal can leave behind.
 *
 * Deleting every entry of a section should not leave a growing column of empty
 * lines: consecutive blanks collapse to one, and the document keeps exactly one
 * trailing line ending. Non-blank lines are untouched byte for byte.
 *
 * @param {string[]} lines - lines with terminators.
 * @param {string} eol - the document's line ending.
 * @returns {string[]}
 */
function collapseBlankRuns(lines, eol) {
  const out = []
  for (const raw of lines) {
    const body = raw.replace(/\r?\n$/, '')
    if (body.trim() === '') {
      if (out.length === 0 || out[out.length - 1].replace(/\r?\n$/, '').trim() === '') continue
      out.push(eol)
      continue
    }
    out.push(raw.endsWith('\n') ? raw : `${raw}${eol}`)
  }
  while (out.length > 0 && out[out.length - 1].replace(/\r?\n$/, '').trim() === '') out.pop()
  return out
}

/**
 * Rewrite one bullet's body, keeping its marker, indentation and spacing.
 *
 * A caller may pass the body with or without a leading `- `: the prefix is
 * owned by the document, not by the caller, so it is re-applied here instead of
 * being taken from the replacement. Dropping it would silently demote an entry
 * to a paragraph, which every later `memory_edit` then refuses to find.
 *
 * @param {string} body - the current line without its terminator.
 * @param {string} replacement - new body, optionally prefixed with `- `.
 * @returns {string|null} the rewritten line without terminator, or null when empty.
 */
function rewriteBulletBody(body, replacement) {
  const match = BULLET.exec(body)
  if (!match) return null
  const [, indent, marker, spacing] = match
  let next = String(replacement ?? '').trim()
  // A bare marker is a caller that meant "no text", not an entry whose body is
  // the dash itself.
  if (/^[-*]$/.test(next)) return null
  const prefixed = /^([-*])[ \t]+/.exec(next)
  if (prefixed) next = next.slice(prefixed[0].length).trim()
  if (!next) return null
  return `${indent}${marker}${spacing}${next}`
}

/**
 * Replace or remove the one entry matching `match`.
 *
 * Only bullet lines are candidates: prose and sub-headings inside a section are
 * not entries, and rewriting one of them is how a memory file loses its shape.
 * A match that exists only in prose is reported as `not_an_entry` rather than
 * `no_match`, so the caller learns the text is there but is not addressable.
 *
 * @param {string} text
 * @param {string} heading
 * @param {string} match - literal text (or `literal`, see options) identifying the entry.
 * @param {{ replacement?: string, mode?: 'replace'|'remove', all?: boolean }} options
 * @returns {{ text: string, replaced: number, lines: number[], reason?: string }}
 */
export function editEntry(text, heading, match, options = {}) {
  const mode = options.mode ?? 'replace'
  const section = findSection(text, heading)
  if (!section) return { text, replaced: 0, lines: [], reason: 'no_section' }

  const lines = splitLines(text)
  const hits = []
  let proseHit = false
  let fence = null
  for (let index = section.line + 1; index <= section.endLine; index += 1) {
    const body = lines[index].replace(/\r?\n$/, '')
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(body)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0].repeat(3)
      else if (fenceMatch[1].startsWith(fence)) fence = null
      continue
    }
    if (fence) continue
    if (!body.trim()) continue
    if (!body.includes(match)) continue
    if (BULLET.test(body)) hits.push(index)
    else proseHit = true
  }

  if (hits.length === 0) {
    return { text, replaced: 0, lines: [], reason: proseHit ? 'not_an_entry' : 'no_match' }
  }
  if (hits.length > 1 && options.all !== true) return { text, replaced: 0, lines: hits, reason: 'ambiguous' }

  const eol = detectEol(text)
  const targets = options.all === true ? hits : [hits[0]]

  if (mode === 'remove') {
    // Highest first, so splicing one row cannot shift the next index.
    for (const index of [...targets].sort((a, b) => b - a)) removeBulletLine(lines, index, eol)
    return { text: collapseBlankRuns(lines, eol).join(''), replaced: targets.length, lines: targets }
  }

  // Validate every target before touching the document: a replace that cannot
  // produce a valid entry must not leave half of a multi-target edit applied.
  const rewrites = new Map()
  for (const index of targets) {
    const body = lines[index].replace(/\r?\n$/, '')
    const next = rewriteBulletBody(body, options.replacement)
    if (next === null) return { text, replaced: 0, lines: targets, reason: 'empty_text' }
    rewrites.set(index, `${next}${eol}`)
  }

  for (const [index, line] of rewrites) lines[index] = line
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
  if (!BULLET.test(body)) return { text, replaced: 0, lines: [line], reason: 'not_an_entry' }

  const eol = detectEol(text)
  if ((options.mode ?? 'replace') === 'remove') {
    return { text: collapseBlankRuns(removeBulletLine(lines, line, eol), eol).join(''), replaced: 1, lines: [line] }
  }
  // The marker is the document's, not the caller's: it is preserved here so a
  // replacement written as plain text cannot demote the entry to a paragraph.
  const next = rewriteBulletBody(body, options.replacement)
  if (next === null) return { text, replaced: 0, lines: [line], reason: 'empty_text' }
  lines[line] = `${next}${eol}`
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

/** Raw body of one section, without its heading line. */
export function sectionBody(text, heading) {
  const section = findSection(text, heading)
  if (!section) return null
  const lines = splitLines(text)
  return {
    heading: section.heading,
    level: section.level,
    line: section.line,
    endLine: section.endLine,
    body: lines.slice(section.line + 1, section.endLine + 1).join(''),
    entries: countEntries(text, section.heading),
  }
}

/** Lines an L2 editor may not write: headings and prose have no entry identity. */
function sectionBodyIssues(body) {
  const issues = []
  const lines = splitLines(body)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r?\n$/, '')
    if (!line.trim()) continue
    if (HEADING.test(line)) {
      issues.push({ line: index + 1, text: line, code: 'heading' })
      continue
    }
    if (!BULLET.test(line)) issues.push({ line: index + 1, text: line, code: 'not_entry' })
  }
  return issues
}

/**
 * Replace one section's body, keeping its heading and every other line intact.
 *
 * This is the L2 editor: a person edits the bullets of one section without
 * touching the rest of the file. Headings and prose are refused because they
 * have no entry identity, and a heading written here would split the section
 * into two and shift every line number the panel holds.
 *
 * @param {string} text
 * @param {string} heading
 * @param {string} body - the section body as typed, without the heading line.
 * @returns {{ ok: boolean, text: string, reason?: string, issues?: object[], entries?: number }}
 */
export function replaceSectionBody(text, heading, body) {
  const section = findSection(text, heading)
  if (!section) return { ok: false, text, reason: 'no_section' }

  const issues = sectionBodyIssues(body)
  if (issues.length > 0) return { ok: false, text, reason: 'invalid_body', issues }

  const eol = detectEol(text)
  const lines = splitLines(text)
  const rawLines = String(body ?? '').split(/\r?\n/)
  while (rawLines.length > 0 && rawLines[0].trim() === '') rawLines.shift()
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop()
  const bodyLines = rawLines.map((line) => `${line}${eol}`)
  // A section followed by another heading keeps exactly one blank line between
  // them; the last section of a file ends on its own line ending.
  const rest = lines.slice(section.endLine + 1)
  if (rest.length > 0) bodyLines.push(eol)
  const head = lines.slice(0, section.line + 1)
  return {
    ok: true,
    text: [...head, ...bodyLines, ...rest].join(''),
    entries: bodyLines.filter((line) => BULLET.test(line.replace(/\r?\n$/, ''))).length,
  }
}

/**
 * Remove one section, heading and body, collapsing only the blank seam it
 * leaves behind. Every other byte stays where it was.
 */
export function removeSection(text, heading) {
  const section = findSection(text, heading)
  if (!section) return { ok: false, text, reason: 'no_section' }

  const lines = splitLines(text)
  const before = lines.slice(0, section.line)
  const after = lines.slice(section.endLine + 1)
  while (before.length > 0 && before[before.length - 1].replace(/\r?\n$/, '').trim() === '') before.pop()
  let start = 0
  while (start < after.length && after[start].replace(/\r?\n$/, '').trim() === '') start += 1
  const remaining = after.slice(start)
  const kept = before.length > 0 && remaining.length > 0 ? [...before, `${detectEol(text)}`, ...remaining] : [...before, ...remaining]
  return { ok: true, text: kept.join(''), removed: section.endLine - section.line + 1 }
}

/**
 * Structure checks for the L3 source editor.
 *
 * Nothing here decides what a memory file should say; it only refuses text that
 * cannot be parsed back into the same section/entry model a later write relies
 * on.
 */
export function validateDocument(text) {
  const value = String(text ?? '')
  const issues = []
  if (value.length > 262144) issues.push({ code: 'too_large', message: 'document exceeds 256 KB' })
  if (value.includes('\u0000')) issues.push({ code: 'nul', message: 'document contains a NUL byte' })

  let fence = null
  for (const raw of splitLines(value)) {
    const line = raw.replace(/\r?\n$/, '')
    const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (!match) continue
    if (!fence) fence = match[1][0].repeat(3)
    else if (match[1].startsWith(fence)) fence = null
  }
  if (fence) issues.push({ code: 'unclosed_fence', message: 'a code fence is never closed' })

  return { ok: issues.length === 0, issues }
}
