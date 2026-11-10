import assert from 'node:assert/strict'
import test from 'node:test'

import { allEntries, editEntryAt, removeLines, appendToSection, countEntries, editEntry, ensureTrailingEol, findSection, parseSections, splitLines } from '../src/markdown.js'

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

test('remove blanks the line and keeps the file shape', () => {
  const result = editEntry(BASE, '项目', 'DSH 插件', { mode: 'remove' })
  assert.equal(result.replaced, 1)
  assert.equal(result.text, BASE.replace('- DSH 插件\n', '\n'))
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
  assert.equal(removal.text, '## A\n- one\n\n')
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
