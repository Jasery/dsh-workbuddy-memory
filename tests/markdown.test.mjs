import assert from 'node:assert/strict'
import test from 'node:test'

import { allEntries, editEntryAt, removeLines, appendToSection, countEntries, editEntry, ensureTrailingEol, entrySpan, findSection, parseSections, resolveSection, splitLines, topSection } from '../src/markdown.js'

const BASE = ['# Memory', '', '## 偏好', '- 用简体中文', '- 避免人称代词', '', '## 项目', '- DSH 插件', ''].join('\n')

test('sections skip fenced code', () => {
  const text = ['## A', '```md', '## not a heading', '```', '## B'].join('\n')
  assert.deepEqual(
    parseSections(text).map((section) => section.heading),
    ['A', 'B'],
  )
})

test('append adds one bullet and leaves every other byte alone', () => {
  const { text, created } = appendToSection(BASE, '偏好', '不要过度乐观')
  assert.equal(created, false)
  assert.equal(text, BASE.replace('- 避免人称代词\n', '- 避免人称代词\n- 不要过度乐观\n'))
  assert.equal(countEntries(text, '偏好'), 3)
})

test('append creates a missing section at the end', () => {
  const { text, created } = appendToSection(BASE, '新小节', '一条内容')
  assert.equal(created, true)
  assert.ok(text.startsWith(BASE))
  assert.ok(text.endsWith('## 新小节\n\n- 一条内容\n'))
})

test('append keeps CRLF documents CRLF', () => {
  const crlf = BASE.replace(/\n/g, '\r\n')
  const { text } = appendToSection(crlf, '项目', '新增')
  assert.equal(text.includes('\r\n'), true)
  assert.equal(/[^\r]\n/.test(text), false)
  assert.ok(text.includes('- DSH 插件\r\n- 新增\r\n'))
})

test('append joins the list even with trailing blank lines', () => {
  const text = ['## A', '- one', '', '', '## B'].join('\n')
  const result = appendToSection(text, 'A', 'two')
  assert.equal(result.text, ['## A', '- one', '- two', '', '', '## B'].join('\n'))
})

test('edit replaces exactly one line', () => {
  const result = editEntry(BASE, '偏好', '避免人称代词', { replacement: '- 不用人称代词' })
  assert.equal(result.replaced, 1)
  assert.equal(result.text, BASE.replace('- 避免人称代词', '- 不用人称代词'))
})

test('edit refuses when the match is ambiguous', () => {
  const text = ['## A', '- same', '- same'].join('\n')
  const result = editEntry(text, 'A', 'same', { replacement: '- x' })
  assert.equal(result.replaced, 0)
  assert.equal(result.reason, 'ambiguous')
  assert.deepEqual(result.lines, [1, 2])
  assert.equal(result.text, text)
})

test('edit reports a missing section instead of writing', () => {
  const result = editEntry(BASE, '不存在', 'x', { replacement: 'y' })
  assert.equal(result.reason, 'no_section')
  assert.equal(result.text, BASE)
})

test('remove drops the row and does not leave a blank line behind', () => {
  const result = editEntry(BASE, '项目', 'DSH 插件', { mode: 'remove' })
  assert.equal(result.replaced, 1)
  // The section had one entry: removing it must not leave an empty line where
  // it stood, and the file keeps exactly one trailing line ending.
  assert.equal(result.text, BASE.replace('- DSH 插件\n', ''))
})

test('find is exact first, then case-insensitive', () => {
  assert.ok(findSection(BASE, '偏好'))
  const lower = ['## Prefs', '- x'].join('\n')
  assert.equal(findSection(lower, 'prefs')?.heading, 'Prefs')
  assert.equal(findSection(lower, 'nope'), null)
})

test('trailing eol helper does not double an existing one', () => {
  assert.equal(ensureTrailingEol('a'), 'a\n')
  assert.equal(ensureTrailingEol('a\n'), 'a\n')
  assert.equal(ensureTrailingEol('a\r\n'), 'a\r\n')
  assert.equal(ensureTrailingEol(''), '')
})

test('split keeps terminators', () => {
  assert.deepEqual(splitLines('a\nb'), ['a\n', 'b'])
  assert.deepEqual(splitLines(''), [])
})

test('editEntryAt rewrites only the addressed row', () => {
  const text = '## A\n- one\n- two\n'
  const result = editEntryAt(text, 'A', 1, { replacement: '- ONE' })
  assert.equal(result.replaced, 1)
  assert.equal(result.text, '## A\n- ONE\n- two\n')

  const removal = editEntryAt(text, 'A', 2, { mode: 'remove' })
  assert.equal(removal.text, '## A\n- one\n')
})

test('editEntryAt refuses a line that is not the entry it was told', () => {
  const text = '## A\n- one\n\n## B\n- two\n'
  assert.equal(editEntryAt(text, 'A', 3, { replacement: '- x' }).reason, 'stale_line')
  assert.equal(editEntryAt(text, 'A', 9, { replacement: '- x' }).reason, 'stale_line')
  assert.equal(editEntryAt(text, 'B', 1, { replacement: '- x' }).reason, 'stale_line')
  assert.equal(editEntryAt(text, 'missing', 1, { replacement: '- x' }).reason, 'no_section')
  assert.equal(editEntryAt('## A\n- one\n', 'A', 1, { replacement: '   ' }).reason, 'empty_text')
  assert.equal(editEntryAt('## A\nplain text\n', 'A', 1, { replacement: '- x' }).reason, 'not_an_entry')
})

test('allEntries sees bullets anywhere, with their line numbers', () => {
  const text = '# T\n\n- one\n\n## S\n- two\n  - nested\nnot a bullet\n'
  const rows = allEntries(text)
  assert.deepEqual(rows.map((row) => row.text), ['one', 'two', 'nested'])
  assert.deepEqual(rows.map((row) => row.line), [2, 5, 6])
})

test('removeLines drops rows from the bottom up and keeps one trailing eol', () => {
  const text = 'a\n- one\n- two\nb\n'
  assert.equal(removeLines(text, [2, 1]), 'a\nb\n')
  // Blank lines left where a row was removed collapse instead of piling up.
  assert.equal(removeLines('- one\n\n- two\n', [0]), '- two\n')
  assert.equal(removeLines('- one\n', [0]), '')
})

test('a replacement without a dash keeps the bullet marker', () => {
  const text = '## A\n- one\n- two\n'
  // Both clients send the entry body, not a whole line; the marker belongs to
  // the document, so a plain replacement must not demote the entry to prose.
  assert.equal(editEntry(text, 'A', 'one', { replacement: 'ONE' }).text, '## A\n- ONE\n- two\n')
  assert.equal(editEntry(text, 'A', 'one', { replacement: '- ONE' }).text, '## A\n- ONE\n- two\n')
  assert.equal(editEntryAt(text, 'A', 1, { replacement: 'ONE' }).text, '## A\n- ONE\n- two\n')
})

test('a replacement keeps the marker and indentation the entry already had', () => {
  const text = '## A\n- one\n  * child\n'
  const result = editEntry(text, 'A', 'child', { replacement: 'CHILD' })
  assert.equal(result.replaced, 1)
  assert.equal(result.text, '## A\n- one\n  * CHILD\n')
})

test('an empty replacement is refused instead of deleting the entry', () => {
  const text = '## A\n- one\n- two\n'
  for (const replacement of [undefined, '', '   ', '- ']) {
    const result = editEntry(text, 'A', 'one', { replacement })
    assert.equal(result.replaced, 0, `replacement ${JSON.stringify(replacement)} must not write`)
    assert.equal(result.reason, 'empty_text')
    assert.equal(result.text, text)
  }
  assert.equal(editEntryAt(text, 'A', 1, { replacement: '' }).reason, 'empty_text')
})

test('prose and sub-headings inside a section are not entries', () => {
  const text = '## A\n\n这一节说明：one 是常用选项。\n### one 小节\n- one\n'
  // A prose-only hit is named as such, so the caller knows the text is there.
  const prose = editEntry('## A\n\n说明：one 是常用选项。\n', 'A', 'one', { replacement: 'ONE' })
  assert.equal(prose.replaced, 0)
  assert.equal(prose.reason, 'not_an_entry')

  const heading = editEntry('## A\n### one\n- x\n', 'A', 'one', { replacement: 'ONE' })
  assert.equal(heading.replaced, 0)
  assert.equal(heading.reason, 'not_an_entry')

  // The bullet is still the one addressable target when prose also matches.
  const both = editEntry(text, 'A', 'one', { replacement: 'ONE' })
  assert.equal(both.replaced, 1)
  assert.equal(both.text, '## A\n\n这一节说明：one 是常用选项。\n### one 小节\n- ONE\n')
})

test('a fenced block inside a section is not addressable', () => {
  const text = '## A\n- one\n```\n- one in code\n```\n'
  const result = editEntry(text, 'A', 'one in code', { replacement: 'x' })
  assert.equal(result.replaced, 0)
  assert.equal(result.text, text)
})

test('all=true rewrites every matching bullet and nothing else', () => {
  const text = '## A\n- same\n说明 same\n- same\n'
  const result = editEntry(text, 'A', 'same', { replacement: 'X', all: true })
  assert.equal(result.replaced, 2)
  assert.equal(result.text, '## A\n- X\n说明 same\n- X\n')
})

test('a removal only tidies blanks inside the section it edited', () => {
  // Two blank lines separate B's entries. Editing A must not touch them: the
  // file is shared with another client, so unrelated bytes stay put.
  const text = '## A\n- a1\n- a2\n\n## B\n- b1\n\n\n- b2\n'
  const expected = '## A\n- a2\n\n## B\n- b1\n\n\n- b2\n'

  const removed = editEntry(text, 'A', 'a1', { mode: 'remove' })
  assert.equal(removed.text, expected)
  assert.ok(removed.text.includes('- b1\n\n\n- b2'), 'B keeps its own blank run')

  const atLine = editEntryAt(text, 'A', 1, { mode: 'remove' })
  assert.equal(atLine.text, expected)
  assert.ok(atLine.text.includes('- b1\n\n\n- b2'), 'B keeps its own blank run')
})

test('section ends are resolved in one pass, not by rescanning the tail', () => {
  // The panel parses every memory file on a 3-second poll; a quadratic parser
  // blocked the event loop for seconds on a large file.
  const rows = Array.from({ length: 20000 }, (_, index) => `## h${index}\n- e${index}\n`)
  const text = rows.join('')
  const started = performance.now()
  const sections = parseSections(text)
  const elapsed = performance.now() - started

  assert.equal(sections.length, 20000)
  assert.equal(sections[0].heading, 'h0')
  assert.equal(sections[19999].heading, 'h19999')
  // Flat headings: every section runs to the line before the next one.
  assert.equal(sections[0].endLine, sections[1].line - 1)
  assert.ok(elapsed < 2000, `parsing ${(text.length / 1024).toFixed(0)} KB took ${elapsed.toFixed(0)}ms`)
})

test('a nested heading ends its parent section, a deeper one does not', () => {
  const text = '## A\n- a\n### A1\n- a1\n## B\n- b\n'
  const sections = parseSections(text)
  const byName = new Map(sections.map((section) => [section.heading, section]))
  // A1 is nested inside A: it does not close A, so A runs to the line before B.
  assert.equal(byName.get('A').endLine, 3)
  assert.equal(byName.get('A1').endLine, 3)
  assert.equal(byName.get('B').endLine, 5)
})

test('entrySpan keeps wrapped lines, nested bullets and an inner blank line', () => {
  const lines = splitLines('## S\n- head\n  续行一\n\n  续行二\n  - 子条目\n- next\n')
  assert.deepEqual(entrySpan(lines, 1), { start: 1, end: 5 })
  // A blank line that separates two entries belongs to neither.
  const separated = splitLines('- one\n\n- two\n')
  assert.deepEqual(entrySpan(separated, 0), { start: 0, end: 0 })
})

test('edit replaces a whole multi-line entry', () => {
  const text = '## A\n- head\n  续行一\n  续行二\n- next\n'
  const result = editEntry(text, 'A', 'head', { replacement: '改过' })
  assert.equal(result.replaced, 1)
  assert.equal(result.text, '## A\n- 改过\n- next\n')
})

test('remove takes the continuation lines with the entry', () => {
  const text = '## A\n- head\n  续行一\n  续行二\n- next\n'
  const result = editEntry(text, 'A', 'head', { mode: 'remove' })
  assert.equal(result.text, '## A\n- next\n')
  assert.equal(result.text.includes('续行'), false, 'no orphaned continuation text')
})

test('a match on a continuation line edits the entry that owns it', () => {
  const text = '## A\n- head\n  关键词在这里\n- next\n'
  const result = editEntry(text, 'A', '关键词', { replacement: '改过' })
  assert.equal(result.replaced, 1)
  assert.equal(result.text, '## A\n- 改过\n- next\n')
})

test('a multi-line replacement stays one entry', () => {
  const text = '## A\n- one\n- two\n'
  const result = editEntry(text, 'A', 'one', { replacement: '第一行\n第二行\n- 伪装的条目' })
  assert.equal(result.replaced, 1)
  // One bullet, and the wrapped text is indented under it — not three entries.
  assert.equal(result.text, '## A\n- 第一行\n  第二行\n  伪装的条目\n- two\n')
})

test('append refuses a multi-line entry and a blank heading', () => {
  const text = '## A\n- one\n'
  assert.equal(appendToSection(text, 'A', 'x\ny').reason, 'multiline_text')
  assert.equal(appendToSection(text, '  ', 'x').reason, 'empty_heading')
  assert.equal(appendToSection(text, '', 'x').reason, 'empty_heading')
})

test('a duplicate heading is ambiguous, and a line number disambiguates it', () => {
  const text = '## 同名\n- A\n\n## 同名\n- B\n'
  assert.equal(resolveSection(text, '同名').reason, 'ambiguous_section')
  assert.deepEqual(resolveSection(text, '同名').lines, [0, 3])

  const at = editEntryAt(text, '同名', 4, { replacement: '改B' })
  assert.equal(at.replaced, 1)
  assert.equal(at.text, '## 同名\n- A\n\n## 同名\n- 改B\n')
})

test('bullets above the first H2 belong to the top section', () => {
  const text = '# 标题\n\n- 顶层\n\n## 节\n- 内层\n'
  assert.equal(parseSections(text).map((section) => section.heading).join(','), '节', 'parseSections still starts at level 2')
  assert.equal(topSection(text)?.heading, '(top)')

  const viaPseudo = editEntry(text, '(top)', '顶层', { replacement: '改过' })
  assert.equal(viaPseudo.text, '# 标题\n\n- 改过\n\n## 节\n- 内层\n')

  const viaTitle = editEntry(viaPseudo.text, '标题', '改过', { replacement: '再改' })
  assert.equal(viaTitle.text, '# 标题\n\n- 再改\n\n## 节\n- 内层\n')
})

test('countEntries does not count continuation lines as entries', () => {
  const text = '## A\n- one\n  续行\n  - 子条目\n- two\n'
  assert.equal(countEntries(text, 'A'), 2)
})

test('all=true removes every matching multi-line span, not just their first lines', () => {
  const text = '## A\n- KEY one\n  cont a\n- KEY two\n  cont b\n- keep\n'
  const result = editEntry(text, 'A', 'KEY', { mode: 'remove', all: true })
  assert.equal(result.replaced, 2)
  assert.equal(result.text, '## A\n- keep\n', 'both continuation blocks go with their entries')
})

test('all=true replaces every matching span in place', () => {
  const text = '## A\n- KEY one\n  cont a\n- KEY two\n  cont b\n- keep\n'
  const result = editEntry(text, 'A', 'KEY', { replacement: 'X', all: true })
  assert.equal(result.replaced, 2)
  assert.equal(result.text, '## A\n- X\n- X\n- keep\n')
})

test('a nested sub-bullet is not counted as a top-level entry, but is addressable', () => {
  const text = '## A\n- parent\n  - child\n- sibling\n'
  // Two top-level entries: the child belongs to `parent`'s span.
  assert.equal(countEntries(text, 'A'), 2)
  // It is still a bullet line, so it can be rewritten in place without touching
  // its parent — useful when one sub-point is wrong.
  const result = editEntry(text, 'A', 'child', { replacement: 'CHILD' })
  assert.equal(result.text, '## A\n- parent\n  - CHILD\n- sibling\n')
  // Removing it leaves the parent intact.
  const removed = editEntry(text, 'A', 'child', { mode: 'remove' })
  assert.equal(removed.text, '## A\n- parent\n- sibling\n')
})

test('a nested sub-bullet goes away with its parent entry', () => {
  const text = '## A\n- parent\n  - child\n- sibling\n'
  const result = editEntry(text, 'A', 'parent', { mode: 'remove' })
  assert.equal(result.text, '## A\n- sibling\n', 'the child must not be orphaned')
})
