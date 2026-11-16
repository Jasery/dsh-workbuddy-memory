import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeMemory } from '../src/layers.js'

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
