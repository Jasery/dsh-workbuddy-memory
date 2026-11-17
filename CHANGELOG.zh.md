# 更新日志

[English](CHANGELOG.md) | 中文

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
