# dsh-workbuddy-memory

English | [中文](README.zh.md)

Share one set of memory files between DSH and WorkBuddy: the `MEMORY.md`, daily notes and user profile that WorkBuddy writes are read straight into the DSH context, and written back through guarded tools. No second copy, no sync daemon.

## Status

| Capability | State |
|---|---|
| Injection (project / rules / user / profile sections) | done |
| `memory_status` / `memory_read` / `memory_search` | done |
| Write tools (`memory_append` / `memory_edit` / `memory_prune`) and the bare-write guard | done |
| Revision fence, backups, operation log | done |
| Config card on the Plugins page | done |
| Sidebar memory panel (browse, edit, search) | done |
| Consolidate and restore from the panel | done |

See [`docs/2026-11-09-dsh-workbuddy-memory-design.html`](docs/2026-11-09-dsh-workbuddy-memory-design.html) for the design (Chinese).

## Install

```bash
dsh plugin --profile web add dsh-workbuddy-memory
```

Local development, when the profile's pnpm store was made by another major version:

```bash
node scripts/dev-install.mjs web
```

The script copies the package into `<profile>/node_modules` and registers it in the profile's `dsh.profile.bundles` and `dependencies`. Do **not** hand-write an `insert:` block into `cordis.patch.yml`: the inserted entry and the entry the config card writes end up as two records with the same id, and toggles then look like they do nothing. The card writes an id-targeted override that merges into the bundle's entry.

Verified on `0.2.0-rc.2` and `0.2.2-rc.1`; `engines.dsh` only sets the lower bound `>=0.2.0-0`, so a host major bump does not lock the plugin out.

## Files it reads

| Block | File | Note |
|---|---|---|
| Project memory | `<cwd>/<dataFolder>/memory/MEMORY.md` | `dataFolder` defaults to `.workbuddy` |
| User memory | `<workbuddyHome>/MEMORY.md` | |
| User profile | `<workbuddyHome>/USER.md` or `<workbuddyHome>/user-<uid>-personal/USER.md` | skipped when several candidates exist and no `profileUid` is set |
| Rules | built-in text | tells the model memory is data, and writes go through `memory_*` |

An empty `workbuddyHome` follows WorkBuddy's own order: `WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` → `~/.workbuddy` (multi-instance appends `-<WORKBUDDY_INSTANCE_NUMBER>`). The environment is re-read on every probe, so changing it does not need a DSH restart.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `readOnly` | `false` | master switch; when on, every write is refused |
| `workbuddyHome` | `''` | empty follows the environment |
| `dataFolderName` | `''` | empty follows `WORKBUDDY_DATA_FOLDER_NAME` |
| `inject.refresh` | `on-change` | `first-turn` freezes within a session to save tokens |
| `inject.limits.*` | 10000 / 4000 / 2000 | character limits per block |
| `stateDir` | `''` | index and backups root; defaults to `~/.dsh/workbuddy-memory` |
| `ui.enabled` | `true` | when off, the sidebar panel gets no data (the `/workbuddy-memory` routes stay unregistered) |
| `ui.allowWriteActions` | `true` | master switch for panel writes; while off the panel is read-only and `/action` refuses everything; the panel can turn it on in place |
| `ui.allowFullTextEdit` | `true` | source mode (whole-file edit); the first entry asks for confirmation, and the entry guides you to enable it when off |
| `ui.globalPanel` | `true` | left-rail `记忆` overview entry |
| `ui.projectTab` | `true` | native right-sidebar project-memory tab |
| `ui.sessionAction` | `true` | session-header memory button |
| `ui.refreshMs` | `3000` | `/state` polling interval |
| `ui.maxProjects` | `50` | maximum projects shown in the overview |
| `write.ensureLayout` | `false` | create `<cwd>/<dataFolder>/memory` on first write |
| `search.enabled` | `true` | when off, `memory_search` is not registered at all |

Keys editable from the plugin page carry `.volatile()`; `stateDir` and `locale` need a reload and stay YAML-only.

## Sidebar panel

There is one left entry; project memory lives in the right sidebar:

- **记忆 (overview)**: aggregates every DSH workspace plus recently seen session directories, with per-project entries, bytes, daily files and health; expanding a project lists `MEMORY.md` and its daily notes
- **Right-sidebar project tab**: a native tab next to files/changes, bound to its session's project; it uses the same two-column layout as the overview, but the rail only lists the current project's `MEMORY.md`, daily notes and the global stores
- **Session-header memory button**: opens or focuses that tab

Opening the project tab selects `MEMORY.md`; when it does not exist it selects the latest daily note instead of stopping on a file picker or an empty summary.

Detail groups rows by `## section`, with a local search box and `源码`, `归档旧日期`, `重新加载`.

Editing is on by default:

| Layer | Interaction | Route |
|---|---|---|
| L1 entry | click a row, Enter saves, Esc cancels | `POST /action {type:'edit'}` |
| L1 delete | delete icon at the end of the row | `POST /action {type:'remove'}` |
| L1 add | `＋` next to a section; daily notes use `添加一条` | `POST /action {type:'add'}` |
| L2 section | `编辑小节` → that section's raw body → save | `POST /action {type:'replace-section'}` |
| L3 source | document header `源码` → whole file → structure check | `POST /action {type:'replace-document'}` |
| Delete section | delete icon next to a section heading → confirm | `POST /action {type:'remove-section'}` |
| Undo | within 10 s of a save, `撤销` restores that backup | `POST /action {type:'restore'}` |
| Archive old dailies | plan first, tick the dates, then move them to `memory/archive/` (never writes MEMORY) | `POST /action {type:'prune'}` |

The history browser / roll-back entry was removed; pre-write backups remain for undo and conflict recovery.

Panel data routes, all same-origin checked: `GET /state`, `GET /content`, and `POST /action`. Targets are an enum (`project-memory` / `project-daily` / `user-memory` / `profile`) and dates must be `YYYY-MM-DD`; no path is ever accepted, so it cannot serve as a file browser. A cross-origin `Origin` is 403, and `/action` additionally requires `content-type: application/json` and a body of at most 512 KB (source mode carries a whole file). The host still keeps the read-only `/revisions` and `/revision` routes and pre-write backups for undo and diagnostics; the panel no longer exposes a history browser.

The panel is not a second write path: every action goes through the same store as the tools — same lock, same revision CAS, same backup, same ledger. It sends the revision it displayed, so a file changed underneath it returns `conflict` and the panel offers reload, disk diff, keep the draft, or overwrite after backing up.

"Current project" prefers the viewed session's workspace (the right tab resolves its own session), then the last prompt assembly. The overview does not need a session: every workspace in the registry appears.

### Where projects come from

- The overview merges the DSH **workspace registry** (`ctx.workspaceRegistry`) with directories this plugin has **assembled a prompt for**; the registry covers projects that were registered but never chatted with
- The right tab prefers its own session's workspace, then the last assembly
- The overview does not need a session; project keys still resolve only inside that whitelist (first 8 hex of the cwd's sha1), never an arbitrary path
- No recursive disk scan: the registry is authoritative, and walking the disk would cross permissions, symlinks and large trees

Project memory lives in `<project>/.workbuddy/memory/`. `MEMORY.md` (long-term) and `YYYY-MM-DD.md` (that day's log) are separate files — **a missing MEMORY.md does not mean the project has no memory**, the daily notes are listed on their own.

## Tests

```bash
npm test               # 157 cases
npm run test:coverage  # with coverage
```

Current: **81.7% lines / 76.6% branches / 66.2% functions** (all files under `src/`; the panel rewrite added interaction branches that are not all covered yet).

What the suite pins down: the path resolution chain and the six-step capability matrix, byte-stable markdown edits (including that a rewritten entry keeps its `- ` marker and that an empty replacement is refused instead of deleting the row), the write chain (lock, revision fence, backups, `read_only`, local-calendar daily files), the real-path classification behind the bare-write guard, section ordering and truncation (no half surrogate pairs), the refresh modes and cache keys, all five tools including conflict and idempotent replay, the panel routes' JSON shape and 405/403 edges, and the config card rendered through a four-hook React stand-in — which is what catches a host dropping a snapshot field.

Two suites go further than units: `tests/e2e.test.mjs` boots a real HTTP server over real files in a temp dir (JSON in, bytes out, conflict, restore, prune), and `tests/panel.test.mjs` drives the overview and project surfaces through a minimal hooks runtime, so a click → fetch → re-render round trip is asserted rather than assumed.

Not covered automatically: real browser focus and drag behaviour, and cross-process contention (only half of `fslock`'s wait and timeout paths run).

## Boundaries

- Read failures degrade to "inject nothing"; they never break a turn.
- The project block is skipped when the session working directory is unknown — it never falls back to `process.cwd()`.
- Memory is data: the injected block says so explicitly.

## License

MIT
