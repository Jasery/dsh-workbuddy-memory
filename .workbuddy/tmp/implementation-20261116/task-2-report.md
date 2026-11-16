# Task 2 Report — 写入正确性、回执与归档计划

- 分支：`feature/memory-optimizations`
- 实现基线：`35d55ea`（Task 1 已验收提交 `e41a8e2` / `d01d544` / `d71bff4`）
- 提交：`bc8147c fix(store): 补齐版本门禁回执和归档计划`
- 范围：`src/write/store.js`、`fslock.js`、新 `receipts.js` / `archive.js`；store/tools/e2e 测试夹具；未改 `client.js`、`host/routes.js`、`tools/write.js` 的 UI/工具接线。

## RED（真实命令与输出）

在独立临时目录用 `git archive 35d55ea` 还原基线，复制新回归测试和跨进程 helper，安装同一份 `node_modules` 后运行：

```bash
ROOT=$(mktemp -d)
git archive 35d55ea | tar -x -C "$ROOT"
cp tests/write-integrity.test.mjs "$ROOT/tests/"
cp tests/helpers/append-once.mjs "$ROOT/tests/helpers/"
cp -r node_modules "$ROOT/node_modules"
cd "$ROOT" && node --test tests/write-integrity.test.mjs
```

基线结果：

```text
✖ two processes with one operationId commit exactly once
✖ the same operationId on another target is refused
✖ a restore replay returns the original result without another backup
✖ a destructive rewrite without expectedRevision is refused
✖ an unreadable post-write snapshot is outcome_unknown, not an empty revision
✔ two writers with the same CAS revision: one commits, one conflicts
✔ different operationIds still let both appends land
✖ operationLog:false still deduplicates through the receipt
✖ a receipt that cannot be created refuses the write before the source changes
✖ commits notify once, after locks are released, and listener failures are isolated
✖ two backups taken in the same millisecond never overwrite each other
✖ backupKeep:0 refuses a destructive write but permits append
✖ prune preview creates no state or archive directory
✖ prune apply without a plan is refused
✖ a file changed after the preview is refused, and a new file is not moved
✖ an apply waits on a held date lock and then refuses without moving
✖ a partial move is reported, then resumed and made idempotent
ℹ tests 17
ℹ pass 2
ℹ fail 15
```

两项通过是基线已有行为（同 CAS 串行、不同 ID 的 append），保留下来防止回归；其余 15 项为本次新增契约的 RED。`tests/receipts.test.mjs` 针对新模块，基线因模块不存在无法导入，不计入上述 17 项。

## GREEN（真实命令与输出）

```bash
node --test tests/write-integrity.test.mjs tests/receipts.test.mjs \
  tests/store.test.mjs tests/tools.test.mjs tests/e2e.test.mjs
```

```text
ℹ tests 109
ℹ pass 109
ℹ fail 0
```

提交后完整套件一次：

```bash
node --test
```

```text
ℹ tests 284
ℹ pass 284
ℹ fail 0
ℹ duration_ms 10421.969
```

> 说明：为保持“无 plan 不归档”，`pruneTool` 与 `/action` 尚未转发 `planId`，因此把 tools/e2e 里旧的“预览后直接 apply”断言改为明确断言 `plan_required`，而不是去掉安全检查。Task 4 接线后应恢复成功归档的集成断言。

## 接口契约（Task 4 消费）

### store 创建与订阅

```js
createStore({ cfg, stateDir, onCommit? }) -> {
  append, edit, editAt, remove, replaceSection, replaceDocument,
  removeSection, restore, prune, listRevisions, readRevision,
  operationStats, backupDirFor,
  subscribe(listener) -> disposer
}
```

- 成功且有字节变化的提交发出一次：
  `{ path, target, operation, revision, operationId }`
- `operation`：`append | edit | remove | replace-section | replace-document | remove-section | restore | prune`。
- `duplicate`、`dryRun` 不发。通知在 operation/file（prune 还有 archive/source）锁全部释放后统一发出；监听器同步 throw 或 Promise reject 均被隔离且不 await。
- prune 的移动事件 `path` 是被移走的源文件，额外带 `archivePath`；一次 apply 每移动一项发一条。partial 只对本次新移动项发；恢复重试时已移动项不重复通知。

### CAS 与读取

- `edit/editAt/remove/replaceSection/removeSection/replaceDocument/restore` 对“已存在文件”强制非空 `expectedRevision`，缺失返回 `revision_required`；`append` 的 CAS 可选。
- 写前读取统一 `maxBytes=2 MiB`：`readTextSafe` 的 `ok:false`（含 `changed`）→ `unreadable`；`truncated` → `too_large`。daily append 也检查 `ok/truncated`，不再把 `changed` 当空文件。
- 写后回读同样检查；无法验证时返回 `outcome_unknown`（带 `committed:true`），不会返回基于空文本的假 revision。
- 无内容变化（如 restore 当前文本）返回 `changed:false`，不备份、不替换、不通知。

### 回执

- 位置：`<stateDir>/receipts/<sha1(operationId)>.json`；不依赖 `write.operationLog`，`operationLog:false` 仍去重。
- 普通写先在文件锁内写 `applying`（before/after revision），再备份/替换，最后 `committed`。崩溃重试按当前 hash：等于 after → `duplicate`；等于 before → 可重试；其他 → `outcome_unknown`。
- 容量：终态 24h/最多 2000 条、未决（applying/partial）最多 100、单条 1 MiB。超限返回 `receipt_capacity`，不动源、不淘汰未知记录；`begin` 失败即拒绝写。过期 terminal 在读取时也会失效，去重仅在窗口内成立。
- operationId 最长 200 字符，超限 `operation_id_too_long`；指纹绑定规范化路径、动作/模式、语义请求 hash（含 `expectedRevision`）。同 ID 不同目标/内容 → `operation_mismatch`；committed → 原结果 + `duplicate`。

### prune 预览/应用

```js
prune({ dryRun:true, beforeDays?, dates? }, probe)
  -> { ok, dryRun:true, planId, beforeDays, target:'project-daily',
       candidates:[{date,name,bytes,entries,revision,error?}], entries, expiresAt }

prune({ dryRun:false, planId, dates:[selectedSubset], operationId }, probe)
```

- 预览纯内存：最多 100 个计划、10 分钟；不创建 state/archive/receipt 目录。
- apply 必须非空 `operationId`（否则 `operation_required`）、必须带 `planId`（否则 `plan_required`）和明确 `dates`。计划外项目/过期/源 revision 变化 → `plan_conflict`；selected >1000 → `archive_capacity`。
- 锁序：operation → archive → 按名称排序的源 file locks；全部取得后才校验+移动。
- 首次 apply 在移动前落 `applying` 回执，包含每个源的 revision、确定 `archivePath`、manifest 进度。partial 返回 `{ok:false,code:'partial',pruned,failed}`；同 `operationId` 重试优先用回执 manifest 恢复，不依赖内存 plan、不重新枚举源。已移动项用源/目标存在与 hash 确认；歧义项 `outcome_unknown`。
- 归档目标冲突时用 `date-N.md`；目标路径在首次 apply 固定并持久化。

### 备份

- 文件名 `时间-<UUID8>.md` + `wx` 独占创建，同毫秒不覆盖。
- `backupKeep:0` 时，已存在内容的破坏性 edit/remove/section/document/restore 返回 `backup_required`；普通 append（含已有文件）仍允许，首次写新文件无需备份。
- 备份启用但失败 → `backup_failed`，不动源。

## 下游未接与已知缺口（交 Task 4）

1. `src/tools/write.js` 的 `pruneTool` 未转发 `planId`；`src/host/routes.js` 的 prune action 也未转发 `planId`。当前 UI 旧流程 apply 会得到 `plan_required`。Task 4 需把 preview 返回的 `planId` 与选中的 `dates` 一并提交。
2. Task 4 需映射/展示新错误码：`plan_required`、`plan_conflict`、`operation_required`、`operation_mismatch`、`receipt_capacity`、`archive_capacity`、`backup_required`、`revision_required`、`too_large`、`outcome_unknown`、`partial`、`operation_id_too_long`。`routes.js` 的 `statusFor` 目前对多数新码落到 400。
3. UI 的所有破坏性动作必须继续带当前 `expectedRevision`；服务端现在会拒绝缺失值。`append` 的 CAS 仍可选。
4. prune partial 的 `failed` 项需 UI 可见并提供“用同 planId/operationId 重试”；不要重新预览后静默替换集合。
5. `nothing_to_prune` 不再是 apply 的返回码；空候选在 preview 中以 `candidates: []` 表示，Task 4 文案可沿用/调整。
6. 本任务未改 client、routes、tools 注册；未做浏览器/真实 UI 验收，也未改真实 profile 或用户记忆。

## 设计取舍/风险

- `archive_capacity`（selected >1000）不在 brief 明确列出的错误码里，但需要区分“回执容量”和“归档文件数上限”；已在报告显式列出，若 lead 要求统一为 `receipt_capacity` 可改。
- 预览计划超过 100 时先清过期，再淘汰最老计划；被淘汰的未过期计划 apply 会得到 `plan_required` 而非 `plan_conflict`。这是内存上限的必然取舍。
- prune 通知 `path` 取源文件并附 `archivePath`，便于缓存按源路径失效；若 Task 4 期望 `path` 为归档目标，需要统一。
- 单条回执 1 MiB 与 1000 文件上限未做 1000 文件规模压测；容量拒绝逻辑（records/pending/单条大小）有 focused 测试，1000 文件迁移顺序由代码限制。
- 未承诺外部编辑器原子 CAS；写后回读只能把可检测的竞态变成 `outcome_unknown`。

## 返修 round1（20261116）

- 基线：`bc8147c`；提交：`265982b fix(store): 收紧回执保留与全局维护锁`
- 范围：仅 `src/write/receipts.js`、`src/write/store.js`、`tests/receipts.test.mjs`、`tests/write-integrity.test.mjs`、新 `tests/helpers/receipt-race.mjs`；未改 UI/tools/layer/docs 路线。
- 对应三项 verified finding：未决回执被过期删除/不计数、全局准入与 sweep 跨进程竞态、忽略 update 失败导致伪 ok 与 ABA 复活。

### RED（真实命令与输出）

在临时目录用 `git archive bc8147c` 还原基线，复制本轮新测试与新跨进程 helper，用 junction 指向仓库 `node_modules` 后运行（结束后删除 junction 与临时目录，未动仓库依赖）：

```bash
ROOT=$(mktemp -d)
git archive bc8147c | tar -x -C "$ROOT"
cp tests/receipts.test.mjs tests/write-integrity.test.mjs "$ROOT/tests/"
cp tests/helpers/receipt-race.mjs "$ROOT/tests/helpers/"
cd "$ROOT" && node --test tests/receipts.test.mjs tests/write-integrity.test.mjs
```

```text
ℹ tests 28
ℹ pass 21
ℹ fail 7
✖ an old unresolved receipt is retained and still counts against the pending cap
✖ an unreadable receipt is kept and still holds a pending slot
✖ a failed receipt update is not a commit, and does not revive a deleted entry
✖ two processes cannot both take the last unresolved receipt slot
✖ a stale sweep cannot delete a receipt created after it scanned
✖ an archive receipt update failure stops before more items move, then resumes by hash
✖ a failed final archive receipt update is never reported ok
```

21 项基线行为保持通过；7 项新回归全部 RED，逐项对应三类 finding。跨进程用例用确定性的目录列举/删除 barrier（带 4s 超时），未用概率等待。

### GREEN（真实命令与输出）

```bash
node --test tests/receipts.test.mjs tests/write-integrity.test.mjs \
  tests/store.test.mjs tests/tools.test.mjs tests/e2e.test.mjs
```

```text
ℹ tests 116
ℹ pass 116
ℹ fail 0
```

提交后 full suite 一次：

```bash
node --test
```

```text
ℹ tests 291
ℹ pass 291
ℹ fail 0
ℹ duration_ms 11822.5083
```

提交后再次单独跑两个 focused 文件（确认提交内容与工作树一致）：`tests 28 / pass 28 / fail 0`。

### 接口与错误码变化

- `createReceiptStore({ stateDir, lockWaitMs? })` 的 `read/begin/update/drop` 现在是 **async**（返回 Promise），并新增 `withTransaction(fn, { waitMs })` 与 `lockPath`。`fn` 收到同步的 `tx`（`read/begin/update/drop/maintain`），其内部不再加锁；事务内不得再次调用 `withTransaction`。`src` 内唯一 caller 已改为事务形态，`tests/receipts.test.mjs` 全部同步更新；仓库外若直接使用旧同步 API 需 `await`。
- 锁序：`operation → receipts transaction → archive → 排序后的 file locks`。收据事务覆盖读、过期清理、容量准入、创建与每次更新；无 `operationId` 的写仍只取 file lock，不存在反向锁。通知仍在所有锁释放后发出。
- 新增/改变的结果字段（Task 4 需映射）：
  - 写已落盘但回执更新失败：`{ok:false, code:'outcome_unknown', committed:true, revision, reason:'receipt_update_failed'}`，同时仍发一次该路径的 commit 事件。
  - `applying` 重试且当前 hash 等于 `after`：先尝试落 `committed` 再回 `duplicate`；落盘失败同上。hash 既不等于 `after` 也不可信（含等于 `before` 的 ABA）：`{ok:false, code:'outcome_unknown', reason:'applying_unverified'}`，不再 transform/append，并把回执标成 `outcome_unknown`（尽力而为）。
  - prune 中途回执更新失败：`{ok:false, code:'partial', pruned, failed, receipt:'outcome_unknown', reason:'receipt_update_failed'}`，停止后续移动，保留已移动项与事件。
  - prune 最终状态写失败：全成功时 `{ok:false, code:'outcome_unknown', committed:true, ...}`；本就有失败项时仍 `partial` 并附 `receipt:'outcome_unknown'`。
- 保留/过期：只有 `committed` 超过 24h 会过期；`applying/partial/outcome_unknown` 与损坏记录永不按时间删除，均计入 pending(100) 与 records(2000)；损坏记录读取返回 `receipt_capacity`，准入拒绝不再替它腾位。
- `append` 写调用本身抛错时不 drop 回执（无法证明零字节），回执留在 `applying`，重试保守拒绝；`writeFileAtomic` 抛错可证明未替换，会 drop。

### concerns

- 所有带 `operationId` 的写按 stateDir 串行（含源文件写入与备份），是本轮接受的吞吐代价；并发写多时后到者可能得到 `lock_timeout` 而非 `receipt_capacity`。
- 未决回执不再自动淘汰：`partial` 中永久歧义的条目会长期占一个 pending 槽，只能由人工/后续恢复解决；这是“未知不丢”的必然结果。
- prune 中途更新失败后，磁盘 manifest 落后于实际；恢复依赖源/目标 hash 重新核实（有测试覆盖），但仍不承诺对外部编辑器原子 CAS 或永久 exactly-once。
- `tests/write-integrity.test.mjs` 的两个跨进程用例各含一个 4s 上限 barrier（串行约 10s），无真实记忆、无网络、临时目录由 `mkdtemp` 隔离。
- reviewer 的 `task-2-focused-review-2026-11-16.mjs` 仍使用旧的同步回执 API（`receipts.read(...).record`），本轮未改（非 owned）；如需重跑该探针需先 `await`。

## 返修 round2（20261116）

- 复审来源：`.workbuddy/tmp/implementation-20261116/task-2-rereview-1.md` 的 I1 Remaining。仅改 `src/write/receipts.js`、`tests/receipts.test.mjs`、`tests/write-integrity.test.mjs` 与本报告；未改 store、产品 UI、其他测试以外产品模块或 CI 配置，未运行 CI。
- 修复：新增共享 `isValidReceipt`，read 与容量维护扫描均要求合法 version、非空 id/fingerprint/action/target、枚举内 status、合法 createdAt/updatedAt，以及对应状态的关键字段；committed 必须带有效结果对象。结构无效统一返回/计作 `receipt_capacity`，保留文件并占 pending；序列化入口也验证真实 store 传入的回执。普通写与 prune applying/partial 的差异形态均被接受。
- 测试夹具：补齐普通 append 回执的 path/before/after/result；partial 用例加入 manifest/result；跨进程预置回执也补齐同样的真实字段。

### RED（真实命令与输出）

```text
node --test tests/receipts.test.mjs tests/write-integrity.test.mjs
ℹ tests 30
ℹ pass 28
ℹ fail 2
✖ parseable receipts with invalid or incomplete schemas are retained and refused
✖ a parseable invalid terminal receipt is not expired during capacity maintenance
```

两项新增回归在 schema 实现前失败：read 接受缺 fingerprint 的可解析记录；容量维护清理缺 result 的旧 committed 记录并放行新写。其余 28 项通过。

### GREEN 与完整套件（真实命令与输出）

```text
node --test tests/receipts.test.mjs tests/write-integrity.test.mjs
ℹ tests 30
ℹ pass 30
ℹ fail 0

node --test
ℹ tests 293
ℹ pass 293
ℹ fail 0
ℹ duration_ms 11416.9034

git diff --check
# 无输出，退出码 0
```

未执行 CI（本轮明确取消）。本报告随本轮实现提交；提交号以仓库最新提交记录为准。
