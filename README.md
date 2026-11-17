# dsh-workbuddy-memory

English | [中文](README.zh.md)

Let DSH share the memory files WorkBuddy already writes — no second copy, no
WorkBuddy install needed.

Injection is **layered**: a small core stays always-on, the rest is listed by
topic and read on demand. On two real memory files that took the always-on part
from 12,678 characters to 2,922 with nothing dropped.

## What the model sees

By default the plugin injects **layered**: a small always-on core, plus a list of
topic names the model can look up when it needs them.

- **Core** is the file's `## 常驻记忆` (or `## Core Memory`) section. Only complete
  entries go in, and the core is a *prefix* — if an entry does not fit, the block
  stops there rather than skipping ahead, and says how many were left out.
- **Topic list** names the remaining sections, each as `<source>/<name>`, with one
  line saying how to read them (`memory_read` for a whole topic, `memory_search`
  for a single fact). A truncated list says it is truncated.
- **Budget** is `inject.coreBudget` — 4000 UTF-16 units by default, 4000–20000 —
  split across the project core, the user core, the fixed rules and the topic
  list.
- `inject.mode: 'full'` is the compatibility fallback: every file injected whole
  under its own limit, the way earlier versions did.

A file with no core section is injected whole and reported as `legacy:*` by
`memory_status`; the panel shows it as a banner with its size. Nothing rewrites an
old file on its own — the split is your decision, made in the panel.

**Keep topic bodies to `- ` entries.** A topic section may hold bullet entries,
their indented continuations, and blank lines. Add anything else — one prose
sentence, an `###` sub-heading, a fenced block — and the *whole file* falls back
to whole-file injection, because a file that cannot be split reliably is not
split. The fallback is visible, but it is the behaviour most likely to look like
a bug.

## Tools

Five, and only five:

| Tool | What it does |
|---|---|
| `memory_status` | resolved paths, active mode, compatibility states, writability |
| `memory_read` | read one target; returns the revision and the section list |
| `memory_search` | literal search across the memory files |
| `memory_append` | append one entry to a section, or one line to today's note |
| `memory_edit` | replace or delete one entry |

Bulk work — rewriting a section, restoring a backup, archiving old daily notes —
happens **in the panel**, where a person sees the diff before the write. Those are
deliberately not tools: the same destructive edit driven by a model has nothing in
front of it but its own reasoning.

## Panel

A `Memory` entry in the left rail, a `Project memory` tab in the right sidebar,
and a button in the session header. From there you can edit entries and sections,
rewrite the whole file, paste a draft the model produced (diffed, and refused
unless the revision it was written against still matches), browse and restore
backups, archive old daily notes, and undo a write for ten seconds.

## Safety

Every write — tool or panel — goes through the same path: lock → revision check →
backup → atomic replace → verify. A destructive rewrite must name the revision it
saw; if the file changed underneath, the answer is `conflict` and nothing lands.
There is no "overwrite anyway", by design. Editing memory files with `write` /
`edit` / `apply_patch` is refused, so a model cannot route around the tools.

This is a guard against accidents, not a security boundary: it does not stop a
shell command.

## Install

```bash
dsh plugin --profile web add dsh-workbuddy-memory
```

Requires DSH `>= 0.2.0`. Do not hand-write an `insert:` block into
`cordis.patch.yml` — the config card writes an id-targeted override, and both
together become two records with the same id.

Working on the plugin itself:

```bash
node scripts/dev-install.mjs web   # links the profile to this checkout
```

A source edit then needs only a profile restart. Pass `--copy` for a
self-contained install that must be re-run after each edit.

## Files it reads

| Block | File |
|---|---|
| Project memory | `<cwd>/<dataFolder>/memory/MEMORY.md` |
| Daily notes | `<cwd>/<dataFolder>/memory/YYYY-MM-DD.md` — not injected |
| User memory | `<workbuddyHome>/MEMORY.md` |
| User profile | `<workbuddyHome>/USER.md` or `user-<uid>-personal/USER.md` — read-only |

`dataFolder` defaults to `.workbuddy`. An empty `workbuddyHome` follows
WorkBuddy's own order: `WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` →
`~/.workbuddy`.

Reading creates nothing — no directory, no state, no receipt. The first legitimate
write creates the layout, and a refused write creates nothing either.

## Configuration

The plugin page's config card covers the common ones:

| Key | Default | Meaning |
|---|---|---|
| `readOnly` | `false` | master switch; every write refused |
| `inject.mode` | `layered` | `full` is the compatibility fallback |
| `inject.coreBudget` | `4000` | layered budget, 4000–20000 UTF-16 units |
| `inject.limits.*` | 10000 / 2000 / 8000 / 2000 | per-block limits for `full` mode and legacy files (project / rules / user / profile) |
| `inject.distillAbove` | twice `limits.user` | user-memory size that makes the plugin say the file is due for distillation |
| `inject.profileUid` | `''` | pick one profile candidate by account uid |
| `workbuddyHome` | `''` | empty follows the environment |
| `dataFolderName` | `''` | empty follows `WORKBUDDY_DATA_FOLDER_NAME`, then `.workbuddy` |
| `write.backupKeep` | `20` | backups kept per file; `0` refuses destructive rewrites |
| `ui.allowWriteActions` | `true` | master switch for panel writes |
| `search.enabled` | `true` | when off, `memory_search` is not registered |

Everything else (`inject.refresh`, `inject.sanitizePaths`, `write.*`, `guard.*`,
the three `ui.*` panel entries, `search.maxResults`) is declared with its default
in `src/config.js` and can be set in the profile's `cordis.patch.yml`. `stateDir`
and `locale` are YAML-only and need a reload.

## When a write is refused

The panel explains these in your language; the model gets the same codes.

| Code | What to do |
|---|---|
| `conflict` | The file changed. Read it again, then decide — there is no overwrite. |
| `layering_confirmation_required` | The write would split an unsplit file. Confirm the split once via the panel's draft or source mode. |
| `receipt_capacity` | The receipt store is full. Delete finished records from `<stateDir>/receipts/` (default `~/.dsh/workbuddy-memory/receipts/`) — check unresolved ones first. |
| `backup_required` | `write.backupKeep` is `0`. Set it to at least 1; an ordinary append is still allowed. |
| `outcome_unknown` | Retry with the **same** operation id; a new one may run twice. |

## Limits

- Without the panel (headless, or `ui.enabled: false`) the model can read, search,
  append and edit single entries. Archiving and restoring need the panel.
- External editors do not take this plugin's lock. Against a non-locking editor
  only the revision check protects you, and it catches only changes it can see.
- Run one memory plugin per set of files. Two engines on one `MEMORY.md` have no
  coordination: locks mean nothing to each other, and the same entries get
  injected twice.
- Deduplication is bounded: a committed receipt is remembered for 24 hours, up to
  2000 records. Past that window the same `operationId` is a new request.
- `memory_status` reports this plugin's own contribution in UTF-16 units — not a
  token count, and not a cost.
- Read failures degrade to "inject nothing"; they never break a turn.
- Tested on Windows 11 with Node 24. Not verified on Linux or Node 20.

## Development

```bash
npm test
npm run test:coverage
```

Design documents and the implementation log live in [`docs/`](docs/).

## License

MIT
