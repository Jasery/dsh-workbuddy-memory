/** Section rendering: what gets injected, in what order, and how it is trimmed. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig, resolveDistillAbove } from '../src/config.js'
import { probeEnvironment } from '../src/env.js'
import { createTranslator } from '../src/locale.js'
import { distillHint, isAbnormalState, LAYERED_SHARES, measureSource, redact, renderSections, SECTION_ORDER, shareOf } from '../src/render.js'
import { describeBrief } from '../src/tools/status.js'

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

  const cfg = normalizeConfig({ workbuddyHome: home, stateDir: join(root, 'state'), ...config, inject: { mode: 'full', ...(config.inject ?? {}) } })
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

  const noProject = normalizeConfig({ workbuddyHome: probe.home.path, inject: { mode: 'full', project: false } })
  assert.deepEqual(names(renderSections({ cfg: noProject, probe, t })), ['workbuddy-memory:rules', 'workbuddy-memory:user'])

  const noRules = normalizeConfig({ workbuddyHome: probe.home.path, inject: { mode: 'full', rules: false } })
  assert.deepEqual(names(renderSections({ cfg: noRules, probe, t })), ['workbuddy-memory:project', 'workbuddy-memory:user'])

  const noUser = normalizeConfig({ workbuddyHome: probe.home.path, inject: { mode: 'full', user: false } })
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

test('legacy wrapper and truncation note stay inside a very small old limit', () => {
  const { cfg, probe } = fixture({ project: `## Notes\n- ${'x'.repeat(200)}\n`, config: { inject: { limits: { project: 40 } } } })
  const project = renderSections({ cfg, probe, t }).find((section) => section.name === 'workbuddy-memory:project')
  assert.ok(project.text.length <= 40, `legacy wrapper is ${project.text.length} chars`)
})

test('a legacy block never exceeds its own limit, measured in UTF-16 units', () => {
  // The limit is stated in UTF-16 code units, but the body used to be cut by
  // code point: an emoji counted as one and took two units, so the finished
  // block was longer than the limit it claimed to obey.
  const body = `## Notes\n${Array.from({ length: 2600 }, (_, index) => `- 😀${index}`).join('\n')}\n`
  for (const limit of [40, 10000]) {
    const { cfg, probe } = fixture({ project: body, config: { inject: { limits: { project: limit } } } })
    const project = renderSections({ cfg, probe, t }).find((section) => section.name === 'workbuddy-memory:project')
    assert.ok(project.text.length <= limit, `limit ${limit}: the block is ${project.text.length} UTF-16 units`)
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(project.text), false, 'no half surrogate pair at the cut')
  }
})

test('a limit too small for the wrapper contributes no block at all', () => {
  // Half a heading with no body reads like a truncated memory, not like a
  // limit that is too small to say anything in.
  //
  // The limits are derived from the label rather than hard-coded: the wrapper is
  // `### <label>\n\n`, so a literal like 20 stops being "too small" the moment
  // the label gets shorter — which is exactly what happened when the `(WorkBuddy)`
  // suffix was dropped, and the test then failed for a reason unrelated to what
  // it guards.
  const prefix = `### ${t('section.project')}\n\n`.length
  for (const limit of [prefix - 1, prefix]) {
    const layered = fixture({ project: '## Notes\n- one\n', config: { inject: { mode: 'layered', limits: { project: limit } } } })
    const sections = renderSections({ cfg: layered.cfg, probe: layered.probe, t })
    assert.equal(sections.some((section) => section.name === 'workbuddy-memory:project'), false, `limit ${limit} contributes nothing`)
    assert.match(String(sections.states.project), /^legacy:/, 'the reason is still recorded')

    const full = fixture({ project: '## Notes\n- one\n', config: { inject: { limits: { project: limit } } } })
    assert.equal(names(renderSections({ cfg: full.cfg, probe: full.probe, t })).includes('workbuddy-memory:project'), false, `full mode at ${limit}`)
  }
})

test('a full-mode block that vanished records an abnormal state, not "full"', () => {
  // `renderFileBlock` returns '' when the limit cannot fit the label, so the
  // block is dropped. Recording `full` for it claimed the whole file was
  // injected while the model saw nothing — and `compatibility` stayed silent
  // because `full` is a normal state.
  const prefix = `### ${t('section.project')}\n\n`.length
  for (const limit of [prefix - 1, prefix]) {
    const { cfg, probe } = fixture({ project: '## Notes\n- one\n', config: { inject: { limits: { project: limit } } } })
    const sections = renderSections({ cfg, probe, t })
    assert.equal(sections.some((section) => section.name === 'workbuddy-memory:project'), false)
    assert.match(String(sections.states.project), /^full:too-small$/, `limit ${limit}: the state says why the block is missing`)
    assert.equal(isAbnormalState(sections.states.project), true, 'a dropped block is not a normal state')
  }
})

test('the too-small state reaches status.compatibility', () => {
  // The state exists to be reported. `describeBrief` filters on
  // `isAbnormalState`, so the shape chosen above decides whether a person ever
  // hears about the block that disappeared.
  const prefix = `### ${t('section.project')}\n\n`.length
  const { cfg, probe } = fixture({ project: '## Notes\n- one\n', config: { inject: { limits: { project: prefix - 1 } } } })
  const sections = renderSections({ cfg, probe, t })
  const compatibility = Object.entries(sections.states)
    .filter(([, state]) => isAbnormalState(state))
    .map(([key, state]) => `${key}:${state}`)
  assert.ok(compatibility.includes('project:full:too-small'), compatibility.join(', '))

  const brief = describeBrief(probe, cfg, { mode: sections.mode, states: sections.states }, t)
  assert.ok(brief.compatibility.includes('project:full:too-small'), JSON.stringify(brief.compatibility))
})

test('truncation never halves a surrogate pair', () => {
  const body = `## 偏好\n- ${'😀'.repeat(80)}\n`
  const { cfg, probe } = fixture({ project: body, config: { inject: { limits: { project: 40 } } } })
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

test('a core that does not fit says how many entries were left out, inside the budget', () => {
  // Written-but-invisible is the symptom this product exists to remove: the
  // model read seven entries and concluded the core was seven entries long.
  const entries = Array.from({ length: 12 }, (_, index) => `- entry ${index} ${'核心偏好内容'.repeat(30)}`)
  const { cfg, probe } = fixture({ project: `# Memory\n\n## 常驻记忆\n${entries.join('\n')}\n`, config: { inject: { mode: 'layered' } } })
  const sections = renderSections({ cfg, probe, t })
  const project = sections.find((section) => section.name === 'workbuddy-memory:project')
  const budget = Math.floor(cfg.inject.coreBudget * 0.375)

  assert.ok(project.text.length <= budget, `the core block is ${project.text.length} units against ${budget}`)
  assert.match(project.text, /另有 \d+ 条核心条目超出预算/, 'the block says what did not fit')
  const kept = (project.text.match(/^- entry /gm) ?? []).length
  const named = Number(/另有 (\d+) 条/.exec(project.text)[1])
  assert.equal(kept + named, 12, `every entry is either injected (${kept}) or counted (${named})`)
  assert.match(String(sections.states.project), /core-over-budget/, 'the state names the overflow')
})

test('a full topic directory says there are more topics, inside the budget', () => {
  const topics = Array.from({ length: 40 }, (_, index) => `## 主题${index} ${'很长的主题名称'.repeat(4)}\n- t\n`).join('\n')
  const { cfg, probe } = fixture({ project: `# Memory\n\n## 常驻记忆\n- core\n\n${topics}`, config: { inject: { mode: 'layered' } } })
  const sections = renderSections({ cfg, probe, t })
  const directory = sections.find((section) => section.name === 'workbuddy-memory:profile')
  const budget = Math.floor(cfg.inject.coreBudget * 0.125)

  assert.ok(directory.text.length <= budget, `the directory is ${directory.text.length} units against ${budget}`)
  assert.match(directory.text, /还有更多主题/, 'the directory says the list is partial')
  assert.match(String(sections.states.directory), /^directory-truncated\(\d+\)$/, 'the state names the shortfall')
})

test('the topic directory is sanitized like every other block', () => {
  const { home, cwd, cfg } = fixture({ config: { inject: { mode: 'layered' } } })
  writeFileSync(join(cwd, '.workbuddy', 'memory', 'MEMORY.md'), `# Memory\n\n## 常驻记忆\n- core\n\n## ${join(home, 'bin')} 工具链\n- t\n`, 'utf8')
  const probe = probeEnvironment({ cfg, cwd, detail: true })
  const directory = renderSections({ cfg, probe, t }).find((section) => section.name === 'workbuddy-memory:profile')
  assert.ok(directory)
  assert.equal(directory.text.includes(home), false, 'the home prefix must not survive in a topic heading')
  assert.match(directory.text, /~/)
})

test('the overflow notice is English in an English session and stays in budget', () => {
  // The notice is part of the block, so it is measured like one: two budgets on
  // either side of a line boundary must both stay inside the cap, and the
  // wording has to follow the locale instead of leaking the other language.
  const en = createTranslator('en')
  const entries = Array.from({ length: 30 }, (_, index) => `- ${'long preference text '.repeat(6)}${index}`)
  for (const coreBudget of [4000, 4200]) {
    const { cfg, probe } = fixture({ project: `# Memory\n\n## Core Memory\n${entries.join('\n')}\n`, config: { inject: { mode: 'layered', coreBudget } } })
    const project = renderSections({ cfg, probe, t: en }).find((section) => section.name === 'workbuddy-memory:project')
    const budget = Math.floor(coreBudget * 0.375)
    assert.ok(project.text.length <= budget, `coreBudget ${coreBudget}: ${project.text.length} > ${budget}`)
    assert.match(project.text, /more core entries did not fit/, 'the notice is present and in English')
    assert.doesNotMatch(project.text, /另有/, 'no Chinese leaks into an English block')
  }
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

  const withUid = normalizeConfig({ workbuddyHome: home, inject: { mode: 'full', profileUid: 'abc' } })
  const probe = probeEnvironment({ cfg: withUid, cwd: join(cwd), detail: true })
  const profile = renderSections({ cfg: withUid, probe, t }).find((section) => section.name === 'workbuddy-memory:profile')
  assert.ok(profile, 'a resolved profile file should be injected')
  assert.match(profile.text, /关注 AI/)
  void cfg
})

test('distillAbove defaults to twice limits.user and follows a tuned limit', () => {
  // The threshold is a pressure gauge, so it has to scale with the budget it
  // measures. A literal default would stop tracking a tuned limit.
  const byDefault = normalizeConfig({})
  assert.equal(byDefault.inject.limits.user, 8000, 'the shipped default is 8000')
  assert.equal(byDefault.inject.distillAbove, 16000, 'twice the default limit')

  const tuned = normalizeConfig({ inject: { limits: { user: 3000 } } })
  assert.equal(tuned.inject.distillAbove, 6000, 'follows the tuned limit')

  const explicit = normalizeConfig({ inject: { limits: { user: 3000 }, distillAbove: 9000 } })
  assert.equal(explicit.inject.distillAbove, 9000, 'an explicit value wins')

  // A threshold at or below the limit would fire on every turn even though
  // nothing is being lost yet, so it is lifted above the limit.
  const tooLow = normalizeConfig({ inject: { limits: { user: 5000 }, distillAbove: 100 } })
  assert.equal(tooLow.inject.distillAbove, 5001, 'clamped above the limit')

  // A limit of 0 disables the block, so there is nothing to distil for.
  const off = normalizeConfig({ inject: { limits: { user: 0 } } })
  assert.equal(off.inject.distillAbove, 0)
})

test('the rules block gains a distillation hint only past the threshold', () => {
  const under = fixture({ user: '- 一条\n'.repeat(50) })
  const underRules = renderSections({ cfg: under.cfg, probe: under.probe, t }).find((s) => s.name === 'workbuddy-memory:rules')
  assert.doesNotMatch(underRules.text, /蒸馏阈值/)

  // A file past twice the limit loses most of itself on every turn.
  const over = fixture({ user: `${'- 一条\n'.repeat(6000)}`, config: { inject: { limits: { user: 8000 } } } })
  const overRules = renderSections({ cfg: over.cfg, probe: over.probe, t }).find((s) => s.name === 'workbuddy-memory:rules')
  assert.match(overRules.text, /蒸馏阈值/)
  assert.match(overRules.text, /16000/, 'names the threshold it crossed')
  assert.match(overRules.text, /8000/, 'names the injection limit')
})

test('the hint survives even when the rules text alone would fill the budget', () => {
  // The hint exists for the case where something must be cut, so it must not be
  // the thing that gets cut. The base text gives way instead.
  const over = fixture({ user: `${'- 一条\n'.repeat(6000)}`, config: { inject: { limits: { user: 8000, rules: 400 } } } })
  const rules = renderSections({ cfg: over.cfg, probe: over.probe, t }).find((s) => s.name === 'workbuddy-memory:rules')
  assert.ok(rules.text.length <= 400, `block stays within its budget (${rules.text.length})`)
  assert.match(rules.text, /蒸馏阈值/, 'the hint is the part that survives')
})

test('read-only sessions get no distillation hint', () => {
  // Read-only never writes, so asking for a rewrite would only burn turns.
  const over = fixture({ user: `${'- 一条\n'.repeat(6000)}`, config: { readOnly: true, inject: { limits: { user: 8000 } } } })
  const rules = renderSections({ cfg: over.cfg, probe: over.probe, t }).find((s) => s.name === 'workbuddy-memory:rules')
  assert.doesNotMatch(rules.text, /蒸馏阈值/)
})

test('the user block is truncated at the new 8000 default', () => {
  const body = `${'- 一条\n'.repeat(3000)}`
  const { cfg, probe } = fixture({ user: body })
  const user = renderSections({ cfg, probe, t }).find((s) => s.name === 'workbuddy-memory:user')
  assert.ok(user.text.length < body.length, 'a long file is trimmed')
  assert.match(user.text, /截断/)
})


test('the pressure hint fires as soon as the file passes the injection limit', () => {
  // The gap this closes: distillAbove defaults to twice the limit, so a file
  // between the two was already losing content on every turn with no hint.
  const body = '## A\n' + ('- ' + 'x'.repeat(90) + '\n').repeat(120)
  const { cfg, probe } = fixture({ user: body, config: { inject: { limits: { user: 8000 }, distillAbove: 0 } } })
  assert.ok(body.length > cfg.inject.limits.user, 'fixture is past the limit')
  assert.ok(body.length < cfg.inject.distillAbove, 'but still under the distillation threshold')

  const hint = distillHint({ cfg, probe, t })
  assert.notEqual(hint, '', 'a file over the limit must say so')
  assert.match(hint, /8000/)
})

test('the strong distillation hint still fires past the threshold', () => {
  const body = '## A\n' + ('- ' + 'x'.repeat(90) + '\n').repeat(200)
  const { cfg, probe } = fixture({ user: body, config: { inject: { limits: { user: 8000 }, distillAbove: 0 } } })
  assert.ok(body.length > cfg.inject.distillAbove)
  const hint = distillHint({ cfg, probe, t })
  assert.notEqual(hint, '')
  assert.match(hint, new RegExp(String(cfg.inject.distillAbove)))
})

test('no hint while the file fits the budget', () => {
  const { cfg, probe } = fixture({ user: '## A\n- 短\n' })
  assert.equal(distillHint({ cfg, probe, t }), '')
})

test('a removed conflictPolicy key is ignored, not resurrected', () => {
  // The key was declared and normalized but never read, so a person who set
  // `overwrite` still got `fail`. It is gone from the config entirely now.
  const cfg = normalizeConfig({ write: { conflictPolicy: 'overwrite' } })
  assert.equal('conflictPolicy' in cfg.write, false)
})

test('layered mode injects complete core entries within the per-source budget and exposes topic directory', () => {
  const core = `# Memory\n\n## Core Memory\n- ${'😀'.repeat(800)}\n- short core\n\n## Network\n- provider note\n`
  const { cfg, probe } = fixture({ project: core, user: '# User\n\n## 常驻记忆\n- user core\n\n## Accounts\n- acct\n', config: { inject: { mode: 'layered', coreBudget: 4000 } } })
  const sections = renderSections({ cfg, probe, t })
  const project = sections.find((item) => item.name === 'workbuddy-memory:project')
  assert.ok(project.text.length <= 1500)
  assert.doesNotMatch(project.text, /😀/u, 'an oversized first entry is not half-injected')
  // The core is a file prefix, so the scan stops at the first entry that does
  // not fit: a skipped entry would make the injected set a discontinuous subset
  // and the model would read "the first one was deleted".
  assert.doesNotMatch(project.text, /short core/, 'a later entry is not pulled in past the gap')
  assert.match(project.text, /另有 2 条核心条目超出预算/, 'and the block says two entries stayed out')
  const user = sections.find((item) => item.name === 'workbuddy-memory:user')
  const rules = sections.find((item) => item.name === 'workbuddy-memory:rules')
  const directory = sections.find((item) => item.name === 'workbuddy-memory:profile')
  assert.ok(user.text.length <= 1500)
  assert.ok(rules.text.length <= 500)
  assert.ok(directory.text.length <= 500)
  assert.match(directory.text, /Network/)
  assert.ok(sections.reduce((sum, section) => sum + section.text.length, 0) <= 4000)
  assert.equal(sections.mode, 'layered')
})

test('compact rules are complete in both locales and remain inside the rules share', () => {
  const en = createTranslator('en')
  const zh = createTranslator('zh')
  const { cfg, probe } = fixture({ config: { inject: { mode: 'layered' } } })
  const english = renderSections({ cfg, probe, t: en }).find((item) => item.name === 'workbuddy-memory:rules').text
  // `t` is the Chinese translator: using it for both would have compared the
  // Chinese block with itself, so the English assertions below never ran against
  // English text.
  const chinese = renderSections({ cfg, probe, t: zh }).find((item) => item.name === 'workbuddy-memory:rules').text
  // Derived, not hard-coded: the share moved from 12.5% to 17.5% when the daily
  // rule was added, and a literal here would have failed for the wrong reason.
  const budget = shareOf(cfg.inject.coreBudget, 'rules')
  assert.ok(english.length <= budget, `English rules are ${english.length} units against ${budget}`)
  assert.ok(chinese.length <= budget, `Chinese rules are ${chinese.length} units against ${budget}`)
  assert.match(english, /task-shaped work/)
  assert.match(english, /memory_read/)
  assert.match(english, /panel/)
  assert.match(chinese, /收尾前检查/)
  assert.match(chinese, /memory_read/)
  assert.match(chinese, /面板操作/)
  assert.doesNotMatch(chinese, /task-shaped/, 'no English leaks into the Chinese block')

  // Appending is not a decision to hand back to the user: the rule has to say so,
  // or the model asks "shall I record this?" at the end of every task.
  assert.match(english, /Just append/, 'the English block says to append without asking')
  assert.match(chinese, /直接做，不必问/, 'the Chinese block says the same')

  // Daily files are the case that exposed this: layered mode used to inject no
  // rule about them at all, so a session could run a whole day and never write
  // one. Every locale has to say they exist, that they are not injected, and what
  // to do once they age out.
  for (const [name, block] of [['en', english], ['zh', chinese]]) {
    assert.match(block, /YYYY-MM-DD/, `${name}: names the daily file`)
    assert.match(block, /30/, `${name}: says when to distil`)
  }
  assert.match(english, /never injected/, 'English says daily files are not injected')
  assert.match(chinese, /不注入/, 'Chinese says the same')
})

test('full-mode rules keep every numbered rule inside limits.rules, hint included, in both locales', () => {
  // The English block grew past its own budget when the bulk tidy-up and daily
  // file rules were added: `truncateChars` cut rule 7 mid-word, and with the
  // distillation hint present the whole rule vanished — silently dropping
  // "never copy raw logs into MEMORY.md", the one rule that keeps the file from
  // overflowing the injection limit in the first place.
  //
  // The worst case is a user file past the limit *and* past the threshold: that
  // is the longest hint, so it is the budget the rules have to survive.
  for (const locale of ['en', 'zh']) {
    const translator = createTranslator(locale)
    const { cfg, probe } = fixture({ user: `${'- 一条\n'.repeat(6000)}`, config: { inject: { limits: { user: 8000 } } } })
    assert.ok(cfg.inject.limits.rules > 0, 'the fixture injects the rules block')
    const hint = distillHint({ cfg, probe, t: translator })
    assert.notEqual(hint, '', `${locale}: the fixture is past the limit, so a hint is present`)

    const rules = renderSections({ cfg, probe, t: translator }).find((section) => section.name === 'workbuddy-memory:rules')
    assert.ok(rules.text.length <= cfg.inject.limits.rules, `${locale}: the block is ${rules.text.length} units against a ${cfg.inject.limits.rules} budget`)

    // Every rule the locale ships has to survive: a cut rule is a rule the model
    // never reads, and the block still looks complete without it.
    const declared = translator('rules')
    assert.ok(Array.isArray(declared) && declared.length > 0)
    for (let index = 0; index < declared.length; index += 1) {
      assert.ok(rules.text.includes(`${index + 1}. ${declared[index]}`), `${locale}: rule ${index + 1} survives whole`)
    }
  }
})

test('mixed files retain legacy block while layered source remains layered', () => {
  const { root, cwd, home } = fixture({ project: '## Old\n- legacy\n', user: '# User\n\n## Core Memory\n- core\n' })
  const cfg = normalizeConfig({ workbuddyHome: home, inject: { mode: 'layered' } })
  const probe = probeEnvironment({ cfg, cwd, detail: false })
  const sections = renderSections({ cfg, probe, t })
  assert.match(sections.find((item) => item.name === 'workbuddy-memory:project').text, /legacy/)
  assert.match(sections.find((item) => item.name === 'workbuddy-memory:user').text, /core/)
  assert.equal(sections.mode, 'mixed')
  assert.match(sections.find((item) => item.name === 'workbuddy-memory:profile').text, /legacy/)
  void root
})

test('zero limit disables a source and its entries in every mode', () => {
  const { cwd, home } = fixture({ project: '# Memory\n\n## Core Memory\n- core\n', user: '# User\n\n## Core Memory\n- user\n' })
  const cfg = normalizeConfig({ workbuddyHome: home, inject: { mode: 'layered', limits: { project: 0, user: 0, profile: 0 } } })
  const sections = renderSections({ cfg, probe: probeEnvironment({ cfg, cwd }), t })
  assert.equal(sections.some((item) => item.name === 'workbuddy-memory:project'), false)
  assert.equal(sections.some((item) => item.name === 'workbuddy-memory:user'), false)
  assert.equal(sections.some((item) => item.name === 'workbuddy-memory:profile'), false)
})

test('layered mode says when a file outgrew its share, in the directory, with the count', () => {
  // In layered mode `render.js` used to drop the distillation hint entirely, so
  // a 9903-character user file produced only a truncation note at the end of a
  // block that was capped at its share: the model could see *that* it was cut
  // and had nothing telling it the file had outgrown what a core is for. The
  // signal has to come back, but not in the core block — a per-write character
  // count inside the always-on text changes the prompt on every save.
  const user = `# User\n\n## 常驻记忆\n- user core\n\n## Accounts\n- acct\n\n${Array.from({ length: 100 }, (_, index) => `- 记录 ${index} ${'细节'.repeat(30)}`).join('\n')}\n`
  const { cfg, probe } = fixture({ project: '# Memory\n\n## 常驻记忆\n- core\n', user, config: { inject: { mode: 'layered', coreBudget: 4000 } } })
  const sections = renderSections({ cfg, probe, t })
  const directory = sections.find((item) => item.name === 'workbuddy-memory:profile')
  const userBlock = sections.find((item) => item.name === 'workbuddy-memory:user')
  const chars = user.length
  const share = Math.floor(cfg.inject.coreBudget * 0.375)

  assert.ok(chars > share, `the fixture is past the user share: ${chars} > ${share}`)
  assert.match(directory.text, /用户记忆/, 'the directory names the source that outgrew its share')
  assert.ok(directory.text.includes(String(chars)), `the directory carries the real size ${chars}: ${directory.text}`)
  assert.match(directory.text, /按需/, 'and says the rest is read on demand')
  assert.equal(userBlock.text.includes(String(chars)), false, 'the core block stays free of the per-write count')
  assert.ok(directory.text.length <= Math.floor(cfg.inject.coreBudget * 0.125), `the directory is ${directory.text.length} units`)
})

test('a file that fits its share gets no over-share note', () => {
  const { cfg, probe } = fixture({
    project: '# Memory\n\n## 常驻记忆\n- core\n',
    user: '# User\n\n## 常驻记忆\n- one\n\n## Accounts\n- acct\n',
    config: { inject: { mode: 'layered' } },
  })
  const directory = renderSections({ cfg, probe, t }).find((item) => item.name === 'workbuddy-memory:profile')
  // The directory heading itself says "on demand", so the negative assertion
  // has to name the note rather than the word.
  assert.doesNotMatch(directory.text, /常驻只取核心/, 'nothing is said when nothing is out of budget')
})

test('a file whose topics hold prose and code is injected by its core, not whole', () => {
  // The reported defect: a person had written `## 常驻记忆` and topic sections,
  // and the panel still said the file was unsplit. One code block in one topic
  // was enough to send the whole file back to whole-file injection, so the core
  // the person had written was never used as the core.
  const project = [
    '# 记忆',
    '',
    '## 常驻记忆',
    '- 只记会重犯的坑',
    '',
    '## 主题：算法',
    '状态：已跑通。',
    '### 步骤',
    '```',
    '1. one',
    '2. two',
    '```',
    '',
  ].join('\n')
  const { cfg, probe } = fixture({ project, user: '# User\n\n## 常驻记忆\n- user core\n', config: { inject: { mode: 'layered' } } })
  const sections = renderSections({ cfg, probe, t })
  const projectBlock = sections.find((item) => item.name === 'workbuddy-memory:project')
  const directory = sections.find((item) => item.name === 'workbuddy-memory:profile')

  assert.match(projectBlock.text, /只记会重犯的坑/, 'the core is injected')
  assert.doesNotMatch(projectBlock.text, /1\. one/, 'the code block stays on the on-demand side')
  assert.doesNotMatch(directory.text, /project=legacy/, 'and the source is not reported as unsplit')
  assert.match(directory.text, /主题：算法/, 'the topic is listed so the rest can be read on demand')
  assert.equal(sections.mode, 'layered')
})

test('a legacy state in the directory carries a readable gloss, not a bare code', () => {
  // `user=legacy:missing_core` is a state name, not an explanation. The model
  // reading it learns nothing about whether the block in front of it is whole.
  const { cfg, probe } = fixture({ project: '## Old\n- legacy\n', user: '# User\n\n## Core Memory\n- core\n' })
  const layered = normalizeConfig({ workbuddyHome: probe.home.path, inject: { mode: 'layered' } })
  const sections = renderSections({ cfg: layered, probe, t })
  const directory = sections.find((item) => item.name === 'workbuddy-memory:profile')

  assert.match(directory.text, /project=legacy:missing_core/, 'the machine-readable state is still there')
  assert.match(directory.text, /整份注入/, 'and a person can read what it means')
  // The gloss also has to stop blaming the topic sections: they may hold prose
  // and code, and a model that reads "unsplit" as "my file is malformed" tells
  // the person to rewrite sections that were never the problem.
  assert.match(directory.text, /主题小节.*不影响拆分/, 'and does not accuse the topic sections')
  assert.ok(directory.text.length <= Math.floor(layered.inject.coreBudget * 0.125), `the directory is ${directory.text.length} units`)
  void cfg
})

test('the compatibility line is stable across renders of the same file', () => {
  // A jittery hint is worse than none: it rewrites the prompt prefix on every
  // turn for a file nobody touched.
  const user = `# User\n\n## 常驻记忆\n- core\n\n${Array.from({ length: 60 }, (_, index) => `- ${'x'.repeat(60)}`).join('\n')}\n`
  const { cfg, probe } = fixture({ project: '# Memory\n\n## 常驻记忆\n- core\n', user, config: { inject: { mode: 'layered' } } })
  const first = renderSections({ cfg, probe, t }).find((item) => item.name === 'workbuddy-memory:profile').text
  const second = renderSections({ cfg, probe, t }).find((item) => item.name === 'workbuddy-memory:profile').text
  assert.equal(first, second)
})

test('layered mode still names the distillation threshold when the file crosses it', () => {
  // The full-mode hint says "distil". In layered mode the count and the word
  // "distil" both used to disappear, so a file the plugin itself had declared
  // overdue looked exactly like one that was simply long.
  const user = `# User\n\n## 常驻记忆\n- core\n\n${Array.from({ length: 120 }, (_, index) => `- ${'x'.repeat(80)}`).join('\n')}\n`
  const { cfg, probe } = fixture({
    project: '# Memory\n\n## 常驻记忆\n- core\n',
    user,
    // `resolveDistillAbove` clamps the threshold to at least `limits.user + 1`,
    // so the fixture states both explicitly instead of deriving a number that
    // lands below the clamp.
    config: { inject: { mode: 'layered', coreBudget: 4000, limits: { user: 8000 }, distillAbove: 9000 } },
  })
  const directory = renderSections({ cfg, probe, t }).find((item) => item.name === 'workbuddy-memory:profile')

  assert.ok(user.length > cfg.inject.distillAbove, `the fixture is past the threshold: ${user.length} > ${cfg.inject.distillAbove}`)
  assert.match(directory.text, /蒸馏/, 'the layered directory says the file is due for distillation')
  assert.ok(directory.text.includes(String(user.length)), 'and carries the size that made it due')
  assert.ok(directory.text.length <= Math.floor(cfg.inject.coreBudget * 0.125), `the directory is ${directory.text.length} units`)
})

test('a legacy file past its own limit says so without promising a core split', () => {
  // A legacy file has no core, so "only the core stays always-on" would be a
  // false statement about it. It is still cut, and a cut nobody mentions reads
  // as a complete file.
  const body = `# U\n\n${Array.from({ length: 60 }, (_, index) => `- 记录 ${index} ${'x'.repeat(80)}`).join('\n')}\n`
  const { cfg, probe } = fixture({ project: '# Memory\n\n## 常驻记忆\n- core\n', user: body, config: { inject: { mode: 'layered', limits: { user: 2000 } } } })
  const directory = renderSections({ cfg, probe, t }).find((item) => item.name === 'workbuddy-memory:profile')

  assert.ok(body.length > cfg.inject.limits.user, `the fixture is past the limit: ${body.length}`)
  assert.ok(directory.text.includes(String(body.length)), 'the directory carries the real size')
  assert.match(directory.text, /限额/, 'it names the limit the file is cut at')
  assert.doesNotMatch(directory.text, /常驻只取核心/, 'a legacy file has no core to speak of')
})

test('backupKeep defaults to a tidy-up-sized window', () => {
  assert.equal(normalizeConfig({}).write.backupKeep, 20)
})

test('in layered mode limits.user still moves the distillation threshold it derives', () => {
  // `limits.user` is documented as "just an on/off switch" in layered mode. It
  // is not: `distillAbove` defaults to `2 × limits.user`, and the layered
  // directory reads that threshold. So tuning the limit alone flips the
  // "time to distil" sentence on the same untouched file — which is why the
  // hint and the README have to say so instead of promising a pure switch.
  const user = `# User\n\n## 常驻记忆\n- core\n\n${Array.from({ length: 80 }, (_, index) => `- ${'x'.repeat(60)}`).join('\n')}\n`
  const { probe } = fixture({ project: '# Memory\n\n## 常驻记忆\n- core\n', user })
  const render = (limitsUser) => {
    const cfg = normalizeConfig({
      workbuddyHome: probe.home.path,
      inject: { mode: 'layered', coreBudget: 4000, limits: { user: limitsUser } },
    })
    const directory = renderSections({ cfg, probe, t }).find((item) => item.name === 'workbuddy-memory:profile')
    return { cfg, text: directory.text }
  }

  const wide = render(8000)
  const narrow = render(2000)

  // The derivation itself: 0 means twice the limit, so the limit decides it.
  assert.equal(wide.cfg.inject.distillAbove, 16000, '8000 derives 16000')
  assert.equal(narrow.cfg.inject.distillAbove, 4000, '2000 derives 4000')
  assert.ok(user.length > narrow.cfg.inject.distillAbove, `the file crosses the narrow threshold: ${user.length}`)
  assert.ok(user.length < wide.cfg.inject.distillAbove, `and not the wide one: ${user.length}`)

  // Same file, same mode, same budget: only limits.user changed.
  assert.notEqual(wide.text, narrow.text, 'the layered output follows the derived threshold')
  assert.doesNotMatch(wide.text, /蒸馏/, 'the wide limit leaves the file under its threshold')
  assert.match(narrow.text, /蒸馏/, 'the narrow limit brings the distillation sentence back')
})

test('a topic line names the file it lives in, so the model can pick a target', () => {
  // The directory used to be a bare list of topic names. `memory_read` needs a
  // target as well as a section, and a heading like `Accounts` exists in
  // whichever file it was written in: without the source the model guesses, and
  // a wrong guess is a `no_section` round trip it has to pay for.
  const { cfg, probe } = fixture({
    project: '# Memory\n\n## 常驻记忆\n- core\n\n## Accounts\n- a\n',
    user: '# User\n\n## 常驻记忆\n- ucore\n\n## Accounts\n- b\n\n## Network\n- c\n',
    config: { inject: { mode: 'layered' } },
  })
  const directory = renderSections({ cfg, probe, t }).find((item) => item.name === 'workbuddy-memory:profile')

  assert.match(directory.text, /^- project\/Accounts$/m, 'a project topic carries its source')
  assert.match(directory.text, /^- user\/Network$/m, 'a user topic carries its source')
  // The same heading in both files is two different sections, so it must appear
  // twice. Deduplicating on the name alone would hide one of them.
  const accounts = directory.text.split('\n').filter((line) => line.endsWith('/Accounts'))
  assert.equal(accounts.length, 2, `both Accounts sections are listed: ${directory.text}`)
})

test('the topic directory says how to read a topic, and never loses that line', () => {
  // A list of nouns with no verb is recognisable but not actionable. The line
  // that turns it into a call has to come first: `fitText` drops whole lines
  // from the end, so a hint placed after the topics would be the first thing cut
  // on a long list — exactly when it is most needed.
  const topics = Array.from({ length: 40 }, (_, index) => `## 主题${index} ${'很长的名字'.repeat(3)}\n- t\n`).join('\n')
  const { cfg, probe } = fixture({ project: `# Memory\n\n## 常驻记忆\n- core\n\n${topics}`, config: { inject: { mode: 'layered' } } })
  const sections = renderSections({ cfg, probe, t })
  const directory = sections.find((item) => item.name === 'workbuddy-memory:profile')

  assert.match(directory.text, /memory_read\(target=前缀-memory, section=主题名\)/, 'the directory names the call')
  assert.match(directory.text, /memory_search/, 'and the search tool for a single fact')
  assert.match(String(sections.states.directory), /^directory-truncated\(\d+\)$/, 'the fixture really is truncated')
  // The hint survives the truncation: it is placed before the topics.
  const hintAt = directory.text.indexOf('memory_read(target=前缀-memory')
  const firstTopicAt = directory.text.indexOf('主题0')
  assert.ok(hintAt >= 0 && firstTopicAt > hintAt, 'the hint comes before the topics it explains')
})

test('an empty topic list gets no reading hint', () => {
  // A sentence pointing at a `主题名` that does not exist is worse than silence:
  // the model would call memory_read with a name it invented from the sentence.
  const { cfg, probe } = fixture({
    project: '# Memory\n\n## 常驻记忆\n- core\n',
    user: '# User\n\n## 常驻记忆\n- ucore\n',
    config: { inject: { mode: 'layered', profile: false } },
  })
  const sections = renderSections({ cfg, probe, t })
  const directory = sections.find((item) => item.name === 'workbuddy-memory:profile')
  // No topics and no profile line means no directory at all.
  if (directory) assert.doesNotMatch(directory.text, /memory_read\(target=前缀-memory/, 'no hint without a topic to point at')
})

test('the reading hint is English in an English session', () => {
  const en = createTranslator('en')
  const { cfg, probe } = fixture({ project: '# Memory\n\n## Core Memory\n- core\n\n## Network\n- n\n', config: { inject: { mode: 'layered' } } })
  const directory = renderSections({ cfg, probe, t: en }).find((item) => item.name === 'workbuddy-memory:profile')
  assert.match(directory.text, /memory_read\(target=<prefix>-memory, section=NAME\)/)
  assert.match(directory.text, /^- project\/Network$/m)
  assert.doesNotMatch(directory.text, /前缀|主题名/, 'no Chinese leaks into an English block')
})

test('a long topic list still fits the directory budget with the hint and the source prefix', () => {
  // The prefix and the hint both spend the same 500 units, so the two have to be
  // measured together: a block that overflows is a block whose tail is silently
  // dropped, and the dropped tail here is the topic list itself.
  const topics = Array.from({ length: 60 }, (_, index) => `## Topic ${index} ${'long name '.repeat(4)}\n- t\n`).join('\n')
  for (const locale of ['zh', 'en']) {
    const translator = createTranslator(locale)
    const { cfg, probe } = fixture({ project: `# Memory\n\n## 常驻记忆\n- core\n\n${topics}`, config: { inject: { mode: 'layered' } } })
    const sections = renderSections({ cfg, probe, t: translator })
    const directory = sections.find((item) => item.name === 'workbuddy-memory:profile')
    const budget = Math.floor(cfg.inject.coreBudget * 0.125)
    assert.ok(directory.text.length <= budget, `${locale}: the directory is ${directory.text.length} units against ${budget}`)
    assert.match(String(sections.states.directory), /^directory-truncated\(\d+\)$/, `${locale}: and it says the list is partial`)
    assert.match(directory.text, /还有更多|more topics/, `${locale}: the shortfall is stated in the block`)
  }
})

test('block headings carry no product name, and the rules say where the file comes from', () => {
  // The headings used to read `### 项目记忆（WorkBuddy）`. That was a display
  // string with no logic behind it — nothing resolves a section by it — and it
  // spent 11 units per occurrence in the always-on prefix while saying only which
  // product the file belongs to. The provenance that actually matters is that
  // *another agent may have written the content*, so it lives in the rules where
  // it can be a sentence instead of a label.
  const { cfg, probe } = fixture({
    project: '# Memory\n\n## 常驻记忆\n- core\n',
    user: '# User\n\n## 常驻记忆\n- ucore\n',
    config: { inject: { mode: 'layered' } },
  })
  const sections = renderSections({ cfg, probe, t })
  for (const name of ['workbuddy-memory:project', 'workbuddy-memory:user']) {
    const block = sections.find((section) => section.name === name)
    assert.doesNotMatch(block.text.split('\n')[0], /WorkBuddy/, `${name} heading names no product`)
  }
  // The compact rules are the only place layered mode states the provenance.
  const rules = sections.find((section) => section.name === 'workbuddy-memory:rules').text
  assert.match(rules, /WorkBuddy/, 'layered rules name the shared file')
  assert.match(rules, /别的代理|another agent/, 'and warn that another agent may have written it')
  assert.match(rules, /数据|data/, 'the data-not-instructions rule survives the rewrite')
})

test('the English compact rules keep real headroom inside the rules share', () => {
  // The block is capped at its share of `coreBudget`, and `fitText` drops whole
  // lines from the end: a rule that overflows is a rule the model never reads,
  // while the block still looks complete. That is exactly how layered mode lost
  // the daily-file rule once already. The share is read from `LAYERED_SHARES`
  // rather than hard-coded, so moving the split cannot silently disable this.
  const en = createTranslator('en')
  const { cfg, probe } = fixture({ config: { inject: { mode: 'layered' } } })
  const english = renderSections({ cfg, probe, t: en }).find((item) => item.name === 'workbuddy-memory:rules').text
  const budget = shareOf(cfg.inject.coreBudget, 'rules')
  assert.equal(budget, Math.floor(cfg.inject.coreBudget * LAYERED_SHARES.rules))
  assert.ok(english.length <= budget, `English rules are ${english.length} units against ${budget}`)
  assert.ok(budget - english.length >= 10, `only ${budget - english.length} units of headroom left`)
  const declared = en('compactRules')
  for (let index = 0; index < declared.length; index += 1) {
    assert.ok(english.includes(`${index + 1}. ${declared[index]}`), `rule ${index + 1} survives whole`)
  }
})

test('the layered shares add up and scale with coreBudget', () => {
  // Four blocks, one budget: the ratios have to sum to 1, or the promise "4000
  // units total" is either a lie (over) or leaves room nobody can use (under).
  const total = LAYERED_SHARES.project + LAYERED_SHARES.user + LAYERED_SHARES.rules + LAYERED_SHARES.directory
  assert.equal(Math.round(total * 1000) / 1000, 1, `the shares sum to ${total}`)

  for (const coreBudget of [4000, 8000, 20000]) {
    const sum = ['project', 'user', 'rules', 'directory'].reduce((acc, block) => acc + shareOf(coreBudget, block), 0)
    assert.ok(sum <= coreBudget, `coreBudget ${coreBudget}: the shares ask for ${sum}`)
    // Flooring each share loses at most a unit per block.
    assert.ok(coreBudget - sum <= 4, `coreBudget ${coreBudget}: ${coreBudget - sum} units unallocated`)
  }
})

test('the rules share is sized for English, not just Chinese', () => {
  // The bug this guards: at 12.5% the English rules block could not hold a
  // daily-file rule, and `fitText` dropped it without a word — so English
  // sessions never learned daily files exist while Chinese ones did. English
  // needs ~660 units for the same five rules that cost Chinese ~410.
  const en = createTranslator('en')
  const zh = createTranslator('zh')
  const { cfg, probe } = fixture({ config: { inject: { mode: 'layered' } } })
  const english = renderSections({ cfg, probe, t: en }).find((item) => item.name === 'workbuddy-memory:rules').text
  const chinese = renderSections({ cfg, probe, t: zh }).find((item) => item.name === 'workbuddy-memory:rules').text

  assert.ok(english.length > 500, `English really is the long one: ${english.length} units`)
  assert.ok(english.length <= shareOf(cfg.inject.coreBudget, 'rules'), 'and it still fits its share')
  // Both languages must carry every rule, not just the ones that fit.
  for (const [name, block] of [['en', english], ['zh', chinese]]) {
    const declared = (name === 'en' ? en : zh)('compactRules')
    for (let index = 0; index < declared.length; index += 1) {
      assert.ok(block.includes(`${index + 1}. ${declared[index]}`), `${name}: rule ${index + 1} survives whole`)
    }
  }
})

// ── measureSource: what the panel shows, taken from the prompt's own rules ──

/** The project block the prompt received, and the state it was recorded under. */
function injected(text, config, lang = 'zh') {
  const { cfg, probe } = fixture({ project: text, user: undefined, config })
  const translate = createTranslator(lang)
  const sections = renderSections({ cfg, probe, t: translate })
  const block = sections.find((section) => section.name === 'workbuddy-memory:project')
  return { cfg, sections, state: sections.states.project, block: block?.text ?? null, t: translate }
}

const measure = (cfg, t, file) => measureSource({ cfg, t, key: 'project', file })
const whole = (text) => ({ exists: true, read: 'ok', text })
const layered = { inject: { mode: 'layered' } }

/** A topic section long enough to bring the whole file to `total` UTF-16 units. */
const padded = (head, total) => {
  const row = '- 资料条目，占位。\n'
  return head + row.repeat(Math.ceil((total - head.length) / row.length))
}

test('a layered file with a long tail and a small core is measured as complete', () => {
  // Acceptance 1: 12,000 units of file, 1,000 units of core. The old panel
  // compared the whole file against `limits.project` and lit up red.
  const head = `# M\n\n## 常驻记忆\n- ${'c'.repeat(996)}\n\n## 资料\n`
  const text = padded(head, 12000).slice(0, 12000)
  assert.equal(text.length, 12000)
  const { cfg, state, block, t } = injected(text, layered)
  const result = measure(cfg, t, whole(text))

  assert.equal(result.status, 'complete')
  assert.equal(result.overLimit, false)
  assert.equal(result.dropped, 0)
  assert.equal(result.mode, 'layered')
  assert.equal(result.fallback, null)
  assert.equal(result.state, state)
  assert.equal(result.budget, shareOf(cfg.inject.coreBudget, 'project'))
  assert.equal(result.used, block.length, 'the injected size is the block the prompt received')
  assert.ok(result.need < result.budget, 'the whole core fits')
})

test('a layered file whose core is over its share reports the entries the prompt left out', () => {
  // Acceptance 2: 9,000 units of file, 1,800 units of core.
  const core = Array.from({ length: 6 }, (_, index) => `- 核心条目 ${index} ${'重要'.repeat(140)}`)
  const head = `# M\n\n## 常驻记忆\n${core.join('\n')}\n\n## 资料\n`
  const text = padded(head, 9000)
  assert.ok(text.length >= 9000 && text.length < 10000, `fixture is ${text.length} units: under limits.project`)
  const { cfg, state, block, t } = injected(text, layered)
  const result = measure(cfg, t, whole(text))

  assert.equal(result.status, 'core-over-budget')
  assert.equal(result.overLimit, true)
  assert.match(state, /^layered:core-over-budget\(\d+\)$/)
  assert.equal(result.dropped, Number(/\((\d+)\)/.exec(state)[1]), 'the same count the prompt records')
  assert.ok(result.dropped > 0 && result.dropped < 6)
  assert.equal(result.used, block.length)
  assert.ok(result.need > result.budget)
})

test('a core that needs exactly its share can still lose the single entry to the notice reservation', () => {
  // Measured before the refactor: a one-entry core block needing exactly 1,400
  // units is dropped, because the overflow notice is reserved first.
  const label = t('section.project')
  const prefix = `### ${label}\n\n`.length
  const heading = `## ${t('coreHeading')}`.length
  const body = Array.from({ length: 1 }, () => `- ${'c'.repeat(1400 - prefix - heading - 1 - 2)}`)
  const text = `# M\n\n## 常驻记忆\n${body.join('\n')}\n`
  const { cfg, state, t: translate } = injected(text, layered)
  const result = measure(cfg, translate, whole(text))

  assert.equal(result.need, 1400, `the complete block needs exactly the share: ${result.need}`)
  assert.equal(result.budget, 1400)
  assert.equal(result.status, 'core-over-budget')
  assert.equal(result.dropped, 1)
  assert.equal(result.state, state)
})

test('whole-file truncation comes from the render, not from chars > limit', () => {
  // Acceptance 3: an English wrapper costs 20 units, so 9,998 units of body do
  // not fit a 10,000 limit. The old `chars > limit` check called this file fine.
  const cases = [
    ['y'.repeat(9998), 'truncated'],
    ['y'.repeat(9980), 'complete'],
    ['y'.repeat(9981), 'truncated'],
    [`\n\n   ${'y'.repeat(9980)}\n\n   `, 'complete'],
  ]
  for (const [text, expected] of cases) {
    const { cfg, state, block, t } = injected(text, {}, 'en')
    const result = measure(cfg, t, whole(text))
    assert.equal(result.status, expected, `${text.trim().length} body units`)
    assert.equal(result.mode, 'whole')
    assert.equal(result.fallback, null)
    assert.equal(result.budget, cfg.inject.limits.project)
    assert.equal(result.need, `### ${t('section.project')}\n\n`.length + text.trim().length)
    assert.equal(result.overLimit, expected === 'truncated')
    assert.equal(result.used, block.length, 'the injected size is the block the prompt received')
    assert.equal(result.state, state)
    if (expected === 'truncated') assert.ok(result.need > result.budget)
  }
})

test('a limit that cannot hold the wrapper is reported as an omitted block', () => {
  const prefix = `### ${t('section.project')}\n\n`.length
  for (const limit of [prefix - 1, prefix]) {
    const { cfg, state, block, t: translate } = injected('## Notes\n- one\n', { inject: { limits: { project: limit } } })
    const result = measure(cfg, translate, whole('## Notes\n- one\n'))
    assert.equal(block, null, `limit ${limit}: nothing reaches the prompt`)
    assert.equal(state, 'full:too-small')
    assert.equal(result.status, 'omitted')
    assert.equal(result.overLimit, true)
    assert.equal(result.used, 0)
    assert.equal(result.need > result.budget, true)
    assert.equal(result.state, state)
  }
})

test('the panel state follows the prompt ladder: missing, off, empty, unreadable, then measured', () => {
  const text = '## 偏好\n- 一条\n'
  const base = injected(text, {})

  const missing = measure(base.cfg, base.t, { exists: false })
  assert.equal(missing.status, 'missing')
  assert.equal(missing.overLimit, false)
  assert.equal(missing.mode, null)
  assert.equal(missing.state, 'disabled', 'the prompt records a missing source as disabled too')

  for (const patch of [{ enabled: false }, { project: false }, { limits: { project: 0 } }]) {
    const { cfg, t: translate, state } = injected(text, { inject: patch })
    const off = measure(cfg, translate, whole(text))
    assert.equal(off.status, 'disabled', JSON.stringify(patch))
    assert.equal(off.overLimit, false)
    // The master switch is applied above `renderSections` (by the section
    // provider), so only the two source-level switches share its state string.
    if (!('enabled' in patch)) assert.equal(off.state, state)
    // A switch off outranks an unreadable file: there is nothing to measure.
    assert.equal(measure(cfg, translate, { exists: true, read: 'unreadable' }).status, 'disabled')
  }

  const blank = measure(base.cfg, base.t, whole('  \n\n'))
  assert.equal(blank.status, 'empty')
  assert.equal(blank.overLimit, false)

  for (const reason of ['unreadable', 'changed', 'too_large', 'not_a_file']) {
    const unreadable = measure(base.cfg, base.t, { exists: true, read: reason })
    assert.equal(unreadable.status, 'unmeasurable', reason)
    assert.equal(unreadable.reason, reason)
    assert.equal(unreadable.overLimit, false, 'an unmeasured file is not counted as over budget')
  }
})

test('a file that falls back to whole-file injection in layered mode says so', () => {
  const { cfg, t, state } = injected('## 偏好\n- 一条\n', layered)
  const result = measure(cfg, t, whole('## 偏好\n- 一条\n'))
  assert.equal(result.mode, 'whole')
  assert.equal(result.fallback, 'legacy')
  assert.equal(result.reason, 'missing_core')
  assert.equal(result.status, 'complete')
  assert.equal(result.state, state)
})

test('measureSource agrees with the prompt on every block it injects', () => {
  const long = Array.from({ length: 12 }, (_, index) => `- entry ${index} ${'核心偏好内容'.repeat(30)}`)
  const table = [
    ['full', {}, '## 偏好\n- 一条\n'],
    ['full', {}, 'y'.repeat(9998)],
    ['full', { inject: { limits: { project: 40 } } }, `## Notes\n- ${'x'.repeat(200)}\n`],
    ['full', { inject: { limits: { project: 19 } } }, '## Notes\n- one\n'],
    ['full', {}, `## 😀\n${'😀'.repeat(6000)}\n`],
    ['layered', layered, '# M\n\n## 常驻记忆\n- a\n- b\n\n## 主题\n- t\n'],
    ['layered', layered, `# M\n\n## 常驻记忆\n${long.join('\n')}\n`],
    ['layered', { inject: { mode: 'layered', coreBudget: 4200 } }, `# M\n\n## 常驻记忆\n${long.join('\n')}\n`],
    ['layered', layered, '## 偏好\n- 一条\n'],
    ['layered', layered, 'y'.repeat(12000)],
    ['layered', layered, '# M\n\n## 常驻记忆\n- fine\nprose\n'],
    ['layered', layered, '# M\n\n## 常驻记忆\n\n## 主题\n- t\n'],
  ]
  for (const [, config, text] of table) {
    for (const lang of ['zh', 'en']) {
      const label = `${JSON.stringify(config)} ${lang} ${text.slice(0, 12)}`
      const { cfg, state, block, t: translate } = injected(text, config, lang)
      const result = measure(cfg, translate, whole(text))
      assert.equal(result.state, state, `${label}: state`)
      assert.equal(result.used, block === null ? 0 : block.length, `${label}: injected units`)
      // Read the answer off what the prompt received, not off the measurement:
      // a whole-file block that is shorter than wrapper plus file has lost
      // body (with or without a note — a small limit cannot fit the note), and
      // a split file has lost entries when its state says so.
      const full = `### ${translate('section.project')}\n\n`.length + text.trim().length
      const lost = block === null || (result.mode === 'whole' ? block.length < full : /core-over-budget/.test(state))
      const lostEntries = /core-over-budget\((\d+)\)/.exec(state)
      assert.equal(result.overLimit, lost, `${label}: overLimit`)
      if (lostEntries) assert.equal(result.dropped, Number(lostEntries[1]), `${label}: dropped`)
      assert.equal(result.need > result.budget, lost, `${label}: what was lost did not fit`)
    }
  }
})
