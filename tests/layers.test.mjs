import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeMemory, summarizeMemory } from '../src/layers.js'

 test('accepts one empty or populated core section and complete bullet entries', () => {
  assert.deepEqual(analyzeMemory('# Memory\n\n## 常驻记忆\n\n## 偏好\n- 中文\n  续行\n'), {
    mode: 'layered', reason: null, problem: null, coreHeading: '常驻记忆',
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

test('a topic section may hold prose, sub-headings and code without undoing the split', () => {
  // Only the core is injected and cut to a budget, so only the core has to be a
  // list of entries. A topic is read whole; its shape is content, not structure.
  // Before this, one fenced block in one section put the entire file back on
  // whole-file injection even though the person had already written a core.
  const text = [
    '# Memory',
    '',
    '## 常驻记忆',
    '- stable',
    '',
    '## 主题：算法',
    '状态：已跑通。',
    '### 步骤',
    '```',
    '1. one',
    '2. two',
    '```',
    '- 一条普通条目',
    '',
  ].join('\n')
  const parsed = analyzeMemory(text)
  assert.equal(parsed.mode, 'layered')
  assert.equal(parsed.problem, null)
  assert.equal(parsed.coreEntries.length, 1)
  assert.equal(parsed.topics.length, 1)
  assert.equal(parsed.topics[0].heading, '主题：算法')
  // Not parseable as entries, so the body is kept as one block, verbatim.
  assert.equal(parsed.topics[0].entries.length, 1)
  assert.match(parsed.topics[0].entries[0].text, /### 步骤/)
  assert.match(parsed.topics[0].entries[0].text, /1\. one/)
  assert.match(parsed.topics[0].entries[0].text, /一条普通条目/)

  const summary = summarizeMemory(text)
  assert.equal(summary.mode, 'layered')
  assert.equal(summary.topics, 1)
  assert.ok(summary.topicChars > summary.coreChars, 'the rich topic stays on the on-demand side')
})

test('an empty topic heading is not listed, and an unparseable core names its line', () => {
  const empty = '## 常驻记忆\n- stable\n\n## 空小节\n\n'
  assert.equal(analyzeMemory(empty).topics.length, 0)

  // The panel needs to point at the line, not just the reason: "the core holds
  // prose" over a 40-entry file is a hunt.
  const broken = '# Memory\n\n## 常驻记忆\n- fine\nprose is not a bullet\n'
  const parsed = analyzeMemory(broken)
  assert.equal(parsed.mode, 'legacy')
  assert.equal(parsed.reason, 'invalid_core')
  assert.equal(parsed.problem.section, '常驻记忆')
  assert.equal(parsed.problem.line, 5, 'the prose line, 1-based, as the file shows it')
  assert.equal(summarizeMemory(broken).problem.line, 5, 'the summary carries the position, not the text')
})

test('duplicate core sections report every position', () => {
  const parsed = analyzeMemory('## 常驻记忆\n- one\n\n## 常驻记忆\n- two\n')
  assert.equal(parsed.reason, 'ambiguous_core')
  assert.deepEqual(parsed.problem.lines, [1, 4])
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

