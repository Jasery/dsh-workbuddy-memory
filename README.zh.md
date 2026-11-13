# dsh-workbuddy-memory

[English](README.md) | 中文

让 DSH 与 WorkBuddy 共用同一批记忆文件：WorkBuddy 写的 `MEMORY.md`、日期笔记与用户画像，DSH 直接读进上下文，也能通过受控工具写回去。不维护第二份副本，不做同步。

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

要求 DSH `>= 0.2.0`，已在 `0.2.0-rc.2` 与 `0.2.2-rc.1` 上实测。

## 读哪些文件

| 块 | 文件 | 说明 |
|---|---|---|
| 项目记忆 | `<cwd>/<dataFolder>/memory/MEMORY.md` | `dataFolder` 默认 `.workbuddy`，注入 |
| 日期笔记 | `<cwd>/<dataFolder>/memory/YYYY-MM-DD.md` | 当天流水，**不注入**，只提供路径 |
| 用户记忆 | `<workbuddyHome>/MEMORY.md` | 注入 |
| 用户画像 | `<workbuddyHome>/USER.md` 或 `user-<uid>-personal/USER.md` | 多个候选且未指定 `profileUid` 时不注入 |

`workbuddyHome` 留空时按 WorkBuddy 的顺序解析：`WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` → `~/.workbuddy`。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_status` | 解析后的路径、文件大小、可写性与生效配置 |
| `memory_read` | 读一个目标，返回 revision 与小节列表 |
| `memory_search` | 按字面量搜索全部记忆文件（`search.enabled: false` 时不注册） |
| `memory_append` | 往指定小节追加一条，或往当天笔记追加一行 |
| `memory_edit` | 替换或删除一条（只认 `- ` 条目，匹配不唯一时拒绝） |
| `memory_replace_section` | 整节重写（比逐条 edit 快，用于压缩一节） |
| `memory_list_revisions` | 列出某个文件可回滚的备份 |
| `memory_restore` | 回到某个备份（`expectedRevision` 必传） |
| `memory_prune` | 把旧日期文件移动到 `memory/archive/`，不写 MEMORY.md |

后三个只在 `ui.allowWriteActions` 打开时注册，走的是与面板完全相同的写链。

条目模型：一条条目是「`- ` 行 + 它下面的续行（缩进 ≥2 空格或制表符）+ 嵌套子条目」，`memory_edit` 按整条替换/删除，续行不会留成孤儿。`memory_append` 与 `memory_edit` 都只接受一条；`text` 里带换行会返回 `multiline_text`，`replacement` 里带换行则作为同一条的续行写入。

小节名：同名小节出现两次时返回 `ambiguous_section` 并附行号（改用行号定位）；空白小节名返回 `empty_heading`；第一个 `##` 之前、直接挂在 H1 下的条目用 `section: "(top)"`（或文件自己的 H1 标题）寻址。

所有写入都走同一条链：跨进程锁 → revision 比对 → 备份 → 原子写入。直接用 `write` / `edit` 改记忆文件会被守卫拒绝。

## 配置

常用项（完整列表见插件页配置卡）：

| 键 | 默认 | 说明 |
|---|---|---|
| `readOnly` | `false` | 总闸，开启后一切写入被拒绝 |
| `workbuddyHome` | `''` | 留空跟随环境变量 |
| `inject.limits.*` | 10000 / 2000 / 8000 / 2000 | 各块按字符截断（项目 / 规则 / 用户 / 画像） |
| `inject.distillAbove` | `0` → `limits.user` 的两倍 | 用户记忆超过这个字符数时，规则里会要求按主题蒸馏；一旦超过 `limits.user` 本身，规则会先给「已超注入上限、部分内容读不到」的警告 |
| `ui.enabled` | `true` | 关掉后侧栏面板与相关路由不注册 |
| `ui.globalPanel` / `ui.projectTab` / `ui.sessionAction` | `true` | 三个面板入口开关 |
| `ui.allowWriteActions` | `true` | 面板写操作总开关 |
| `search.enabled` | `true` | 关掉后 `memory_search` 不注册 |

`stateDir` 与 `locale` 需要重载插件，只以 YAML 为准。

## 面板

- **左栏「记忆」**：汇总所有 DSH 工作区与最近会话目录，按项目展开 `MEMORY.md` 和日期笔记。
- **右栏「项目记忆」页签**：与文件/变更并列，只看当前项目的记忆和全局记忆。
- **会话头「记忆」按钮**：打开或聚焦该页签。

面板支持条目录入、小节编辑、整文件源码模式与撤销；旧日期文件可归档到 `memory/archive/`，归档不写 MEMORY.md。写入仍是同一条存储链，文件被外部改动时返回 `conflict` 并给出重载/覆盖等出口。

面板跟随宿主语言：所有文案都注册进宿主的 locale 服务，DSH 切语言时面板一起切。

## 边界

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
