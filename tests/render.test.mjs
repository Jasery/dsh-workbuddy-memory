/** Section rendering: what gets injected, in what order, and how it is trimmed. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { probeEnvironment } from '../src/env.js'
import { createTranslator } from '../src/locale.js'
import { redact, renderSections, SECTION_ORDER } from '../src/render.js'

const t = createTranslator('zh')

/**
 * Build a probe over a temporary home/workspace.
 *
 * @param {object} [options]
 * @param {string} [options.project] - project MEMORY.md body, omitted means no file.
 * @param {string} [options.user] - user MEMORY.md body.
 * @param {object} [options.config] - extra config overrides.
 */
function fixture(options = {}) {
  const { project, config = {} } = options
  const user = 'user' in options ? options.user : '- 全局一条\n'
  const root = mkdtempSync(join(tmpdir(), 'wbm-render-'))
  const home = join(root, 'home')
  const cwd = join(root, 'repo')
  mkdirSync(join(home, 'memory'), { recursive: true })
  mkdirSync(join(cwd, '.workbuddy', 'memory'), { recursive: true })

  if (project !== undefined) writeFileSync(join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), project, 'utf8')
  if (user !== undefined) writeFileSync(join(home, 'MEMORY.md'), user, 'utf8')

  const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(root, 'state'), ...config })
  const probe = probeEnvironment({ cfg, cwd, detail: true })
  return { root, home, cwd, cfg, probe }
}

const names = (sections) => sections.map((section) => section.name)

test('sections come out in fixed order', () => {
  const { cfg, probe } = fixture({ project: '## 偏好\n- 用简体中文\n' })
  const sections = renderSections({ cfg, probe, t })

  assert.deepEqual(names(sections), [
    'workbuddy-memory:project',
    'workbuddy-memory:rules',
    'workbuddy-memory:user',
  ])
  assert.deepEqual(
    sections.map((section) => section.order),
    [SECTION_ORDER.project, SECTION_ORDER.rules, SECTION_ORDER.user],
  )
  assert.equal(SECTION_ORDER.project < SECTION_ORDER.rules, true)
  assert.equal(SECTION_ORDER.rules < SECTION_ORDER.user, true)
  assert.equal(SECTION_ORDER.user < SECTION_ORDER.profile, true)
})

test('the project block carries the file body under its label', () => {
  const { cfg, probe } = fixture({ project: '## 偏好\n- 用简体中文\n' })
  const project = renderSections({ cfg, probe, t }).find((section) => section.name === 'workbuddy-memory:project')
  assert.match(project.text, /^### /)
  assert.match(project.text, /用简体中文/)
})

test('a missing or empty file contributes nothing', () => {
  const missing = fixture({ project: undefined, user: undefined })
  assert.deepEqual(names(renderSections({ cfg: missing.cfg, probe: missing.probe, t })), ['workbuddy-memory:rules'])

  const blank = fixture({ project: '   \n\n', user: '  \n' })
  assert.deepEqual(names(renderSections({ cfg: blank.cfg, probe: blank.probe, t })), ['workbuddy-memory:rules'])
})

test('per-block switches remove exactly one block', () => {
  const { cfg, probe } = fixture({ project: '## 偏好\n- a\n' })

  const noProject = normalizeConfig({ workbuddyHome: probe.home.path, inject: { project: false } })
  assert.deepEqual(names(renderSections({ cfg: noProject, probe, t })), ['workbuddy-memory:rules', 'workbuddy-memory:user'])

  const noRules = normalizeConfig({ workbuddyHome: probe.home.path, inject: { rules: false } })
  assert.deepEqual(names(renderSections({ cfg: noRules, probe, t })), ['workbuddy-memory:project', 'workbuddy-memory:user'])

  const noUser = normalizeConfig({ workbuddyHome: probe.home.path, inject: { user: false } })
  assert.deepEqual(names(renderSections({ cfg: noUser, probe, t })), ['workbuddy-memory:project', 'workbuddy-memory:rules'])
  void cfg
})

test('the rules block teaches writing, and changes wording when read-only', () => {
  const writable = fixture({ project: '## 偏好\n- a\n' })
  const rules = renderSections({ cfg: writable.cfg, probe: writable.probe, t }).find((s) => s.name === 'workbuddy-memory:rules')
  assert.match(rules.text, /memory_append/)
  assert.match(rules.text, /1\. /)

  const readOnly = fixture({ project: '## 偏好\n- a\n', config: { readOnly: true } })
  const ro = renderSections({ cfg: readOnly.cfg, probe: readOnly.probe, t }).find((s) => s.name === 'workbuddy-memory:rules')
  assert.match(ro.text, /只读/)
  assert.doesNotMatch(ro.text, /改已有条目之前先 memory_read/)
})

test('an oversized block is trimmed and says so', () => {
  const body = `## 偏好\n${'- '.concat('长'.repeat(50)).concat('\n').repeat(40)}`
  const { home, cfg } = fixture({ project: body, config: { inject: { limits: { project: 120 } } } })
  const sections = renderSections({ cfg, probe: probeEnvironment({ cfg, cwd: join(home, '..', 'repo'), detail: true }), t })
  const project = sections.find((section) => section.name === 'workbuddy-memory:project')

  assert.equal(project.text.length < body.length, true)
  assert.match(project.text, /截断|truncated|120/)
})

test('truncation never halves a surrogate pair', () => {
  const body = `## 偏好\n- ${'😀'.repeat(80)}\n`
  const { cfg, probe } = fixture({ project: body, config: { inject: { limits: { project: 20 } } } })
  const project = renderSections({ cfg, probe, t }).find((section) => section.name === 'workbuddy-memory:project')

  // Every emoji still has its low surrogate: no lone \uD83D at the cut.
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.exec(project.text)
  assert.equal(lone, null, 'a truncated block must not end on half a surrogate pair')
})

test('the home prefix is redacted, and can be turned off', () => {
  const { home, cwd, cfg } = fixture({})
  writeFileSync(join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), `## 记录\n- 在 ${join(home, 'notes')} 里\n`, 'utf8')
  const probe = probeEnvironment({ cfg, cwd, detail: true })

  const redacted = renderSections({ cfg, probe, t }).find((section) => section.name === 'workbuddy-memory:project')
  assert.equal(redacted.text.includes(home), false, 'the home prefix must not survive')
  assert.match(redacted.text, /~/)
  assert.match(redacted.text, /notes/)

  const raw = normalizeConfig({ workbuddyHome: home, inject: { sanitizePaths: false } })
  const plainProbe = probeEnvironment({ cfg: raw, cwd, detail: true })
  const project = renderSections({ cfg: raw, probe: plainProbe, t }).find((section) => section.name === 'workbuddy-memory:project')
  assert.equal(project.text.includes(home), true, 'sanitizePaths: false keeps the real path')
})

test('redact only touches the home prefix and both separators', () => {
  const home = 'C:\\Users\\me'
  assert.equal(redact(`${home}\\notes`, home), '~\\notes')
  assert.equal(redact('C:/Users/me/notes', home), '~/notes')
  assert.equal(redact('D:\\other\\notes', home), 'D:\\other\\notes')
  assert.equal(redact('no path here', home), 'no path here')
  assert.equal(redact('', home), '')
  assert.equal(redact('anything', ''), 'anything')
})

test('an ambiguous profile is reported instead of guessed', () => {
  const { root, home, cfg, probe } = fixture({ project: '## 偏好\n- a\n' })
  // Two personal dirs: the plugin cannot tell which account this is.
  mkdirSync(join(home, 'user-aaa-personal'), { recursive: true })
  mkdirSync(join(home, 'user-bbb-personal'), { recursive: true })
  writeFileSync(join(home, 'user-aaa-personal', 'USER.md'), 'A\n', 'utf8')
  writeFileSync(join(home, 'user-bbb-personal', 'USER.md'), 'B\n', 'utf8')
  void root

  const ambiguousProbe = probeEnvironment({ cfg, cwd: join(home, '..', 'repo'), detail: true })
  assert.equal(ambiguousProbe.profile.ambiguous, true)

  const sections = renderSections({ cfg, probe: ambiguousProbe, t })
  const profile = sections.find((section) => section.name === 'workbuddy-memory:profile')
  assert.ok(profile, 'the profile block should explain the ambiguity')
  assert.match(profile.text, /画像|profile/)
  assert.doesNotMatch(profile.text, /^A$|^B$/m)
  void probe
})

test('a chosen profile file is rendered', () => {
  const { home, cwd, cfg } = fixture({ project: '## 偏好\n- a\n' })
  const dir = join(home, 'user-abc-personal')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'USER.md'), '## 画像\n- 关注 AI\n', 'utf8')

  const withUid = normalizeConfig({ workbuddyHome: home, inject: { profileUid: 'abc' } })
  const probe = probeEnvironment({ cfg: withUid, cwd: join(cwd), detail: true })
  const profile = renderSections({ cfg: withUid, probe, t }).find((section) => section.name === 'workbuddy-memory:profile')
  assert.ok(profile, 'a resolved profile file should be injected')
  assert.match(profile.text, /关注 AI/)
  void cfg
})
