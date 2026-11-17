# Changelog

English | [中文](CHANGELOG.zh.md)

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
- `inject.distillAbove` adds a distillation threshold: when user memory grows past
  it, the injected rules say the file is due for a by-topic distillation. Its
  default follows `limits.user` (twice that value), so tuning the limit alone
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
- One write path for tools and panel: cross-process lock, revision check, backup,
  atomic replace, verified post-read.
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
