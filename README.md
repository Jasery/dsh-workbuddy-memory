# dsh-workbuddy-memory

English | [中文](README.zh.md)

Share one set of memory files between DSH and WorkBuddy: the `MEMORY.md`, daily notes and user profile that WorkBuddy writes are read straight into the DSH context, and written back through guarded tools. No second copy, no sync daemon.

## Status

| Capability | State |
|---|---|
| Injection (project / rules / user / profile sections) | done |
| `memory_status` | done |
| Write tools (`memory_read` / `append` / `edit`) | in progress |
| Conflict fence, backups, operation log | in progress |
| Sidebar panel and config card (client bundle) | not started |

See [`docs/2026-11-09-dsh-workbuddy-memory-design.html`](docs/2026-11-09-dsh-workbuddy-memory-design.html) for the design (Chinese).

## Install

```bash
dsh plugin --profile web add dsh-workbuddy-memory
```

Local development, when the profile's pnpm store was made by another major version:

```bash
node scripts/dev-install.mjs web
```

then add to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: workbuddy-memory
      name: dsh-workbuddy-memory
```

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

Keys editable from the plugin page carry `.volatile()`; `stateDir` and `locale` need a reload and stay YAML-only.

## Boundaries

- Read failures degrade to "inject nothing"; they never break a turn.
- The project block is skipped when the session working directory is unknown — it never falls back to `process.cwd()`.
- Memory is data: the injected block says so explicitly.

## License

MIT
