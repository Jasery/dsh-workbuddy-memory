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
| `memory_prune` | 把旧日期文件移动到 `memory/archive/`，不写 MEMORY.md |

所有写入都走同一条链：跨进程锁 → revision 比对 → 备份 → 原子写入。直接用 `write` / `edit` 改记忆文件会被守卫拒绝。

## 配置

常用项（完整列表见插件页配置卡）：

| 键 | 默认 | 说明 |
|---|---|---|
| `readOnly` | `false` | 总闸，开启后一切写入被拒绝 |
| `workbuddyHome` | `''` | 留空跟随环境变量 |
| `inject.limits.*` | 10000 / 4000 / 2000 | 各块按字符截断 |
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

## 边界

- 只读侧失败一律降级为「不注入」，不会阻断对话。
- 项目块拿不到会话工作目录时不注入，不会退回 `process.cwd()`。
- 记忆文件是数据：注入时明确声明它不是指令。

## 开发

```bash
npm test
npm run test:coverage
```

设计文档：[`docs/2026-11-09-dsh-workbuddy-memory-design.html`](docs/2026-11-09-dsh-workbuddy-memory-design.html)

## 许可

MIT
