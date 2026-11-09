import assert from 'node:assert/strict'
import test from 'node:test'

import { appendToSection, countEntries, editEntry, ensureTrailingEol, findSection, parseSections, splitLines } from '../src/markdown.js'

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
