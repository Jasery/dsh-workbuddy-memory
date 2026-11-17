# Changelog

English | [中文](CHANGELOG.zh.md)

## 0.2.2 — 2026-11-17

- **Daily notes can carry sections, and their entries can be edited.** A daily
  note is written as `# YYYY-MM-DD` followed by `## topic` sections; the panel
  groups rows by section, so a note written as a flat bullet list showed no
  structure at all. `memory_append` used to accept `section` for a daily file and
  silently ignore it — returning `ok: true` while writing a bare bullet — so
  nothing could ever produce a heading. It now creates the heading (or reuses it)
  and appends under it, rewriting the file with a backup; without `section` the
  bullet is still appended with a plain `O_APPEND`, no rewrite and no backup.
  `memory_edit` can correct or remove an entry in a daily note. Structural
  operations — `replaceSection`, `removeSection`, `replaceDocument`, `restore` —
  remain MEMORY.md-only: a log is appended to and corrected, never rearranged.
- **A daily note with no `##` heading is no longer reported as empty.** Entries
  were counted only inside `parseSections` ranges, and that parser starts at level
  2 — so a file written as bare bullets had `entries: 0` and the panel showed "this
  file is still empty" over a 1.5 KB file. The region above the first heading is
  now reported as a `(top)` section (the same pseudo-heading the tools already use
  for addressing), in `/state`, in `/content`, and in `memory_read`.
  `memory_read(section: "(top)")` resolves instead of answering `no_section` for a
  name the tool itself had just listed.
- The panel's "add a dated entry" form offers an optional section field; leaving it
  empty appends to the end of the file.
- Tool descriptions say what happens in each case, instead of promising sections
  only for MEMORY.md and then dropping the argument.

## 0.2.1 — 2026-11-17

- **Layered mode now tells the model that daily files exist.** The compact rules
  covered when to write, what to write and how to edit, but never mentioned
  `YYYY-MM-DD.md` — so a session could run a whole day without writing one, and
  the "distil past 30 days, then archive" step had nothing pointing at it. A fifth
  rule now says the daily file is append-only, is not injected, and what to do once
  it ages out.
- **The rules share of `coreBudget` grew from 12.5% to 17.5%** (project and user
  cores drop 37.5% → 35% each) to make room for it. The share had been sized
  against Chinese: the same five rules cost 411 units in Chinese but 657 in
  English, so at 500 units the English block could not hold the new rule and
  `fitText` would have dropped it silently — English sessions would have stayed
  unaware while Chinese ones were told. The ratios now live in one place
  (`LAYERED_SHARES` in `src/render.js`) instead of three literals.
- **Appending an entry needs no permission.** Rule 2 now ends with
  `Just append.` — it said when and what to write, but not that a single append
  is the model's own call, so sessions ended with "shall I record this?" instead.
- Fixed a test that compared the Chinese rules block with itself: it rendered
  both locales with the same translator, so the English assertions never ran
  against English text.

## 0.2.0 — 2026-11-17

Layered injection, and four fewer tools. **Upgrading changes what reaches the
prompt** — read the first two items before you upgrade.

- **Default injection is now layered.** A file's `## 常驻记忆` (or `## Core
  Memory`) section is injected as an always-on core; the remaining sections are
  listed by name with `project/` / `user/` prefixes and a line saying how to read
  them, and the model fetches a topic with `memory_read` when it needs it. On two
  real memory files this took the always-on part from 12,678 characters to 2,922
  with nothing dropped. `inject.mode: 'full'` restores the old whole-file
  behaviour.
- **A file with no core section is still injected whole**, and reports
  `legacy:missing_core` (or `:ambiguous_core` / `:invalid_core` /
  `:non_entry_content`) in `memory_status`. Nothing rewrites an old file on its
  own: the split is the user's decision, confirmed in the panel. An ordinary
  `memory_append` into an unsplit file is refused with
  `layering_confirmation_required` rather than silently rearranging someone's
  memory.
- **`memory_prune` is gone.** Archiving old daily notes is a panel action, where a
  person sees the preview and the plan. No alias stub was left behind: a
  definition that only ever refuses still advertises an ability the model does not
  have. `memory_replace_section`, `memory_list_revisions` and `memory_restore`
  were never shipped and are not coming back as tools either — the panel owns
  whole-section rewrites, version history and restore.
- **`ui.allowFullTextEdit` is removed.** Source mode and the draft dialog are part
  of the panel; using them is your decision, not a switch to find. A profile that
  still sets it will not fail — the key is simply no longer read.
- New `inject.coreBudget` (4000, range 4000–20000, UTF-16 code units) sets the
  layered budget, split 37.5% / 37.5% / 12.5% / 12.5% across the project core, the
  user core, the fixed rules, and the topic list plus compatibility notes. In
  layered mode `inject.limits.project` / `.user` only decide whether that source is
  on at all.
- The panel now shows **whether a file is split**. `/state` reports a `layering`
  summary per store (mode, reason, counts, both halves' sizes — never the entry
  text, because `/state` is polled every few seconds), and a file still injected
  whole gets a banner naming its size and the reason, with one action: copy a
  prompt that asks the model for a split draft. It is not a "split this file"
  button — the plugin never rewrites a file on its own.
- Block headings no longer carry a product name (`### 项目记忆`, not
  `### 项目记忆（WorkBuddy）`). The suffix cost 11 units per occurrence in the
  always-on prefix and said which product owns the file; the provenance that
  matters — that another agent may have written the content — is now rule 1 of the
  compact rules.
- **Reads are bounded and race-safe.** `memory_read` refuses a file past 2 MiB with
  `too_large` instead of hashing a prefix that a later edit would use to delete the
  rest; a read whose file changed underneath returns `read_conflict`; `offset` /
  `nextOffset` page by UTF-16 code units without splitting a surrogate pair, and an
  offset inside one returns `bad_offset`.
- **Writes got a receipt store.** An `operationId` now survives a crash, so a
  retried request replays instead of writing twice. Committed receipts are kept 24
  hours (up to 2000, at most 100 unresolved); unresolved ones are never
  age-deleted, because they are the only evidence that a write's outcome is
  unknown. Reusing an id for a different request returns `operation_mismatch`;
  an id whose outcome could not be confirmed returns `outcome_unknown` and should
  be retried with the *same* id.
- Archiving is bound to the plan it was previewed from: a file that changed in
  between, or one that appeared after the preview, is refused rather than swept up.
  A partial move reports what finished and resumes by hash.
- Empty and title-only legacy files can be bootstrapped by an ordinary append
  again; only a file that actually holds entries is protected by the layering
  guard.
- The English compact-rules block was compressed to fit its 500-unit budget. It had
  grown past it, and `fitText` was dropping the last rule silently.
- Documentation: the README is now an introduction rather than a manual (23.5 KB →
  8 KB); implementation detail moved to `docs/implementation-notes.md`.

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
