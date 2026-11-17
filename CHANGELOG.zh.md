# 更新日志

[English](CHANGELOG.md) | 中文

最新的在最前。下面每个已发布版本都在 npm 上，日期是发布时间。这份文件只记
**每个版本改了什么**——设计上的理由在 [`docs/`](docs)，不写在这里。

## 未发布

没发布之前，这里的东西都不算版本。

### 破坏性变更

- 移除 `ui.allowFullTextEdit`，连带移除 `full_text_disabled` 这个拒绝码。源码
  模式与草案弹层不再有单独开关，整文件写入只受 `readOnly` 与 `write.enabled`
  约束。旧 profile 里残留这个键仍能正常加载（未知键被忽略），不需要手工清理。

### 新增

- `inject.mode: 'layered'`（新的默认值）：一小段常驻核心 + 一份按需查询的主题
  目录，取代「每个记忆文件整份注入」。`'full'` 保留为兼容与排障回退。
- `inject.coreBudget`，默认 **4000** 个 UTF-16 码元（范围 4000–20000，包装算在
  内），按 37.5% 项目核心 / 37.5% 用户核心 / 12.5% 规则 / 12.5% 主题目录与兼容
  提示分配。
- 面板：历史版本（预览差异并恢复）、草案弹层（绑定写作时对应的 revision）、
  归档（绑定预览出来的那份计划）、十秒撤销（绑定产生它的那次写入）。
- 持久操作回执，落在 `<stateDir>/receipts/`，所以带同一个 `operationId` 的重试
  是重放而不是写两遍。

### 变更

- 给模型的工具收成五个：`memory_status`、`memory_read`、`memory_search`、
  `memory_append`、`memory_edit`。`memory_replace_section`、
  `memory_list_revisions`、`memory_restore`、`memory_prune` 移除，且不留空壳
  别名。store 方法与 HTTP 路由都还在；批量管理改成面板动作，人在写入前看得到
  预览和差异。
- `inject.refresh: 'first-turn'` 改成**按会话**冻结一份快照（原来按工作目录），
  所以同一项目里开新会话读到的是文件当前的样子。提交的写入会让该文件的缓存文本
  失效。
- `memory_status` 的 `lastAssembly` 带 `measuredAs: 'plugin-contribution'` 标
  签，不再给出估算的注入字符数。这些数字是本插件贡献的 UTF-16 码元数，不是宿主
  最终的提示词，也不是 token 数。
- 每一次写入——工具的和面板的——都走同一条链：操作锁 → 回执事务 → 文件锁 →
  revision 比对 → 备份 → 回执 `applying` → 原子替换 → 写入后回读校验。
- 读取有界：`readTextSafe` 始终按描述符读取，读取中文件被改动会返回 `changed`，
  而不是交回一个撕裂的前缀。`memory_read` 支持 UTF-16 分页。
- 面板写入接入宿主的信任栅栏（`connection.requestRejection`，懒读，headless 降级
  为本地 origin 检查），并要求 `application/json`。
- 弹层内的拒绝显示在弹层里，而不是只写进它遮罩后面的横幅。项目或草案已经变了
  之后才迟到的响应会被丢弃。
- 配置卡按路径分段写入嵌套键。原先它把一个点号字符串当作单个字段名传给宿主，
  宿主判为 "not volatile" 而整笔拒绝，导致 22 个控件里有 19 个存不了。

### 修复

- 破坏性改写一律要求 `expectedRevision`；revision 不一致返回 `conflict`。面板的
  冲突弹层只给三条出口——重新加载、保留草稿、查看磁盘差异——故意没有「覆盖」。
- 写入与回执之间崩溃按保守方式处理：即便与记录的**写入前** revision 相同，也不
  当作「这次没写」的证据，而是返回 `outcome_unknown`，把决定交给人。
- 备份用独占创建，名字带时间加随机后缀，所以同一毫秒的两次写入是两份文件。
- `write.backupKeep: 0` 时破坏性改写返回 `backup_required`；普通追加仍然允许，
  因为加字节不会截断已有内容。
- 空文件或只有标题的旧文件可以正常首写；已有内容的文件仍要求确认划分。
- 核心超额时会说明少了几条；主题目录被截断时会说明还有更多。
- 核心取的是前缀：第一条放不下就停在那里，不会跳过它去捡后面更短的条目。核心小节
  重复视为有歧义并退回 legacy；空核心小节是合法的。
- 归档：预览不建目录、不建归档、不写回执。执行绑定项目、日期集合与每个源文件的
  revision，所以预览之后被改过的文件会被拒（`plan_conflict`），预览之后才出现的
  文件不会被顺手扫走。部分完成会报出已移动与失败的清单，并按清单续跑而不是重新
  枚举。

### 说明

- 没有核心小节的记忆文件保持 legacy 整份注入，并报告 `legacy:missing_core` /
  `legacy:ambiguous_core` / `legacy:invalid_core` / `legacy:non_entry_content`。
  插件不会自动重排旧文件。
- 保守降级的范围较宽：主题小节里掺一句普通段落、一个 `###` 子标题、一段代码围栏
  或一行只缩进 1 个空格的续行，整个文件就会退回 legacy 整份注入。
- 去重只在回执窗口内承诺（24 小时 / 2000 条，未决 100 条）。
- 外部编辑器不认本插件的锁：DSH 对自己是串行的，DSH 对不加锁的编辑器只靠
  revision 比对保护，落在同一毫秒窗口里的写入靠备份可恢复，而不是被阻止。
- 仅在 Windows 11 + Node 24.14.0 验证过；Linux 与 Node 20 未跑，也不承诺节省
  token 或费用。

## 0.1.4 — 2026-11-12

- 配置卡补上注入上限与蒸馏阈值的控件。这两个键原先只能手工改 profile 的 YAML
  才能设置，而 README 明确告诉人们不要那么做。
- 移除两个误提交的临时文件，并把 `.cmsg*.txt` 加进 `.gitignore`。

## 0.1.3 — 2026-11-12

- 面板跟随宿主语言。所有文案都注册进宿主的 locale 服务，DSH 切语言时面板一起切。
- 客户端的 `inject` 列表补上 `locale` 服务。缺这一条时面板会悄悄用自己的那份
  文案，从不跟随应用语言。
- `scripts/dev-install.mjs` 改成把 profile 链接到本仓库（Windows 用 junction，
  其他平台用目录符号链接），不再复制，所以改完源码只需重启 profile。

## 0.1.2 — 2026-11-12

- `inject.limits.user` 可配置，默认 **8000** 个 UTF-16 码元。
- 新增 `inject.distillAbove` 蒸馏阈值：用户记忆超过它时，注入的规则会说明该按
  主题蒸馏了。默认值跟随 `limits.user`（取它的两倍），所以只调限额也会带着阈值
  一起动。
- `memory_status` 报告解析后的各项限额与蒸馏阈值。

## 0.1.1 — 2026-11-11

- 工具返回值能过宿主的 lossless JSON 校验。宿主会给每个工具结果做快照，任一属性
  是 `undefined`、非有限数或 `-0` 就判整份非法——而且是在**写入已经落盘之后**，
  于是调用方看到的是「一次已经成功的写入失败了」，不带同一幂等键重试就会写两遍。
  现在返回值用 `null` 代替 `undefined`，并在工具注册处包一层兜底。
- 注入的规则补上「什么时候该写」，让模型不再记录一次性回答和进行中的状态。

## 0.1.0 — 2026-11-11

首个公开版本。

- 四块注入：项目记忆、项目规则、用户记忆、用户画像。默认
  `inject.refresh: 'on-change'`，可选 `'first-turn'`。
- 五个工具：`memory_status`、`memory_read`、`memory_search`、`memory_append`、
  `memory_edit`。`memory_prune` 让模型侧归档旧日期笔记。
- 工具与面板共用一条写入链：跨进程锁、revision 比对、备份、原子替换、写入后
  回读校验。
- 守卫拒绝裸 `write` / `edit` / `apply_patch` 改记忆文件，强制走 `memory_*`。
- 侧栏面板：跨 DSH 工作区的全局总览 + 项目页签，支持分段渲染、行内条目编辑、
  搜索、整理与回滚。旧日期笔记只归档，绝不并进 `MEMORY.md`。
- 面板路由接入宿主的信任栅栏；被截断的文件不允许整节写回。
- 配置卡由 volatile 字段支撑，改配置不必手改 YAML。
- 已有的 WorkBuddy 目录与文件原地复用；不需要安装 WorkBuddy。
- 纯读取不创建任何东西。第一次合法写入才创建目录布局（`write.ensureLayout`，
  默认 `true`）。
