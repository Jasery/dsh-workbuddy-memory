# dsh-workbuddy-memory

[English](README.md) | 中文

让 DSH 直接共用 WorkBuddy 已经写好的记忆文件，不另存一份，也不用先装 WorkBuddy。

注入默认**分层**：少量核心常驻，其余按主题列成清单、用时再查。省下的是每轮都要付的上下文，不是能力——长记忆文件尤其明显。

## 模型看到什么

一个记忆文件分成两半，只有一半每轮都进上下文：

```
MEMORY.md
│
├─ ## 常驻记忆 ──────────► 每轮注入正文
│    - 每次都要用的那条        （只取前缀：放不下就停，并说明少了几条）
│    - 另一条每次都要用的
│
└─ ## 某个主题 ──────────┐
   ## 另一个主题 ────────┼─► 只注入小节名
   ## 第三个主题 ────────┘   要用时 memory_read 才读整节
```

于是提示词里大致是这样：

```
### 项目记忆
## 常驻记忆
- 每次都要用的那条…

### 可按需查询的主题
- 常驻没写的先看这里：memory_read(target=前缀-memory, section=主题名)…
- project/某个主题
- user/另一个主题
```

每行带 `project/` 或 `user/` 前缀，是因为 `memory_read` 要同时给 target 和 section——只给名字的话模型得猜去哪个文件读。清单被截断时会说明还有更多。

**预算** `inject.coreBudget` 默认 4000 码元（可设 4000–20000），分给项目核心、用户核心、固定规则和主题清单。`inject.mode: 'full'` 是兼容回退：整份注入，和早先版本一样。

没有核心小节的文件按整份注入（`memory_status` 显示 `legacy:*`，面板有提示条）。插件**不会自己**重排旧文件——怎么划分是你的决定。

> ⚠️ **主题正文只写 `- ` 条目。** 掺进别的东西——一句说明、一个子标题、一段代码围栏——**整个文件**就退回整份注入，因为分不干净的就不硬分。这是最容易被误认为「插件坏了」的行为。

## 安装

```bash
dsh plugin --profile web add dsh-workbuddy-memory
```

要求 DSH `>= 0.2.0`。不要往 `cordis.patch.yml` 手写 `insert:`——配置卡写入的是按 id 合并的覆盖条目，两者并存会变成两条同 id 记录。

改插件本身：

```bash
node scripts/dev-install.mjs web   # 把 profile 链接到本仓库
```

改完源码只需重启 profile。加 `--copy` 退回自包含安装，但每次改动都要重跑。

## 工具

只有五个：

| 工具 | 作用 |
|---|---|
| `memory_status` | 解析后的路径、当前模式、兼容状态、可写性 |
| `memory_read` | 读一个目标，返回 revision 与小节列表 |
| `memory_search` | 按字面量搜索记忆文件 |
| `memory_append` | 往指定小节追加一条，或往当天笔记追加一行 |
| `memory_edit` | 替换或删除一条 |

批量工作——整节重写、恢复历史版本、归档旧日期笔记——**在面板里做**，人在写入前看得到差异。这些故意不做成工具：同样的破坏性改写由模型来开，它面前只有自己的推理。

## 面板

左栏一个「记忆」入口、右栏一个「项目记忆」页签、会话头一个按钮。在里面可以逐条/按节编辑、整文件重写、粘贴模型给出的草案（会建差异；草案写作时的 revision 与磁盘不一致就拒绝）、浏览并恢复备份、归档旧日期笔记，以及十秒撤销。

## 安全

每一次写入——工具的和面板的——都走同一条链：加锁 → revision 比对 → 备份 → 原子替换 → 写回校验。破坏性改写必须报出它看到的 revision；文件在下面被改过就返回 `conflict`，这次写入不落盘。设计上没有「覆盖」这个出口。用 `write` / `edit` / `apply_patch` 直接改记忆文件会被拒绝，模型绕不过工具。

这是防误操作的栅栏，不是执行环境的安全边界：它拦不住 shell 命令。

## 读哪些文件

| 块 | 文件 |
|---|---|
| 项目记忆 | `<cwd>/<dataFolder>/memory/MEMORY.md` |
| 日期笔记 | `<cwd>/<dataFolder>/memory/YYYY-MM-DD.md`，不注入 |
| 用户记忆 | `<workbuddyHome>/MEMORY.md` |
| 用户画像 | `<workbuddyHome>/USER.md` 或 `user-<uid>-personal/USER.md`，只读 |

`dataFolder` 默认 `.workbuddy`。`workbuddyHome` 留空时按 WorkBuddy 的顺序解析：`WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` → `~/.workbuddy`。

纯读取不创建任何东西——不建目录、不建状态、不写回执。第一次合法写入才创建布局，被拒绝的写入同样什么都不创建。

## 配置

插件页的配置卡覆盖常用的几个：

| 键 | 默认 | 说明 |
|---|---|---|
| `readOnly` | `false` | 总闸，开启后一切写入被拒绝 |
| `inject.mode` | `layered` | `full` 是兼容回退 |
| `inject.coreBudget` | `4000` | 分层预算，4000–20000 个 UTF-16 码元 |
| `inject.limits.*` | 10000 / 2000 / 8000 / 2000 | `full` 模式与 legacy 文件的各块上限（项目 / 规则 / 用户 / 画像） |
| `inject.distillAbove` | `limits.user` 的两倍 | 用户记忆超过这个字符数就提示该按主题蒸馏 |
| `inject.profileUid` | `''` | 按账号 uid 挑一个画像候选 |
| `workbuddyHome` | `''` | 留空跟随环境变量 |
| `dataFolderName` | `''` | 留空跟随 `WORKBUDDY_DATA_FOLDER_NAME`，再退到 `.workbuddy` |
| `write.backupKeep` | `20` | 每个文件保留的备份数；`0` 时拒绝破坏性改写 |
| `ui.allowWriteActions` | `true` | 面板写操作总开关 |
| `search.enabled` | `true` | 关掉后 `memory_search` 不注册 |

其余键（`inject.refresh`、`inject.sanitizePaths`、`write.*`、`guard.*`、三个 `ui.*` 面板入口、`search.maxResults`）在 `src/config.js` 里带默认值声明，可在 profile 的 `cordis.patch.yml` 里设置。`stateDir` 与 `locale` 只以 YAML 为准，需要重载插件。

## 写入被拒绝时

面板会用中文给出同样的说明，模型拿到的也是这些码。

| 拒绝码 | 怎么处理 |
|---|---|
| `conflict` | 文件被改过了。重新读一遍再决定，设计上没有「覆盖」。 |
| `layering_confirmation_required` | 这次写入会把未划分的文件拆开。用面板的粘贴草案或源码模式确认一次划分。 |
| `receipt_capacity` | 操作回执满了。从 `<stateDir>/receipts/`（默认 `~/.dsh/workbuddy-memory/receipts/`）删掉已完成的——先核实未决的那些。 |
| `backup_required` | `write.backupKeep` 是 `0`。设为 1 以上；普通追加仍然允许。 |
| `outcome_unknown` | 用**同一个**操作 id 重试；换新 id 可能执行两遍。 |

## 边界

| 情况 | 结果 |
|---|---|
| 没有面板（headless 或 `ui.enabled: false`） | 模型只能读、搜、追加、单条编辑；归档与恢复历史版本需要面板 |
| 用外部编辑器改同一份文件 | 它不认本插件的锁，只有 revision 比对兜着，且只拦得住看得见的改动 |
| 同时挂两个记忆插件 | 不支持。两份锁互不相识，同一批条目还会被注入两次 |
| 同一个 `operationId` 隔很久再重放 | 已提交回执只记 24 小时、最多 2000 条，过窗口就算新请求 |
| `memory_status` 里的字符数 | 是本插件自己的贡献（UTF-16 码元），不是 token 数，也不是费用 |
| 读记忆失败 | 降级为不注入，不会阻断对话 |

只在 Windows 11 + Node 24 上验证过，Linux 与 Node 20 未验证。

## 开发

```bash
npm test
npm run test:coverage
```

设计文档与实现笔记在 [`docs/`](docs/)。

## 许可

MIT
