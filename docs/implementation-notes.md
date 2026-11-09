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
