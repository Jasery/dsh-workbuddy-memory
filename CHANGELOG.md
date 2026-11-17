# Changelog

English | [中文](CHANGELOG.zh.md)

Newest first. Every released version below is published on npm; dates are the
publish date. What each release changed is the whole point of this file — the
design rationale lives in [`docs/`](docs), not here.

## Unreleased

Nothing is versioned here until it is published.

### Breaking

- `ui.allowFullTextEdit` is removed, and with it the `full_text_disabled`
  refusal. Source mode and the draft dialog are no longer gated: `readOnly` and
  `write.enabled` are the only gates on a whole-file write. A profile that still
  carries the key keeps loading — unknown keys are ignored — so nothing has to be
  edited by hand.

### Added

- `inject.mode: 'layered'` (the new default): a small always-on core plus an
  on-demand topic directory, instead of every memory file injected whole.
  `'full'` remains as the compatibility and troubleshooting fallback.
- `inject.coreBudget`, default **4000** UTF-16 code units (range 4000–20000,
  wrappers included), split 37.5% project core / 37.5% user core / 12.5% rules /
  12.5% topic directory and compatibility notes.
- Panel: version history with a diff preview and restore, a draft dialog bound to
  the revision it was written against, archiving bound to its preview, and a
  ten-second undo bound to the write that produced it.
- Persistent operation receipts under `<stateDir>/receipts/`, so a retried write
  with the same `operationId` replays instead of writing twice.

### Changed

- The model-facing tool set is five: `memory_status`, `memory_read`,
  `memory_search`, `memory_append`, `memory_edit`.
  `memory_replace_section`, `memory_list_revisions`, `memory_restore` and
  `memory_prune` are gone, with no alias stubs. The store methods and HTTP routes
  stay; bulk management is a panel action now, where a person sees a preview and
  a diff first.
- `inject.refresh: 'first-turn'` freezes one snapshot **per session** instead of
  per working directory, so a new session in the same project reads the files as
  they are. Committed writes invalidate that file's cached text.
- `memory_status` reports `lastAssembly` with `measuredAs:
  'plugin-contribution'` and no longer offers an estimated injected-character
  count. The numbers are this plugin's contribution in UTF-16 code units, not the
  host's final prompt or a token count.
- Every write — tool or panel — runs one path: operation lock → receipt
  transaction → file lock → revision check → backup → receipt `applying` →
  atomic replace → verified post-read.
- Reads are bounded: `readTextSafe` always reads through the descriptor, and a
  file changed mid-read reports `changed` rather than returning a torn prefix.
  `memory_read` gains UTF-16 pagination.
- Panel writes go through the host's trust fence
  (`connection.requestRejection`, read lazily, degrading to a local origin check)
  and require `application/json`.
- Refusals inside a modal are shown in the modal, not only in the banner behind
  its mask. A late response for a project or draft that has since changed is
  discarded.
- The config card writes nested keys by path segments. It previously passed a
  dotted string as one field name, which the host refused as "not volatile", so
  19 of its 22 controls could not be saved.

### Fixed

- A destructive rewrite always requires `expectedRevision`; a revision mismatch is
  refused as `conflict`. The panel's conflict dialog offers exactly three exits —
  reload, keep the draft, view the on-disk diff — and deliberately no overwrite.
- A crash between the write and its receipt is resolved conservatively: matching
  the recorded *before* revision is not treated as proof the write never ran, so
  it answers `outcome_unknown` and leaves the decision to a person.
- Backups are exclusive-created with a time plus random suffix, so two writes in
  the same millisecond produce two files.
- `write.backupKeep: 0` refuses destructive rewrites with `backup_required`;
  an ordinary append is still allowed, because adding bytes cannot truncate.
- An empty or heading-only legacy file can take its first write; a file with
  content still requires the layering confirmation.
- An over-budget core says how many entries were left out; a truncated topic
  directory says there is more.
- The core section is a prefix: it stops at the first entry that does not fit
  rather than skipping ahead to a shorter one. Duplicated core sections are
  ambiguous and fall back to legacy; empty ones are valid.
- Archiving: a preview creates no directory, no archive and no receipt. An apply
  is bound to the project, the date set and each source's revision, so a file
  changed after the preview is refused (`plan_conflict`) and a file created after
  it is not swept up. A partial outcome is reported with moved and failed lists
  and resumes by manifest instead of re-enumerating.

### Notes

- A memory file with no core section keeps legacy whole-file injection and
  reports `legacy:missing_core` / `legacy:ambiguous_core` / `legacy:invalid_core`
  / `legacy:non_entry_content`. Nothing rewrites an old file automatically.
- The conservative fallback is wide: a plain paragraph, an `###` sub-heading, a
  code fence or a 1-space continuation line in a topic section drops the whole
  file back to legacy injection.
- Deduplication is promised only inside the receipt window (24 hours / 2000
  records, 100 unresolved).
- An external editor does not take this plugin's lock: DSH against DSH is
  serialized, DSH against a non-locking editor is protected only by the revision
  check, and a write landing in the same few milliseconds is recoverable through
  the backup rather than prevented.
- Verified on Windows 11 with Node 24.14.0 only. Linux and Node 20 have not been
  run, and no token or cost saving is claimed.

## 0.1.4 — 2026-11-12

- The config card exposes the injection limits and the distillation threshold.
  Both keys were readable only by hand-editing the profile YAML before, which the
  README tells people not to do.
- Removed two accidentally committed scratch files, and added `.cmsg*.txt` to
  `.gitignore`.

## 0.1.3 — 2026-11-12

- The panel follows the host language. Every string is registered with the host's
  locale service, so switching DSH's language switches the panel with it.
- The client declares the `locale` service in its `inject` list. Without that
  entry the panel silently kept its own copy and never followed the app language.
- `scripts/dev-install.mjs` links the profile to this repository (a junction on
  Windows, a directory symlink elsewhere) instead of copying, so a source change
  needs only a profile restart.

## 0.1.2 — 2026-11-12

- `inject.limits.user` is configurable, default **8000** UTF-16 code units.
- `inject.distillAbove` adds a distillation threshold: when user memory grows
  past it, the injected rules say the file is due for a by-topic distillation.
  Its default follows `limits.user` (twice that value), so tuning the limit alone
  moves the threshold with it.
- `memory_status` reports the resolved limits and the distillation threshold.

## 0.1.1 — 2026-11-11

- Tool results survive the host's lossless-JSON gate. The host snapshots every
  tool result and rejects it when any property is `undefined`, not finite, or
  `-0` — *after* the write already landed, so a caller saw a failure for a write
  that had succeeded, and a retry without the same idempotency key wrote twice.
  Results now use `null` instead of `undefined`, with a wrapper at the tool
  registration site as a backstop.
- The injected rules say when a write is worth making, so the model stops
  recording one-off answers and in-progress state.

## 0.1.0 — 2026-11-11

First public release.

- Four injection blocks: project memory, project rules, user memory, user
  profile. `inject.refresh: 'on-change'` by default, `'first-turn'` as the
  alternative.
- Five tools: `memory_status`, `memory_read`, `memory_search`, `memory_append`,
  `memory_edit`. `memory_prune` archives old daily notes from the model side.
- One write path for tools and panel: cross-process lock, revision check,
  backup, atomic replace, verified post-read.
- A guard refuses a bare `write` / `edit` / `apply_patch` against a memory file,
  so edits go through `memory_*` instead.
- Sidebar panel: a global overview across DSH workspaces plus a per-project tab,
  with segmented rendering, inline entry editing, search, tidy-up and rollback.
  Old daily notes are archived, never folded into `MEMORY.md`.
- Panel routes reach the host's trust fence, and a truncated file cannot be
  written back section by section.
- A config card backed by volatile fields, so changes apply without editing YAML.
- Existing WorkBuddy directories and files are reused in place; no WorkBuddy
  install is required.
- Reading creates nothing. The first legitimate write creates the layout
  (`write.ensureLayout`, default `true`).
