/**
 * Plugin configuration.
 *
 * Every key a person is expected to change from the UI carries `.volatile()`:
 * the host only projects volatile fields into a settings form, and an entry
 * without any volatile field gets no form at all — which would leave the
 * plugin's config card an empty shell. Keys that need a plugin reload to take
 * effect (`stateDir`, `locale`) stay ordinary on purpose.
 */

import z from '@deepseek-ai/schemastery'

const REFRESH_MODES = ['first-turn', 'on-change']

export const Config = z.object({
  readOnly: z
    .boolean()
    .default(false)
    .description('Never write to WorkBuddy memory. Tools report read_only.')
    .volatile(),

  workbuddyHome: z
    .string()
    .default('')
    .description('WorkBuddy home. Empty follows WORKBUDDY_CONFIG_DIR / CODEBUDDY_CONFIG_DIR / ~/.workbuddy.')
    .volatile(),

  dataFolderName: z
    .string()
    .default('')
    .description('Per-workspace memory folder name. Empty follows WORKBUDDY_DATA_FOLDER_NAME or .workbuddy.')
    .volatile(),

  stateDir: z
    .string()
    .default('')
    .description('Index, backups and operation log root. Empty means <dsh home>/workbuddy-memory.'),

  inject: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      refresh: z.union(REFRESH_MODES).default('on-change').volatile(),
      project: z.boolean().default(true).volatile(),
      rules: z.boolean().default(true).volatile(),
      user: z.boolean().default(true).volatile(),
      profile: z.boolean().default(true).volatile(),
      profileFile: z.string().default('').volatile(),
      profileUid: z.string().default('').volatile(),
      sanitizePaths: z.boolean().default(true).volatile(),
      limits: z
        .object({
          project: z.number().default(10000),
          rules: z.number().default(2000),
          user: z.number().default(8000),
          profile: z.number().default(2000),
        })
        .description('Character limits per injected block. 0 disables the block.')
        .volatile(),
      // `0` means "derive from limits.user", which keeps the two keys in step
      // when only the limit is tuned. Anything else is an absolute character
      // count. A number cannot express "default to twice another key" in the
      // schema, so the default is resolved in normalizeConfig instead.
      distillAbove: z
        .number()
        .default(0)
        .description('User MEMORY.md characters above which the rules ask the model to distill by topic. 0 = twice limits.user.')
        .volatile(),
    }),

  write: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      // No `conflictPolicy`: a revision mismatch is always refused. The key used
      // to offer `fail | merge | overwrite` and nothing ever read it, so a person
      // who set `overwrite` still got `fail` — a switch that lies is worse than
      // no switch. `overwrite` is available where it is legible: the panel's
      // conflict dialog drops `expectedRevision` for one explicit click.
      lockWaitMs: z.number().default(3000).volatile(),
      // Memory tidy-up is a burst of small edits, which is exactly the case that
      // burns through a short rotation. Backups are plain text, so keeping more
      // costs almost nothing and buys back the rollback point.
      backupKeep: z.number().default(20).volatile(),
      fsync: z.boolean().default(true).volatile(),
      operationLog: z.boolean().default(true).volatile(),
      ensureLayout: z
        .boolean()
        .default(false)
        .description('Create <cwd>/<dataFolder>/memory on first write. Off by default: inventing a hidden folder can race WorkBuddy workspace setup.')
        .volatile(),
    }),

  guard: z.object({
    enabled: z.boolean().default(true).volatile(),
  }),

  ui: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      allowWriteActions: z.boolean().default(true).volatile(),
      allowFullTextEdit: z.boolean().default(true).volatile(),
      globalPanel: z.boolean().default(true).volatile(),
      projectTab: z.boolean().default(true).volatile(),
      sessionAction: z.boolean().default(true).volatile(),
      refreshMs: z.number().default(3000).volatile(),
      maxProjects: z.number().default(50).volatile(),
    })
    .description('Panel entries, polling and scan bounds.'),

  search: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      maxResults: z.number().default(8).volatile(),
      indexMaxFileBytes: z.number().default(262144).volatile(),
    }),

  locale: z.union(['auto', 'zh', 'en']).default('auto'),
})

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function num(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.min(Math.max(value, min), max)
  return Math.round(clamped)
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * Resolve the user-memory distillation threshold.
 *
 * `0` (and anything unusable) means "twice `limits.user`": the threshold is a
 * pressure gauge, so it should scale with the budget it measures. Deriving it
 * here instead of baking 16000 into the schema keeps the two in step when a
 * person tunes only the limit.
 *
 * A non-zero value is clamped to at least `limit + 1`, because a threshold at
 * or below the limit would ask for distillation before the block is even
 * truncated — noise on every turn.
 *
 * @param {unknown} raw - the configured `inject.distillAbove`.
 * @param {number} userLimit - the resolved `inject.limits.user`.
 * @returns {number} the character count that triggers a distillation hint.
 */
export function resolveDistillAbove(raw, userLimit) {
  const limit = Number.isFinite(userLimit) && userLimit > 0 ? userLimit : 0
  const derived = limit > 0 ? limit * 2 : 0
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return derived
  const clamped = Math.min(Math.max(Math.round(raw), 1), 2000000)
  return limit > 0 ? Math.max(clamped, limit + 1) : clamped
}

/**
 * Turn a possibly partial or invalid config into a complete one.
 *
 * Never throws: a bad config must degrade, not take the host down.
 *
 * @param {unknown} raw - the config the loader passed to `apply`.
 * @returns {object} a complete, clamped config.
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const inject = input.inject && typeof input.inject === 'object' ? input.inject : {}
  const write = input.write && typeof input.write === 'object' ? input.write : {}
  const search = input.search && typeof input.search === 'object' ? input.search : {}
  const guard = input.guard && typeof input.guard === 'object' ? input.guard : {}
  const ui = input.ui && typeof input.ui === 'object' ? input.ui : {}
  const limits = inject.limits && typeof inject.limits === 'object' ? inject.limits : {}

  const resolvedLimits = {
    project: num(limits.project, 10000, 0, 200000),
    rules: num(limits.rules, 2000, 0, 200000),
    user: num(limits.user, 8000, 0, 200000),
    profile: num(limits.profile, 2000, 0, 200000),
  }

  return {
    readOnly: bool(input.readOnly, false),
    workbuddyHome: text(input.workbuddyHome).trim(),
    dataFolderName: text(input.dataFolderName).trim(),
    stateDir: text(input.stateDir).trim(),
    locale: pick(input.locale, ['auto', 'zh', 'en'], 'auto'),

    inject: {
      enabled: bool(inject.enabled, true),
      refresh: pick(inject.refresh, REFRESH_MODES, 'on-change'),
      project: bool(inject.project, true),
      rules: bool(inject.rules, true),
      user: bool(inject.user, true),
      profile: bool(inject.profile, true),
      profileFile: text(inject.profileFile).trim(),
      profileUid: text(inject.profileUid).trim(),
      sanitizePaths: bool(inject.sanitizePaths, true),
      limits: resolvedLimits,
      // `0` is the "follow limits.user" sentinel, resolved here rather than in
      // the schema: schemastery has no way to default one key from another, and
      // a literal 16000 would silently stop tracking a tuned `limits.user`.
      distillAbove: resolveDistillAbove(inject.distillAbove, resolvedLimits.user),
    },

    write: {
      enabled: bool(write.enabled, true),
      lockWaitMs: num(write.lockWaitMs, 3000, 0, 60000),
      backupKeep: num(write.backupKeep, 20, 0, 100),
      fsync: bool(write.fsync, true),
      operationLog: bool(write.operationLog, true),
      ensureLayout: bool(write.ensureLayout, false),
    },

    guard: {
      enabled: bool(guard.enabled, true),
    },

    ui: {
      enabled: bool(ui.enabled, true),
      allowWriteActions: bool(ui.allowWriteActions, true),
      allowFullTextEdit: bool(ui.allowFullTextEdit, true),
      globalPanel: bool(ui.globalPanel, true),
      projectTab: bool(ui.projectTab, true),
      sessionAction: bool(ui.sessionAction, true),
      refreshMs: num(ui.refreshMs, 3000, 500, 60000),
      maxProjects: num(ui.maxProjects, 50, 1, 500),
    },

    search: {
      enabled: bool(search.enabled, true),
      maxResults: num(search.maxResults, 8, 1, 50),
      indexMaxFileBytes: num(search.indexMaxFileBytes, 262144, 1024, 4 * 1024 * 1024),
    },
  }
}
