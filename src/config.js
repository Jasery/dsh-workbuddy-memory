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
const CONFLICT_POLICIES = ['fail', 'merge', 'overwrite']

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
          user: z.number().default(4000),
          profile: z.number().default(2000),
        })
        .volatile(),
    }),

  write: z
    .object({
      enabled: z.boolean().default(true).volatile(),
      conflictPolicy: z.union(CONFLICT_POLICIES).default('fail').volatile(),
      lockWaitMs: z.number().default(3000).volatile(),
      backupKeep: z.number().default(5).volatile(),
      fsync: z.boolean().default(true).volatile(),
      operationLog: z.boolean().default(true).volatile(),
    }),

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
  const limits = inject.limits && typeof inject.limits === 'object' ? inject.limits : {}

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
      limits: {
        project: num(limits.project, 10000, 0, 200000),
        rules: num(limits.rules, 2000, 0, 200000),
        user: num(limits.user, 4000, 0, 200000),
        profile: num(limits.profile, 2000, 0, 200000),
      },
    },

    write: {
      enabled: bool(write.enabled, true),
      conflictPolicy: pick(write.conflictPolicy, CONFLICT_POLICIES, 'fail'),
      lockWaitMs: num(write.lockWaitMs, 3000, 0, 60000),
      backupKeep: num(write.backupKeep, 5, 0, 100),
      fsync: bool(write.fsync, true),
      operationLog: bool(write.operationLog, true),
    },

    search: {
      enabled: bool(search.enabled, true),
      maxResults: num(search.maxResults, 8, 1, 50),
      indexMaxFileBytes: num(search.indexMaxFileBytes, 262144, 1024, 4 * 1024 * 1024),
    },
  }
}
