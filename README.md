# dsh-workbuddy-memory

[![CI](https://github.com/Jasery/dsh-workbuddy-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Jasery/dsh-workbuddy-memory/actions/workflows/ci.yml)

English | [中文](README.zh.md)

Let DSH share the memory files WorkBuddy already writes — no second copy, no
WorkBuddy install needed.

Injection is **layered**: a small core stays always-on, the rest is listed by
topic and read on demand. What you save is context you would pay for every turn,
not capability — and it shows most on a long memory file.

## What the model sees

A memory file is split in two, and only one half reaches the context every turn:

```
MEMORY.md
│
├─ ## 常驻记忆 ──────────► injected every turn
│    - the entry needed every time   (a prefix: the scan stops at the first
│    - another one like that          entry that does not fit, and says how
│                                     many were left out)
│
└─ ## some topic ────────┐
   ## another topic ─────┼─► only the section names are injected
   ## a third topic ─────┘   memory_read fetches a whole topic on demand
```

So the prompt looks roughly like this:

```
### 项目记忆
## 常驻记忆
- the entry needed every time…

### 可按需查询的主题
- 常驻没写的先看这里：memory_read(target=前缀-memory, section=主题名)…
- project/some topic
- user/another topic
```

Each line carries a `project/` or `user/` prefix because `memory_read` needs a
target as well as a section — with a bare name the model has to guess which file to
read. A truncated list says it is truncated.

**Budget** is `inject.coreBudget` — 4000 units by default, 4000–20000 — split
across the project core, the user core, the fixed rules and the topic list.
`inject.mode: 'full'` is the compatibility fallback: every file injected whole,
the way earlier versions did.

A file with no usable core section is injected whole and reported as `legacy:*`
by `memory_status`; the panel shows it as a banner that names the section and
line. Nothing rewrites an old file on its own — the split is your decision.

> **The core section has to be `- ` entries.** It is injected every turn and cut
> to a budget entry by entry, so anything else in it — a prose sentence, a
> sub-heading, a fenced block — makes it unmeasurable and sends the whole file
> back to whole-file injection. The panel says where.
>
> **A topic section may hold anything** — prose, `###` sub-headings, code
> blocks. Only the topic name reaches the prompt; the body is read whole through
> `memory_read(section=…)`, so its shape does not decide whether it can be read.
> This is the behaviour most likely to look like a bug.

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

| Situation | What happens |
|---|---|
| No panel (headless, or `ui.enabled: false`) | The model can read, search, append and edit single entries; archiving and restoring need the panel |
| An external editor writes the same file | It does not take this plugin's lock — only the revision check protects you, and only against changes it can see |
| Two memory plugins on one file set | Not supported. The locks mean nothing to each other, and the same entries get injected twice |
| The same `operationId` replayed much later | Committed receipts are kept 24 hours, up to 2000 — past that it is a new request |
| The character counts in `memory_status` | This plugin's own contribution in UTF-16 units, not a token count or a cost |
| A read fails | Degrades to "inject nothing"; it never breaks a turn |

Tested on Windows 11 with Node 24. Not verified on Linux or Node 20.

## Development

```bash
npm test
npm run test:coverage
```

Design documents and the implementation log live in [`docs/`](docs/).

## License

MIT
