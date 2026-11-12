# dsh-workbuddy-memory

English | [中文](README.zh.md)

Share one set of memory files between DSH and WorkBuddy: the `MEMORY.md`, daily notes and user profile that WorkBuddy writes are read straight into the DSH context, and written back through guarded tools. No second copy, no sync daemon.

## Install

```bash
dsh plugin --profile web add dsh-workbuddy-memory
```

Local development, when the profile's pnpm store was made by another major version:

```bash
node scripts/dev-install.mjs web
```

Do **not** hand-write an `insert:` block into `cordis.patch.yml`: the inserted entry and the entry the config card writes end up as two records with the same id. The card writes an id-targeted override that merges into the bundle's entry.

Requires DSH `>= 0.2.0`; verified on `0.2.0-rc.2` and `0.2.2-rc.1`.

## Files it reads

| Block | File | Note |
|---|---|---|
| Project memory | `<cwd>/<dataFolder>/memory/MEMORY.md` | `dataFolder` defaults to `.workbuddy`; injected |
| Daily notes | `<cwd>/<dataFolder>/memory/YYYY-MM-DD.md` | that day's log; **not injected**, path only |
| User memory | `<workbuddyHome>/MEMORY.md` | injected |
| User profile | `<workbuddyHome>/USER.md` or `user-<uid>-personal/USER.md` | skipped when several candidates exist and no `profileUid` is set |

An empty `workbuddyHome` follows WorkBuddy's own order: `WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` → `~/.workbuddy`.

## Tools

| Tool | What it does |
|---|---|
| `memory_status` | resolved paths, file sizes, writability, effective config |
| `memory_read` | read one target; returns revision and section list |
| `memory_search` | literal search across all memory files (not registered when `search.enabled: false`) |
| `memory_append` | append an entry to a section, or a line to today's note |
| `memory_edit` | replace or delete one entry (only `- ` entries; ambiguous matches are refused) |
| `memory_prune` | move old daily files to `memory/archive/`; never writes MEMORY.md |

Every write goes through the same chain: cross-process lock → revision check → backup → atomic write. Editing memory files with `write` / `edit` is refused by the guard.

## Configuration

Common keys (the plugin page lists all of them):

| Key | Default | Meaning |
|---|---|---|
| `readOnly` | `false` | master switch; when on, every write is refused |
| `workbuddyHome` | `''` | empty follows the environment |
| `inject.limits.*` | 10000 / 2000 / 8000 / 2000 | character limits per block (project / rules / user / profile) |
| `inject.distillAbove` | `0` → twice `limits.user` | user memory size that makes the rules ask for a by-topic distillation |
| `ui.enabled` | `true` | when off, the panel and its routes are not registered |
| `ui.globalPanel` / `ui.projectTab` / `ui.sessionAction` | `true` | the three panel entries |
| `ui.allowWriteActions` | `true` | master switch for panel writes |
| `search.enabled` | `true` | when off, `memory_search` is not registered |

`stateDir` and `locale` need a reload and stay YAML-only.

## Panel

- **`记忆` in the left rail**: aggregates every DSH workspace plus recently seen session directories; expanding a project lists `MEMORY.md` and its daily notes.
- **`项目记忆` tab in the right sidebar**: next to files/changes, scoped to the current project's memory plus the global stores.
- **Memory button in the session header**: opens or focuses that tab.

The panel supports entry editing, section editing, whole-file source mode and undo; old daily files can be archived to `memory/archive/` (archiving never writes MEMORY.md). Writes use the same store as the tools, so an external change returns `conflict` with reload / overwrite options.

## Boundaries

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
