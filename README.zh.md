# dsh-workbuddy-memory

[English](README.md) | 中文

让 DSH 与 WorkBuddy 共用同一批记忆文件：WorkBuddy 写的 `MEMORY.md`、日期笔记与用户画像，DSH 直接读进上下文，也能通过受控工具写回去。不维护第二份副本，不做同步；也不需要先装 WorkBuddy——目录和文件已经在，就直接用。

## 注入什么

默认是**分层**注入：一小段常驻核心，加上一份主题清单，模型需要时再用 `memory_read` / `memory_search` 按需查。

- **核心**是文件里唯一的 `## 常驻记忆`（或 `## Core Memory`，大小写不敏感）小节。只注入完整的 `- ` 条目，而且核心取的是**前缀**：第一条放不下就停在那里，不会跳过它去捡后面更短的条目。有条目没放下时，块里会写明少了几条。
- **主题清单**列出其余 `##` 小节名（以及用户画像入口），模型知道有什么，但不必背着全部正文。清单被截断时会说明还有更多。
- **预算**：`inject.coreBudget` 默认 **4000**，可设 4000–20000，单位是 **UTF-16 码元**，包装也算在内。它按 37.5% / 37.5% / 12.5% / 12.5% 分给项目核心、用户核心、固定规则、主题目录加兼容提示。包装、完整条目、代理对都算进这份额度，任何一处都不会从字符中间切断。
- `inject.mode: 'full'` 是兼容与排障回退：每个文件按自己的 `inject.limits.*` 整份注入，和早先的版本一样。**在插件页配置卡的「注入模式」里切换**，不要去改 profile 的 YAML——见[配置](#配置)。
  分层模式下 `inject.limits.project` / `.user` 只决定这一路源开不开（0 等于关掉），真正的上限是 `coreBudget`。两处例外值得知道：`limits.user` 同时是 `inject.distillAbove` 默认值的基准（它的两倍），调小它会让同一个文件更早被判为该蒸馏；面板的「已超注入限额」标签仍按 `inject.limits.project` 比较文件大小，那是体积告警，不是在说实际注入了多少。
- 分层模式下，文件超过自己的份额时，主题目录里会带真实字数说明（例如「用户记忆（WorkBuddy） 9903 字符，常驻只取核心，其余请按需查询」）；超过 `inject.distillAbove` 时还会说明该蒸馏了。这条提示放在主题目录里，不放进核心块：常驻文本里带字数会让每次保存都改写提示词前缀。同一个阈值也驱动 full 模式的规则提示——两种模式超过阈值都会说「该蒸馏」，区别只在提示落在哪里。
- 文件**没有**核心小节时，保持 legacy 兼容整份注入（按自己的 `inject.limits.*` 截断），并在 `memory_status` 里显示为 `legacy:missing_core` / `legacy:ambiguous_core` / `legacy:invalid_core` / `legacy:non_entry_content`。legacy 正文**不**计入 `coreBudget`。插件**不会自己**重排旧文件：哪条进核心、哪条留在长尾，是用户的决定，在面板里做。
- **保守降级，以及它的代价。** 主题小节的正文只能写 `- ` 条目（加缩进 2 空格以上的续行）和空行。只要掺进别的——一句说明、一个 `###` 子标题、一段代码围栏、一行只缩进 1 个空格的续行——**整个文件**就会退回 legacy 整份注入：实测加一句说明就从 40 字符涨到 5511 字符常驻。删除核心小节同理（同一组实测里从 33 涨到 5042）。这是故意的（分不干净的就不硬分），降级也可见（`legacy:non_entry_content` / `legacy:missing_core`），但它是最容易被误认为「插件坏了」的行为：主题正文只写条目，或者接受整份文件一起进来。
- 空核心小节是合法的，不算兼容状态：块里只有标题、没有条目。核心小节重复则视为有歧义，退回 legacy，不去猜用哪一个。

`inject.refresh` 默认仍是 `on-change`：每次装配都重算块，文件缓存每次读都复查 `mtime`/`ctime`/`size`，提交写入会让对应文件的缓存失效；`first-turn` 改为每个会话冻结一份快照。

## 安装

```bash
dsh plugin --profile web add dsh-workbuddy-memory
```

本地开发（profile 的 pnpm store 版本不一致时）：

```bash
node scripts/dev-install.mjs web
```

它把 profile 链接到本仓库（Windows 用 junction，其他平台用目录符号链接），所以改完源码只需重启 profile，不必重新安装。代价是 profile 依赖这个仓库原地不动；加 `--copy` 可退回自包含的复制安装，但每次改动都要重跑。

不要再往 `cordis.patch.yml` 手写 `insert:`——插出来的条目会和配置卡写入的条目成为两条同 id 记录。配置卡写入的是按 id 合并的覆盖条目。

要求 DSH `>= 0.2.0`；开发与实测基于 `0.2.0-rc.2` 与 `0.2.2-rc.1`。

## 读哪些文件

| 块 | 文件 | 说明 |
|---|---|---|
| 项目记忆 | `<cwd>/<dataFolder>/memory/MEMORY.md` | `dataFolder` 默认 `.workbuddy`，注入 |
| 日期笔记 | `<cwd>/<dataFolder>/memory/YYYY-MM-DD.md` | 当天流水，**不注入**，只提供路径 |
| 用户记忆 | `<workbuddyHome>/MEMORY.md` | 注入 |
| 用户画像 | `<workbuddyHome>/USER.md` 或 `user-<uid>-personal/USER.md` | 只读；多个候选且未指定 `profileUid` 时不注入 |

`workbuddyHome` 留空时按 WorkBuddy 的顺序解析：`WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` → `~/.workbuddy`。

## 第一次使用

- **纯读取不创建任何东西。** 不建目录、不建状态目录、不写回执。装到一台干净机器上先看看，是纯读操作。
- **第一次合法写入才创建布局**：`write.ensureLayout` 默认 `true`，所以往 `<cwd>/<dataFolder>/memory` 追加时会按需创建该目录（以及带 `# 记忆` / `## 常驻记忆` 骨架的文件）。显式设成 `write.ensureLayout: false` 可关掉——那时写入返回 `no_store`。
- 被拒绝的写入同样什么都不创建：参数校验在任何 `mkdir` 之前完成，所以一次 `multiline_text` 拒绝不会在磁盘上留痕。
- 已有的 WorkBuddy 目录与文件原地复用，不需要安装 WorkBuddy。

## 工具

注册给模型的工具只有五个：

| 工具 | 作用 |
|---|---|
| `memory_status` | 解析后的路径、当前模式、兼容状态、可写性与最近一次插件贡献 |
| `memory_read` | 读一个目标，返回 revision 与小节列表 |
| `memory_search` | 按字面量搜索记忆文件（`search.enabled: false` 时整个不注册） |
| `memory_append` | 往指定小节追加一条，或往当天笔记追加一行 |
| `memory_edit` | 替换或删除一条（只认 `- ` 条目，匹配不唯一时拒绝） |

批量管理——整节重写、恢复历史版本、归档旧日期笔记——**在面板里做**，人在写入前看得到预览和差异。这些动作故意不做成工具：同样的破坏性改写由模型来开，它面前只有自己的推理，版本栅栏也没法问"你确定是这个意思吗"。已撤掉的工具名也不留空壳别名：一个只会拒绝的定义，等于向模型宣告一项它没有的能力。

条目模型：一条条目是「`- ` 行 + 它下面的续行（缩进 ≥2 空格或制表符）+ 嵌套子条目」，`memory_edit` 按整条替换/删除，续行不会留成孤儿。`memory_append` 与 `memory_edit` 都只接受一条；`text` 里带换行会返回 `multiline_text`，`replacement` 里带换行则作为同一条的续行写入。

小节名：同名小节出现两次时返回 `ambiguous_section` 并附行号（改用行号定位）；空白小节名返回 `empty_heading`；第一个 `##` 之前、直接挂在 H1 下的条目用 `section: "(top)"`（或文件自己的 H1 标题）寻址。

## 写入、冲突与恢复

每一次写入——工具的和面板的——都走同一条链：跨进程锁 → revision 比对 → 备份 → 原子替换 → 写入后再读回校验。用 `write` / `edit` / `str_replace_editor` / `apply_patch` 直接改记忆文件会被守卫拒绝（按真实路径判定，指进记忆目录的符号链接/junction 一样拒）。这是防误操作的栅栏，不是执行环境的安全边界：它拦不住 shell 命令。

破坏性改写必须报出它看到的 revision。文件在下面被改过时，答案是 `conflict`，这次写入不落盘。面板的冲突弹层只给三条出口——**重新加载**（丢掉草稿，看磁盘现在的样子）、**保留草稿继续编辑**、**查看磁盘差异**——故意没有「覆盖」：那个按钮会扔掉 `expectedRevision`，而栅栏存在的意义就是查它，按下去还会连带丢掉另一个客户端刚写进去的内容。源码模式的横幅留的是「文件在你编辑期间被改过」，历史版本弹层说的是让你重新选版本，因为那里能做的动作就是选版本。

备份按文件、按次生成，名字是时间加随机后缀，用独占创建，所以同一毫秒的两次写入是两份文件。面板的撤销是十秒窗口，绑定的是产生它的那次写入（它的文件、它的项目、它的 revision），不是十秒后屏幕上恰好显示的那份文档。

幂等：同一个 `operationId` 会重放请求而不是写两遍。id 与动作、目标集合和请求体绑定，所以拿它去做另一个请求会被 `operation_mismatch` 拒绝，而不是返回另一个写入的结果。重放一个已提交的操作会拿回原始结果并带 `duplicate: true`。

## 面板

- **左栏「记忆」**：汇总所有 DSH 工作区与最近会话目录，按项目展开 `MEMORY.md` 和日期笔记。
- **右栏「项目记忆」页签**：与文件/变更并列，只看当前项目的记忆和全局记忆。
- **会话头「记忆」按钮**：打开或聚焦该页签。

面板支持条目录入（按行定位，点哪一行就改哪一行）、小节编辑、整文件源码模式、草案弹层（粘贴正文与它写作时对应的 revision；只有 revision 仍然一致才会建差异）、历史版本（列备份、预览差异、恢复预览过的那一个）、归档旧日期笔记，以及十秒撤销。归档把旧日期文件移动到 `memory/archive/`，绝不写 `MEMORY.md`；预览不建目录、不建状态，执行则绑定在预览出来的那份计划上——中途被改过的文件、预览之后才出现的文件都会被拒，而不是顺手扫走。

面板跟随宿主语言：所有文案都注册进宿主的 locale 服务，DSH 切语言时面板一起切。

## 配置

常用项（插件页配置卡覆盖常改的那几个，完整键见下表）：

| 键 | 默认 | 说明 |
|---|---|---|
| `readOnly` | `false` | 总闸，开启后一切写入被拒绝 |
| `workbuddyHome` | `''` | 留空跟随环境变量 |
| `dataFolderName` | `''` | 留空跟随 `WORKBUDDY_DATA_FOLDER_NAME`，再退到 `.workbuddy` |
| `inject.enabled` | `true` | 关掉后完全不注入 |
| `inject.mode` | `layered` | `full` 是兼容回退；在配置卡里切换 |
| `inject.coreBudget` | `4000` | 分层的 UTF-16 码元预算，4000–20000；在配置卡里改 |
| `inject.refresh` | `on-change` | `first-turn` 为每个会话冻结一份快照 |
| `inject.limits.*` | 10000 / 2000 / 8000 / 2000 | `full` 模式与 legacy 文件的各块上限（项目 / 规则 / 用户 / 画像）；`0` 在任何模式下都关掉该块。分层下 `limits.user` 同时决定 `inject.distillAbove` 的默认值（本值的两倍） |
| `inject.distillAbove` | `0` → `limits.user` 的两倍 | 用户记忆超过这个字符数时就会提示该按主题蒸馏：分层模式下写在主题目录里，整份（full）模式下写在规则块里。`0` 表示取 `limits.user` 的两倍，所以分层下 `limits.user` 既决定这一路源开不开，也决定这个默认阈值；一旦超过 `limits.user` 本身，full 的规则会先给「已超注入上限、部分内容读不到」的警告 |
| `inject.profileFile` / `inject.profileUid` | `''` | 显式指定画像文件，或按账号 uid 挑一个候选 |
| `inject.sanitizePaths` | `true` | 注入文本里把 home 前缀换成 `~` |
| `write.enabled` | `true` | 关掉后一切写入返回 `write_disabled` |
| `write.ensureLayout` | `true` | 第一次合法写入时创建项目记忆目录 |
| `write.backupKeep` | `20` | 每个文件保留的备份数；`0` 时拒绝破坏性改写 |
| `write.lockWaitMs` | `3000` | 等锁多久后返回 `lock_timeout` |
| `write.fsync` / `write.operationLog` | `true` | rename 前刷盘；给操作台账追加一行 |
| `guard.enabled` | `true` | 拒绝裸 `write` / `edit` / `apply_patch` 写进记忆文件 |
| `ui.enabled` | `true` | 关掉后侧栏面板与相关路由不注册 |
| `ui.allowWriteActions` | `true` | 面板写操作总开关 |
| `ui.allowFullTextEdit` | `true` | 源码模式与草案是否可以整份改写 |
| `ui.globalPanel` / `ui.projectTab` / `ui.sessionAction` | `true` | 三个面板入口开关 |
| `ui.refreshMs` / `ui.maxProjects` | `3000` / `50` | 面板轮询与扫描上限 |
| `search.enabled` | `true` | 关掉后 `memory_search` 不注册 |
| `search.maxResults` / `search.indexMaxFileBytes` | `8` / `262144` | 默认命中上限与单文件扫描上限 |

`stateDir` 与 `locale` 需要重载插件，只以 YAML 为准。

## 常见拒绝码与处置

工具会把这些码返回给模型，面板则用中文给出同样的说明。完整文案在面板的文案表里——下面这些是「带下一步动作」的。

| 拒绝码 | 发生了什么 | 怎么处理 |
|---|---|---|
| `layering_confirmation_required` | 文件里还是整份记忆，这次写入会把已有条目挪进「常驻记忆」小节下面。这个划分是用户的决定，不该由一次编辑顺带完成。 | 用面板的**粘贴草案**或**源码模式**整份保存一次，确认划分；之后写入就通了。最常见的触发方式：在一个还没划分的旧文件上新建一个叫「常驻记忆」/「Core Memory」的小节。 |
| `receipt_capacity` | 操作回执满了（未决 100 条，或总计 2000 条），所有带 `operationId` 的写入都被拒绝——面板每次点击都算。 | 已完成的回执可以从 `<stateDir>/receipts/` 删掉（默认 `~/.dsh/workbuddy-memory/receipts/`）。**先核实未决的**：`applying` / `partial` / `outcome_unknown` 的回执是「某次写入结果未知」的唯一证据。 |
| `backup_required` | `write.backupKeep` 是 `0`，破坏性改写因为没有退路被拒绝。 | 到插件配置里把 `write.backupKeep` 设为 1 以上——即 profile 的 `cordis.patch.yml` 中该条目的 `config:` 段（见[配置](#配置)）；面板里没有这个控件。0 的时候普通追加仍然允许。 |
| `plan_required` | 归档执行没有带上预览产生的计划。 | 重新预览一次归档，再从那份预览执行。 |
| `plan_conflict` | 计划过期了，或者预览之后日期文件集合变了。 | 重新出计划；预览之后才出现的文件故意不会被扫走。 |
| `operation_mismatch` | 这个 `operationId` 已经属于另一个请求，所以没有重放。 | 真正的新写入换一个 id；同一个 id 只用来重试完全相同的请求。 |
| `outcome_unknown` | 上一次写入的结果没能确认。 | 用**同一个**操作 id 重试，这是安全的；换新 id 可能执行两遍。 |
| `read_conflict` / `conflict` | 读取或写入期间文件被改动了。 | 重新读一遍再决定。设计上没有「覆盖」这个出口。 |
| `too_large` | 文件超过面板的读取/编辑上限（256 KB 文本）。 | 用外部编辑器，或者逐条改而不是整份改。 |
| `full_text_disabled` | 整份编辑（源码模式 / 草案）是关的。 | 到配置卡打开「全文编辑」。 |

## 与其它记忆插件的共存

**不要**在同一个 profile 里挂两个接管同一批记忆文件的插件。它们之间没有任何协调，而失败方式都很安静或者很莫名其妙：

- **工具重名。** 两个插件在同一个作用域注册 `memory_read`，第二个注册会失败。本插件会明确报出冲突的工具名，并把自己已经注册的部分回滚——不会顶替别人的定义。对方插件未必这么克制，所以最终哪个定义生效可能取决于加载顺序。
- **同一个文件被双写。** 两个引擎都认为自己拥有 `MEMORY.md`。一方的锁对另一方毫无意义，一方的 revision 比对也只能拦住它恰好看见的改动，于是写入可能悄悄覆盖另一方的。
- **同一份记忆被注入两次。** 两个插件把同一批文件读进提示词，每条条目都要付两遍上下文，模型还会看到两份可能已经走样的副本。

一批记忆文件只挂一个插件。这个版本不提供「前缀」方案，也不承诺跨引擎兼容。

## 边界

如实写，不当成安全承诺：

- **没有面板时**（headless，或 `ui.enabled: false`），模型只能读、搜、追加、单条编辑。归档旧日期笔记与恢复历史版本需要面板——按设计就没有对应工具。
- **`write.backupKeep: 0`** 时破坏性改写返回 `backup_required`（没有退路就不改写）；普通追加仍然允许：加字节不会截断已有内容。
- **去重回执是有限窗口**：已提交的回执记 24 小时，最多 2000 条，未决（applying / partial / outcome_unknown）最多 100 条且永不被挤掉。过了窗口，同一个 `operationId` 就是一个新请求。
- **外部编辑器不认本插件的锁。** 锁只协调愿意遵守它的写入者：本插件对自己是串行的。DSH 对不加锁的编辑器（WorkBuddy 自己的 `Edit`、普通文本编辑器）只靠 revision 比对，只能拦住它看得见的改动。同一毫秒窗口里的两次写入仍可能撞车，能兜住的是备份加上写入后记录的 revision，让它是可恢复的，而不是悄无声息——这种撞车没法从插件内部*避免*。同一时刻一个插件实例占用一份文件；两个引擎同时驱动同一批文件不在支持范围。
- **`memory_status` 不报 token。** `lastAssembly` 是本插件自己的贡献，单位是 UTF-16 码元，脱敏之后再量，并且带着 `measuredAs: 'plugin-contribution'` 标签——它不是宿主最终的提示词，也不是 token 数或费用。
- 只读侧失败一律降级为「不注入」，不会阻断对话。
- 项目块拿不到会话工作目录时不注入，不会退回 `process.cwd()`。
- 记忆文件是数据：注入时明确声明它不是指令。

## 开发

```bash
npm test
npm run test:coverage
```

设计笔记在 [`docs/`](https://github.com/Jasery/dsh-workbuddy-memory/tree/main/docs)：实现笔记
（`implementation-notes.md`）与设计文档（HTML）。

## 许可

MIT
