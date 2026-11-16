# 默认分层与五工具记忆插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在原目录上实现轻量默认分层、可靠读写与用户管理闭环，模型工具收敛为五个，保留显式全文回退。

**Architecture:** 纯解析/预算层选择核心与目录；Host 以会话快照和有界文件缓存装配。所有工具与 UI 共用 store 的锁、版本、备份、回执和提交通知。低频管理保留在 UI，不另造模型管理工具或第二份记忆。

**Tech Stack:** Node >=20，ESM JavaScript，node:test，schemastery/Cordis；现有无构建 Client JS；无新增生产依赖。

**Spec:** `docs/2026-11-16-通用记忆插件-分层设计.html` + `docs/2026-11-16-原优化方案逐项复审结论.html#tools`。优先级：本计划明确接口 > 复审结论 > 分层专题 > 原11项历史方案。用户2026-11-16 16:18明确授权开工、指定CodeBuddy实现与主代理验收；无需重复询问既定推荐路线。

## Global Constraints

- 当前分支 `feature/memory-optimizations`；基线 `59133e2`；不合main、不发版、不tag、不创建Release；不改真实profile/用户记忆做测试。
- 默认沿用WorkBuddy目录，不依赖安装WorkBuddy；纯读不创建任何持久目录；合法首次写才创建；显式ensureLayout:false保留。
- 默认 `inject.mode='layered'`，显式 `'full'` 回退；保留既有refresh默认on-change，不增加turn-start、静默名单、工具前缀、多目录扫描或向量库。
- `inject.coreBudget=4000`，范围4000–20000 UTF-16码元；项目核心37.5%、用户核心37.5%、固定规则12.5%、目录/提示余量；所有包装计数、完整条目、Unicode安全。旧文件兼容正文用旧limits，明确不受4000总额约束。
- 核心为唯一H2 `常驻记忆`/case-insensitive `Core Memory`，围栏内不认；空核心有效；缺失/重复/不支持结构为可见兼容状态；不自动重排旧文件。
- 五个默认模型工具：memory_status/read/search/append/edit；search.enabled:false仍可隐藏搜索；无UI也不恢复管理工具；不留旧名字空壳。
- 普通edit/remove强制CAS；append可选CAS；批量管理只在可信UI以预览基线执行。单一路径、共享文件锁、备份防碰撞、持久有界回执与操作指纹；lossless JSON。
- 无额外LLM调用；主模型生成草案，由用户复制正文和来源baseRevision到面板预览后保存；旧基线/截断源拒绝，不能删revision强盖。
- 暂不升级package版本或改变DSH下限。最低宿主版本/实际模型费用未测不能写通过；不得以代码字符数等同token或费用。
- 用户后续明确调整：剩余实现和返修由lead直接启动内置subagent，不再调用CodeBuddy；写任务仍串行，不并行写同仓库。每任务先失败测试再修、相关测试后全套一次、限定文件提交；报告写`.workbuddy/tmp/implementation-20261116/task-N-report.md`（忽略目录）。实现者不能派生子代理、push、install到profile。已完成CodeBuddy产物保留按同标准验收。

## Review Focus

1. schema返回volatile引用及热更新注册生命周期——Task1用真实schema解析＋可dispose事件夹具测试，不只原始对象。
2. 同ID两个进程排队／旧CAS／回执失败／备份同毫秒——Task2在同一目标和全局操作号范围验证，不靠顺序重试。
3. 旧文件普通写入暗中生成核心标题、超限emoji和目录、无效首写创建垃圾——Task3以真实临时文件测试拒绝和无副作用。
4. UI文件/项目切换后的异步预览、选错备份与过期baseRevision——Task4绑定目标身份与版本，按钮状态和路由端都验证。
5. UTC与未来日期、版本支持、pack漏敏感文件、无UI回退——Task5固定时钟与本地回归；用户取消CI矩阵，未运行的远端平台明确未知。

## File Structure & ownership

Task1: config.js/index.js/runtime-config.js(可新增)；fsx.js/tools/read.js/env.js；对应测试。
Task2: write/store.js/fslock.js/receipts.js(新增)/archive.js(可新增)；store测试；定义后续onCommit和归档plan接口。
Task3: layers.js(新增)/render.js/cache.js/inject.js/tools/status.js；store初始化与过渡检查、index通知接线；locale；测试。
Task4: client.js/host/routes.js/tools/index.js/tools/write.js；新增client-management.js仅在现有导出方式可无依赖加载时；UI/route/tool测试与locale。
Task5: README中英、implementation-notes、CHANGELOG、package-lock必要版本一致（不升版本）；本地场景回归；审查脚本改为修后验证（不是删除暴露缺口的证据）。用户取消本轮CI，不新增.github/workflows或远端矩阵。

### Task 1: 配置真实生效与安全读取

**Files:** src/config.js, src/index.js, src/runtime-config.js(optional), src/fsx.js, src/tools/read.js, src/env.js; tests/index/inject/paths/tools/render及新config测试；tests/store/e2e中的日期夹具。

**Interfaces:**
- `normalizeConfig(raw)`继续返回平值对象，先递归读取合法volatile `.get()`引用（包括limits整个对象），原始对象可用，不修改引用。
- `registerTools()`与`registerSections()`须返回可释放控制器（保留原names/invalidate接口）；注册变化通过精确disposer或子Context重建，不积累注册。ui/guard/sections对应重新挂载；loader/volatile-update来自安装源，事件体paths，ctx.on事件存在时订阅。保持同一个cfg对象引用、深更新，stateDir/locale普通修改按重载。
- `readTextSafe(path,{maxBytes})`保留现有形状，真正有界读取；截断标识可靠。`readTool`新增`offset`按所选原文UTF16偏移、返回`offset/nextOffset/truncated`；代理对边界对齐；limit默认20000，上限200000。
- 2MiB以上目标读取拒绝`too_large, revision:null, writable:false`，不发片段hash。只读`user-profile`目标不进入store.TARGETS写枚举，歧义拒绝；保留默认read参数兼容。

- [x] RED: schema.validate({readOnly:true, workbuddyHome:fixture,search:{enabled:false},inject:{limits:{user:3000}}})→apply实际工具拒写、路径不回退、搜索未注册；更新refs触发事件后权限/注册变；目录纯读无创建。
- [x] RED: UTF16码元分页含emoji拼接无损、section分页、offset不合法拒绝、2MiB+无伪revision、single profile uid正确。现有日期用本地构造或固定now，归档old/new相对日期，不给整个CI改TZ掩盖。
- [x] Run focused RED with exact failed output in report.
- [x] Implement above;注册时获取disposer并安全清理，当前ctx缺可选事件API测试仍可降级启动，不能假装热更新。
- [x] Run focused GREEN and full `node --test` once；UTC日期测试单跑通过；`git diff --check`。
- [x] Commit only owned paths `fix(config): 修复配置引用及读取边界`，report包括接口和测试，不push。

### Task 2: 写入正确性、回执与归档计划

**Files:** src/write/store.js, fslock.js, receipts.js(new), archive.js(optional); tests/store及新concurrent/receipts测试；routes/client的接口仅记录，Task4消费，不在本任务改UI。

**Interfaces:**
- `createStore({cfg,stateDir,onCommit?})`返回原方法＋`subscribe(listener):disposer`；成功有变化的提交一次发`{path,target,operation,revision,operationId}`；duplicate/dryRun不通知；partial归档已移动项也逐路径通知。通知在锁释放后统一发射，不await监听Promise，隔离同步异常与异步rejection；onCommit与subscribe共用一点。
- 所有已有内容的edit/editAt/remove/replaceSection/removeSection/replaceDocument/restore强制非空expectedRevision；append可选；too_large/unreadable完整源拒绝；只读与write.enabled仍最先拦截。Task1已经将readTextSafe无cap分支也改为同fd前后fstat、变更ok:false,error:'changed'；所有store读caller（尤其daily append旧532行及写后回读）必须检查ok/truncated再用text，不能把changed当空文件继续写；拒绝时外部字节与换行均保留。不要恢复helper的旧长度伪快照。
- `prune({dryRun:true,beforeDays?,dates?},probe)`返回`planId,candidates[{date,revision,...}],expiresAt`；在内存有界保存最多100个计划、10分钟，纯预览不建state/archive目录；随机计划ID绑定规范化project dir与确切集合。
- `prune({dryRun:false,planId,dates:[selectedSubset],operationId},probe)`仅执行计划内明确子集；首次apply缺plan报plan_required、外项目/过期/变更报plan_conflict；计划后新增文件不移动。统一锁序operation→archive→排序后的源file locks。首次apply才把所选源revision、确定归档目标路径和进度持久化到回执；不持久化纯预览。partial返回`ok:false,code:'partial',pruned,failed`。相同operationId优先查持久回执，committed回原结果且duplicate；partial/applying用原清单恢复，不依赖过期/重启丢失的内存plan，不重新枚举源。用源/目标存在和hash确认已移动项，只执行可确定安全的余项，歧义outcome_unknown；不同请求operation_mismatch。归档只移动，不证明已蒸馏。
- operationId绑定全局{canonical path(s),operation/mode,semantic request hash含原expectedRevision}，最长200字符；在operation锁→file锁里重查，same request committed duplicate回原结果；换目标/内容operation_mismatch。关键回执不受operationLog:false影响；终态24小时/最多2000条，未决最多100条，单回执最多1MiB、归档最多1000文件。达到上限先返回receipt_capacity且不动源，不淘汰未知记录；回执创建失败先拒绝。去重只在保留窗口内有效，未决不盲目重做。写前applying保存before/after hash，重启用当前hash判定提交或outcome_unknown；不许诺外部编辑原子CAS。读/纯预览不创建回执目录。
- 备份名时间＋UUID/独占创建，不覆盖；已有原文的edit/remove/section/document/restore破坏改写在backupKeep:0时backup_required；普通append仍遵从显式backupKeep:0（包括已有文件追加），新文件首次append无需原文备份。备份启用但失败拒绝；prune按原文移动/确定目标恢复，不伪称普通备份。共享stateDir路径/动作锁不按会话分裂。prune apply必须有非空合法operationId（缺失operation_required），纯预览不要求。

- [x] RED: 同ID排队（独立store/独立进程）只一次提交；同ID换目标拒绝；restore replay duplicate；无CAS改写revision_required；同CAS一成一冲突；不同IDappend都落；operationLog:false仍去重、receipt失败无源变动。
- [x] RED: 同毫秒备份不覆盖；backupKeep0破坏写拒绝；prune缺plan拒绝、预览后文件变更拒绝、新文件不移动、持日期锁等待/拒绝、partial报告可见、重复apply幂等。
- [x] Run focused RED；implement集中store/小模块，避免再造不同UI写链。
- [x] Run focused GREEN；full suite允许旧prune callers因新接口暂红但必须报告并更新store/tools测试接口夹具，不能去掉安全检查让旧测试绿。Task4更新UI消费。
- [x] Commit `fix(store): 补齐版本门禁回执和归档计划`；report清楚下游接口与未决覆盖，不能说全套过若未过。

### Task 3: 默认分层、快照作用域与惰性首写

**Files:** src/layers.js(new), render/cache/inject/config/index/env/tools/status; store初始化/transition校验；locale中英；tests/layers/render/inject/index/store/tools。

**Interfaces:**
- `analyzeMemory(text)`→`{mode:'layered'|'legacy',reason:null|string,coreEntries:[{text,...}],topics:[{heading,...}]}`；唯一合法核心、无围栏伪标题、条目和续行完整。无核心/歧义/非条目内容是legacy（原文不变）。H1前区普通内容保留未分节入口。
- Config增加`inject.mode` layered默认/full、`inject.coreBudget`4000(4000..20000)。各来源布尔false或旧limit=0在所有模式下关闭整个来源（核心、legacy正文、该来源目录一并关闭；profile=0禁画像入口，rules=0禁规则）；旧limit的正值仅约束full/legacy，layered正值预算由coreBudget比例决定。项目/用户逐文件判模式，不因一侧legacy把整次降级；legacy整个块含包装按对应旧limit，另一侧layered仍守自身份额。layered四组成1500/1500/500/500基准比例，不借未用额；规则共用500，全部目录、兼容提示、画像入口共用末尾500，标题/分隔计预算。mixed总量可超4000，lastAssembly统计实际全量并标mixed。精简规则中英均必须完整，模板最小预算测试。不再常驻实时chars或给模型prune指令。画像只给read-only入口不默认全文。
- `registerSections(...).lastAssembly(session): null|{cwd,blocks,totalChars,states,measuredAs:'plugin-contribution'}`；first-turn WeakMap会话键，cwd/config更改重建；无session per-assembly；缺cwd不退进程目录。有效cwd优先注入ctx.get('workingDirectory').get(session)，fallback header.cwd；工具也使用同一resolver。
- cache规范路径、mtime/ctime/size，最多64文件/8MiB总字节，单文件安全上限2MiB；按onCommit路径定向失效。读取解析hint同快照；lastAssembly不是宿主最终采纳/真实token。
- status默认简短：路径来源、状态、有效mode/compat原因、可写、lastAssembly/null、有限警告，不枚举所有日期或回显全config；UI可保留详细state。
- `write.ensureLayout`默认true；合法性/权限检查与empty/multiline/target/date校验先于mkdir。新建长期文件同语言H1+空核心+指定section（未指定Notes），首次写核心不重复。已有legacy普通append不得自动插核心：在file锁内比较before/after若legacy→layered普通工具拒绝layering_confirmation_required。可信replaceDocument UI入口可做迁移；不要加入模型整档工具。纯读安装不建state；无cwd不创建。
- 同一store commit订阅供注入/catalog；tools原withWriteNotice避免双通知，UI写也生效。global catalog保留全局语义。

- [ ] RED: unique/empty/duplicate/en alias/fence/非条目；预算含emoji包装硬上限、完整条目，old项目+layered用户混合；新增长尾不改prompt。
- [ ] RED: 两同cwd会话不同首份、面板/工具共享commit通知、有效cwd变化、配置代次、无会话；status disabled0/never assembled null。
- [ ] RED: 合法首写新建；无效/只读首写零目录副作用；legacy改核心普通工具拒绝，legacy正常主题可写；explicit ensureLayout:false拒绝。
- [ ] Implement，保留full确定性完整条目/行裁剪和明示legacy；不迁移真实文件。
- [ ] focused GREEN + full suite并确认无功能被硬删；commit `feat(memory): 默认分层披露与会话快照`；report指标。

### Task 4: 用户管理闭环与五工具目录

**Files:** src/client.js, host/routes.js, tools/index.js, tools/write.js, locale/*；tests/client/panel/routes/e2e/index/tools/store；可新增测试助手但不写临时模拟产品页。

**Interfaces:**
- 复用GET /revisions、/revision、POST /action restore。UI当前文件“历史版本”：选择→差异预览→恢复，状态冻结{projectKey,target,name,currentRevision}。所有异步返回按目标+请求代次丢弃；切项目/文件/关闭（含切到无文件项目）立即作废请求，不只等openFile才递增。undo存原projectKey/target/备份名/该次成功写后的revision，调用固定原目标与版本，不借当前doc.revision；切换文件不可误恢复。
- 草案状态保存{projectKey,target,section?,baseRevision,原文,草案}；粘贴正文+baseRevision，读取完整原文确认revision===baseRevision后才预览。改目标/正文/基线即作废预览；应用固定expectedRevision=baseRevision和同operationId，不自动换绑最新doc.revision。普通源码手改也锁编辑开始时版本并预览差异确认；移除冲突后删revision强盖，保留重载/保留草案，旧/缺基线或源truncated拒绝。复用lineDiff与现有content路由，不新增管理服务。
- 归档route补planId透传，首次应用冻结{projectKey,planId,dates,operationId}。plan_conflict/expired/unknown_plan才要求重新预览；partial/outcome_unknown或网络结果未知保持原完整请求，以同ID+同日期集合重试，不只提交failed日期，不先换计划。新选择/重新计划才新ID。成功重放duplicate可用；不声称自动完成蒸馏，不新增route级通知（store.subscribe唯一事件源）。
- 完成UI承接后一次移除四工具注册/专用defineTool factory与文案：prune,replace_section,list_revisions,restore。保留store方法和routes，无别名空壳；final五个status/read/search/append/edit。只读总闸不影响只读诊断。
- 工具bulk不注册，因此不用泛化模型批准引擎；UI受信任来源栅栏仍必须接入，store/route CAS仍强制；HTTP客户端伪造approved:true不可绕过版本、来源、目标校验。
- 模型规则提醒批量整理出草案交UI，不得为绕开工具循环多次edit；少量日常单条纠错正常。headless明示管理需用户，不建议shell绕守卫。
- Client entry开关变化实际注册/撤销，新增mode/coreBudget设置中英显示；使用现有locale与主题变量（新增视觉不能硬编码颜色），不引入Client包依赖。

- [ ] RED: 默认五名/搜索off四名/UIoff仍五名，旧四名不在schema和规则；更新原工具包装测试为store/UI回归，不删存储测试。
- [ ] RED: 历史备份选择与恢复、切项目后不误恢复、迟回包丢弃；草案同base预览应用一次/陈旧拒绝；源太大不写；archive计划变化/partial；权限off所有写禁用。
- [ ] Implement并run node --check src/client.js；focused GREEN＋full suite。
- [ ] Commit `feat(ui): 承接记忆管理并精简模型工具`；report真实UI证据限制，不能把模拟测试说成浏览器验收。

### Task 5: 使用说明与本地功能回归（CI 已由用户取消）

**Files:** README.md, README.zh.md, docs/implementation-notes.md, CHANGELOG.md(若有则读后改), tests相关；docs/2026-11-16-优化复审验证.mjs改为correct-behavior检查或明示历史不适用，不能继续让问题存在才通过。不得新增.github/workflows或其他CI文件。

**Interfaces:**
- 仅本地验收：现有Node全套测试和一次coverage；UTC/Asia-Shanghai与未来固定时间场景不依赖wall clock；package/lock根版本一致、npm pack --dry-run --json验证产物。无CI/远端矩阵，不安装额外Node版本来宣称跨平台通过；Linux/Node20未跑如实写未验证。不build/发布/Release/tag。
- README中英：无需WorkBuddy、原目录复用、读不创建首写创建、默认分层/全文回退、legacy待确认、五工具＋UI管理、无UI管理边界、backupKeep0约束、回执有界期限、外部非协作竞争窗口、当前验证宿主范围。
- 配置37旧键+2新键清单→读取位置/生效时机/权限；不为了全量审计删有用旧键。新工具集合/模型文案长度用实际registerTools重新测，数字不当token。
- O02日志保留具体冲突名与不覆盖别人的定义；说明不支持双引擎接管同文件，不加前缀。
- 场景夹具至少覆盖核心可见/长尾可查/旧文件过渡/非相关文本稳定/不同项目隔离/管理恢复一条路径；无实际LLM费用实验不可给节省承诺。

- [ ] Run focused cross-TZ tests RED/GREEN if newly修复；补pack/version检查，语义测试不镜像函数实现。
- [ ] 完成README/维护文档，所有事实来自最终代码；不更新发布版本，不做CI。
- [ ] Run full `node --test`、coverage、schema raw length、npm pack dry-run、git diff --check，报告实际本地平台结果，Linux/Node20未跑则未知。
- [ ] Commit `docs(memory): 补齐分层工具说明与本地回归`；report逐项对应O01-O11，O08明确按用户要求本轮取消，不算未完成缺陷。

## Controller acceptance & reporting

- 每任务BASE记录、内置subagent实现、主代理读diff和报告、独立任务审查（spec+quality）；有缺陷用内置subagent窄修，不把实现者自评当验收；不再调用CodeBuddy。
- 全任务结束读final-review流程，做全分支审查与一次UI/UX审查；真实浏览器/当前profile验证需要能安全只读/隔离，不偷偷替换当前服务。未安装则最终明确代码已验收、live UI未覆盖。
- 主代理新鲜跑全套、UTC、coverage、pack、语法、场景回归，按矩阵标出通过与未验证。最终交付`docs/YYYY-MM-DD-记忆插件优化完成报告.html`自包含HTML；附已实现/实测/残余边界与提交记录，present一次。
- 每任务提交到功能分支；主代理最终push（代理http://127.0.0.1:7890）；不merge、不publish、不tag。
