# Changelog

Notable changes to this plugin. No release dates are recorded here: a version number
appears only once it is actually published, and this file is not a release log.

## Unreleased — memory optimisations

### Injection is layered by default

- `inject.mode` is now `'layered'`: a small always-on core plus an on-demand topic
  directory, instead of every memory file injected whole. `'full'` remains as the
  compatibility and troubleshooting fallback.
- The core is the file's single `## 常驻记忆` / `## Core Memory` (case-insensitive,
  fenced blocks ignored). Only complete bullet entries are injected, and the core is a
  prefix: it stops at the first entry that does not fit rather than skipping ahead. An
  over-budget core says how many entries were left out.
- New `inject.coreBudget`, default **4000** (4000–20000 UTF-16 code units, wrappers
  included), split 37.5% project core / 37.5% user core / 12.5% rules / 12.5% topic
  directory and compatibility notes.
- A file without a core section keeps legacy whole-file injection and reports
  `legacy:missing_core` / `legacy:ambiguous_core` / `legacy:invalid_core` /
  `legacy:non_entry_content`. Nothing rewrites an old file automatically; the
  core/topic split stays the user's decision.
- Empty core sections are valid; duplicated ones are ambiguous and fall back to legacy.
- Every block is measured in UTF-16 code units, never splitting a surrogate pair, and
  the truncation/overflow notices are reserved inside the budget they describe.

### The snapshot is scoped to a session

- `inject.refresh: 'first-turn'` now freezes one snapshot **per session** instead of per
  working directory, so a new session in the same project reads the files as they are.
- Committed writes invalidate the affected file's cached text and bump the generation.
- `memory_status` reports `lastAssembly` with `measuredAs: 'plugin-contribution'` and
  no longer offers an estimated injected-character count; the numbers are this plugin's
  contribution in UTF-16 code units, not the host's final prompt or a token count.

### Five model tools; bulk management moved to the panel

- The registered set is `memory_status`, `memory_read`, `memory_search`,
  `memory_append`, `memory_edit`. `memory_replace_section`, `memory_list_revisions`,
  `memory_restore` and `memory_prune` are gone, with no alias stubs: a definition that
  only ever refuses still advertises an ability the model does not have.
- Rewriting a section, restoring a backup and archiving old daily notes are panel
  actions now, where a person sees a preview and a diff first. The store methods and
  the HTTP routes stay; only the model-facing wrappers were removed.
- `search.enabled: false` removes `memory_search` from the catalog entirely.

### One write path, with receipts

- Every write — tool or panel — runs operation lock → receipt transaction → file lock →
  revision check → backup → receipt `applying` → atomic replace → verified post-read.
- New persistent, bounded operation receipts (`<stateDir>/receipts/`): committed records
  expire after 24 hours, up to 2000 records, with at most 100 unresolved ones that are
  never evicted. A store at capacity refuses the new operation instead of deleting
  evidence.
- An `operationId` is bound to the action, the target set and the request body, so
  reusing it for a different request is refused with `operation_mismatch` instead of
  returning the other write's result. Replaying a committed operation returns the
  original result with `duplicate: true`.
- A crash between the write and the receipt is resolved conservatively: matching the
  recorded *before* revision is not treated as proof the write never ran (the file could
  have been changed and changed back), so it refuses with `outcome_unknown` and leaves
  the decision to a person.
- Destructive rewrites require `expectedRevision`. There is no policy switch: the
  `write.conflictPolicy` key that once offered `overwrite` (and was read by nothing) is
  still absent, and the panel's conflict dialog deliberately offers no overwrite exit.
- Backups are exclusive-created with a time plus random suffix, so two writes in the
  same millisecond produce two files instead of one overwriting the other.
- `write.backupKeep: 0` refuses destructive rewrites with `backup_required`; an ordinary
  append is still allowed, because adding bytes cannot truncate what is there.

### Archiving is bound to its preview

- A prune preview creates no directory, no archive and no receipt; the plan lives in
  memory (100 plans, 10-minute TTL).
- An apply requires its `operationId` and `planId`, and is bound to the project, the
  date set and each source's revision. A file changed after the preview is refused
  (`plan_conflict`); a file created after the preview is not swept up.
- The apply takes the archive lock and then every source file lock, in sorted order,
  before moving anything. Partial outcomes are reported with the moved and failed lists,
  the manifest is persisted so a retry resumes instead of re-enumerating, and a failed
  final receipt update is never reported as success.

### Panel: management surfaces

- Entry editing addressed by line (the row that was clicked is the row that changes),
  section editing, whole-file source mode, a draft dialog bound to the revision it was
  written against, version history with a diff preview, archiving, and a ten-second undo
  bound to the write that produced it.
- A conflict offers exactly three exits — reload, keep the draft, view the on-disk diff.
  There is deliberately no "overwrite": that button would drop the `expectedRevision`
  the fence exists to check. Source mode keeps `code.conflict` in its banner, and the
  history dialog says to pick a version again.
- Refusals inside a modal are shown in the modal, not only in the banner behind its
  mask; a late response for a project or draft that has since changed is discarded.
- Panel writes go through the host's trust fence (`connection.requestRejection`, read
  lazily, degrading to a local origin check) and require `application/json`.

### Compatibility and limits

- No WorkBuddy install is required; existing directories and files are reused in place.
- Reading creates nothing. The first legitimate write creates the layout
  (`write.ensureLayout`, default `true`); `false` makes such a write fail with
  `no_store`. A refused write creates nothing at all.
- Without the panel, the model can read, search, append and edit single entries;
  archiving and version restore need the panel.
- Deduplication is promised only inside the receipt window (24 hours / 2000 records,
  100 unresolved).
- An external editor does not take this plugin's lock: DSH against DSH is serialized,
  DSH against a non-locking editor is protected only by the revision check, and a write
  landing in the same few milliseconds is recoverable through the backup rather than
  prevented. Two engines driving the same files is not supported.
- Verified on Windows 11 with Node 24.14.0 only. Linux and Node 20 have not been run,
  and no token or cost saving is claimed: no experiment with real model billing was done.
