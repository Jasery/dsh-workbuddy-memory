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

/**
 * Heading of the pseudo-section that owns bullets above the first real heading.
 *
 * `parseSections` starts at level 2 on purpose (an H1 is a document title, not a
 * topic), which left bullets written directly under the H1 with no section at
 * all: they were injected and searchable but could not be edited or removed by
 * any tool. Rather than widening `parseSections` — an H1 spans the whole file,
 * so it would swallow every subsection and make `appendToSection` insert at the
 * end of the document — the top region is addressable under this name.
 */
export const TOP_SECTION = '(top)'

/** Indent width, with a tab counted as two so mixed indentation still orders. */
function indentWidth(indent) {
  let width = 0
  for (const char of indent) width += char === '\t' ? 2 : 1
  return width
}

/** Whether a line is a blank line once its terminator is removed. */
function isBlank(body) {
  return body.trim() === ''
}

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
 * Section ends are resolved with one backward pass over the heading list: a
 * section ends just before the next heading at the same or a shallower level.
 * The previous forward version re-scanned the whole tail for every heading,
 * which is quadratic — a 900 KB file blocked the event loop for 15 seconds, and
 * the panel calls this per file on a 3-second poll.
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

  // Backward pass with a stack of open headings. Walking from the end, the top
  // of the stack is always the nearest heading that follows the current one:
  // deeper headings cannot close it, so they are popped first, and whatever is
  // left at the same or a shallower level is exactly the section boundary.
  const open = []
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const current = sections[index]
    while (open.length > 0 && open[open.length - 1].level > current.level) open.pop()
    const next = open[open.length - 1]
    if (next) {
      current.endLine = next.line - 1
      current.end = next.start
    }
    open.push(current)
  }

  return sections
}

/**
 * Every section carrying one heading, exact matches first then case-insensitive.
 *
 * Duplicate headings are not hypothetical: merging two files, copy-pasting a
 * block, or two clients each creating the same section all produce them. A
 * lookup that silently returns the first one makes the second unreachable — the
 * caller reads it, edits it, and gets `no_match` with no hint that the heading
 * repeats.
 *
 * @param {string} text
 * @param {string} heading
 * @returns {{ heading: string, level: number, line: number, endLine: number, start: number, end: number }[]}
 */
export function findSections(text, heading) {
  const sections = parseSections(text)
  const wanted = String(heading ?? '').trim()
  const exact = sections.filter((section) => section.heading === wanted)
  if (exact.length > 0) return exact
  const folded = wanted.toLowerCase()
  return sections.filter((section) => section.heading.toLowerCase() === folded)
}

/**
 * Locate one section by heading text (exact, then case-insensitive).
 *
 * Returns the first match, so an existing caller keeps its old behaviour; use
 * `findSections` when the caller must know whether the heading repeats.
 *
 * @param {string} text
 * @param {string} heading
 */
export function findSection(text, heading) {
  return findSections(text, heading)[0] ?? null
}

/**
 * Resolve a section for a caller that also names a line number.
 *
 * With duplicate headings, "the section called X" is ambiguous but "the section
 * called X that contains line N" is not: the line number disambiguates without
 * asking the caller to re-read the file. Only when no match contains `line` is
 * the ordinary `resolveSection` answer used, so the error codes stay the same.
 *
 * @param {string} text
 * @param {string} heading
 * @param {number} line
 */
export function resolveSectionAt(text, heading, line) {
  if (Number.isInteger(line)) {
    const containing = findSections(text, heading).find((section) => line > section.line && line <= section.endLine)
    if (containing) return { ok: true, section: containing }
  }
  return resolveSection(text, heading)
}

/**
 * The region above the first level-2 heading, as a pseudo-section.
 *
 * Its `line` is -1 so the "first body line" is `line + 1 === 0`, which lets the
 * entry walkers in this module treat it like any other section. Only returned
 * when it actually holds a bullet: an empty header region is not a target worth
 * naming, and `no_section` is the more useful answer there.
 *
 * @param {string} text
 */
export function topSection(text) {
  const lines = splitLines(text)
  let fence = null
  let first = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const body = lines[index].replace(/\r?\n$/, '')
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(body)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0].repeat(3)
      else if (fenceMatch[1].startsWith(fence)) fence = null
      continue
    }
    if (fence) continue
    const match = HEADING.exec(body)
    if (match && match[1].length >= 2) {
      first = index
      break
    }
  }

  for (let index = 0; index < first; index += 1) {
    if (BULLET.test(lines[index].replace(/\r?\n$/, ''))) {
      return { heading: TOP_SECTION, level: 1, line: -1, endLine: first - 1, start: 0, end: lines.slice(0, first).join('').length }
    }
  }
  return null
}

/**
 * Resolve a caller's section name to exactly one section, or explain why not.
 *
 * `duplicates > 1` is a refusal, not a guess: picking the first is how the
 * second copy became unreachable in the first place, and the panel needs line
 * numbers to offer "edit that one instead".
 *
 * @param {string} text
 * @param {string} heading
 * @returns {{ ok: true, section: object } | { ok: false, reason: 'no_section' | 'ambiguous_section', duplicates?: number, lines?: number[] }}
 */
export function resolveSection(text, heading) {
  const wanted = String(heading ?? '').trim()
  const matches = findSections(text, wanted)
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous_section', duplicates: matches.length, lines: matches.map((section) => section.line) }
  }
  if (matches.length === 1) return { ok: true, section: matches[0] }

  // The top region is only addressable by its pseudo name, or by the document's
  // own title — the name a person reads at the top of the file and reasonably
  // types into `section`.
  if (wanted === TOP_SECTION) {
    const top = topSection(text)
    return top ? { ok: true, section: top } : { ok: false, reason: 'no_section' }
  }
  const top = topSection(text)
  if (top) {
    const title = splitLines(text)[0]?.replace(/\r?\n$/, '') ?? ''
    const match = HEADING.exec(title)
    if (match && match[1].length === 1 && match[2].trim().toLowerCase() === wanted.toLowerCase()) {
      return { ok: true, section: top }
    }
  }
  return { ok: false, reason: 'no_section' }
}

/**
 * Append one bullet to a section, creating the section when missing.
 *
 * Refuses an empty heading and a multi-line entry rather than writing them:
 * a whitespace heading produced a `##    ` line that no lookup could ever match
 * again, and a newline inside `line` turned one call into several entries — an
 * unindented `## ` in the text even created a section. Both are silent damage,
 * so both are errors here, not something the caller discovers later.
 *
 * @param {string} text - current document.
 * @param {string} heading - section heading without `##`.
 * @param {string} line - entry text without the leading `- `.
 * @returns {{ ok: boolean, text: string, created: boolean, reason?: string }}
 */
export function appendToSection(text, heading, line) {
  const eol = detectEol(text)
  const title = String(heading ?? '').trim()
  if (!title) return { ok: false, text, created: false, reason: 'empty_heading' }

  const raw = String(line ?? '').trim()
  if (!raw) return { ok: false, text, created: false, reason: 'empty_text' }
  if (/\r?\n/.test(raw)) return { ok: false, text, created: false, reason: 'multiline_text' }
  // A body starting with a marker would become a second bullet on one line.
  const entry = `- ${raw.replace(/^([-*])[ \t]+/, '')}`

  const resolved = resolveSection(text, title)
  if (!resolved.ok && resolved.reason === 'ambiguous_section') {
    return { ok: false, text, created: false, reason: 'ambiguous_section', lines: resolved.lines, duplicates: resolved.duplicates }
  }
  const section = resolved.ok ? resolved.section : null

  if (!section) {
    const head = text.length === 0 ? '' : text.endsWith('\n') ? text : text + eol
    const spacer = head.length === 0 ? '' : eol
    return { ok: true, text: `${head}${spacer}## ${title}${eol}${eol}${entry}${eol}`, created: true }
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

  return { ok: true, text: lines.join(''), created: false }
}

/**
 * The span of one entry: its bullet line plus every line that belongs to it.
 *
 * An entry is not one line. A wrapped bullet — the common shape in a memory file
 * written by hand or by a model — continues on indented lines, may contain blank
 * lines inside a paragraph, and may own nested sub-bullets. Treating only the
 * first line as the entry left the rest behind as orphaned text that no tool
 * could then address, delete, or even see.
 *
 * Termination is deliberately conservative:
 *  - a heading always ends the entry;
 *  - a bullet at the same or shallower indent starts a new entry;
 *  - a bullet *deeper* than the entry's own indent is a child, so it is kept;
 *  - a blank line is kept only when the line after it is still indented past the
 *    entry, so a blank line that separates two entries is not swallowed;
 *  - anything else ends it.
 *
 * @param {string[]} lines - lines with their terminators.
 * @param {number} index - 0-based index of the bullet line.
 * @returns {{ start: number, end: number } | null} null when the line is not a bullet.
 */
export function entrySpan(lines, index) {
  const body = (lines[index] ?? '').replace(/\r?\n$/, '')
  const match = BULLET.exec(body)
  if (!match) return null
  const baseIndent = indentWidth(match[1])

  let end = index
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const next = lines[cursor].replace(/\r?\n$/, '')
    if (HEADING.test(next)) break

    if (isBlank(next)) {
      // Keep the gap only when the entry resumes after it; otherwise this blank
      // line is the separator between entries and belongs to neither.
      const after = (lines[cursor + 1] ?? '').replace(/\r?\n$/, '')
      if (after === '' || HEADING.test(after)) break
      if (!/^([ \t]{2,}|\t)/.test(after) && !BULLET.test(after)) break
      if (!/^([ \t]{2,}|\t)/.test(after) && indentWidth(BULLET.exec(after)?.[1] ?? '') <= baseIndent) break
      end = cursor
      continue
    }

    const child = BULLET.exec(next)
    if (child) {
      // A deeper bullet is this entry's child; one at the same or a shallower
      // indent is the next entry.
      if (indentWidth(child[1]) > baseIndent) {
        end = cursor
        continue
      }
      break
    }

    // An indented non-bullet line is a wrapped continuation.
    if (/^([ \t]{2,}|\t)/.test(next)) {
      end = cursor
      continue
    }
    break
  }
  return { start: index, end }
}

/**
 * Whether a line is inside an entry that starts above it.
 *
 * `editEntry` must not treat a continuation line as a candidate: the caller's
 * `match` may well occur there, but the addressable thing is the entry it
 * belongs to.
 *
 * @param {string[]} lines
 * @param {number} index
 * @returns {number} the entry's start line, or -1 when `index` is not a continuation.
 */
export function continuationOwner(lines, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const body = lines[cursor].replace(/\r?\n$/, '')
    if (isBlank(body) || HEADING.test(body)) return -1
    const span = entrySpan(lines, cursor)
    if (span && index >= span.start && index <= span.end) return span.start
    if (BULLET.test(body)) return -1
  }
  return -1
}

/**
 * Drop one entry — its bullet line and every continuation line — cleanly.
 *
 * Removing only the bullet left the indented remainder behind as orphaned text
 * that no tool could address afterwards, so the whole span goes. The span is
 * spliced rather than blanked: a blanked span would leave the same column of
 * whitespace this function exists to avoid, only wider.
 *
 * @param {string[]} lines - mutable line array, terminators kept.
 * @param {number} index - 0-based line index of the entry's bullet line.
 * @param {string} eol - the document's line ending.
 * @returns {string[]} the array to keep using (splicing shortens it).
 */
function removeBulletLine(lines, index, eol) {
  const span = entrySpan(lines, index)
  if (!span) {
    lines.splice(index, 1)
    return lines
  }
  lines.splice(span.start, span.end - span.start + 1)
  return lines
}

/**
 * Tidy the blank lines a removal can leave behind, inside one line range.
 *
 * Deleting every entry of a section should not leave a growing column of empty
 * lines: consecutive blanks collapse to one. Only the given span is rewritten —
 * collapsing the whole document would rewrite bytes in sections the caller
 * never touched, which is exactly what makes a shared file conflict.
 *
 * @param {string[]} lines - lines with terminators.
 * @param {string} eol - the document's line ending.
 * @param {number} [from] - first line index that may be rewritten.
 * @param {number} [to] - last line index (inclusive) that may be rewritten.
 * @returns {string[]}
 */
function collapseBlankRuns(lines, eol, from = 0, to = lines.length - 1) {
  const start = Math.max(0, Math.min(from, lines.length))
  const end = Math.max(start - 1, Math.min(to, lines.length - 1))
  const head = lines.slice(0, start)
  const span = lines.slice(start, end + 1)
  const tail = lines.slice(end + 1)

  const out = []
  for (const raw of span) {
    const body = raw.replace(/\r?\n$/, '')
    if (body.trim() === '') {
      if (out.length === 0 || out[out.length - 1].replace(/\r?\n$/, '').trim() === '') continue
      out.push(eol)
      continue
    }
    out.push(raw.endsWith('\n') ? raw : `${raw}${eol}`)
  }

  // Only trim a trailing blank run when the span reaches the end of the file:
  // otherwise the next line belongs to another section.
  if (end === lines.length - 1) {
    while (out.length > 0 && out[out.length - 1].replace(/\r?\n$/, '').trim() === '') out.pop()
  }
  return [...head, ...out, ...tail]
}

/**
 * Rewrite one entry's body, keeping its marker, indentation and spacing.
 *
 * A caller may pass the body with or without a leading `- `: the prefix is
 * owned by the document, not by the caller, so it is re-applied here instead of
 * being taken from the replacement. Dropping it would silently demote an entry
 * to a paragraph, which every later `memory_edit` then refuses to find.
 *
 * A replacement containing newlines keeps them as continuation lines of the
 * same entry, indented to match. Writing them through verbatim turned one call
 * into several entries — a `- ` inside the text became a bullet the caller never
 * declared, and an unindented `## ` became a section. Indenting is the faithful
 * reading of "one entry whose text wraps".
 *
 * @param {string} body - the current line without its terminator.
 * @param {string} replacement - new body, optionally prefixed with `- `.
 * @param {string} eol - the document's line ending.
 * @returns {string|null} the rewritten entry without terminator, or null when empty.
 */
function rewriteBulletBody(body, replacement, eol = '\n') {
  const match = BULLET.exec(body)
  if (!match) return null
  const [, indent, marker, spacing] = match
  const raw = String(replacement ?? '').trim()
  // A bare marker is a caller that meant "no text", not an entry whose body is
  // the dash itself.
  if (/^[-*]$/.test(raw)) return null

  const segments = raw.split(/\r?\n/)
  let head = segments[0].trim()
  const prefixed = /^([-*])[ \t]+/.exec(head)
  if (prefixed) head = head.slice(prefixed[0].length).trim()
  if (!head) return null

  const rest = segments.slice(1)
  // Trailing blank lines are not part of the entry.
  while (rest.length > 0 && rest[rest.length - 1].trim() === '') rest.pop()
  if (rest.length === 0) return `${indent}${marker}${spacing}${head}`

  const pad = `${indent}  `
  const continuation = rest.map((line) => {
    // A marker on a continuation line would read as a nested entry the caller
    // never declared. It is wrapped text, so the marker goes.
    const text = line.trim().replace(/^([-*])[ \t]+/, '')
    return text === '' ? '' : `${pad}${text}`
  })
  return [`${indent}${marker}${spacing}${head}`, ...continuation].join(eol)
}

/**
 * Replace or remove the one entry matching `match`.
 *
 * Only bullet lines are candidates: prose and sub-headings inside a section are
 * not entries, and rewriting one of them is how a memory file loses its shape.
 * A match that exists only in prose is reported as `not_an_entry` rather than
 * `no_match`, so the caller learns the text is there but is not addressable.
 *
 * A match that lands on a continuation line resolves to the entry that owns it:
 * the text is genuinely there, and the addressable thing is its bullet. Reporting
 * `not_an_entry` for it — as this did — told the caller the text could not be
 * edited at all, when the entry was one line up.
 *
 * @param {string} text
 * @param {string} heading
 * @param {string} match - literal text identifying the entry.
 * @param {{ replacement?: string, mode?: 'replace'|'remove', all?: boolean }} options
 * @returns {{ text: string, replaced: number, lines: number[], reason?: string }}
 */
export function editEntry(text, heading, match, options = {}) {
  const mode = options.mode ?? 'replace'
  const resolved = resolveSection(text, heading)
  if (!resolved.ok) return { text, replaced: 0, lines: resolved.lines ?? [], reason: resolved.reason }
  const section = resolved.section

  const lines = splitLines(text)
  const hits = new Set()
  let proseHit = false
  let fence = null
  for (let index = section.line + 1; index <= section.endLine; index += 1) {
    const body = (lines[index] ?? '').replace(/\r?\n$/, '')
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(body)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0].repeat(3)
      else if (fenceMatch[1].startsWith(fence)) fence = null
      continue
    }
    if (fence) continue
    if (!body.trim()) continue
    if (!body.includes(match)) continue
    if (BULLET.test(body)) {
      hits.add(index)
      continue
    }
    // A continuation line belongs to the entry above it, so the hit is that
    // entry — not a reason to refuse.
    const owner = continuationOwner(lines, index)
    if (owner >= 0 && owner > section.line) hits.add(owner)
    else proseHit = true
  }

  const found = [...hits].sort((a, b) => a - b)
  if (found.length === 0) {
    return { text, replaced: 0, lines: [], reason: proseHit ? 'not_an_entry' : 'no_match' }
  }
  if (found.length > 1 && options.all !== true) return { text, replaced: 0, lines: found, reason: 'ambiguous' }

  const eol = detectEol(text)
  const targets = options.all === true ? found : [found[0]]

  if (mode === 'remove') {
    // Highest first, so splicing one span cannot shift the next index.
    for (const index of [...targets].sort((a, b) => b - a)) removeBulletLine(lines, index, eol)
    return {
      text: collapseBlankRuns(lines, eol, section.line, section.endLine).join(''),
      replaced: targets.length,
      lines: targets,
    }
  }

  // Validate every target before touching the document: a replace that cannot
  // produce a valid entry must not leave half of a multi-target edit applied.
  const rewrites = new Map()
  for (const index of targets) {
    const body = lines[index].replace(/\r?\n$/, '')
    const next = rewriteBulletBody(body, options.replacement, eol)
    if (next === null) return { text, replaced: 0, lines: targets, reason: 'empty_text' }
    rewrites.set(index, next)
  }

  // Replace each entry's whole span, highest first so earlier indices stay
  // valid. Leaving the old continuation lines in place was the bug: the entry
  // was rewritten but its wrapped text survived as orphans.
  for (const index of [...targets].sort((a, b) => b - a)) {
    const span = entrySpan(lines, index) ?? { start: index, end: index }
    const next = rewrites.get(index)
    const replacementLines = next.split(eol).map((line) => `${line}${eol}`)
    // The last line of a document may have no terminator; keep that shape.
    if (!lines[span.end].endsWith('\n')) replacementLines[replacementLines.length - 1] = replacementLines[replacementLines.length - 1].replace(/\r?\n$/, '')
    lines.splice(span.start, span.end - span.start + 1, ...replacementLines)
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
  const lines = splitLines(text)
  // Resolve against the section that actually contains this line. With duplicate
  // headings the first match ends above `line`, and answering `stale_line` there
  // would strand the second section entirely — the line number is exactly the
  // escape hatch a duplicate heading is supposed to have.
  const resolved = resolveSectionAt(text, heading, line)
  if (!resolved.ok) return { text, replaced: 0, lines: resolved.lines ?? [], reason: resolved.reason }
  const section = resolved.section
  if (!Number.isInteger(line) || line <= section.line || line > section.endLine) {
    return { text, replaced: 0, lines: [], reason: 'stale_line' }
  }

  const body = lines[line]?.replace(/\r?\n$/, '') ?? ''
  if (!BULLET.test(body)) return { text, replaced: 0, lines: [line], reason: 'not_an_entry' }

  const eol = detectEol(text)
  if ((options.mode ?? 'replace') === 'remove') {
    return {
      text: collapseBlankRuns(removeBulletLine(lines, line, eol), eol, section.line, section.endLine).join(''),
      replaced: 1,
      lines: [line],
    }
  }
  // The marker is the document's, not the caller's: it is preserved here so a
  // replacement written as plain text cannot demote the entry to a paragraph.
  const next = rewriteBulletBody(body, options.replacement, eol)
  if (next === null) return { text, replaced: 0, lines: [line], reason: 'empty_text' }

  const span = entrySpan(lines, line) ?? { start: line, end: line }
  const replacementLines = next.split(eol).map((entry) => `${entry}${eol}`)
  if (!lines[span.end].endsWith('\n')) replacementLines[replacementLines.length - 1] = replacementLines[replacementLines.length - 1].replace(/\r?\n$/, '')
  lines.splice(span.start, span.end - span.start + 1, ...replacementLines)
  return { text: lines.join(''), replaced: 1, lines: [line] }
}

/**
 * Bullet entries of a section with their line numbers, in document order.
 *
 * Continuation lines and nested sub-bullets are not entries of their own; they
 * belong to the bullet above them, so they are folded into that entry's `span`
 * instead of being reported as separate rows. Counting them separately is what
 * made the panel's "N entries" disagree with what a person sees.
 *
 * @param {string} text
 * @param {string} heading
 */
export function sectionEntries(text, heading) {
  const section = findSection(text, heading)
  if (!section) return []
  const lines = splitLines(text)
  const out = []
  for (let index = section.line + 1; index <= section.endLine; index += 1) {
    const body = (lines[index] ?? '').replace(/\r?\n$/, '')
    const match = /^([ \t]*)[-*][ \t]+(\S.*)$/.exec(body)
    if (!match) continue
    const span = entrySpan(lines, index)
    const end = span?.end ?? index
    out.push({ line: index, indent: match[1].length, text: match[2].trim(), endLine: end })
    // Skip the lines this entry already owns: they are its body, not entries.
    index = end
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

/**
 * Count entries under one section.
 *
 * A continuation line is not an entry: counting it inflated every section that
 * holds a wrapped bullet, which is what the panel's row counts show.
 */
export function countEntries(text, heading) {
  const section = findSection(text, heading)
  if (!section) return 0
  return sectionEntries(text, section.heading).length
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

/**
 * Lines an L2 editor may not write: headings and prose have no entry identity.
 *
 * An indented line under a bullet is that entry's continuation, not prose — the
 * editor refused multi-line entries outright, which made the L2 panel unable to
 * reproduce the very shape `memory_edit` now preserves.
 */
function sectionBodyIssues(body) {
  const issues = []
  const lines = splitLines(body)
  let ownerIndent = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r?\n$/, '')
    if (!line.trim()) continue
    if (HEADING.test(line)) {
      issues.push({ line: index + 1, text: line, code: 'heading' })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      ownerIndent = indentWidth(bullet[1])
      continue
    }
    // Indented under the entry above it: a continuation, not prose.
    if (ownerIndent >= 0 && /^([ \t]{2,}|\t)/.test(line) && indentWidth(/^([ \t]*)/.exec(line)[1]) > ownerIndent) continue
    issues.push({ line: index + 1, text: line, code: 'not_entry' })
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
  const resolved = resolveSection(text, heading)
  if (!resolved.ok) return { ok: false, text, reason: resolved.reason, lines: resolved.lines, duplicates: resolved.duplicates }
  const section = resolved.section

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
  const resolved = resolveSection(text, heading)
  if (!resolved.ok) return { ok: false, text, reason: resolved.reason, lines: resolved.lines, duplicates: resolved.duplicates }
  const section = resolved.section

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
