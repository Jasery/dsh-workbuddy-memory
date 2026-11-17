import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeMemory, summarizeMemory } from '../src/layers.js'

 test('accepts one empty or populated core section and complete bullet entries', () => {
  assert.deepEqual(analyzeMemory('# Memory\n\n## 常驻记忆\n\n## 偏好\n- 中文\n  续行\n'), {
    mode: 'layered', reason: null, coreHeading: '常驻记忆',
    coreEntries: [],
    topics: [{ heading: '偏好', entries: [{ text: '中文\n续行' }] }],
  })
  assert.equal(analyzeMemory('## Core Memory\n- Keep this\n\n## Notes\n- note\n').mode, 'layered')
})

test('keeps ordinary H1 preamble reachable as an unsectioned topic', () => {
  const parsed = analyzeMemory('# Memory\nA preamble note.\n\n## Core Memory\n- stable\n')
  assert.equal(parsed.mode, 'layered')
  assert.equal(parsed.topics[0].heading, null)
  assert.equal(parsed.topics[0].entries[0].text, 'A preamble note.')
})

test('rejects missing, duplicate, fenced and malformed core sections as legacy', () => {
  for (const text of [
    '## Notes\n- one\n',
    '## 常驻记忆\n- one\n\n## 常驻记忆\n- two\n',
    '```md\n## 常驻记忆\n- fake\n```\n',
    '## 常驻记忆\nprose is not a bullet\n',
  ]) assert.equal(analyzeMemory(text).mode, 'legacy')
})

test('summarizeMemory counts what stays always-on and what becomes on demand', () => {
  // The panel needs the numbers, not the text: shipping every core entry through
  // `/state` on a 3-second poll would send the whole memory file to the browser.
  const text = '# Memory\n\n## 常驻记忆\n- core one\n- core two\n\n## Alpha\n- a1\n- a2\n\n## Beta\n- b1\n'
  const summary = summarizeMemory(text)
  assert.equal(summary.mode, 'layered')
  assert.equal(summary.reason, null)
  assert.equal(summary.coreEntries, 2)
  assert.equal(summary.topics, 2)
  assert.ok(summary.coreChars > 0 && summary.coreChars < text.length, `core is a part of the file: ${summary.coreChars}`)
  assert.ok(summary.topicChars > 0, 'the on-demand part is measured too')
  assert.equal('coreEntries' in summary && Array.isArray(summary.coreEntries), false, 'no entry text is carried')
})

test('a legacy file reports its whole length as always-on and nothing on demand', () => {
  // This is the number that makes the banner worth showing: the entire file is
  // in the prompt every turn, and there is no on-demand half to offset it.
  const text = '## 旧格式\n- one\n- two\n'
  const summary = summarizeMemory(text)
  assert.equal(summary.mode, 'legacy')
  assert.equal(summary.reason, 'missing_core')
  assert.equal(summary.coreChars, text.length)
  assert.equal(summary.topicChars, 0)
  assert.equal(summary.topics, 0)
})

test('an empty file summarizes as legacy rather than crashing', () => {
  const summary = summarizeMemory('')
  assert.equal(summary.mode, 'legacy')
  assert.equal(summary.coreChars, 0)
})

