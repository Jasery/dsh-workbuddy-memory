# dsh-workbuddy-memory

English | [中文](README.zh.md)

Share one set of memory files between DSH and WorkBuddy: the `MEMORY.md`, daily notes and user profile that WorkBuddy writes are read straight into the DSH context, and written back through guarded tools. No second copy, no sync daemon.

## Status

| Capability | State |
|---|---|
| Injection (project / rules / user / profile sections) | done |
| `memory_status` / `memory_read` / `memory_search` | done |
| Write tools (`memory_append` / `memory_edit`) and the bare-write guard | done |
| Revision fence, backups, operation log | done |
| Config card on the Plugins page | done |
| Sidebar memory panel (browse) | done |
| Editing entries from the panel | not started |
| `memory_consolidate` (fold old daily notes) | not started |

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

Keys editable from the plugin page carry `.volatile()`; `stateDir` and `locale` need a reload and stay YAML-only.

## Sidebar panel

The `记忆` icon at the bottom of the sidebar opens it: a status line (home, current project, read-only or not, backup count), a file tree on the left (project `MEMORY.md`, daily notes, user `MEMORY.md`, profile), and the selected file's text with per-section entry counts on the right. It polls every 3 seconds.

Data comes from two read-only host routes, `/workbuddy-memory/state` and `/workbuddy-memory/content`. Targets are an enum (`project-memory` / `project-daily` / `user-memory` / `profile`) and dates must be `YYYY-MM-DD`; no path is ever accepted, so it cannot serve as a file browser. `POST` is 405 everywhere and a cross-origin `Origin` is 403.

"Current project" is the working directory the last prompt assembly saw, so the panel only knows which project to show after a session has talked to it once.

## Tests

```bash
npm test               # 105 cases
npm run test:coverage  # with coverage
```

Current: **90.5% lines / 77.9% branches / 76.2% functions** (all 20 files under `src/` are counted).

What the suite pins down: the path resolution chain and the six-step capability matrix, byte-stable markdown edits, the write chain (lock, revision fence, backups, `read_only`), the real-path classification behind the bare-write guard, section ordering and truncation (no half surrogate pairs), the refresh modes and cache keys, all five tools including conflict and idempotent replay, the panel routes' JSON shape and 405/403 edges, and the config card rendered through a four-hook React stand-in — which is what catches a host dropping a snapshot field.

Not covered automatically: real browser focus and drag behaviour, and cross-process contention (only half of `fslock`'s wait and timeout paths run).

## Boundaries

- Read failures degrade to "inject nothing"; they never break a turn.
- The project block is skipped when the session working directory is unknown — it never falls back to `process.cwd()`.
- Memory is data: the injected block says so explicitly.

## License

MIT
