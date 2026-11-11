# dsh-workbuddy-memory

[English](README.md) | 中文

让 DSH 与 WorkBuddy 共用同一批记忆文件：WorkBuddy 写的 `MEMORY.md`、日期笔记、用户画像，DSH 能直接读进上下文，也能通过受控工具写回去。不维护第二份副本，不做同步。

## 状态

| 能力 | 状态 |
|---|---|
| 注入（项目 / 规则 / 用户 / 画像 四块） | 已实现 |
| `memory_status` / `memory_read` / `memory_search` | 已实现 |
| 写入工具（`memory_append` / `memory_edit` / `memory_prune`）与裸写守卫 | 已实现 |
| revision 栅栏、备份、操作账本 | 已实现 |
| 插件页配置卡 | 已实现 |
| 侧栏记忆面板（浏览 + 编辑 + 搜索） | 已实现 |
| 面板内归档旧日期（不写 MEMORY）与撤销 | 已实现 |

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
| `memory_search` | 按字面量搜索所有记忆文件，返回文件 + 小节 + 行号（`search.enabled: false` 时不注册） |
| `memory_append` | 往指定小节追加一条，或往当天笔记追加一行 |
| `memory_edit` | 替换或删除一条；只认 `- ` 条目，散文与子标题拒绝；匹配不唯一时拒绝而不是猜 |
| `memory_prune` | 把旧日期流水归档到 `memory/archive/`，不写 MEMORY.md（`dryRun` 默认 `true`，先出计划再执行） |

`memory_edit` 的 `replacement` 只写条目正文，`- ` 前缀与缩进由文件保留（传了也会被剥掉再补回）；`mode=replace` 时 `replacement` 为空会返回 `empty_text`，不会静默删掉那条。

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
| `ui.allowWriteActions` | `true` | 面板写操作总开关。关着时面板只读，`/action` 一律拒绝；面板内可一键开启 |
| `ui.allowFullTextEdit` | `true` | 源码模式（整文件编辑）。第一次进入时二次确认；关闭后源码入口会引导开启 |
| `ui.globalPanel` | `true` | 左栏「记忆」全局总览入口 |
| `ui.projectTab` | `true` | 右侧栏原生「项目记忆」页签 |
| `ui.sessionAction` | `true` | 会话头「记忆」快捷按钮 |
| `ui.refreshMs` | `3000` | 面板轮询 `/state` 的间隔 |
| `ui.maxProjects` | `50` | 全局总览最多展示的项目数 |
| `write.ensureLayout` | `false` | 项目里没有 `.workbuddy/memory` 时，由第一次写入创建它 |
| `search.enabled` | `true` | 关掉后 `memory_search` 不注册，模型看不到该工具 |

可在插件页直接改的键都标了 `.volatile()`；`stateDir` 与 `locale` 需要重载插件，只以 YAML 为准。

## 侧栏面板

现在只有一个左侧入口，项目记忆在右侧栏：

- **记忆（总览）**：扫描 DSH 已登记的全部工作区 + 最近会话目录，按项目汇总条目数、字节、日期文件和待归档状态；点项目展开带辅助线的文件树（`MEMORY.md` 与日期笔记）
- **右侧栏「项目记忆」页签**：与文件/变更并列的原生页签，按会话绑定当前项目；和总览一样是左侧文件列表 + 右侧文档的两栏布局，只是文件列表只含当前项目的 `MEMORY.md`、日期笔记和全局记忆
- **会话头「记忆」按钮**：打开 / 聚焦右侧栏页签

打开项目页签时会自动落到 `MEMORY.md`；没有 `MEMORY.md` 就落到最新日期笔记，不会先停在文件选择器或空统计上。

详情按 `## 小节` 分组，顶部有搜索框（本地过滤 + 高亮）与「源码」「归档旧日期」「重新加载」。

编辑能力默认开启：

| 层级 | 交互 | 落到哪 |
|---|---|---|
| L1 条目 | 点一行变成单行输入框，Enter 保存 / Esc 取消 | `POST /action {type:'edit'}` |
| L1 删除 | 行尾删除图标 | `POST /action {type:'remove'}` |
| L1 新增 | 小节标题右侧 `＋`；日期笔记用「添加一条」 | `POST /action {type:'add'}` |
| L2 小节 | 小节标题右侧「编辑小节」→ 该小节原始内容 → 保存 | `POST /action {type:'replace-section'}` |
| L3 源码 | 文档头「源码」→ 整文件 → 结构校验 | `POST /action {type:'replace-document'}` |
| 删除小节 | 小节标题右侧删除图标 → 确认 | `POST /action {type:'remove-section'}` |
| 撤销 | 保存后 10 秒内点「撤销」 | `POST /action {type:'restore'}` |
| 归档旧日期 | 出计划（哪些日期文件）→ 勾选 → 移动到 `memory/archive/`，不写 MEMORY | `POST /action {type:'prune'}` |

历史浏览/回滚入口已移除；写入前备份仍保留，用于撤销和冲突恢复。

面板数据通道：`GET /state`、`GET /content`、`POST /action`，全部同源校验。目标只接受枚举（`project-memory` / `project-daily` / `user-memory` / `profile`），日期只接受 `YYYY-MM-DD`，不收路径，所以它不能当文件浏览器用；跨源请求 403；`/action` 还强制 `content-type: application/json` 且 body ≤ 512 KB（源码模式要带整份文件）。宿主侧仍保留 `/revisions`、`/revision` 只读路由和写入前备份，供撤销与诊断使用；面板不再提供历史浏览。

面板不是第二条写入路径：每个动作都进同一个 `store`，同一把锁、同一套 revision CAS、同一份备份、同一本操作账本。写入时带上你看到的 revision，文件在此期间被改过就返回 `conflict`，面板给三个出口（重新加载 / 查看磁盘差异 / 保留草稿 / 覆盖并先备份）。

「当前项目」优先取当前会话所属的工作区（右侧栏按 tab 的会话解析），其次取最近一次 prompt 装配看到的工作目录；总览页不依赖会话，工作区注册表里有的项目都会出现。

### 项目来源

- 全局总览合并两个来源：DSH 的**工作区注册表**（`ctx.workspaceRegistry`）与**最近装配过提示词的目录**；前者覆盖已经登记但还没聊过的项目
- 项目记忆页优先用当前会话所属工作区；没有会话时退回最近一次装配的目录；右侧栏页签按自己 tab 的会话解析
- 总览不需要会话，刷新时直接读注册表；项目 key 仍然只在这份白名单里解析（cwd 的 sha1 前 8 位），不接受任意路径
- 不做磁盘递归扫描：工作区注册表已经是权威列表，递归会跨权限、软链和大目录

项目记忆在 `<项目>/.workbuddy/memory/`。`MEMORY.md`（长期）与 `YYYY-MM-DD.md`（当天流水）是两个独立文件：**没有 MEMORY.md 不代表这个项目没记录**，日期笔记会单独列在树里。

## 测试

```bash
npm test               # 157 个用例
npm run test:coverage  # 带覆盖率
```

`tests/e2e.test.mjs` 起一个真实 HTTP 服务打真文件（临时目录），验证「JSON → 文件变化」这条缝；`tests/panel.test.mjs` 用一个极简 hooks 运行时驱动总览与项目页，点击 → fetch → 重渲染整条链路。

当前：**行 81.7% / 分支 76.6% / 函数 66.2%**（`src/` 全部文件都进统计；面板重构后新增的交互分支还未全部覆盖）。

| 覆盖面 | 用例锁定的是 |
|---|---|
| `paths` / `env` | 路径解析链、六种环境矩阵、画像歧义不猜 |
| `markdown` | 追加与替换逐字节稳定、围栏内标题不算小节、匹配不唯一拒绝、改条目保留 `- ` 前缀、空替换报 `empty_text`、散文与子标题不算条目、删条目不留空行 |
| `write/store` | 锁内复检、revision 栅栏、备份、`read_only` / `write_disabled`、日期笔记按本地日历、`ensureLayout` 开关 |
| `write/guard` | 真路径分类、兄弟目录不误伤、只读时让行、非写入器放行 |
| `render` | 四块顺序、开关只关一块、超限截断、代理对不切半、home 脱敏 |
| `inject` / `cache` | 同一次装配只读一次盘、`first-turn` 冻结、provider 异常不炸 turn |
| `tools/*` | 五个工具的正常路径 + 冲突 + 幂等重放 + 歧义拒绝 |
| `host/routes` | JSON 形状、枚举 target、非法日期、405/403、项目汇总与 totals |
| `client` | 用四钩子的假 React 渲染，锁住「宿主 snapshot 没有 `mode` 时控件仍可编辑」；总览树、项目解析、L1/L2/L3 动作与冲突出口 |

没有自动化覆盖的部分：真实浏览器里的拖拽/焦点行为，以及跨进程并发写（`fslock` 的等待与超时分支只测到一半）。

## 边界

- 只读侧失败一律降级为「不注入」，不会阻断一轮对话。
- 项目块拿不到会话工作目录时不注入——不会退回 `process.cwd()`，读错项目比不读更糟。
- 记忆文件是数据：注入时明确声明它不是指令。

## 许可

MIT
