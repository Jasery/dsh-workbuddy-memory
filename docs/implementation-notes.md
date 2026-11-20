# 实现笔记：宿主契约实测

设计文档（`2026-11-09-dsh-workbuddy-memory-design.html`）是按包内 `.d.ts` 与 README 写的，实际跑起来有几条与文档假设不同。这里记录实测结论，避免下次重新踩。

环境：`@deepseek-ai/dsh` 0.2.0-rc.2（全局 CLI）+ web profile。

## 1. 注入不需要走 waterfall

`section()` 的 `text` provider 签名是 `(context: AssembleContext) => string`，类型上只有 `{ scope, signal }`。但 `assemble()` 把**同一个 context 对象**传给 section provider、context provider 和 variable provider，而 `dsh-agent-loop` 通过 `ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)` 读它 —— 说明运行时 context 上有 `agent`。

结论：`text: (context) => context.agent?.session?.header?.cwd` 直接可用，不必改走 `system-prompt/assemble` 瀑布。省掉「自行 sort 后 push」的麻烦，顺序交给宿主按 `order` 归并。

`session.header.cwd` 类型上是可选的；拿不到时项目块返回空字符串，不回落 `process.cwd()`。

## 2. 空 section 不会从数组里消失

返回 `''` 的 section 仍然留在 `assembly.sections` 里（`text: ''`），只是在 `renderPrompt()` 拼字符串时被 `filter(text => text.length > 0)` 丢掉。

所以「开关关掉」的验证方式是断言 `renderPrompt(assembly)` 不含该块，不是断言 `assembly.sections` 里没有它。

## 3. volatile 不能嵌套

`inject: z.object({ enabled: z.boolean().volatile() }).volatile()` 会让插件**加载失败**：

```
ValidationError: invalid config:
  - $.inject.enabled volatile fields require a fixed object path without an enclosing volatile field
```

规则：volatile 只能标在「没有 volatile 祖先」的固定路径上。要么标叶子（`inject.enabled`），要么标整块（`inject.limits`，内部字段不再标），不能同时。

这条错误发生在 `resolveConfig`，即 **Config 校验失败 = 插件条目不激活**，日志里只有一行 `1 entry did not activate`。

## 4. settings 命名空间 = profile entry id

- `ctx.configForms.get(id)` 和 `whileServed([id])` 的 id 是 **profile 条目 id**（`- id: workbuddy-memory`），不是包名。
- `plugins.bundle.config` slot 的 `key` 才是**包名**（`dsh-workbuddy-memory`）。
- 两者混用不会报错，只会得到一个永远不触发的 `whileServed` —— 配置卡静默不出现。

## 5. 插件页显示条件

插件要出现在插件页「已安装」列表，profile 的 `package.json.dependencies` 必须有它。只有 `cordis.patch.yml` 里的 insert 条目不够 —— 插件会正常工作，但页面上找不到。

配置卡是否渲染取决于 `ledger.bundles.has(pkg.name)`，即 `plugins.bundle.config` slot 有没有注册成功；而注册能否成功又取决于 Host 是否 serve 了该命名空间，后者要求 Config 里**至少有一个 volatile 字段**。

## 6. 工具 schema 必须显式 additionalProperties

```js
output: { schema: { type: 'object' } }   // JsonSchemaError: schema.additionalProperties must be explicitly true or false
output: { schema: { type: 'object', additionalProperties: true } }  // ok
```

`defineTool` 的 `parameters` UI schema 与 `output.schema`（标准 JSON Schema）是两套东西，前者宽松，后者严格。

## 7. client 模块格式

不是 ESM 文件，而是：

```js
window.__ModuleLoader__.load({
  id: '<包名>',
  factory: (require) => {
    const React = require('react')
    return { apply, inject: ['slots'] }
  },
})
```

`require` 由宿主注入（React 单实例，不打包）。客户端 `inject` 数组是**必需服务**，列了 `configForms` 会在旧版本上整个 client 不加载 —— 所以用 `ctx.inject(['configForms'], cb)` 子作用域，缺失时静默跳过。

## 8. 本地安装绕不过 pnpm store

`dsh plugin --profile web add <path>` 会调用内置 pnpm。若 profile 之前由另一个 pnpm 大版本创建，直接失败：

```
ERR_PNPM_UNEXPECTED_STORE  The dependencies at ...\node_modules are currently linked from the store at ...\store\v11
```

这时的替代路径是 `scripts/dev-install.mjs`：把包文件复制到 `<profile>/node_modules/<name>`，不改 store。`cordis.patch.yml` 的条目仍需手写一次（脚本不动用户配置）。

## 9. 配置写入真的落到 patch 文件

在配置卡上勾「只读模式」，`cordis.patch.yml` 末尾出现：

```yaml
- id: workbuddy-memory
  name: dsh-workbuddy-memory
  config:
    readOnly: true
```

宿主保留 YAML 注释，只在同名条目上合并 `config`。取消勾选写的是 `readOnly: false`（显式值），不是删掉该行 —— 想回到「跟随默认」应走 `unset`，值语义留给后续版本。

## 10. Web UI 首次认证

`dsh web` 打印的 `?token=` 用于换 cookie：`GET /` 命中 token → 303 → `Set-Cookie ...; HttpOnly; SameSite=Strict`。token 不是一次性的，但浏览器首次落在 401 页面时不会自动重试，需要一次 `location.replace('./')` 或刷新才进得去。

## 11. 在 0.2.2-rc.1 上复跑（2026-11-09 晚）

本机有两套宿主：全局 CLI 原为 `0.2.0-rc.2`，桌面 runtime 已是 `0.2.2-rc.1`。把全局 CLI 升到同一个版本后复跑，插件无需改核心逻辑，但有五处宿主契约变化值得记下来。

### 11.1 升级方式：必须用 Node 24 装

`@deepseek-ai/dsh@0.2.2-rc.1` 的 `engines.node` 是 `>=24.9.0`，而 PATH 上的默认 node 是 22.22.2（WorkBuddy 自带）。用 22 装也能装（只是 EBADENGINE 警告），但正确做法是用桌面 runtime 里的 node 24 跑 npm：

```bash
npm-prefix-bin=$(dirname $(which node))/node      # 换成 runtime 的 node.exe
"$NODE24" "$NPMCLI" install -g @deepseek-ai/dsh@0.2.2-rc.1 --prefix "$APPDATA/npm"
```

装的时候若报 `EBUSY ... koffi.node`，是本机还跑着旧版 dsh（koffi 原生模块被占用），先停掉再装。

### 11.2 `assemble()` 现在要求工具执行器在场

`ctx.systemPrompt.assemble()` 内部要做工具 schema 投影，会调用 `tools.selectExecutor()`；组合里没有执行器时直接抛 `ToolExecutorUnavailableError`。这不是插件的 bug（装配由宿主发起），但任何在进程内复现装配的测试脚本都要先挂 `@deepseek-ai/dsh-tool-executor-native`。

### 11.3 装配上下文的 `agent` 是顶层字段

`assembleContextFor(agent, signal)` 返回 `{ agent, scope: agent, signal }`。注入侧读 `context.agent.session.header.cwd` 在 0.2.0 与 0.2.2 上一致；把 `agent` 塞进 `scope` 里则读不到。

### 11.4 插件要登记进 `dsh.profile.bundles`，不能只手写 insert

这条最要紧。原来在 profile 的 `cordis.patch.yml` 里手写：

```yaml
- insert:
    - id: workbuddy-memory
      name: dsh-workbuddy-memory
```

配置卡能显示、能勾选，但 `form.set()` 的落盘是在**用户 patch 层追加一条同 id 的新条目**，结果装配里出现两个 `workbuddy-memory`，`insert` 里那条永远是旧值 —— 表现为「勾了没反应」。

正确做法是把它当 bundle：`package.json` 的 `dsh.profile.bundles` 加包名（`dependencies` 也要有，插件页才会列出）。bundle 层负责 insert 条目，用户 patch 层的 `- id: workbuddy-memory` 再按 id 合并 `config`，装配结果只有一条：

```yaml
- id: workbuddy-memory
  name: dsh-workbuddy-memory
  config:
    readOnly: true
```

`scripts/dev-install.mjs` 已改为自动完成这两步，不再打印「手写 insert」。

### 11.5 只读时规则块换文案

复跑时发现的真缺口：`readOnly: true` 只让工具返回 `read_only`，但注入的规则块仍在教模型「用 memory_append 写」。模型会照着试，白跑几轮。现在 `readOnly` 走 `rulesReadOnly` 文案（中英各一份），直接说明本次会话只读、不要尝试写入、要改请让用户关掉开关。

### 11.6 0.2.2 上不兼容的第三方插件（与本插件无关）

启动日志会报 `1 entry did not activate`：`better-sidebar` 在等一个 `webRuntime` 服务，0.2.2 里没有；`dsh-plugin-gate` 在插件页显示「异常」。这两个是别家的插件，不影响本插件——本插件在 0.2.2 上注入、工具、守卫、配置卡全部通过。

## 12. 面板写路由（M4c/M4d）

### 12.1 `req` 是可读流，不需要宿主提供 body 解析

`webServer.register({kind:'prefix'})` 的 handler 拿到的是标准 `IncomingMessage`，`req.on('data')` / `on('end')` 直接可用。所以 `/action` 自己读 body，带硬上限并在超限时 `req.destroy()`，不依赖任何未公开的宿主中间件。上限最初是 64 KB，L3 整份文件写入把它提到 512 KB（`MAX_ACTION_BYTES`，见 §14.6）；读路由的正文上限仍是 2 MB、显示截断 256 KB（`MAX_BODY_BYTES` / `MAX_TEXT_CHARS`）。

### 12.2 状态码按「人接下来能做什么」定

`conflict` → 409（重新读一遍再决定）、`read_only` / `write_disabled` / `write_actions_disabled` → 403、`no_store` / `no_revision` / `not_found` → 404、`too_large` → 413、`lock_timeout` → 423，其余 400。客户端只把这些 code 翻成一句话（`describeCode`），不在 UI 里判断业务。

### 12.3 行号比文本匹配适合面板

工具用「关键词 + 唯一性检查」定位条目，这对模型够用；面板握着的是「我渲染的是第 3 行」，用文本匹配反而会在两行内容相同时报 `ambiguous`。所以 `editEntryAt(text, heading, line)` 先校验该行仍在小节范围内、且确实是一个 `- ` 条目，否则 `stale_line`。文件在别处被改过时，行号校验会先失败，比 revision 检查更早给出可读原因。

### 12.4 旧日期只归档，不搬进 MEMORY（WorkBuddy 同款）

早期版本有个 `consolidate`：把 30 天前的日期条目**原样**按 `## YYYY-MM-DD` 成节 append 进 `MEMORY.md` 再清源行。这是错的——WorkBuddy 的 30 天维护是**提示词指令**，由模型按主题**蒸馏**进 MEMORY 后**删除旧文件**，靠语义压缩控制体积；原样搬运只会撑爆 10000 字符注入限额。

现已改为 `prune`：只把旧日期文件 `rename` 到 `memory/archive/`，**绝不写 MEMORY.md**。蒸馏交给模型（注入规则里写明先蒸馏再归档）。移动而非删除，原始流水可找回；`dryRun` 默认 true 先出计划。注入规则同步改为「先蒸馏进 MEMORY，再归档；不要原样搬流水」。当时还给了模型一个 `memory_prune` 工具，后来随管理工具一起撤出模型目录，入口只剩面板「归档旧日期」（见 §15.6）。

### 12.5 面板测试需要一个 hooks 运行时

纯函数测试覆盖不到「点击 → fetch → 重渲染」。`tests/helpers/react.mjs` 实现了一个单实例 hooks 运行时（`useState` 有真实 setter、`useEffect` 按 deps 比较、`useMemo`/`useCallback` 缓存），`settle()` 循环渲染直到没有新状态，`fire()` 把事件喂给某个节点的 handler。这能把「点一行 → 发一条 `{type:'edit', line:3, expectedRevision:'rev-project'}`」钉死，也会在 hook 顺序错乱时立刻炸出来。

一个坑：hook 槽是模块级的，跨测试复用会把上一个用例的选中态带进来 —— 每个用例前必须 `runtime.reset()`。

### 12.6 `title` 也要跟着权限走

只读时行内仍渲染了 `title="点击编辑"`，测试断言抓到的。提示语必须和可操作性一致，否则用户点了没反应还会以为坏了。

## 13. 面板「这个项目」是谁

### 13.1 面板没有会话，只能沿用最近装配过的 cwd

`recent.cwd` 是注入路径的副作用：`systemPrompt.section` 的 `text(context)` 拿到 `context.agent.session.header.cwd` 时顺手记下。所以**没说过话就没有项目**，面板显示「未确定」。这是设计如此，但不是好的交互 —— 用户不知道自己该做什么。

### 13.2 多项目：白名单 + 不可逆 key

第一版只有一个 `recent.cwd`，切项目只能靠「去那个项目说一句话再刷新」。现在 `recent` 带一个 12 条上限的 `Map<cwd, ts>`，`/state` 返回 `projects` 列表（含 `name` / `hasMemory` / `daily`），客户端渲染成下拉框。

关键约束：`/content?project=<key>` 的 key 是 `sha1(cwd).slice(0,8)`，且**必须在白名单里**，否则 404 `unknown_project`。这样面板能切项目，但仍然读不到任何「插件没见过」的路径 —— 安全性没有因为多项目而放宽。

### 13.3 「没有 MEMORY.md」不等于没有记忆

用户最容易卡住的一点：项目记忆目录里有 `YYYY-MM-DD.md` 但没有 `MEMORY.md`，面板左栏只写「这个项目还没有 MEMORY.md」，看起来像整个项目都没记录。现在空态文案明确说：两个是独立文件，日期笔记在下面单独列。

### 13.4 修改入口要写全路径

「面板只读」这种提示等于没说。现在详情区顶部直接给路径：**插件页 → dsh-workbuddy-memory → 记忆面板 → 面板写操作**，并补一句「不想开也可以让智能体调 memory_append / memory_edit」。

## 14. 面板 v2：项目目录、右栏页签与编辑

### 14.1 工作区注册表要「读」不要「inject」

`ctx.workspaceRegistry.list()` 是宿主侧拿全部项目的权威来源。不要在插件里 `ctx.inject(['workspaceRegistry'])`：那会把它记成硬依赖，`ui.enabled: false` 或没有工作区服务的 profile 也会被牵连。用 `ctx.get('workspaceRegistry')` 在每次需要时懒读，拿不到就退回 `recent.seen`。

返回值：`{ id, path, title, sessionIds, createdAt, updatedAt }`。`updatedAt` 适合做「最近活跃」排序，`path` 是 canonical realpath。

### 14.2 右栏页签是两段式注册

```js
ctx.sidebarRightTabs.register({
  id: '<包名>', kind: '<kind>', priority: 'extension',
  title: () => '项目记忆',
  guide: [{ id: 'memory', order: 40, title: () => '项目记忆' }],
})
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '<包名>' }, Body))
```

- 第一段声明「这是什么页」；第二段用 `id`（不是 `kind`）作为 key 提供 body / title。
- `openTab(kind)` 打开；`openTabIn(sessionId, kind)` 是 Tab 域的内部路径，不在 `ISidebarRight` 接口上。
- body 是 session scope，props 里有 `sessionId`；用它解析当前项目，不要用 `recent.cwd`。
- 会话头按钮挂在 `conversation.session.header.utilities`，是 session scope 的 list，点击后调 `openTab` 即可。

### 14.3 项目解析优先用会话，不要猜 cwd

`main` 与右栏 tab 的 props 都带全局 `useSessions` / `useWorkspaces`：

- 主面板：找 `retainedBy.mainView > 0` 的会话，读 `cwd`；
- 右栏 tab：直接用 props 的 `sessionId`；
- 再退回会话所属工作区的 `path`，最后才是宿主最近一次装配的 cwd。

### 14.4 汇总接口要分两层

`/state` 返回全量项目摘要 + `totals`，但不返回条目正文；正文仍走 `/content`。统计按 `MEMORY.md` 的 `mtime + size` 缓存，项目多时只 `stat` 不重读。`resolve(key)` 直接遍历 seed 比 `list()` 后再找便宜得多，避免每个 `/content` 都重算全部项目。

### 14.5 截断显示的 revision 要用全文算

`describe()` 为面板截断正文到 256 KB，但 `revision` 必须用读到的完整文本（`contentRevision(file.text)`）算，否则面板拿截断前缀的 revision 去保存，永远 `conflict`。

### 14.6 全文编辑的 body 上限

L3 会带整份文件，`POST /action` 的 body 上限从 64 KB 提到 512 KB；store 另用 `validateDocument()` 拒绝超过 256 KB、含 NUL、代码围栏不闭合的文本。面板对 `doc.truncated` 的文档禁用 L2/L3，避免把截断内容写回去。

### 14.7 编辑默认值与二次确认

`ui.allowWriteActions` 现在默认 `true`。整份文件写（源码模式与草案）没有单独的开关：`ui.allowFullTextEdit` 已移除，用不用源码模式由用户决定。面板第一次进入源码模式会弹一次整文件写入的风险提示（`sessionStorage` 记住本次浏览器会话），那只是提示，不是功能门禁。真正的写入仍然经过锁、CAS、备份和账本。

## 15. 分层注入与写链（2026-11-16 优化，实测）

本节记录当前实现，全部结论都能在 `src/` 与 `tests/` 里找到对应代码或用例。未验证的项在 §15.10 单独列出。

### 15.1 分层识别规则（`src/layers.js`）

- 只认 **H2**：`## 常驻记忆` / `## Core Memory`（大小写不敏感，`toLocaleLowerCase` 比较）。代码围栏内的行不参与标题扫描，围栏用 ``` / ~~~ 配对，且只认同一种标记。
- 核心小节必须**恰好一个**。0 个 → `legacy:missing_core`；多个 → `legacy:ambiguous_core`。
- 核心正文按条目解析：`- ` 开头的非空行开启一条；缩进 ≥2 且非空的行是上一条的续行；其它任何非空行（散文、子标题）→ `legacy:invalid_core`，并回传 `problem: { section, line }` 供面板定位。
- **其余 H2 小节（主题）不要求是条目**（2026-11-19 放宽）：主题只在提示词里出现小节名，正文由 `memory_read(section=…)` 整节读出，形状不影响能不能读。解析成功就按条目计数，失败则把正文原样保留成**一个整块**（去掉首尾空行），长度照实计入按需那一半。空正文的小节直接跳过，不列进主题清单——没有正文的小节在目录里只是一个指向空气的名字。与核心同名的第二个 H2 不重复计入主题。
- 放宽之前，主题小节里出现一句散文、一个 `###` 或一个代码围栏就整份判 `legacy:non_entry_content`，后果是用户已经写好的常驻小节从来没被当成核心用过，而面板只显示「未划分常驻/按需」——等于否认用户做过的操作。`non_entry_content` 这个 reason 现在**不再产生**，但文案保留，兼容旧宿主。
- 第一个 H2 之前的非标题、非空文本会成为一个「未分节」主题（`heading: null`），渲染时用 `t('unsectioned')` 显示。
- 空核心正文合法：`entries: []`，`mode: 'layered'`。

### 15.2 预算切分与「前缀」语义（`src/render.js`）

- `coreBudget` 默认 4000，`normalizeConfig` 夹到 4000–20000。
- 切分在 `render.js` 的 `LAYERED_SHARES` 里，单位是**比例**不是码元，所以随 `coreBudget` 缩放：项目核心 35%、用户核心 35%、规则 17.5%、主题目录 + 兼容提示 12.5%（合计 100%）。用 `shareOf(coreBudget, block)` 取某一块的额度，不要在别处重新写 `Math.floor(coreBudget * 0.xx)`——这三个数字原先散在三处，改一处漏两处。
- **规则块的份额是按英文定的，不是按中文。** 同样五条规则，中文 411 码元、英文 657 码元。原先 12.5%（500）时英文装不下第 5 条日期文件规则，`fitText` 会静默丢掉它——结果英文会话完全不知道日期文件存在，中文会话知道。17.5%（700）让两种语言都装得下且都有余量（中 +289 / 英 +43）。改这个比例前先跑 `tests/render.test.mjs` 里那条「the rules share is sized for English」。
- 核心条目是文件**前缀**：第一条放不下就停止，不会跳过它去捡后面更短的条目——跳过会让模型分不清「漏掉的」和「被删掉的」。溢出提示的槽位在任何条目落位前预留，且按最坏情况（位数最多）预留，所以加提示永远不会把块顶出预算。
- 少放了条目时状态写成 `layered:core-over-budget(N)`，并进入 `compatibility`；`NORMAL_STATES` 之外的任何状态都算「这块不是全部」。
- 规则块在分层下不用 `inject.limits.rules` 的长度，而是 `shareOf(coreBudget, 'rules')`，整行取舍；**规则块里的蒸馏/超限提示只在 `inject.mode: 'full'` 下注入**（`hint = layered ? '' : …`）。判据是配置模式，不是某个文件是否退回 legacy——所以 legacy 文件跑在默认分层配置下同样没有这段提示。分层下用户记忆超限的可见性由主题目录与 `memory_status` 的 `compatibility` 承担。
- **但 `inject.distillAbove` 两种模式都生效**（M-3 起）：full 下写在规则块（`distillHint`），分层下写在主题目录（`render.js:111-114` 的 `overShare` 带 `distill` 标记 → `overShareDistill` 文案）。所以两种模式超过同一阈值都会说「该蒸馏」，区别只在提示落在哪一块。
- `limits.project` / `.user` 在分层下只当**块上限**的开关用（`> 0` 才启用），不参与预算。但 `limits.user` 还有第二个作用：`distillAbove` 的默认值是 `2 × limits.user`（`resolveDistillAbove`），所以**分层下调小 `limits.user` 会让同一个文件更早被判为该蒸馏**。实测：同一份 5033 字符用户文件，`limits.user: 8000`（阈值 16000）只出「常驻只取核心」，`limits.user: 2000`（阈值 4000）多出「已超过蒸馏阈值……下次改动时先按主题蒸馏」。`limits.user: 0` 仍然关掉整个用户来源（`render.js:79` 先判 `> 0`，`distillAbove` 也随之变 0）。这条语义由 `tests/render.test.mjs` 的 `in layered mode limits.user still moves the distillation threshold it derives` 钉住，面板 hint 与 README 配置表按它写。
- 主题目录的 section 名沿用 `workbuddy-memory:profile`（与画像块共名），所以状态从 `states.directory` 读，不从名字推断。
- `inject.mode: 'full'`：每块按自己的 `limits.*` 整份渲染，UTF-16 码元计量，包装/前缀/截断提示都算在内；`prefix.length >= limit` 时**不产出任何块**，状态记 `full:too-small`（不记 `full`，否则「注入了」是谎话）。
- 混合状态：只要有一路源退回 legacy，整体 `mode` 报 `mixed`，否则 `layered`；`full` 模式报 `full`。

### 15.3 会话快照作用域（`src/inject.js`）

- 四个 section provider 共用一次 `stateFor(context)`：
  - `on-change`（默认）：`perAssembly` 是 `WeakMap<context, state>`，一次装配算一次；提交事件或 `invalidate()` 会换掉整张表（`generation += 1`）。
  - `first-turn`：`firstTurn` 是 `WeakMap<session, {cwd, generation, configSignature, state}>`。**按会话对象**冻结，不是按 cwd——同一项目的另一个会话读到的是文件此刻的样子，这正是「刚改完模型还读旧内容」的成因。
- 文件内容走 `createFileCache()`（有界 64 文件 / 8 MB / 单文件 2 MB，按 `mtime+ctime+size` 失效，读后再 stat 一次，不一致就放弃这次快照）。提交事件会 `invalidate(path)` 对应文件并 bump generation。
- `lastAssembly(session)` 只在 `generation` 与 `configSignature` 都还一致时返回，且带 `measuredAs: 'plugin-contribution'`。它是本插件的贡献（UTF-16 码元），不是宿主最终提示词，也不是 token；`memory_status` 的描述里写明这一点。

### 15.4 写入链锁序（`src/write/store.js`、`src/write/fslock.js`）

固定顺序，任何新入口都必须照此排队，否则会死锁或丢更新：

```
operation lock（op-<hash>.lock，只有带 operationId 时）
  → receipts 事务锁（<stateDir>/locks/receipts.lock）
    → 文件锁（pathKey 派生，Windows 下 identity() 折叠大小写与分隔符）
      → CAS（expectedRevision 比对）
        → transform / prepare（纯内存）
        → 备份（独占创建，时间 + randomUUID）
          → 回执 applying（必须在破坏性动作**之前**落盘）
            → 原子替换（同目录临时文件 + rename）
              → 写后读回校验（revision 必须等于计划值）
```

归档（`prune`）的锁序是：operation → receipts → archive 目录锁 → 按日期排序的源文件锁（全部取完再动任何一个文件）。所有事件（`onCommit`）都在锁释放之后发出，监听器抛错或 reject 不会改变写入结果。

### 15.5 回执状态机与 ABA 保守策略（`src/write/receipts.js`）

- 状态：`applying` → `committed` / `partial` / `outcome_unknown`。只有 `committed` 会过期（24h）；`applying` / `partial` / `outcome_unknown` 属于未决，永远保留、计入未决上限（100）。
- 上限：总记录 2000 条、未决 100 条、单条 1 MB。到达上限时**拒绝新操作**，不删未决记录腾位；结构不合法的回执同样按未决计（删掉一个含义不明的记录可能删掉唯一证据）。
- 读、过期清扫、容量准入、写入都在同一把跨进程锁内完成，所以两个进程不会同时看到「还剩最后 1 个未决槽」。
- 重放：带同一个 `operationId` 且指纹一致时，`committed` 直接返回原结果 + `duplicate: true`；`applying` 则比较磁盘 revision：
  - 等于记录的 `after` → 认定是崩溃前那次提交，补记 `committed`（补记失败则如实报 `outcome_unknown` + `committed: true`）。
  - 等于记录的 `before` → **保守拒绝**：文件可能被改到 `after` 又改回来，无法证明写入没跑过，于是把回执标成 `outcome_unknown` 并返回 `outcome_unknown`（`reason: applying_unverified`）。这就是 ABA 的取舍：宁可让人来判，不自动重做。
  - 两者都不是 → 同样 `outcome_unknown`。
- 指纹 = `{action, 规范化后的目标路径集合, 请求体（键排序）}` 的 hash。所以同一个 id 用在别的目标或别的请求上是 `operation_mismatch`，不会返回另一个写入的结果。
- 无 `operationId` 的调用不写回执，也就没有回执级去重（CAS 仍在）。`operationLog: false` 只关掉统计台账，不影响回执。

### 15.6 归档计划绑定与 partial 恢复（`src/write/archive.js`、`store.prune`）

- 预览是纯内存：计划存在进程内，最多 100 份、TTL 10 分钟、单次最多 1000 个文件；**不创建** state 目录、archive 目录或回执。
- 执行必须有 `operationId`（否则 `operation_required`）、有 `planId`（否则 `plan_required`）、有非空日期列表。计划绑定 `canonicalPath(projectDir)`、日期集合与每个候选的 revision；`plan_conflict` 的 reason 区分 `project` / `expired` / `unknown_date` / `changed` / `missing`。
- 第一批移动前把 manifest（每个日期 + 目标路径 + 状态）写进回执 `applying`；之后每个文件的状态变化都更新回执。回执 update 失败立刻停手并返回 `partial`（带已移动/失败清单），绝不继续移动。
- 重放按 manifest 逐项判定，而不是重新枚举：`moved` 项复查目标 hash；源和目标都存在、或都不存在 → `outcome_unknown`（不猜）；只有目标存在且 hash 对得上 → 认定已移动。全部成功才 `committed`，有失败则 `partial` 并保留可重试的 manifest。
- 最终状态写入失败时绝不报 `ok`：`outcome_unknown` 或 `partial`，且把文件变更事件照样发出去。
- 已知取舍：归档不写 MEMORY.md，也不提供模型侧入口；归档没有配套的一键「移回」——原始流水在 `memory/archive/` 里，人工可取回。

### 15.7 五个模型工具与 UI 承接

- 注册集合固定为 `memory_status` / `memory_read` / `memory_search` / `memory_append` / `memory_edit`。`search.enabled: false` 时 `memory_search` 整个不注册；已撤的四个工具（`memory_prune`、`memory_replace_section`、`memory_list_revisions`、`memory_restore`）没有任何别名空壳。
- 所有工具结果过一层 `lossless()`：`undefined` → `null`，非有限数 → `null`，`-0` → `null`。宿主对 tool result 做 lossless 快照，任一非法值会判整份非法，而写入此时已经落盘——所以兜底放在注册处而不是各工具里。
- **主题标题的命名引导放在「写的那一刻」，不占注入预算。** 目录里每行只有 `project/<标题>`，标题写成一个名词（「Git」）就等于这一节在模型眼里不存在：它知道有这个主题，但判断不出什么时候该读。引导落在三处：`memory_append` 的 `section` 描述（随工具 schema 每轮可见，不计入 `coreBudget`）、面板新建小节表单的占位符与说明行（`editor.sectionPlaceholder` / `editor.sectionTitleHint`；日更文件不显示说明行——那里的标题是日志分组，不是目录项）、以及 `layer.copyPrompt`（模型出划分草案时照它命名）。**没有往 `compactRules` 加第 6 条**：英文规则块 657 / 700 只剩 43 码元，而 `fitText` 从尾部整行丢弃，加一行会被静默丢掉（`tests/render.test.mjs` 的英文 headroom 用例会先红）。真要进常驻规则，只有两条路——改写现有英文规则腾出空间，或把 `LAYERED_SHARES.rules` 从 17.5% 抬到 19%（目录 12.5%→11%），都不是纯文案改动，留给下一次预算调整。
- 面板承接（`POST /workbuddy-memory/action` + `GET /state|/content|/revisions|/revision`）：`add`/`edit`/`remove`/`replace-section`/`replace-document`/`remove-section`/`restore`/`prune`。请求走宿主信任栅栏 `connection.requestRejection`（拿不到该服务时降级为本地 origin 检查），`/action` 还要求 `application/json`。
- 面板与工具共用同一个 `store` 实例，所以两条路径在同一把锁上排队；`ui.allowWriteActions` 是面板写操作的总开关，整份文件写（`replace-document` 与草案）只受 `readOnly` 与 `write.enabled` 约束，没有额外的功能开关。
- 冲突出口只有三条（重载 / 保留草稿 / 查看磁盘差异），没有「覆盖」。恢复（`restore`）必须带当前 revision，且会先把当前文件备份一次，所以恢复本身也可撤销。

### 15.8 已知限制

- 锁只对**协作方**有效。外部编辑器（WorkBuddy 自己的 `Edit`、任意文本编辑器）不认这把锁，只靠 revision 比对兜；同一毫秒窗口里的竞争写可能撞车，靠备份 + 写后 revision 变成「可恢复」而不是「可避免」。两个引擎同时驱动同一批文件不在支持范围（不加路径前缀做隔离）。
- 无面板时模型只能读、搜、追加、单条编辑；归档与历史恢复必须由人在面板点。
- `backupKeep: 0` 时破坏性改写返回 `backup_required`，普通追加仍允许。面板没有「备份保留数」控件（`write.backupKeep` 没进配置卡），所以拒绝文案指向 profile 的 `cordis.patch.yml` 的 `config:` 段，而不是一个不存在的开关。
- 去重只在窗口内：已提交回执 24h / 2000 条，未决 100 条；过了窗口同一个 id 就是新请求。
- `memory_status` 不估 token、不估注入字符数；`lastAssembly` 只是插件贡献（UTF-16 码元，脱敏后测量）。
- `src/tools/status.js` 里的 `describe()`（详细探针）当前没有调用方——面板 `/state` 用的是 `routes.js` 自己的 `describe(path)`。它保留未删，`tests/` 也不覆盖它，所以覆盖率里 `status.js` 偏低（47%）。**未验证**：这段代码是否还有用途，未做决定。
- 分层下的**规则块**超限/蒸馏提示不注入（见 §15.2），但 `inject.distillAbove` 的阈值在分层下仍通过主题目录生效；`limits.user` 是它的默认基准，所以分层下调小 `limits.user` 会改变同一份文件的输出。这是有意的取舍（两个阈值都要保留），不是遗漏。

### 15.9 工具契约细节（从 README 移入）

这些是工具的行为契约，不是实现选择，但篇幅细碎，放在 README 会把介绍写成手册。

- **条目模型**：一条条目 =「`- ` 行 + 它的续行（缩进 ≥2 空格或制表符）+ 嵌套子条目」。`memory_edit` 按整条替换/删除，续行不会留成孤儿。`entrySpan()` 的终止规则：标题一定结束条目；同缩进或更浅的条目开始新条目；更深的条目是子条目保留；空行只在下一行仍缩进时保留（否则它是两条之间的分隔）；其他情况结束。
- **一次一条**：`memory_append` 与 `memory_edit` 都只接受一条。`text` 里带换行返回 `multiline_text`（否则一次调用会偷写多条）；`replacement` 里带换行则作为同一条的续行写入并缩进对齐，因为那读作「一条换行的条目」。
- **小节寻址**：同名小节返回 `ambiguous_section` 并附行号，改用行号定位；空白小节名返回 `empty_heading`；第一个 `##` 之前、直接挂在 H1 下的条目用 `section: "(top)"` 或文件自己的 H1 标题寻址（`parseSections` 从 level 2 起，H1 是文档标题不是主题，所以这片区域单独给了伪小节名，否则那些条目注入得到、搜得到，却没有任何工具能改）。
- **`memory_edit` 的匹配**：只认 `- ` 条目，命中续行时解析到它所属的条目（文字确实在那里，可寻址的是上面那行）；只出现在普通段落里返回 `not_an_entry` 而不是 `no_match`，让调用方知道文字在但不可寻址。匹配不唯一返回 `ambiguous` 并附行号，不猜。
- **`memory_read`**：`section` 返回该小节全文（含标题），`sectionsOnly` 只回标题与条目数；`offset` / `nextOffset` 按 UTF-16 码元分页且不切断代理对，落在代理对中间的 offset 返回 `bad_offset` 而不是静默挪位。文件超过 2 MiB 返回 `too_large`：从部分内容算出的 revision 会让一次编辑删掉它没读到的部分。
- **`memory_status`** 的 `compatibility` 覆盖所有「注入的不是全部」的状态，不只是 `legacy:`——核心超预算、主题清单被截断同样说明模型看到的是子集。

### 15.10 本轮未验证

- 只在 Windows 11 + Node 24.14.0 上跑过；Linux 与 Node 20 未运行，不能宣称跨平台通过。
- 未在本机真实 DSH profile 上做 live UI 复验（不安装 profile、不动真实记忆是用户本轮的约束），面板行为由 `tests/panel.test.mjs`（真实组件 + 桩 React + 桩 fetch）验证。
- 未测最低宿主版本（0.2.0）与新宿主的组合；未测实际模型费用，不提供「省了多少 token」的承诺——分层的收益无法在没有真实 LLM 计费的实验里量化。

## 16. CI 与发布（2026-11-17）

### 16.1 分工：CI 只校验，`v*` tag 才发布

`.github/workflows/ci.yml` 跑在 push main 与 PR 上；`.github/workflows/publish.yml` 只由 `v*` tag 触发（或手动 `workflow_dispatch`）。合并到 main 不可能发版。

这与方案 O-08 原本写的「只校验、不发布」不同。用户当次明确要求 CI 自动发布，于是「发布前必须人工确认」这条规则换了一个执行点：**打 tag 就是那个确认**。发布路径上没有第二个开关，也没有「顺手发出去」的入口。

### 16.2 发布前把三处版本号对齐成机器检查

tag、`package.json.version`、两份 CHANGELOG 是三个独立的「这是哪个版本」的声明，npm 和 git 都不比较它们。`scripts/check-release.mjs` 一次比完，另外查 registry：

- 已发布 + 没有 `--allow-published` → 失败（防止把旧版本重发成新 tag）；
- 已发布 + 有 `--allow-published` → 打印 `already-published: true`，workflow 跳过 publish 只重建 Release。这样重跑一个发布作业是幂等的，不必删 tag 再推。
- registry 不可达 → `unknown`，不当作「版本空闲」放行，也不阻塞发布。

查的是单版本端点 `/<name>/<version>`，不是 packument——后者随每次发布增长。

### 16.3 Release 正文从哪来

`scripts/release-notes.mjs` 优先用 `.release-notes/v<version>.md`（手写、可带 `# 标题` 首行），否则取 `CHANGELOG.zh.md` 的 `## <version>` 小节；末尾追加 compare 链接，上一个 tag 由 `git describe --tags --abbrev=0 <tag>^` 得出，所以 checkout 必须 `fetch-depth: 0`。两种情况都不会产出空正文。

### 16.4 测试对运行环境的两个隐式依赖（CI 暴露）

本地一直是绿的，上 CI 一次挂掉 49 条，原因都不在代码逻辑：

- **面板文案跟随 `navigator.language`**，CI runner 是 `en-US`，而断言全是中文。Node 20 上更糟：`navigator` 全局根本不存在（v21 才加），于是必然回落到英文。修法是 `tests/helpers/locale.mjs` 在测试里固定语言——让文案成为测试的属性，而不是机器的属性。
- **`--test-coverage-include` 是 Node 22 才有的参数**。矩阵里 Node 20 只跑 `npm test`，覆盖率单独在 Node 24 上测。

### 16.5 两个真 bug：路径在「创建之前」没有规范化

`canon()`（guard）与 `resolveLink()`（fslock）原先都只在**整条路径存在**时才 `realpath`，否则原样返回调用方的写法。这在路径本来就规范的机器上看不出问题，在 CI 的 Windows runner 上炸了 11 条，根因是同一个：`TEMP` 是 8.3 短名（`C:\Users\RUNNER~1\...`），文件创建前后同一个文件有两种写法。

- guard 侧：`isMemoryTarget()` 对「记忆目录里即将新建的文件」返回 false，于是 `write` 直接写进去——正好是 guard 存在的意义所在的那个写操作。
- 指纹侧：`fingerprintFor()` 哈希路径，第一次调用（文件还不存在）与重放（文件已存在）得到不同指纹，重放被判 `operation_mismatch` 而不是 `duplicate`，receipt 的重放安全性失效。

修法统一为「解析最近的存在祖先，再把缺失的尾段接回去」，实现在 `resolveLink()` 一处，`guard.canon()` 直接复用。三个收据测试另有一处同类问题：用 `String(to).startsWith(stateDir)` 判断路径，而 `writeFileAtomic` 在 rename 前会 realpath 目标，两者拼写不同，注入的失败一次都没触发。

### 16.6 发布命令（人工兜底）

CI 是主路径，但保留手工发版能力：

```bash
node scripts/check-release.mjs <version>        # 对齐检查
npm publish --access public                     # 临时 userconfig 指向 registry.npmjs.org
git tag -a v<version> -m "<标题>" && git push origin v<version>   # 触发 publish.yml
```

`npm publish` 成功后不要再用 `npm view` 验证：npm 有审核期，期间 CLI 查不到该版本，重试还会报 `E409 Cannot publish over previously staged version`——那是正常流程不是失败。
