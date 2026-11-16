# 实施协调记录 · 2026-11-16

- Baseline: 59133e2, feature/memory-optimizations; user explicitly authorized implementation with CodeBuddy workers and lead acceptance.
- Ruling: 用户“好…开工”承接已交付设计与推荐五工具目标，按推荐标题与4000可配置预算执行；不再重复要求整份计划批准 — 都是仓库内可逆实现 — 若理解偏差则可回退，不涉及发布。
- Ruling: 代码实现使用 CodeBuddy，因该backend无follow-up，审查修复使用新的CodeBuddy窄任务 — 遵守用户指定工具 — 成本是新上下文但避免子代理交互不可达。
- Ruling: 所有写任务串行，独立审查可与无重叠准备工作并行 — 共享仓库避免覆盖 — 验收不能依赖实现者自报。
- Ruling: 不把当前profile安装/重载当作已经授权发布；先在仓库和隔离夹具完成验收，真实UI证据若不可安全取得则明确未验证 — 避免影响活跃会话与真实记忆 — 限制是最终报告需区分源码与live UI。
- Plan self-review: 目录/默认分层/过渡/预算→Task3，配置/读取→Task1，CAS/幂等/备份/归档→Task2，管理承接与五工具→Task4，CI/中英文档→Task5，O02/O11文档→Task5；O09合并管理，无新增工具。
- Task 1 BASE: 59133e2. CodeBuddy implement-config-read (external run 6e5bc736-eda5-4c27-9aa6-8aafd1322414) committed e41a8e2; DONE_WITH_CONCERNS; report .workbuddy/tmp/implementation-20261116/task-1-report.md. Worker70focused/257full/6UTC passed; lead fresh70focused passed. Independent review-config-read running, diff .workbuddy/tmp/implementation-20261116/task-1-review.diff. Team board task-1 lead owns acceptance.
- Task1 lead real Cordis Context/Service effect-owned fixture: 9tools/4sections/1guard/1route→search/guard/ui off8/4/0/0→on9/4/1/1→fiber.dispose0/0/0/0. First fixture omitted effect ownership in fake service, false residual was fixture issue; corrected test passes. Not live profile.
- Task1 lead reproduced read race: small source grows after tool pre-stat to2097169bytes; actual capped read then sectionsOnly returnsok:true and hash(prefix) not full, no truncated flag.
- Task1 review-config-read: Spec/Quality REQUEST_CHANGES; 2 Important (tool ignores capped actual read; helper unbounded when stat races),1 Minor (low-surrogate requested cursor silently moves). No Critical; lifecycle source directions pass. Report task-1-review-report.md.
- Task1 fix round1/5: CodeBuddy fix-read-races committed d01d544; report §7 RED49pass/5fail→GREEN54focused/262full. Lead fresh5 race/cursor tests passed; diffcheck passed. Independent rereview-read-races:原2Important与Minor均ADDRESSED；新增Important：无maxBytes初长度快照read可能漏已追加尾部，在CAS本次重读中假成功（20→50B），不能放行。
- Task1 fix round2/5: CodeBuddy fix-unbounded-snapshot committed d71bff4，RED42pass/1fail→GREEN97focused/263full。lead fresh2 external-CAS/current-revision测试通过。rereview-snapshot-fix ADDRESSED，独立2/2通过，未见fix新增breakage，Task1 gate放行。日档append caller changed检查交Task2。
- Task 2: ready to dispatch after plan commit; Task3..5 wait on preceding gate.
- Ruling: Task2区分普通append与破坏改写的backupKeep:0语义；前者尊重显式关闭备份，后者需可恢复点才执行；prune apply要求operationId — 避免为安全修复额外禁止低影响追加并保证partial有恢复身份 — 代价是直接调用归档apply不带ID将明确拒绝。
- Ruling: Task2预审收敛归档partial恢复契约：首次apply持久化准确源/目标与进度；重试先查回执，不依赖过期内存plan；操作锁→归档锁→排序文件锁 — 防重启或部分失败重复移动 — 代价是一个有界恢复状态文件而非无状态rename。
- Ruling: 回执终态24h/2000条、未决100条、单条1MiB、ID200字符、归档1000文件上限，容量满先拒绝不动源；通知锁外且partial已移动项也发 — 保持资源有界与状态可见 — 代价是超大管理任务需用户分批，非无限自动化。
- Runtime fact: 当前desktop插件package是指向本仓库的Junction；不承诺源码改动已热生效，不主动改当前profile配置或重载运行中Host。Client源码变化需要宿主现有加载机制/刷新后另验。
- Ruling: Task3按文件混合判模式，legacy块守旧limit且mixed如实统计全量，目录/兼容提示共500且不借额；旧limit=0跨模式关来源 — 保持原显式关闭语义和渐进过渡 — 代价是旧正值预算仅用于旧路径，需文档区分。
