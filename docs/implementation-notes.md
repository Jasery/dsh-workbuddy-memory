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

`webServer.register({kind:'prefix'})` 的 handler 拿到的是标准 `IncomingMessage`，`req.on('data')` / `on('end')` 直接可用。所以 `/action` 自己读 body，带 64 KB 硬上限并在超限时 `req.destroy()`，不依赖任何未公开的宿主中间件。

### 12.2 状态码按「人接下来能做什么」定

`conflict` → 409（重新读一遍再决定）、`read_only` / `write_disabled` / `write_actions_disabled` → 403、`no_store` / `no_revision` / `not_found` → 404、`lock_timeout` → 423，其余 400。客户端只把这些 code 翻成一句话（`describeCode`），不在 UI 里判断业务。

### 12.3 行号比文本匹配适合面板

工具用「关键词 + 唯一性检查」定位条目，这对模型够用；面板握着的是「我渲染的是第 3 行」，用文本匹配反而会在两行内容相同时报 `ambiguous`。所以 `editEntryAt(text, heading, line)` 先校验该行仍在小节范围内、且确实是一个 `- ` 条目，否则 `stale_line`。文件在别处被改过时，行号校验会先失败，比 revision 检查更早给出可读原因。

### 12.4 旧日期只归档，不搬进 MEMORY（WorkBuddy 同款）

早期版本有个 `consolidate`：把 30 天前的日期条目**原样**按 `## YYYY-MM-DD` 成节 append 进 `MEMORY.md` 再清源行。这是错的——WorkBuddy 的 30 天维护是**提示词指令**，由模型按主题**蒸馏**进 MEMORY 后**删除旧文件**，靠语义压缩控制体积；原样搬运只会撑爆 10000 字符注入限额。

现已改为 `prune`（工具 `memory_prune` / 面板「归档旧日期」）：只把旧日期文件 `rename` 到 `memory/archive/`，**绝不写 MEMORY.md**。蒸馏交给模型（注入规则里写明先蒸馏再归档）。移动而非删除，原始流水可找回；`dryRun` 默认 true 先出计划。注入规则同步改为「先蒸馏进 MEMORY，再 memory_prune 归档；不要原样搬流水」。

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

`ui.allowWriteActions` 与 `ui.allowFullTextEdit` 现在默认 `true`。设置卡里把全文编辑从关到开会先弹确认；面板第一次进入源码模式也会弹一次（`sessionStorage` 记住本次浏览器会话）。两处都只是 UI 确认，真正的写入仍然经过锁、CAS、备份和账本。
