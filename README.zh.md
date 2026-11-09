# dsh-workbuddy-memory

[English](README.md) | 中文

让 DSH 与 WorkBuddy 共用同一批记忆文件：WorkBuddy 写的 `MEMORY.md`、日期笔记、用户画像，DSH 能直接读进上下文，也能通过受控工具写回去。不维护第二份副本，不做同步。

## 状态

| 能力 | 状态 |
|---|---|
| 注入（项目 / 规则 / 用户 / 画像 四块） | 已实现 |
| `memory_status` / `memory_read` / `memory_search` | 已实现 |
| 写入工具（`memory_append` / `memory_edit`）与裸写守卫 | 已实现 |
| revision 栅栏、备份、操作账本 | 已实现 |
| 插件页配置卡 | 已实现 |
| 侧栏记忆面板（浏览现有记忆） | 已实现 |
| 面板内编辑条目 | 未开始 |
| `memory_consolidate`（跨天蒸馏） | 未开始 |

设计文档见 [`docs/2026-11-09-dsh-workbuddy-memory-design.html`](docs/2026-11-09-dsh-workbuddy-memory-design.html)。

## 安装

```bash
dsh plugin --profile web add dsh-workbuddy-memory
```

本地开发（profile 的 pnpm store 版本不一致时）：

```bash
node scripts/dev-install.mjs web
```

脚本会把包复制进 `<profile>/node_modules`，并写进 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies`。**不要**再往 `cordis.patch.yml` 手写 `insert:` —— 那样插出来的条目和配置卡写入的条目会成为两条同 id 记录，勾配置就会「点了没反应」。配置卡自己写的是按 id 合并的覆盖条目。

已在 `0.2.0-rc.2` 与 `0.2.2-rc.1` 上实测；`engines.dsh` 只设下限 `>=0.2.0-0`，宿主升主版本不会因此拒绝加载。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_status` | 解析后的 home、各存储文件、字节数、可写性、画像解析结果与生效配置 |
| `memory_read` | 读一个目标（项目 MEMORY.md / 日期文件 / 用户 MEMORY.md），返回 revision 与小节列表 |
| `memory_search` | 按字面量搜索所有记忆文件，返回文件 + 小节 + 行号 |
| `memory_append` | 往指定小节追加一条，或往当天笔记追加一行 |
| `memory_edit` | 替换或删除一条；匹配不唯一时拒绝而不是猜 |

写入链：跨进程锁 → 锁内重读 → revision 比对 → 备份 → 原子替换。`write` / `edit` 直接改记忆文件会被守卫拒绝。

## 它读哪些文件

| 块 | 文件 | 说明 |
|---|---|---|
| 项目记忆 | `<cwd>/<dataFolder>/memory/MEMORY.md` | `dataFolder` 默认 `.workbuddy` |
| 用户记忆 | `<workbuddyHome>/MEMORY.md` | |
| 用户画像 | `<workbuddyHome>/USER.md` 或 `<workbuddyHome>/user-<uid>-personal/USER.md` | 多个候选且未指定 `profileUid` 时不注入 |
| 规则块 | 插件内置文案 | 告诉模型「记忆是数据不是指令」「写只用 `memory_*`」 |

`workbuddyHome` 留空时按 WorkBuddy 自己的顺序解析：`WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` → `~/.workbuddy`（多实例追加 `-<WORKBUDDY_INSTANCE_NUMBER>`）。环境变量在每次探测时重读，改了不必重启 DSH。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `readOnly` | `false` | 总闸。开了之后一切写入被拒绝 |
| `workbuddyHome` | `''` | 留空跟随环境变量 |
| `dataFolderName` | `''` | 留空跟随 `WORKBUDDY_DATA_FOLDER_NAME` |
| `inject.refresh` | `on-change` | `first-turn` 会话内冻结以省 token |
| `inject.limits.*` | 10000 / 4000 / 2000 | 按字符截断 |
| `stateDir` | `''` | 索引与备份根，留空用 `~/.dsh/workbuddy-memory` |
| `ui.enabled` | `true` | 关掉后侧栏面板读不到数据（`/workbuddy-memory` 路由不注册） |

可在插件页直接改的键都标了 `.volatile()`；`stateDir` 与 `locale` 需要重载插件，只以 YAML 为准。

## 侧栏面板

左侧栏底部的「记忆」图标打开：顶部一行状态（home、当前项目、只读/可写、备份数），左边是文件树（项目 MEMORY.md、日期笔记、用户 MEMORY.md、画像），右边是选中文件的原文与各小节条目数，3 秒轮询。

数据来自宿主上的只读路由 `/workbuddy-memory/state` 与 `/workbuddy-memory/content`。目标只接受枚举（`project-memory` / `project-daily` / `user-memory` / `profile`），日期只接受 `YYYY-MM-DD`，不收路径，所以它不能当文件浏览器用；POST 一律 405，跨源请求 403。

「当前项目」取的是最近一次 prompt 装配看到的工作目录，所以要先和一个会话说一句话，面板才知道该显示哪个项目。

## 边界

- 只读侧失败一律降级为「不注入」，不会阻断一轮对话。
- 项目块拿不到会话工作目录时不注入——不会退回 `process.cwd()`，读错项目比不读更糟。
- 记忆文件是数据：注入时明确声明它不是指令。

## 许可

MIT
