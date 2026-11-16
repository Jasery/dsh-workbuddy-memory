# dsh-workbuddy-memory

English | [中文](README.zh.md)

Share one set of memory files between DSH and WorkBuddy: the `MEMORY.md`, daily notes and user profile that WorkBuddy writes are read straight into the DSH context, and written back through guarded tools. No second copy, no sync daemon, and no WorkBuddy install required — if the files are already there, they are reused as they are.

## What reaches the prompt

By default the plugin injects **layered**: a small always-on core plus a directory of topic names that the model can look up on demand with `memory_read` / `memory_search`.

- **Core** is the file's single `## 常驻记忆` (or `## Core Memory`, case-insensitive) section. Only complete bullet entries are injected, and the section is a *prefix*: the scan stops at the first entry that does not fit instead of skipping ahead. When entries are left out, the block says how many.
- **Topic directory** lists the remaining `##` headings (plus the user-profile entry), so the model knows what exists without carrying it. A truncated list says it is truncated.
- **Budget**: `inject.coreBudget` defaults to **4000** and accepts 4000–20000, measured in **UTF-16 code units** including every wrapper. It is split 37.5% / 37.5% / 12.5% / 12.5% across the project core, the user core, the fixed rules, and the topic directory plus compatibility notes. Wrappers, complete entries and surrogate pairs all count against that share; nothing is cut mid-character.
- `inject.mode: 'full'` is the compatibility and troubleshooting fallback: each file is injected whole under its own `inject.limits.*` value, the way earlier versions did.
  In layered mode `inject.limits.project` / `.user` only decide whether that source is on at all (0 turns it off); the real ceiling is `coreBudget`. One exception worth knowing: the panel's "over limit" chip still compares the file against `inject.limits.project`, which is a size warning, not a statement about what was injected.
- A file **without** a core section keeps legacy whole-file injection under its own `inject.limits.*` and is reported as `legacy:missing_core` / `legacy:ambiguous_core` / `legacy:invalid_core` / `legacy:non_entry_content` in `memory_status`. Legacy text is deliberately **not** counted against `coreBudget`. Nothing rewrites an old file on its own: the split is the user's decision, made in the panel.
- An empty core section is valid and is not a compatibility state: the block carries the heading and no entries. A duplicated core section is ambiguous and falls back to legacy rather than guessing which one is meant.

`inject.refresh` stays `on-change` by default: the blocks are recomputed for each assembly, the file cache re-checks `mtime`/`ctime`/`size` on every read, and a committed write invalidates that file's cached text. `first-turn` freezes one snapshot per session instead.

## Install

```bash
dsh plugin --profile web add dsh-workbuddy-memory
```

Local development, when the profile's pnpm store was made by another major version:

```bash
node scripts/dev-install.mjs web
```

That links the profile to this checkout (a junction on Windows, a directory symlink
elsewhere), so a source edit needs only a profile restart — no re-install. The profile
then depends on this checkout staying in place; pass `--copy` for a self-contained
install that must be re-run after each edit.

Do **not** hand-write an `insert:` block into `cordis.patch.yml`: the inserted entry and the entry the config card writes end up as two records with the same id. The card writes an id-targeted override that merges into the bundle's entry.

Requires DSH `>= 0.2.0`; developed and verified against `0.2.0-rc.2` and `0.2.2-rc.1`.

## Files it reads

| Block | File | Note |
|---|---|---|
| Project memory | `<cwd>/<dataFolder>/memory/MEMORY.md` | `dataFolder` defaults to `.workbuddy`; injected |
| Daily notes | `<cwd>/<dataFolder>/memory/YYYY-MM-DD.md` | that day's log; **not injected**, path only |
| User memory | `<workbuddyHome>/MEMORY.md` | injected |
| User profile | `<workbuddyHome>/USER.md` or `user-<uid>-personal/USER.md` | read-only; skipped when several candidates exist and no `profileUid` is set |

An empty `workbuddyHome` follows WorkBuddy's own order: `WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` → `~/.workbuddy`.

## First use

- **Reading creates nothing.** No directory, no state directory, no receipt. Loading the plugin into a fresh machine and looking around is a read-only operation.
- **The first legitimate write creates the layout**: `write.ensureLayout` defaults to `true`, so an append into `<cwd>/<dataFolder>/memory` creates that directory (and the file, with a `# Memory` / `## Core Memory` skeleton) when it is missing. Set `write.ensureLayout: false` to turn that off — the write is then refused with `no_store`.
- A refused write creates nothing either: the argument checks run before any `mkdir`, so a `multiline_text` refusal leaves the filesystem untouched.
- Existing WorkBuddy directories and files are used in place. WorkBuddy does not have to be installed.

## Tools

Five tools are registered for the model:

| Tool | What it does |
|---|---|
| `memory_status` | resolved paths, active mode, compatibility states, writability, and the latest plugin contribution |
| `memory_read` | read one target; returns the revision and the section list |
| `memory_search` | literal search across the memory files (not registered at all when `search.enabled: false`) |
| `memory_append` | append one entry to a section, or one line to today's note |
| `memory_edit` | replace or delete one entry (only `- ` entries; an ambiguous match is refused) |

Bulk management — rewriting a whole section, restoring a backup, archiving old daily notes — is done **in the panel**, where a person sees a preview and a diff before the write. Those actions are deliberately not tools: the same destructive edit driven by a model has nothing in front of it but its own reasoning, and a version fence cannot ask "did you mean this?". There are no alias stubs for the retired tool names either — a definition that only ever refuses still advertises an ability the model does not have.

Entry model: an entry is "the `- ` line plus its continuation lines (indent of 2+ spaces or a tab) and nested sub-bullets". `memory_edit` replaces and removes the whole span, so a wrapped entry never leaves orphaned text behind. Both `memory_append` and `memory_edit` take one entry per call: a newline in `text` returns `multiline_text`, while a newline in `replacement` is written as a continuation of the same entry.

Sections: a duplicated heading returns `ambiguous_section` with line numbers (address it by line instead); a blank heading returns `empty_heading`; bullets sitting directly under the H1, above the first `##`, are addressed with `section: "(top)"` or the document's own H1 title.

## Writes, conflicts and recovery

Every write — tool or panel — goes through one path: cross-process lock → revision check → backup → atomic replace → verified post-read. Editing memory files with `write` / `edit` / `str_replace_editor` / `apply_patch` is refused by the guard (it classifies by real path, so a symlink or junction into the memory directory is refused too). That is a guard against accidents, not a security boundary: it does not stop a shell command.

A destructive rewrite must name the revision it saw. When the file changed underneath, the answer is `conflict` and the write does not land. The panel's conflict dialog offers exactly three ways out — **reload** (discard the draft and show the file as it is), **keep the draft and keep editing**, and **view the on-disk diff** — and there is deliberately no "overwrite anyway": that button would drop the `expectedRevision` the fence exists to check, and discard whatever the other client had just written. Source mode keeps `code.conflict` in its banner ("the file changed while you were editing"), and the version-history dialog says to pick a version again, because that is the action available there.

Backups are per file and per write, named by time plus a random suffix, created exclusively so two writes in the same millisecond are two files. Undo in the panel is a ten-second window bound to the write that produced it (its file, its project, its revision), not to whatever document is on screen.

Idempotency: pass the same `operationId` to replay a request instead of writing twice. An id is bound to the action, the target set and the request body, so reusing it for a different request is refused with `operation_mismatch` instead of returning the other write's result. Replaying a committed operation returns the original result with `duplicate: true`.

## Panel

- **`Memory` in the left rail**: aggregates every DSH workspace plus recently seen session directories; expanding a project lists `MEMORY.md` and its daily notes.
- **`Project memory` tab in the right sidebar**: next to files/changes, scoped to the current project's memory plus the global stores.
- **Memory button in the session header**: opens or focuses that tab.

The panel supports entry editing (addressed by line, so the row a person clicked is the row that changes), section editing, whole-file source mode, a draft dialog (paste a body plus the revision it was written against; the diff is built only when that revision still matches), version history (list backups, preview the diff, restore the one that was previewed), archiving of old daily notes, and a ten-second undo. Archiving moves old daily files to `memory/archive/` and never writes `MEMORY.md`; a preview creates no directory and no state, and the apply is bound to the plan it was previewed from — a file that changed in between, or one that appeared after the preview, is refused rather than swept up.

The panel follows the app language: every string is registered with the host's
locale service, so switching DSH's language switches the panel too.

## Configuration

Common keys (the plugin page lists all of them):

| Key | Default | Meaning |
|---|---|---|
| `readOnly` | `false` | master switch; when on, every write is refused |
| `workbuddyHome` | `''` | empty follows the environment |
| `dataFolderName` | `''` | empty follows `WORKBUDDY_DATA_FOLDER_NAME`, then `.workbuddy` |
| `inject.enabled` | `true` | when off, nothing is injected at all |
| `inject.mode` | `layered` | `full` is the compatibility fallback |
| `inject.coreBudget` | `4000` | layered budget in UTF-16 code units, 4000–20000 |
| `inject.refresh` | `on-change` | `first-turn` freezes one snapshot per session |
| `inject.limits.*` | 10000 / 2000 / 8000 / 2000 | per-block limits for `full` mode and for legacy files (project / rules / user / profile); `0` disables that block in every mode |
| `inject.distillAbove` | `0` → twice `limits.user` | `inject.mode: 'full'` only: user memory size that makes the rules ask for a by-topic distillation; past `limits.user` itself the rules first warn that part of the file is unreadable |
| `inject.profileFile` / `inject.profileUid` | `''` | choose the profile file explicitly, or pick one candidate by account uid |
| `inject.sanitizePaths` | `true` | replace the home prefix with `~` in injected text |
| `write.enabled` | `true` | when off, every write returns `write_disabled` |
| `write.ensureLayout` | `true` | create the project memory directory on a valid first write |
| `write.backupKeep` | `20` | backups kept per file; `0` refuses destructive rewrites |
| `write.lockWaitMs` | `3000` | how long a writer waits for the lock before `lock_timeout` |
| `write.fsync` / `write.operationLog` | `true` | flush before rename; append to the operation ledger |
| `guard.enabled` | `true` | refuse bare `write` / `edit` / `apply_patch` into memory files |
| `ui.enabled` | `true` | when off, the panel and its routes are not registered |
| `ui.allowWriteActions` | `true` | master switch for panel writes |
| `ui.allowFullTextEdit` | `true` | whether source mode and drafts may rewrite a whole file |
| `ui.globalPanel` / `ui.projectTab` / `ui.sessionAction` | `true` | the three panel entries |
| `ui.refreshMs` / `ui.maxProjects` | `3000` / `50` | panel polling and scan bounds |
| `search.enabled` | `true` | when off, `memory_search` is not registered |
| `search.maxResults` / `search.indexMaxFileBytes` | `8` / `262144` | default hit limit and per-file scan cap |

`stateDir` and `locale` need a reload and stay YAML-only.

## Boundaries

Stated as they are, not as a security claim:

- **Without the panel** (headless, or `ui.enabled: false`) the model can read, search, append and edit single entries. Archiving old daily notes and restoring a historical version need the panel — there is no tool for them, by design.
- **`write.backupKeep: 0`** refuses destructive rewrites with `backup_required` (no way back, no rewrite). An ordinary append is still allowed: adding bytes cannot truncate what is already there.
- **Deduplication is bounded**: a committed receipt is remembered for 24 hours, up to 2000 records, with at most 100 unresolved ones. Past that window the same `operationId` is simply a new request.
- **External editors do not take this plugin's lock.** DSH against DSH is serialized; DSH against a non-locking editor (WorkBuddy's own `Edit`, a plain text editor) is only protected by the revision check, which catches changes it can see. Two writes landing inside the same few milliseconds can still collide, and the backup plus the recorded post-write revision are what make that recoverable rather than silent. One plugin instance owns a file at a time; two engines driving the same file is not supported.
- **`memory_status` does not report tokens.** `lastAssembly` is this plugin's own contribution in UTF-16 code units, measured after redaction, and it says so (`measuredAs: 'plugin-contribution'`). It is not the host's final prompt and not a token count or a cost.
- Read failures degrade to "inject nothing"; they never break a turn.
- The project block is skipped when the session working directory is unknown — it never falls back to `process.cwd()`.
- Memory is data: the injected block says so explicitly.

## Development

```bash
npm test
npm run test:coverage
```

Design notes live in [`docs/`](https://github.com/Jasery/dsh-workbuddy-memory/tree/main/docs): an implementation log
(`implementation-notes.md`) and the design documents (HTML).

## License

MIT
