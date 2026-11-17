/*
 * Browser half of dsh-workbuddy-memory.
 *
 * Two surfaces, one rule: nothing here writes a file directly. The panel turns
 * a click into one `POST /action`, and the host runs it through the same store
 * the tools use — same lock, same revision check, same backup, same ledger.
 *
 * The overview panel aggregates every workspace DSH knows about; the project
 * panel shows one project plus the global stores. They share one workspace
 * component so a new interaction never has to be written twice.
 *
 * Loading follows the host's module contract: a `__ModuleLoader__` entry with a
 * factory that receives `require`. React comes from the host, never bundled.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-workbuddy-memory'
    /** Settings namespace is the profile entry id, not the package name. */
    const ENTRY = 'workbuddy-memory'
    const API = '/workbuddy-memory'
    const PANEL_OVERVIEW = 'workbuddy-memory'
    const TAB_ID = 'dsh-workbuddy-memory'
    const TAB_KIND = 'workbuddy-memory'
    const SOURCE_ACK_KEY = 'wbm:fulltext-ack'

    /**
     * The bounds `normalizeConfig` clamps `inject.coreBudget` to.
     *
     * The schema does **not** clamp: a stored 1000 stays 1000 in the snapshot and
     * is turned into 4000 at run time (`config.js`, `num(inject.coreBudget,
     * 4000, 4000, 20000)`). The control's `min`/`max` only constrain validity, so
     * they neither stop the typing nor the blur that commits it. Rendering the
     * stored number would therefore show 1000 while the plugin ran at 4000 — the
     * card has to show the value in force, which is why the render site clamps
     * with these same bounds.
     */
    const CORE_BUDGET_MIN = 4000
    const CORE_BUDGET_MAX = 20000

    /**
     * The `inject.coreBudget` value the plugin will actually run with.
     *
     * Mirrors `num(inject.coreBudget, 4000, 4000, 20000)` in `config.js` — the
     * same type check, rounding and bounds — so the card cannot drift from the
     * value `normalizeConfig` derives. A non-number is not clamped to the bound,
     * it falls back to the default, which is also what the runtime does.
     */
    function effectiveCoreBudget(stored) {
      if (typeof stored !== 'number' || !Number.isFinite(stored)) return CORE_BUDGET_MIN
      return Math.round(Math.min(Math.max(stored, CORE_BUDGET_MIN), CORE_BUDGET_MAX))
    }

    // ── copy ────────────────────────────────────────────────────────────────
    //
    // Every user-visible string lives in these two dictionaries and is reached
    // through `t()`. The host's locale service owns which one is active, so
    // switching the app language switches this panel too — a panel that stays
    // Chinese inside an English shell reads as a foreign object, not a feature.
    //
    // Keys are stable identifiers, not the Chinese text: the dictionary is the
    // source of truth for wording, and `en` is the fallback the host consults
    // when the active language misses a key.

    const ZH = {
      // shared
      'common.cancel': '取消',
      'common.save': '保存',
      'common.delete': '删除',
      'common.close': '关闭',
      'common.reload': '重新加载',
      'common.open': '打开',
      'common.view': '查看',
      'common.retry': '重试',
      'common.loading': '读取中…',

      // panel shell
      'panel.memory': '记忆',
      'panel.projectMemory': '项目记忆',
      'panel.allProjects': '全部项目',
      'panel.refresh': '刷新',
      'panel.globalOverview': '全局总览',

      // rail
      'rail.searchProjects': '搜索项目…',
      'rail.onlyWithMemory': '只看有记忆',
      'rail.allProjects': '全部项目',
      'rail.global': '全局',
      'rail.userMemory': '用户 MEMORY.md',
      'rail.noMemory': '无记忆',
      'rail.dayUnit': '天',

      // stats
      'stats.projects': '项目',
      'stats.entries': '条目',
      'stats.dailyFiles': '日期文件',
      'stats.pendingArchive': '待归档',

      // dashboard
      'dash.needsAttention': '需要关注',
      'dash.recentActivity': '最近活跃',
      'dash.globalMemory': '全局记忆',
      'dash.neverArchived': '{days} 天未归档',
      'dash.noProjects': '还没有认到项目：先在这个项目的会话里发一句话，再回来刷新。',

      // targets
      'target.projectMemory': 'MEMORY.md',
      'target.projectDaily': '日期笔记',
      'target.userMemory': '用户 MEMORY.md',
      'target.profile': '用户画像',

      // file states
      'file.notCreated': '未创建',
      'file.readOnly': '只读',
      'file.unreadable': '不可读',
      'file.empty': '这个文件还是空的。',
      'file.noMemory': '这个项目还没有 MEMORY.md',
      'file.noMemoryHint': '日期笔记是独立文件，在下面单独列出。',

      // document actions
      'doc.addEntry': '添加条目',
      'doc.addFirst': '添加第一条',
      'doc.editSection': '编辑小节',
      'doc.removeSection': '删除小节',
      'doc.sourceMode': '源码模式',
      'doc.newSection': '新建小节',
      'doc.searchInDoc': '在文档内搜索…',
      'doc.sectionHeading': '小节标题',
      'doc.sectionBody': '小节内容（只能写 `- ` 条目和空行）',
      'doc.entryText': '条目内容',
      'doc.clickToEdit': '点击编辑',
      'doc.archiveOld': '归档旧日期',
      'doc.history': '历史版本',
      'doc.draft': '粘贴草案',

      // version history
      'history.title': '历史版本',
      'history.subtitle': '{target} 的备份，最新的在前。选一个预览差异再决定是否恢复。',
      'history.loading': '读取备份列表…',
      'history.empty': '这个文件还没有备份：每次写入前才会留一份。',
      'history.diffTitle': '与磁盘当前内容的差异（+ 是恢复后会回来的行）',
      'history.stats': '+{added} / -{removed} 行',
      'history.restore': '恢复这个版本',
      'history.base': '恢复会以当前 revision {revision} 为基线，先备份再写。',
      'history.noBase': '当前文件读不到完整 revision（太大或不可读），不能在这里恢复。',
      'history.stale': '文件在你看差异之后又被改过了，请重新选版本。',
      'history.restored': '已恢复到这个版本',

      // draft apply
      'draft.title': '粘贴草案',
      'draft.subtitle': '把模型给出的完整正文和它的来源 revision 贴进来。面板会读一遍磁盘原文，只有 revision 对得上才预览差异。',
      'draft.body': '草案正文（整份文件）',
      'draft.bodyPlaceholder': '把完整的新正文粘贴到这里（草案）…',
      'draft.base': '来源 revision',
      'draft.baseHint': '模型生成草案时读到的 revision。和磁盘不一致时不会预览，也不会写入。',
      'draft.preview': '预览差异',
      'draft.apply': '应用草案',
      'draft.needBase': '请先填入草案的来源 revision：没有基线就无法确认磁盘原文没变。',
      'draft.noDiff': '正文和磁盘内容一致，没有需要写入的改动。',
      'draft.staleBase': '磁盘上的 revision 是 {disk}，草案的基线是 {base}，两者不一致。请重新取一份原文和 revision，或让模型重新生成草案。',
      'draft.truncated': '这个文件超过面板读取上限，读不到完整原文，不能用草案整份覆盖。',
      'draft.applied': '草案已应用',
      'draft.diffTitle': '与磁盘当前内容的差异（+ 是草案新增的行）',
      'draft.stats': '+{added} / -{removed} 行',
      // A draft is applied with `replace-document`, which full-text editing
      // gates. With the switch off the entry asks first, like source mode does.

      // feedback
      'flash.saved': '已保存，下一轮对话生效',
      'flash.added': '已添加',
      'flash.removed': '已删除，可在 10 秒内撤销',
      'flash.sectionSaved': '小节已保存',
      'flash.sectionRemoved': '小节已删除',
      'flash.documentSaved': '整份文件已保存',
      'flash.undo': '撤销',

      // dialogs
      'dialog.conflictTitle': '文件已被改动',
      'dialog.conflictBody': '你看到的是 {mine}，磁盘上是 {disk}。草稿没有丢，选一个：',
      'dialog.sourceTitle': '源码模式',
      'dialog.sourceBody': '整份文件编辑会绕过条目模型，只保留结构校验。确定继续？',
      'dialog.pruneTitle': '归档旧日期文件',
      'dialog.pruneBody': '把选中的日期文件移动到 memory/archive/。不会写入 MEMORY.md —— 蒸馏要先用 memory_append / memory_edit 做完。',
      'dialog.confirmDelete': '确定删除？',
      'dialog.confirmDeleteSection': '确定删除整个小节（含标题和所有条目）？',

      // settings card
      'settings.general': '通用',
      'settings.readOnly': '只读模式',
      'settings.readOnlyHint': '打开后所有写入被拒绝：工具返回 read_only，面板隐藏写操作，裸写守卫放行。',
      'settings.home': 'WorkBuddy 主目录',
      'settings.homeHint': '留空跟随环境变量（WORKBUDDY_CONFIG_DIR → CODEBUDDY_CONFIG_DIR → ~/.workbuddy）。',
      'settings.homePlaceholder': '留空 = 跟随环境变量',
      'settings.dataFolder': '项目记忆目录名',
      'settings.dataFolderHint': '留空跟随 WORKBUDDY_DATA_FOLDER_NAME，再退到 .workbuddy。',
      'settings.inject': '注入与写入',
      'settings.injectMemory': '注入记忆',
      'settings.injectMemoryHint': '把项目记忆、规则、用户记忆与画像写进 system prompt。',
      'settings.allowWrite': '允许写入',
      'settings.allowWriteHint': '关闭后 memory_append / memory_edit 一律拒绝；只读模式是更高一级的总闸。',
      'settings.panelWrite': '面板写操作',
      'settings.panelWriteHint': '关闭后面板只读，工具仍然可用。',
      'settings.userLimit': '用户记忆上限',
      'settings.userLimitHint': '分层模式下只决定这一路源开不开（0 = 不注入），真正的上限是下面的常驻预算；但它同时是「蒸馏阈值」的默认基准（默认 = 本值 × 2），所以调小本值会让同一个文件更早被判定该蒸馏。整份（full）模式与 legacy 文件才按这个字符数截断。',
      'settings.distillAbove': '蒸馏阈值',
      'settings.distillAboveHint': '用户记忆超过这个字符数时就会提示该按主题蒸馏：分层模式下写在主题目录里（带真实字数），整份（full）模式下写在规则块里。默认 0 = 用户记忆上限的两倍；分层下同样生效，把用户记忆上限设为 0 可以关掉整个用户来源。',
      'settings.projectLimit': '项目记忆上限',
      'settings.projectLimitHint': '整份（full）模式与 legacy 文件注入到上下文的最大字符数。分层模式下只决定这一路源开不开（0 = 不注入）。',
      'settings.injectMode': '注入模式',
      'settings.injectModeHint': '分层：少量核心常驻，其余按需查询（默认）。整份（full）：每个文件按自己的上限整份注入，是兼容与排障回退。',
      'settings.injectModeLayered': '分层',
      'settings.injectModeFull': '整份（full）',
      'settings.coreBudget': '常驻预算',
      'settings.coreBudgetHint': '分层注入的总预算，单位是 UTF-16 码元，可设 4000–20000。按 37.5% / 37.5% / 12.5% / 12.5% 分给项目核心、用户核心、固定规则与主题目录；包装也计入。',
      'settings.hostRejected': '宿主拒绝了这次修改（值不合法或已被更高层覆盖）',
      'settings.noWriteAccess': '当前连接无法写入宿主配置。请直接编辑 profile 的 cordis.patch.yml 后重载插件。',

      // status codes
      'code.write_actions_disabled': '面板写操作未开启：到设置页把「面板写操作」打开。',
      'code.read_only': '只读模式已开启，写入被拒绝。',
      'code.write_disabled': '写入开关是关的。',
      'code.conflict': '文件在你编辑期间被改过。',
      'code.stale_line': '这一行已经不在原处了，重新加载后再改。',
      'code.not_an_entry': '这一行不是条目，不能按条目改。',
      'code.no_section': '小节找不到了。',
      'code.ambiguous_section': '同名小节不止一个，无法确定改哪一个；用行号定位，或先合并重名小节。',
      'code.empty_heading': '小节名不能为空。',
      'code.multiline_text': '一次只能写一条；要写多条请分多次调用。',
      'code.invalid_body': '小节内容不合法：只能写 `- ` 条目和空行，不能写标题或普通段落。',
      'code.invalid_structure': '整份文件结构不合法：检查代码围栏和文件大小。',
      'code.too_large': '文件太大，无法在面板里编辑。',
      'code.empty_text': '内容不能为空。',
      'code.ambiguous': '同一个关键词匹配到多条，换一句更精确的。',
      'code.lock_timeout': '文件正被另一个写入占用，稍后再试。',
      'code.revision_required': '缺少 revision，无法安全写入。',
      'code.nothing_to_prune': '没有可归档的旧日期文件。',
      'code.no_project': '面板还没认到项目：先在这个项目的会话里发一句话，再回来刷新。',
      'code.no_store': '这个项目没有记忆目录。',
      'code.no_profile': '没有画像文件。',
      'code.ambiguous_profile': '画像有多个候选，未指定用哪个。',
      'code.not_found': '文件还不存在。',
      'code.unreadable': '文件读不出来。',
      'code.body_too_large': '请求太大。',
      'code.json_required': '请求格式不对。',
      'code.unknown_action': '不支持的动作。',
      'code.no_route': '面板接口没有注册：确认插件配置里的「界面」是打开的。',
      'code.unknown_project': '这个项目不在面板的白名单里。',
      'code.read_only_target': '用户画像是只读的。',
      'code.backup_failed': '备份失败，写入被拒绝（不能在没有退路的情况下覆盖）。',
      'code.write_failed': '写入失败。',
      'code.action_failed': '动作执行失败。',
      'code.untrusted': '宿主拒绝了这个请求（跨站或未登录）。',
      'code.cross_origin': '跨站请求被拒绝。',
      'code.plan_required': '归档需要先出计划：重新预览一次再归档。',
      'code.plan_conflict': '这份归档计划已经失效（过期或文件集合变了），请重新出计划。',
      'code.partial': '部分文件没有归档完成，可以用同一份计划重试。',
      'code.outcome_unknown': '上一次写入的结果没能确认。用同一个操作 ID 重试是安全的；换 ID 可能重复执行。',
      'code.operation_mismatch': '这个操作 ID 已经用在另一个请求上，不会重放。',
      'code.operation_required': '缺少操作 ID，无法安全地重试归档。',
      'code.no_revision': '这个备份已经不在列表里了，刷新后重选。',
      'code.archive_capacity': '这次归档的文件太多，分批处理。',
      'code.layering_confirmation_required': '这个旧文件还没有划分「常驻记忆 / 按需主题」，直接把条目写进核心等于替用户重排记忆。请用面板的「粘贴草案」或「源码模式」整份保存一次，确认划分后再写入。',
      'code.receipt_capacity': '操作回执已满（未决 100 条或总计 2000 条），新的写入会被拒绝。已完成的回执可在 {receiptsDir} 清理；未决（applying / partial / outcome_unknown）的回执是「某次写入结果未知」的唯一证据，删之前请先人工核实。',
      'code.backup_required': '备份保留数是 0，破坏性改写被拒绝（没有退路就不覆盖）。请到插件配置里把 `write.backupKeep` 设为 1 以上：profile 的 cordis.patch.yml 中该条目的 `config:` 段（面板里没有这个控件），改完重载插件再试；普通追加不受影响。',
      'code.backup_name_collision': '备份文件名连续撞车，写入被拒绝。稍后重试；如果一直出现，检查备份目录是否被外部工具占满。',
      'code.archive_failed': '归档过程出错，源文件没有被移动。稍后重试同一份计划。',
      'code.rename_failed': '这个日期文件移动失败（可能被占用或权限不足），其余文件的状态见结果里的明细。',
      'code.operation_id_too_long': '操作 ID 超过 200 个字符。换一个短一些的 ID；面板自己生成的 ID 都很短。',
      'code.read_conflict': '读取期间文件被改动了，这份内容不能作为写入基线。重新读一遍再改。',
      'code.bad_offset': '分页偏移不合法：要么超出文件范围，要么落在代理对中间。改用上一页返回的 nextOffset 继续读。',
      'code.profile_not_found': '没有找到用户画像文件（USER.md）。指定 profileUid，或让 WorkBuddy 生成一份画像。',
      'code.unknown_target': '不认识这个目标。可选值见结果里的 targets 列表。',
      'code.bad_target': '这个目标不能这样改写（例如日期笔记只支持追加）。换一个动作或目标。',
      'code.bad_section': '小节名不合法：不能为空，也不能包含换行。',
      'code.bad_date': '日期格式不对，需要 YYYY-MM-DD。',
      'code.bad_request': '请求读不出来，重试一次；持续出现说明面板与宿主版本不匹配。',
      'code.bad_json': '请求体不是合法 JSON。重新加载面板后再试。',
      'code.internal': '插件内部出错，这次操作没有完成。稍后重试，持续出现请带上日志反馈。',
      'code.method_not_allowed': '这个接口不接受该请求方法。重新加载面板后再试。',
      'code.empty_query': '搜索关键词是空的，填一个再搜。',
      'code.search_disabled': '检索开关是关的：到设置页打开「启用检索」。',
      'code.no_path': '没有解析到文件路径。检查 WorkBuddy 主目录与项目记忆目录名。',
      'code.not_a_file': '这个路径不是普通文件（可能是目录或链接）。',
      'code.no_match': '没有找到要改的那一行：文件可能已经改过了，重新加载后再选。',

      // settings card, second block
      'settings.loadingConfig': '读取配置…',
      'settings.guardSection': '拦截裸写',
      'settings.guardHint': '阻止 write / edit 直接改记忆文件，强制走 memory_* 工具。',
      'settings.searchSection': '启用检索',
      'settings.searchHint': 'memory_search 是否可用。',
      'settings.panelSection': '记忆面板',
      'settings.panelHint': '打开后可以直接改条目、归档旧日期与撤销。默认开启；只读模式仍是总闸。',
      'settings.globalPanel': '左栏「记忆」总览',
      'settings.globalPanelHint': '所有 DSH 工作区的汇总入口。关闭只隐藏界面，不删除任何文件。',
      'settings.projectTab': '右侧栏页签',
      'settings.projectTabHint': '在右侧栏注册「项目记忆」原生页签，可边聊边看。',
      'settings.sessionAction': '会话头按钮',
      'settings.sessionActionHint': '在会话头放一个记忆按钮，用来打开右栏页签。',
      'settings.refreshMs': '刷新间隔（毫秒）',
      'settings.refreshMsHint': '面板轮询 /state 的间隔，默认 3000。',
      'settings.maxProjects': '最多展示项目',
      'settings.maxProjectsHint': '汇总最多拉取多少个工作区，默认 50。',
      'settings.revisionLine': 'revision {revision} · {state} · {override}',
      'settings.writable': '可写',
      'settings.overridden': '有本机覆盖',
      'settings.followDefault': '跟随默认',

      // state labels
      'state.current': '当前',
      'state.missing': '目录不存在',
      'state.overLimit': '超限',
      'state.dailyOnly': '仅日期笔记',
      'state.hasMemory': '有记忆',
      'state.currentProject': '当前项目',
      'state.pickProject': '选择一个项目',
      'state.undetermined': '未确定项目',
      'state.noMatchingProject': '没有匹配的项目',
      'state.noWorkspaces': '还没有工作区',
      'state.noUserMemory': '没有用户 MEMORY.md',
      'state.multipleCandidates': '多个候选',
      'state.multipleCandidatesUnused': '多个候选，未使用',
      'state.unknownError': '未知错误',
      'state.projectGone': '这个项目已经不在最近会话里了，换一个。',
      'state.profileReadOnlyNote': '画像是蒸馏产物，这里只能看不能改。',

      // relative time
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',

      // counts
      'count.entries': '{n} 条',
      'count.entriesPercent': '{n} 条 · {percent}%',
      'count.matches': '{n} 条匹配',
      'count.days': '{n} 天',
      'count.chipProjects': '项目 {n}',
      'count.chipWithMemory': '有记忆 {n}',
      'count.chipEntries': '条目 {n}',
      'count.chipOverLimit': '超限 {n}',
      'count.chipPending': '待归档 {n}',
      'count.allProjects': '全部项目 {n}',
      'count.truncatedProjects': '只显示前 {n} 个，可在设置里调大「最多展示项目」',
      'count.memoryLine': 'MEMORY {n} 条 · {bytes}',
      'count.usedPercent': '已用 {percent}%',
      'count.bytes': '字节',
      'count.latestDaily': '最新日期 {date}',

      // attention
      'attention.overLimit': '已超注入限额，下一轮注入会截断',
      'attention.stale': '{date} 已 {days} 天未归档',
      'attention.missing': '工作区目录不存在',
      'attention.unreadable': 'MEMORY.md 不可读',
      'attention.none': '没有需要立即处理的项目。',
      'attention.noActivity': '还没有任何项目写过记忆。',

      // editor
      'editor.edit': '编辑',
      'editor.addToSection': '在这个小节加一条',
      'editor.bodyHint': '只写 `- ` 条目和空行；标题与普通段落会被拒绝。',
      'editor.saveSection': '保存小节',
      'editor.noMatchingEntry': '没有匹配的条目',
      'editor.emptySection': '（空小节）',
      'editor.newEntryPlaceholder': '新条目内容，Enter 保存，Ctrl/Cmd+Enter 继续添加',
      'editor.fileTooLarge': '文件超过 256 KB',
      'editor.saveHint': '保存前会做结构校验；每次写入都会先备份。',
      'editor.saveDocument': '保存整份文件',
      'editor.addDailyEntry': '添加日期条目',
      'editor.sectionPlaceholder': '小节标题，例如：工具环境坑',
      'editor.firstEntryPlaceholder': '第一条内容（可留空，稍后再加）',
      'editor.pending': '（待补充）',
      'editor.sectionCreated': '小节已创建',
      'editor.add': '添加',
      'editor.create': '创建',
      'editor.changedElsewhere': '这个文件在别处被改过了，屏幕上是旧内容。',
      'editor.readOnlyOn': '只读模式已开启。',
      'editor.panelEditOff': '面板编辑未开启。',
      'editor.enableEditing': '启用编辑',
      'editor.enabledEditing': '已开启面板编辑',
      'editor.dailyAppendOnly': '日期笔记是追加文件：可以加条目，不能按条目改写或删除。',
      'editor.searchPlaceholder': '搜索当前文件的条目…  Ctrl/Cmd+F',
      'editor.addOne': '添加一条',
      'editor.emptyFile': '这个文件还是空的',
      'editor.sectionDefault': '记录',
      'editor.append': '追加',
      'editor.source': '源码',
      'editor.noCurrentProject': '还没有认到当前项目',
      'editor.pickProjectHint': '在某个项目的会话里发一句话，或者直接从下面选一个项目。',
      'editor.openMemory': '打开 MEMORY.md',
      'editor.createMemory': '创建 MEMORY.md',
      'editor.fileMissing': '这个文件还不存在',
      'editor.fileMissingHint': '可以直接添加第一条条目；写入时会自动创建文件。',
      'editor.pickFile': '选择文件…',
      'editor.profileReadOnly': '用户画像（只读）',
      'editor.tooLargeStatsOnly': '文件太大，只给统计。',
      'editor.viewDiskDiff': '查看磁盘差异',
      'editor.reloadDiscard': '重新加载（丢弃草稿）',
      'editor.keepDraft': '保留草稿继续编辑',
      'editor.limitWarning': '已用 {chars} 字，超过注入限额 {limit}，下一轮注入会截断。',
      'editor.overLimitChip': '超注入限额',

      // source mode
      'source.title': '进入源码模式？',
      'source.bodyAllowed': '源码模式会整文件写入。结构校验、备份和撤销仍然生效，但一次误改可能同时影响多个小节。确认后本次浏览器会话不再重复提示。',
      'source.confirmAllowed': '我明白，打开源码',
      'source.cannotEnableWrite': '无法写入宿主配置，请到设置页手动开启「面板写操作」。',
      'source.tooLargeToEdit': '文件超过面板读取上限，不能在这里整文件编辑；请用逐条编辑或外部编辑器。',

      // prune dialog
      'prune.description': '把早于指定天数的日期流水移动到 memory/archive/，不写入 MEMORY.md。请先确认已把值得长期保留的结论蒸馏进 MEMORY.md；归档后原始流水仍可在 archive/ 找回。',
      'prune.before': '早于',
      'prune.replan': '重新出计划',
      'prune.scanning': '正在扫描…',
      'prune.noResults': '没有结果',
      'prune.noneOlder': '{days} 天以前没有日期文件。',
      'prune.row': '{date} · {n} 条 · {bytes}',
      'prune.archived': '已归档 {n} 个日期文件',
      'prune.running': '执行中…',
      'prune.action': '归档 {n} 个文件',
      'prune.partial': '没有全部完成：{done} 个已归档，{left} 个结果未确定。用同一份计划重试，已归档的不会重复移动。',
      'prune.retry': '重试（同一计划）',
      'prune.stalePlan': '这份计划已经失效（过期或文件集合变了），请重新出计划再归档。',
      'prune.planGone': '这份计划不在了，请重新出计划。',

      // misc
      'misc.undo': '已撤销',
      'misc.confirmDeleteSectionBody': '确定删除「{section}」及它的全部条目？写入前会先备份。',
      'misc.panelTitleWithName': '{name} · 记忆',
      'misc.conflictDetail': '你看到的是 {mine}，磁盘上是 {disk}。草稿没有丢，选一个：',
      'misc.issuesDetail': '（第 {lines} 行）',
      'misc.projectTabDesc': '当前项目的 MEMORY.md、日期笔记与全局用户记忆',
    }

    const EN = {
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.delete': 'Delete',
      'common.close': 'Close',
      'common.reload': 'Reload',
      'common.open': 'Open',
      'common.view': 'View',
      'common.retry': 'Retry',
      'common.loading': 'Loading…',

      'panel.memory': 'Memory',
      'panel.projectMemory': 'Project memory',
      'panel.allProjects': 'All projects',
      'panel.refresh': 'Refresh',
      'panel.globalOverview': 'Overview',

      'rail.searchProjects': 'Search projects…',
      'rail.onlyWithMemory': 'With memory only',
      'rail.allProjects': 'All projects',
      'rail.global': 'Global',
      'rail.userMemory': 'User MEMORY.md',
      'rail.noMemory': 'No memory',
      'rail.dayUnit': 'd',

      'stats.projects': 'Projects',
      'stats.entries': 'Entries',
      'stats.dailyFiles': 'Daily files',
      'stats.pendingArchive': 'To archive',

      'dash.needsAttention': 'Needs attention',
      'dash.recentActivity': 'Recent activity',
      'dash.globalMemory': 'Global memory',
      'dash.neverArchived': 'not archived for {days} days',
      'dash.noProjects': 'No project recognised yet: send one message in a session of that project, then come back and refresh.',

      'target.projectMemory': 'MEMORY.md',
      'target.projectDaily': 'Daily note',
      'target.userMemory': 'User MEMORY.md',
      'target.profile': 'User profile',

      'file.notCreated': 'Not created',
      'file.readOnly': 'Read-only',
      'file.unreadable': 'Unreadable',
      'file.empty': 'This file is still empty.',
      'file.noMemory': 'This project has no MEMORY.md yet',
      'file.noMemoryHint': 'Daily notes are separate files, listed below.',

      'doc.addEntry': 'Add entry',
      'doc.addFirst': 'Add the first entry',
      'doc.editSection': 'Edit section',
      'doc.removeSection': 'Delete section',
      'doc.sourceMode': 'Source mode',
      'doc.newSection': 'New section',
      'doc.searchInDoc': 'Search in document…',
      'doc.sectionHeading': 'Section heading',
      'doc.sectionBody': 'Section body (only `- ` entries and blank lines)',
      'doc.entryText': 'Entry text',
      'doc.clickToEdit': 'Click to edit',
      'doc.archiveOld': 'Archive old dailies',
      'doc.history': 'Version history',
      'doc.draft': 'Paste a draft',

      'history.title': 'Version history',
      'history.subtitle': 'Backups of {target}, newest first. Pick one to preview the diff before deciding to restore.',
      'history.loading': 'Reading the backup list…',
      'history.empty': 'This file has no backups yet: one is taken before each write.',
      'history.diffTitle': 'Diff against the file on disk (+ lines come back on restore)',
      'history.stats': '+{added} / -{removed} lines',
      'history.restore': 'Restore this version',
      'history.base': 'The restore uses the current revision {revision} as its base and backs up first.',
      'history.noBase': 'The current file has no usable revision (too large or unreadable), so it cannot be restored here.',
      'history.stale': 'The file changed after you opened the diff; pick a version again.',
      'history.restored': 'Restored to that version',

      'draft.title': 'Paste a draft',
      'draft.subtitle': 'Paste the complete new body and the revision it was written against. The panel reads the file back first: a diff is only built when the revision matches.',
      'draft.body': 'Draft body (whole file)',
      'draft.bodyPlaceholder': 'Paste the complete new body here…',
      'draft.base': 'Source revision',
      'draft.baseHint': 'The revision the draft was produced from. When it does not match the disk, nothing is previewed and nothing is written.',
      'draft.preview': 'Preview the diff',
      'draft.apply': 'Apply the draft',
      'draft.needBase': 'Fill in the revision the draft came from first: without a base there is no way to know the file has not changed.',
      'draft.noDiff': 'The body matches the file on disk; there is nothing to write.',
      'draft.staleBase': 'The file on disk is {disk} but the draft was written against {base}. Read the file again for a fresh revision, or have the draft regenerated.',
      'draft.truncated': 'This file is past the panel read limit, so its full text is unavailable and a whole-file draft cannot be applied.',
      'draft.applied': 'Draft applied',
      'draft.diffTitle': 'Diff against the file on disk (+ lines come from the draft)',
      'draft.stats': '+{added} / -{removed} lines',
      // A draft is applied with `replace-document`, which full-text editing
      // gates. With the switch off the entry asks first, like source mode does.

      'flash.saved': 'Saved; applies from the next turn',
      'flash.added': 'Added',
      'flash.removed': 'Deleted; undo within 10 seconds',
      'flash.sectionSaved': 'Section saved',
      'flash.sectionRemoved': 'Section deleted',
      'flash.documentSaved': 'File saved',
      'flash.undo': 'Undo',

      'dialog.conflictTitle': 'The file changed underneath you',
      'dialog.conflictBody': 'You saw {mine}, the disk has {disk}. Your draft is not lost — pick one:',
      'dialog.sourceTitle': 'Source mode',
      'dialog.sourceBody': 'Editing the whole file bypasses the entry model and keeps only structural checks. Continue?',
      'dialog.pruneTitle': 'Archive old daily notes',
      'dialog.pruneBody': 'Move the selected dated files into memory/archive/. MEMORY.md is never written — distil with memory_append / memory_edit first.',
      'dialog.confirmDelete': 'Delete this entry?',
      'dialog.confirmDeleteSection': 'Delete the whole section (heading and every entry)?',

      'settings.general': 'General',
      'settings.readOnly': 'Read-only mode',
      'settings.readOnlyHint': 'Every write is refused: tools return read_only, the panel hides write actions, the bare-write guard stands down.',
      'settings.home': 'WorkBuddy home',
      'settings.homeHint': 'Empty follows the environment (WORKBUDDY_CONFIG_DIR → CODEBUDDY_CONFIG_DIR → ~/.workbuddy).',
      'settings.homePlaceholder': 'Empty = follow the environment',
      'settings.dataFolder': 'Project memory folder name',
      'settings.dataFolderHint': 'Empty follows WORKBUDDY_DATA_FOLDER_NAME, then .workbuddy.',
      'settings.inject': 'Injection and writing',
      'settings.injectMemory': 'Inject memory',
      'settings.injectMemoryHint': 'Put project memory, rules, user memory and the profile into the system prompt.',
      'settings.allowWrite': 'Allow writing',
      'settings.allowWriteHint': 'Off refuses every memory_append / memory_edit; read-only mode is the higher master switch.',
      'settings.panelWrite': 'Panel write actions',
      'settings.panelWriteHint': 'Off makes the panel read-only; the tools still work.',
      'settings.userLimit': 'User memory limit',
      'settings.userLimitHint': 'In layered mode this only decides whether the source is on at all (0 = off); the real ceiling is the always-on budget below. It is also the base the distillation threshold defaults to (default = this × 2), so lowering it makes the same file count as due for distillation sooner. Only whole-file (full) mode and legacy files are cut at this many characters.',
      'settings.distillAbove': 'Distillation threshold',
      'settings.distillAboveHint': 'Past this many characters of user memory the plugin says the file is due for a by-topic distillation: in layered mode in the topic directory (with the real size), in whole-file (full) mode in the rules block. Default 0 = twice the user memory limit. It applies in layered mode too; set the user memory limit to 0 to turn the whole source off.',
      'settings.projectLimit': 'Project memory limit',
      'settings.projectLimitHint': 'Characters of the project MEMORY.md injected in whole-file (full) mode and for legacy files. In layered mode it only decides whether the source is on (0 = off).',
      'settings.injectMode': 'Injection mode',
      'settings.injectModeHint': 'Layered: a small always-on core, the rest read on demand (default). Whole file (full): every file is injected whole under its own limit — the compatibility and troubleshooting fallback.',
      'settings.injectModeLayered': 'Layered',
      'settings.injectModeFull': 'Whole file (full)',
      'settings.coreBudget': 'Always-on budget',
      'settings.coreBudgetHint': 'Total budget for layered injection, in UTF-16 code units, 4000–20000. Split 37.5% / 37.5% / 12.5% / 12.5% across the project core, the user core, the fixed rules and the topic directory; wrappers count.',
      'settings.hostRejected': 'The host refused this change (invalid value, or overridden by a higher layer)',
      'settings.noWriteAccess': 'This connection cannot write host config. Edit the profile cordis.patch.yml and reload the plugin.',

      'code.write_actions_disabled': 'Panel write actions are off: enable "Panel write actions" in settings.',
      'code.read_only': 'Read-only mode is on; the write was refused.',
      'code.write_disabled': 'The write switch is off.',
      'code.conflict': 'The file changed while you were editing.',
      'code.stale_line': 'That line is no longer there; reload and try again.',
      'code.not_an_entry': 'That line is not an entry, so it cannot be edited as one.',
      'code.no_section': 'The section is gone.',
      'code.ambiguous_section': 'More than one section has that heading, so the target is ambiguous; address it by line, or merge the duplicates first.',
      'code.empty_heading': 'A section name is required.',
      'code.multiline_text': 'One entry per call; call again for another.',
      'code.invalid_body': 'Invalid section body: only `- ` entries, continuation lines and blank lines, no headings or paragraphs.',
      'code.invalid_structure': 'Invalid file structure: check code fences and file size.',
      'code.too_large': 'The file is too large to edit in the panel.',
      'code.empty_text': 'The content cannot be empty.',
      'code.ambiguous': 'That keyword matches more than one entry; be more specific.',
      'code.lock_timeout': 'Another write holds the file; try again shortly.',
      'code.revision_required': 'A revision is required to write safely.',
      'code.nothing_to_prune': 'No old daily notes to archive.',
      'code.no_project': 'No project recognised yet: send one message in a session of that project, then refresh.',
      'code.no_store': 'This project has no memory directory.',
      'code.no_profile': 'No profile file.',
      'code.ambiguous_profile': 'Several profile candidates and none chosen.',
      'code.not_found': 'The file does not exist yet.',
      'code.unreadable': 'The file cannot be read.',
      'code.body_too_large': 'The request is too large.',
      'code.json_required': 'Wrong request format.',
      'code.unknown_action': 'Unsupported action.',
      'code.no_route': 'The panel route is not registered: check that the UI switch is on in the plugin config.',
      'code.unknown_project': 'That project is not in the panel allowlist.',
      'code.read_only_target': 'The user profile is read-only.',
      'code.backup_failed': 'The backup failed, so the write was refused (no overwrite without a way back).',
      'code.write_failed': 'The write failed.',
      'code.action_failed': 'The action failed.',
      'code.untrusted': 'The host refused this request (cross-site or not signed in).',
      'code.cross_origin': 'A cross-site request was refused.',
      'code.plan_required': 'Archiving needs a plan first: preview it again, then archive.',
      'code.plan_conflict': 'This archive plan is no longer valid (expired, or the file set changed). Recompute the plan.',
      'code.partial': 'Some files were not archived; retry with the same plan.',
      'code.outcome_unknown': 'The outcome of the previous write could not be confirmed. Retrying with the same operation id is safe; a new id may run it twice.',
      'code.operation_mismatch': 'That operation id already belongs to a different request, so it was not replayed.',
      'code.operation_required': 'An operation id is required to retry an archive safely.',
      'code.no_revision': 'That backup is no longer in the list; refresh and pick again.',
      'code.archive_capacity': 'Too many files for one archive run; do it in batches.',
      'code.layering_confirmation_required': 'This older file has no "core memory / on-demand topic" split yet, and writing entries into the core would re-arrange someone\'s memory for them. Save it once through the panel\'s draft or source mode to confirm the split, then write.',
      'code.receipt_capacity': 'The operation receipt store is full (100 unresolved or 2000 total), so new writes are refused. Finished receipts can be cleared from {receiptsDir}; unresolved ones (applying / partial / outcome_unknown) are the only evidence that some write\'s outcome is unknown, so check them before deleting.',
      'code.backup_required': 'The backup count is 0, so a destructive rewrite is refused (no overwrite without a way back). Set `write.backupKeep` to at least 1 in the plugin config — the `config:` block of that entry in the profile\'s cordis.patch.yml (there is no control for it in the panel) — then reload the plugin; an ordinary append is unaffected.',
      'code.backup_name_collision': 'Backup names collided repeatedly, so the write was refused. Try again shortly; if it keeps happening, check whether the backup directory is full.',
      'code.archive_failed': 'Archiving failed and no source file was moved. Retry the same plan.',
      'code.rename_failed': 'This dated file could not be moved (in use, or not permitted). The per-file detail in the result says what happened to the rest.',
      'code.operation_id_too_long': 'The operation id is longer than 200 characters. Use a shorter one; the panel\'s own ids are short.',
      'code.read_conflict': 'The file changed while it was being read, so this content cannot serve as a write base. Read it again before editing.',
      'code.bad_offset': 'Invalid paging offset: past the end of the file, or inside a surrogate pair. Continue from the nextOffset the previous page returned.',
      'code.profile_not_found': 'No user profile (USER.md) was found. Set profileUid, or have WorkBuddy produce a profile.',
      'code.unknown_target': 'Unknown target. The allowed values are listed in the result.',
      'code.bad_target': 'This target cannot be rewritten that way (a dated note is append-only, for example). Pick another action or target.',
      'code.bad_section': 'Invalid section name: it cannot be empty or contain a newline.',
      'code.bad_date': 'Wrong date format; it must be YYYY-MM-DD.',
      'code.bad_request': 'The request could not be read. Retry; if it keeps happening, the panel and the host disagree on the protocol.',
      'code.bad_json': 'The request body is not valid JSON. Reload the panel and try again.',
      'code.internal': 'The plugin hit an internal error and the action did not complete. Retry; if it persists, report it with the log.',
      'code.method_not_allowed': 'This route does not accept that method. Reload the panel and try again.',
      'code.empty_query': 'The search query is empty; type something first.',
      'code.search_disabled': 'Search is off: turn on "Enable search" in settings.',
      'code.no_path': 'No file path could be resolved. Check the WorkBuddy home and the project memory folder name.',
      'code.not_a_file': 'That path is not a regular file (it may be a directory or a link).',
      'code.no_match': 'The line to change was not found; the file may have changed. Reload and pick the row again.',

      'settings.loadingConfig': "Loading configuration…",
      'settings.guardSection': "Block bare writes",
      'settings.guardHint': "Stop write / edit from touching memory files directly; force the memory_* tools.",
      'settings.searchSection': "Enable search",
      'settings.searchHint': "Whether memory_search is available.",
      'settings.panelSection': "Memory panel",
      'settings.panelHint': "Edit entries, archive old dailies and undo from the panel. On by default; read-only mode is still the master switch.",
      'settings.globalPanel': "Left-rail \"Memory\" overview",
      'settings.globalPanelHint': "The aggregate entry for every DSH workspace. Off only hides the UI; no file is deleted.",
      'settings.projectTab': "Right-sidebar tab",
      'settings.projectTabHint': "Register a native \"Project memory\" tab so it is visible while chatting.",
      'settings.sessionAction': "Session header button",
      'settings.sessionActionHint': "Put a memory button in the session header that opens the right-sidebar tab.",
      'settings.refreshMs': "Refresh interval (ms)",
      'settings.refreshMsHint': "How often the panel polls /state. Default 3000.",
      'settings.maxProjects': "Max projects shown",
      'settings.maxProjectsHint': "How many workspaces the overview pulls. Default 50.",
      'settings.revisionLine': "revision {revision} · {state} · {override}",
      'settings.writable': "writable",
      'settings.overridden': "locally overridden",
      'settings.followDefault': "following defaults",
      'state.current': "Current",
      'state.missing': "Directory missing",
      'state.overLimit': "Over limit",
      'state.dailyOnly': "Daily notes only",
      'state.hasMemory': "Has memory",
      'state.currentProject': "Current project",
      'state.pickProject': "Pick a project",
      'state.undetermined': "Undetermined project",
      'state.noMatchingProject': "No matching project",
      'state.noWorkspaces': "No workspaces yet",
      'state.noUserMemory': "No user MEMORY.md",
      'state.multipleCandidates': "Several candidates",
      'state.multipleCandidatesUnused': "Several candidates, none used",
      'state.unknownError': "Unknown error",
      'state.projectGone': "That project is no longer in recent sessions; pick another.",
      'state.profileReadOnlyNote': "The profile is a distillation product: viewable here, not editable.",
      'time.justNow': "just now",
      'time.minutesAgo': "{n} min ago",
      'time.hoursAgo': "{n} h ago",
      'time.daysAgo': "{n} d ago",
      'count.entries': "{n} entries",
      'count.entriesPercent': "{n} entries · {percent}%",
      'count.matches': "{n} matches",
      'count.days': "{n} d",
      'count.chipProjects': "Projects {n}",
      'count.chipWithMemory': "With memory {n}",
      'count.chipEntries': "Entries {n}",
      'count.chipOverLimit': "Over limit {n}",
      'count.chipPending': "To archive {n}",
      'count.allProjects': "All projects {n}",
      'count.truncatedProjects': "Showing the first {n}; raise \"Max projects shown\" in settings",
      'count.memoryLine': "MEMORY {n} entries · {bytes}",
      'count.usedPercent': "{percent}% used",
      'count.bytes': "Bytes",
      'count.latestDaily': "Latest {date}",
      'attention.overLimit': "Over the injection limit; the next turn truncates it",
      'attention.stale': "{date} has not been archived for {days} days",
      'attention.missing': "The workspace directory does not exist",
      'attention.unreadable': "MEMORY.md is unreadable",
      'attention.none': "Nothing needs attention right now.",
      'attention.noActivity': "No project has written memory yet.",
      'editor.edit': "Edit",
      'editor.addToSection': "Add an entry to this section",
      'editor.bodyHint': "Only `- ` entries and blank lines; headings and paragraphs are refused.",
      'editor.saveSection': "Save section",
      'editor.noMatchingEntry': "No matching entry",
      'editor.emptySection': "(empty section)",
      'editor.newEntryPlaceholder': "New entry; Enter saves, Ctrl/Cmd+Enter keeps adding",
      'editor.fileTooLarge': "The file exceeds 256 KB",
      'editor.saveHint': "Saving runs a structural check; every write is backed up first.",
      'editor.saveDocument': "Save the whole file",
      'editor.addDailyEntry': "Add a dated entry",
      'editor.sectionPlaceholder': "Section heading, e.g. Toolchain pitfalls",
      'editor.firstEntryPlaceholder': "First entry (may be empty; add more later)",
      'editor.pending': "(to be filled in)",
      'editor.sectionCreated': "Section created",
      'editor.add': "Add",
      'editor.create': "Create",
      'editor.changedElsewhere': "This file changed elsewhere; what you see is stale.",
      'editor.readOnlyOn': "Read-only mode is on.",
      'editor.panelEditOff': "Panel editing is off.",
      'editor.enableEditing': "Enable editing",
      'editor.enabledEditing': "Panel editing enabled",
      'editor.dailyAppendOnly': "Daily notes are append-only: you can add entries, not rewrite or delete them.",
      'editor.searchPlaceholder': "Search entries in this file…  Ctrl/Cmd+F",
      'editor.addOne': "Add an entry",
      'editor.emptyFile': "This file is still empty",
      'editor.sectionDefault': "Notes",
      'editor.append': "Append",
      'editor.source': "Source",
      'editor.noCurrentProject': "No current project recognised",
      'editor.pickProjectHint': "Send one message in a session of that project, or pick one below.",
      'editor.openMemory': "Open MEMORY.md",
      'editor.createMemory': "Create MEMORY.md",
      'editor.fileMissing': "This file does not exist yet",
      'editor.fileMissingHint': "You can add the first entry; the file is created on write.",
      'editor.pickFile': "Pick a file…",
      'editor.profileReadOnly': "User profile (read-only)",
      'editor.tooLargeStatsOnly': "The file is too large; showing statistics only.",
      'editor.viewDiskDiff': "View the on-disk diff",
      'editor.reloadDiscard': "Reload (discard the draft)",
      'editor.keepDraft': "Keep the draft and keep editing",
      'editor.limitWarning': "Using {chars} characters against a {limit}-character limit; the next turn truncates it.",
      'editor.overLimitChip': "Over the injection limit",
      'source.title': "Enter source mode?",
      'source.bodyAllowed': "Source mode writes the whole file. Structural checks, backups and undo still apply, but one mistake can hit several sections at once. This browser session will not ask again.",
      'source.confirmAllowed': "I understand — open source mode",
      'source.cannotEnableWrite': "Cannot write host config; enable \"Panel write actions\" in settings.",
      'source.tooLargeToEdit': "The file exceeds the panel read limit, so it cannot be edited as a whole here; edit entries or use an external editor.",
      'prune.description': "Move dated logs older than the given number of days into memory/archive/; MEMORY.md is never written. Make sure you have distilled what matters into MEMORY.md first — the raw logs stay findable in archive/.",
      'prune.before': "Older than",
      'prune.replan': "Recompute the plan",
      'prune.scanning': "Scanning…",
      'prune.noResults': "No results",
      'prune.noneOlder': "No dated files older than {days} days.",
      'prune.row': "{date} · {n} entries · {bytes}",
      'prune.archived': "Archived {n} dated files",
      'prune.running': "Running…",
      'prune.action': "Archive {n} files",
      'prune.partial': "Not everything finished: {done} archived, {left} with an unresolved outcome. Retry with the same plan — what already moved will not move twice.",
      'prune.retry': "Retry (same plan)",
      'prune.stalePlan': "This plan is no longer valid (expired, or the file set changed). Recompute the plan before archiving.",
      'prune.planGone': "That plan is gone; recompute the plan.",
      'misc.undo': "Undone",
      'misc.confirmDeleteSectionBody': "Delete \"{section}\" and every entry in it? Every write is backed up first.",
      'misc.panelTitleWithName': "{name} · Memory",
      'misc.conflictDetail': "You saw {mine}, the disk has {disk}. Your draft is not lost — pick one:",
      'misc.issuesDetail': "(line {lines})",
      'misc.projectTabDesc': "This project’s MEMORY.md, daily notes and the global user memory",
    }

    /**
     * Bind the host's translate function, falling back to this file's own
     * dictionaries.
     *
     * The host owns language selection; the fallback exists only so the panel
     * still renders when `locale` is absent (an older host, or a unit test that
     * mounts the module without the service). It never overrides a host answer.
     *
     * The host binding is looked up on **every call**, not captured once: the
     * locale service may arrive after `apply` runs, and a captured `null` would
     * leave the panel on its own dictionaries for the rest of the session.
     *
     * @param {object} ctx - client root context.
     * @returns {(key: string, vars?: Record<string, string|number>) => string}
     */
    function bindCopy(ctx) {
      const local = localLanguage()
      const hostBound = () => {
        try {
          const locale = ctx?.locale
          if (typeof locale?.bind !== 'function') return null
          return locale.bind(NS)
        } catch {
          return null
        }
      }
      return (key, vars) => {
        let text
        const host = hostBound()
        if (host) {
          try {
            text = host(key)
          } catch {
            text = undefined
          }
        }
        if (typeof text !== 'string' || text.length === 0 || text === key) {
          text = local === 'zh' ? (ZH[key] ?? EN[key] ?? key) : (EN[key] ?? ZH[key] ?? key)
        }
        if (!vars) return text
        return text.replace(/\{(\w+)\}/g, (match, name) => String(vars[name] ?? match))
      }
    }

    /**
     * The browser's own language, used only when no host locale service exists.
     *
     * The host's documented fallback is English because a browser naming no
     * registered language is unlikely to read Chinese. That reasoning applies to
     * the host's *registered* languages, not to a panel running without the
     * service at all — there, honouring the browser is the closer guess.
     *
     * @returns {'zh'|'en'}
     */
    function localLanguage() {
      try {
        const nav = globalThis.navigator
        const tag = nav?.languages?.[0] ?? nav?.language ?? ''
        if (/^zh/i.test(tag)) return 'zh'
        if (tag) return 'en'
      } catch {
        // No navigator: fall through to the English default.
      }
      return 'en'
    }

    // ── theme-aligned styles ────────────────────────────────────────────────
    //
    // Everything visual lives here instead of 200 inline style objects: hover,
    // focus-visible and media queries are impossible inline, and the host's
    // theme variables are the only way a panel looks native in both themes.

    const CSS = `
      .wbm-root {
        --wbm-bg: var(--dsw-alias-bg-base, #0e1116);
        --wbm-panel: var(--dsw-alias-bg-layer-1, #141922);
        --wbm-panel-2: var(--dsw-alias-bg-layer-2, #1a212c);
        --wbm-border: var(--dsw-alias-border-l2, rgba(127,127,127,.24));
        --wbm-border-soft: var(--dsw-alias-border-l1, rgba(127,127,127,.14));
        --wbm-text: var(--dsw-alias-label-primary, #e4e8ef);
        --wbm-text-2: var(--dsw-alias-label-secondary, #a3adbd);
        --wbm-text-3: var(--dsw-alias-label-tertiary, #747e8e);
        --wbm-accent: var(--dsw-alias-state-business-primary, #6ea8fe);
        --wbm-accent-soft: color-mix(in srgb, var(--wbm-accent) 14%, transparent);
        --wbm-ok: var(--dsw-alias-state-success-primary, #7dd3a0);
        --wbm-warn: var(--dsw-alias-state-warn-primary, #e8b96a);
        --wbm-danger: var(--dsw-alias-state-error-primary, #ef8080);
        --wbm-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));
        --wbm-radius: var(--dsw-radius-md, 8px);
        --wbm-shadow: var(--dsw-elevation-panel, 0 12px 40px rgba(0,0,0,.28));
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        font-size: 13px; color: var(--wbm-text); background: var(--wbm-bg);
        position: relative;
      }
      .wbm-root *, .wbm-root *::before, .wbm-root *::after { box-sizing: border-box; }
      .wbm-header {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        padding: 10px 16px; border-bottom: 1px solid var(--wbm-border-soft);
        background: var(--wbm-bg); min-height: 48px;
      }
      .wbm-title { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
      .wbm-crumb { color: var(--wbm-text-3); font-size: 12px; }
      .wbm-spacer { flex: 1; }
      .wbm-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .wbm-chip {
        font-size: 11px; line-height: 1.6; padding: 1px 7px; border-radius: 999px;
        color: var(--wbm-text-2); background: var(--wbm-panel-2); border: 1px solid var(--wbm-border-soft);
        white-space: nowrap;
      }
      .wbm-chip.ok { color: var(--wbm-ok); border-color: color-mix(in srgb, var(--wbm-ok) 35%, transparent); }
      .wbm-chip.warn { color: var(--wbm-warn); border-color: color-mix(in srgb, var(--wbm-warn) 35%, transparent); }
      .wbm-chip.bad { color: var(--wbm-danger); border-color: color-mix(in srgb, var(--wbm-danger) 35%, transparent); }
      .wbm-chip.accent { color: var(--wbm-accent); border-color: color-mix(in srgb, var(--wbm-accent) 35%, transparent); }
      .wbm-btn {
        display: inline-flex; align-items: center; gap: 5px;
        border: 1px solid var(--wbm-border); background: transparent; color: var(--wbm-text-2);
        font: inherit; font-size: 12px; line-height: 1.5; padding: 4px 9px; border-radius: 6px;
        cursor: pointer; transition: background .12s, color .12s, border-color .12s;
        white-space: nowrap;
      }
      .wbm-btn:hover:not(:disabled) { background: var(--wbm-hover); color: var(--wbm-text); }
      .wbm-btn.primary {
        color: var(--wbm-text); border-color: color-mix(in srgb, var(--wbm-accent) 55%, transparent);
        background: color-mix(in srgb, var(--wbm-accent) 16%, transparent);
      }
      .wbm-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--wbm-accent) 26%, transparent); }
      .wbm-btn.danger { color: var(--wbm-danger); }
      .wbm-btn:disabled { opacity: .45; cursor: default; }
      .wbm-btn:focus-visible, .wbm-icon:focus-visible, .wbm-file:focus-visible, .wbm-project:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--wbm-accent)); outline-offset: 1px;
      }
      .wbm-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px;
        background: transparent; color: var(--wbm-text-3); cursor: pointer;
      }
      .wbm-icon:hover:not(:disabled) { background: var(--wbm-hover); color: var(--wbm-text); }
      .wbm-icon:disabled { opacity: .4; cursor: default; }
      .wbm-layout { display: flex; flex: 1; min-height: 0; }
      .wbm-rail {
        width: 264px; flex: 0 0 264px; overflow-y: auto;
        border-right: 1px solid var(--wbm-border-soft); background: var(--wbm-panel);
        padding: 10px 8px 18px;
      }
      .wbm-rail-head { padding: 0 6px 8px; }
      .wbm-search {
        width: 100%; padding: 5px 9px; font: inherit; font-size: 12px;
        color: var(--wbm-text); background: var(--wbm-panel-2);
        border: 1px solid var(--wbm-border-soft); border-radius: 6px; outline: none;
      }
      .wbm-search:focus { border-color: color-mix(in srgb, var(--wbm-accent) 55%, transparent); }
      .wbm-rail-group {
        font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em;
        color: var(--wbm-text-3); padding: 12px 8px 4px;
      }
      .wbm-rail > .wbm-rail-group:first-child { padding-top: 2px; }
      .wbm-project, .wbm-file {
        display: flex; align-items: center; gap: 7px; width: 100%;
        border: none; background: transparent; color: var(--wbm-text-2);
        font: inherit; font-size: 12.5px; text-align: left; padding: 5px 8px;
        border-radius: 6px; cursor: pointer; min-width: 0;
      }
      .wbm-project:hover, .wbm-file:hover { background: var(--wbm-hover); color: var(--wbm-text); }
      .wbm-project.active, .wbm-file.active { background: var(--wbm-accent-soft); color: var(--wbm-text); }
      .wbm-file { padding-left: 24px; font-size: 12px; }
      .wbm-tree-children { position: relative; margin: 2px 0 4px 13px; }
      .wbm-tree-children .wbm-file { position: relative; padding-left: 18px; }
      .wbm-tree-children .wbm-file::before {
        content: ''; position: absolute; left: 0; top: 0; bottom: 0;
        border-left: 1px solid var(--wbm-border-soft);
      }
      .wbm-tree-children .wbm-file:last-child::before { bottom: 50%; }
      .wbm-tree-children .wbm-file::after {
        content: ''; position: absolute; left: 0; top: 50%; width: 10px;
        border-top: 1px solid var(--wbm-border-soft);
      }
      .wbm-tree-children .wbm-file:hover::before,
      .wbm-tree-children .wbm-file:hover::after { border-color: var(--wbm-border); }
      .wbm-dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--wbm-ok); }
      .wbm-dot.empty { background: var(--wbm-border); }
      .wbm-dot.warn { background: var(--wbm-warn); }
      .wbm-dot.bad { background: var(--wbm-danger); }
      .wbm-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wbm-meta { color: var(--wbm-text-3); font-size: 10.5px; white-space: nowrap; }
      .wbm-chevron { color: var(--wbm-text-3); transition: transform .12s; flex: 0 0 auto; }
      .wbm-chevron.open { transform: rotate(90deg); }
      .wbm-note { color: var(--wbm-text-3); font-size: 11.5px; line-height: 1.6; padding: 4px 8px; }
      .wbm-detail { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
      .wbm-doc-head { padding: 14px 20px 10px; border-bottom: 1px solid var(--wbm-border-soft); }
      .wbm-doc-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; font-weight: 600; }
      .wbm-doc-path {
        margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px; color: var(--wbm-text-3); word-break: break-all;
      }
      .wbm-doc-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
      .wbm-doc-body { flex: 1; overflow-y: auto; padding: 12px 20px 40px; }
      .wbm-content { max-width: 920px; margin: 0 auto; }
      .wbm-banner {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        border: 1px solid var(--wbm-border); background: var(--wbm-panel);
        color: var(--wbm-text-2); border-radius: 7px; padding: 7px 10px; margin-bottom: 10px;
        font-size: 12px; line-height: 1.5;
      }
      .wbm-banner.warn { color: var(--wbm-warn); border-color: color-mix(in srgb, var(--wbm-warn) 35%, transparent); background: color-mix(in srgb, var(--wbm-warn) 8%, var(--wbm-bg)); }
      .wbm-banner.lock { color: var(--wbm-text-2); }
      .wbm-banner .wbm-spacer { flex: 1; }
      .wbm-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 4px 0 16px; }
      .wbm-stat { border: 1px solid var(--wbm-border-soft); background: var(--wbm-panel); border-radius: var(--wbm-radius); padding: 10px 12px; }
      .wbm-stat .k { color: var(--wbm-text-3); font-size: 10.5px; }
      .wbm-stat .v { color: var(--wbm-text); font-size: 19px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.4; }
      .wbm-h2 { font-size: 12px; font-weight: 600; color: var(--wbm-text-2); margin: 18px 0 6px; letter-spacing: .01em; }
      .wbm-list { display: flex; flex-direction: column; gap: 4px; }
      .wbm-list-row {
        display: flex; align-items: center; gap: 8px; padding: 5px 8px;
        border-bottom: 1px dashed var(--wbm-border-soft); font-size: 12px; color: var(--wbm-text-2);
      }
      .wbm-list-row:last-child { border-bottom: none; }
      .wbm-list-row .wbm-name { color: var(--wbm-text); }
      .wbm-section { margin-top: 18px; }
      .wbm-section-head { display: flex; align-items: center; gap: 8px; min-height: 26px; }
      .wbm-section-title { font-size: 13px; font-weight: 600; color: var(--wbm-text); }
      .wbm-count { color: var(--wbm-text-3); font-size: 10.5px; }
      .wbm-section-head .wbm-icon { opacity: .6; }
      .wbm-section-head:hover .wbm-icon { opacity: 1; }
      .wbm-entry {
        display: flex; align-items: flex-start; gap: 7px; padding: 4px 7px;
        border-radius: 6px; line-height: 1.65; font-size: 12.5px;
      }
      .wbm-entry:hover { background: var(--wbm-hover); }
      .wbm-entry-mark { color: var(--wbm-text-3); flex: 0 0 auto; padding-top: 1px; }
      .wbm-entry-text { flex: 1; min-width: 0; word-break: break-word; white-space: pre-wrap; }
      .wbm-entry-actions { display: flex; gap: 2px; flex: 0 0 auto; opacity: 0; transition: opacity .12s; }
      .wbm-entry:hover .wbm-entry-actions, .wbm-entry:focus-within .wbm-entry-actions { opacity: 1; }
      .wbm-mark { background: color-mix(in srgb, var(--wbm-warn) 40%, transparent); color: inherit; border-radius: 2px; }
      .wbm-inline { display: flex; align-items: center; gap: 6px; padding: 3px 0 3px 18px; }
      .wbm-input, .wbm-textarea {
        width: 100%; font: inherit; font-size: 12.5px; color: var(--wbm-text);
        background: var(--wbm-panel-2); border: 1px solid var(--wbm-border); border-radius: 6px;
        padding: 5px 8px; outline: none;
      }
      .wbm-input:focus, .wbm-textarea:focus { border-color: color-mix(in srgb, var(--wbm-accent) 55%, transparent); }
      .wbm-textarea {
        min-height: 128px; resize: vertical; line-height: 1.7;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
      }
      .wbm-editor { border: 1px solid var(--wbm-border); border-radius: 8px; background: var(--wbm-panel); padding: 10px; margin: 8px 0; }
      .wbm-editor-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      .wbm-editor-bar .wbm-spacer { flex: 1; }
      .wbm-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 54px 20px; color: var(--wbm-text-3); text-align: center; }
      .wbm-empty .t { color: var(--wbm-text-2); font-size: 13px; font-weight: 600; }
      .wbm-empty .d { font-size: 12px; line-height: 1.65; max-width: 420px; }
      .wbm-skeleton { height: 12px; border-radius: 4px; background: linear-gradient(90deg, var(--wbm-panel-2), var(--wbm-panel), var(--wbm-panel-2)); background-size: 200% 100%; animation: wbm-shimmer 1.2s linear infinite; margin: 8px 0; }
      @keyframes wbm-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
      .wbm-toast {
        position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px; z-index: 60;
        background: var(--dsw-alias-toast-bg, var(--wbm-panel-2)); color: var(--dsw-alias-toast-label, var(--wbm-text));
        border: 1px solid var(--wbm-border); border-radius: 8px; box-shadow: var(--wbm-shadow);
        padding: 8px 12px; font-size: 12px; max-width: min(560px, 90vw);
      }
      .wbm-toast .wbm-btn { border-color: transparent; color: var(--wbm-accent); }
      .wbm-mask {
        position: fixed; inset: 0; z-index: 55; background: var(--dsw-alias-bg-mask-2, rgba(0,0,0,.32));
        display: flex; align-items: center; justify-content: center; padding: 20px;
      }
      .wbm-modal {
        width: 100%; max-width: 680px; max-height: 82vh; overflow: auto;
        background: var(--wbm-panel); color: var(--wbm-text);
        border: 1px solid var(--wbm-border); border-radius: 10px; box-shadow: var(--wbm-shadow);
        padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
      }
      .wbm-modal .h { font-size: 13.5px; font-weight: 600; }
      .wbm-modal .d { color: var(--wbm-text-2); font-size: 12px; line-height: 1.65; }
      .wbm-modal .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .wbm-diff { max-height: 280px; overflow: auto; border: 1px solid var(--wbm-border-soft); border-radius: 6px; padding: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
      .wbm-diff .same { opacity: .45; }
      .wbm-diff .add { background: color-mix(in srgb, var(--wbm-ok) 18%, transparent); }
      .wbm-diff .del { background: color-mix(in srgb, var(--wbm-danger) 16%, transparent); }
      .wbm-narrow .wbm-rail { display: none; }
      .wbm-narrow .wbm-layout { display: block; }
      .wbm-narrow .wbm-detail { height: 100%; }
      .wbm-narrow .wbm-doc-head { padding: 10px 12px 8px; }
      .wbm-narrow .wbm-doc-body { padding: 10px 12px 30px; }
      .wbm-narrow .wbm-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .wbm-picker { display: flex; align-items: center; gap: 6px; padding: 0 12px 6px; }
      .wbm-picker select {
        flex: 1; min-width: 0; font: inherit; font-size: 12px; color: var(--wbm-text);
        background: var(--wbm-panel-2); border: 1px solid var(--wbm-border-soft);
        border-radius: 6px; padding: 4px 6px;
      }
      .wbm-settings-confirm {
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e8b96a) 40%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e8b96a) 10%, transparent);
        border-radius: 7px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
        font-size: 12px; color: var(--dsw-alias-label-secondary, #a3adbd);
      }
      @media (hover: none) {
        .wbm-entry-actions { opacity: 1; }
      }
      .wbm-tab .wbm-rail { width: 208px; flex-basis: 208px; }
      .wbm-tab .wbm-picker { display: none; }
      .wbm-tab .wbm-header { padding: 8px 12px; min-height: 44px; }
      .wbm-tab .wbm-doc-head { padding: 10px 14px 8px; }
      .wbm-tab .wbm-doc-body { padding: 10px 14px 30px; }
      @media (max-width: 820px) {
        .wbm-tab .wbm-rail { position: static; transform: none; display: none; box-shadow: none; }
        .wbm-tab .wbm-picker { display: flex; }
      }
      @media (max-width: 820px) {
        .wbm-rail {
          position: absolute; inset: 48px auto 0 0; z-index: 20; width: 264px;
          transform: translateX(-100%); transition: transform .15s;
          box-shadow: var(--wbm-shadow);
        }
        .wbm-rail.open { transform: none; }
        .wbm-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .wbm-doc-head, .wbm-doc-body { padding-left: 12px; padding-right: 12px; }
      }
    `

    const STYLE_ID = 'dsh-workbuddy-memory-styles'
    /** One <style> per page, shared by every panel occurrence. */
    function ensureStyles(doc = document) {
      if (doc.getElementById(STYLE_ID)) return
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      doc.head.appendChild(style)
    }

    function removeStyles(doc = document) {
      doc.getElementById(STYLE_ID)?.remove()
    }

    // ── settings card styles (host settings page, not the panel) ────────────

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0' },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '12.5px', fontWeight: 600, color: 'inherit' },
      hint: { fontSize: '11.5px', opacity: 0.62, lineHeight: 1.5 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        fontSize: '12.5px',
        color: 'inherit',
        background: 'rgba(127,127,127,0.08)',
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: '6px',
        outline: 'none',
      },
      toggle: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
      status: { fontSize: '11.5px', opacity: 0.62 },
      error: { fontSize: '11.5px', color: '#e06c75' },
      fieldset: { border: '1px solid rgba(127,127,127,0.2)', borderRadius: '8px', padding: '10px 12px', margin: 0 },
      legend: { fontSize: '11.5px', opacity: 0.7, padding: '0 4px' },
    }

    function useSnapshot(form) {
      const [snap, setSnap] = React.useState(() => form.getSnapshot())
      React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])
      return snap
    }

    function TextField({ label, hint, value, placeholder, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(value ?? '')
      React.useEffect(() => setDraft(value ?? ''), [value])
      return h(
        'label',
        { style: S.row },
        h('span', { style: S.label }, label),
        hint ? h('span', { style: S.hint }, hint) : null,
        h('input', {
          style: S.input,
          type: 'text',
          value: draft,
          placeholder,
          disabled,
          spellCheck: false,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            if ((value ?? '') !== draft) onCommit(draft)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setDraft(value ?? '')
          },
        }),
      )
    }

    function NumberField({ label, hint, value, min, max, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      React.useEffect(() => setDraft(String(value ?? '')), [value])
      return h(
        'label',
        { style: S.row },
        h('span', { style: S.label }, label),
        hint ? h('span', { style: S.hint }, hint) : null,
        h('input', {
          style: S.input,
          type: 'number',
          min,
          max,
          value: draft,
          disabled,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            const next = Number(draft)
            if (Number.isFinite(next) && next !== Number(value)) onCommit(next)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setDraft(String(value ?? ''))
          },
        }),
      )
    }

    /**
     * A closed set of choices.
     *
     * `inject.mode` has exactly two values and the schema rejects anything else,
     * so a free-text field would let a person save a value the plugin silently
     * normalizes back to `layered` — the control would look like it worked.
     *
     * @param {object} props
     * @param {{ value: string, label: string }[]} props.options
     */
    function SelectField({ label, hint, value, options, disabled, onChange }) {
      return h(
        'label',
        { style: S.row },
        h('span', { style: S.label }, label),
        hint ? h('span', { style: S.hint }, hint) : null,
        h(
          'select',
          {
            style: S.input,
            value: value ?? '',
            disabled,
            onChange: (event) => onChange(event.target.value),
          },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ),
      )
    }

    function Switch({ label, hint, checked, disabled, onChange }) {
      return h(
        'label',
        { style: { ...S.toggle, opacity: disabled ? 0.5 : 1 } },
        h('input', { type: 'checkbox', checked: Boolean(checked), disabled, onChange: (event) => onChange(event.target.checked) }),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          h('span', { style: S.label }, label),
          hint ? h('span', { style: S.hint }, hint) : null,
        ),
      )
    }

    /**
     * Write one field of this plugin's config section.
     *
     * The host's `form.set(field, value)` addresses a *scalar* field by name and
     * wraps it as `path: [field]`; it never splits a dotted string. Passing
     * `'inject.limits.project'` therefore asked for a field literally named
     * that, which `isVolatilePath` rejects ("not volatile") and the host answers
     * with a refusal — the card showed its generic "the host refused this
     * change" line and nothing was written. Every nested key below the root was
     * affected; only the three top-level scalars worked.
     *
     * `mutate` takes the path already segmented, so splitting here is what makes
     * a nested key addressable. A `set` on a field inside a `.volatile()` object
     * still passes the host's check: the walk stops at that object's meta.
     *
     * @param {object} form - the host's config form for this plugin entry.
     * @param {string} field - dotted field path, e.g. `inject.limits.project`.
     * @param {unknown} value - the JSON-shaped value to store.
     * @returns {Promise<boolean>} whether the host accepted the write.
     */
    async function writeConfigField(form, field, value) {
      const path = String(field).split('.').filter((part) => part.length > 0)
      if (path.length === 0) return false
      if (typeof form.mutate !== 'function') return form.set(field, value)
      return form.mutate([{ op: 'set', path, value }])
    }

    /**
     * The config card.
     *
     * Every value it shows is the schema-resolved one — what the plugin will
     * actually use — so an empty path field never looks "unset" when the
     * environment already provides it.
     */
    function SettingsCard({ form }) {
      useLocaleRevision()
      const snap = useSnapshot(form)
      const [error, setError] = React.useState('')
      const value = snap.value ?? {}
      const inject = value.inject ?? {}
      const limits = inject.limits ?? {}
      const write = value.write ?? {}
      const search = value.search ?? {}
      const uiGuard = value.guard ?? {}
      const ui = value.ui ?? {}
      const writable = Boolean(snap.writable)

      const commit = React.useCallback(
        async (field, next) => {
          setError('')
          try {
            const ok = await writeConfigField(form, field, next)
            if (!ok) setError(t('settings.hostRejected'))
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          }
        },
        [form],
      )

      if (snap.status === 'loading') return h('div', { style: S.status }, t('settings.loadingConfig'))
      if (snap.status === 'unavailable') {
        return h('div', { style: S.status }, t('settings.noWriteAccess'))
      }

      return h(
        'div',
        { style: S.wrap },
        h(
          'fieldset',
          { style: S.fieldset },
          h('legend', { style: S.legend }, t('settings.general')),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h(Switch, {
              label: t('settings.readOnly'),
              hint: t('settings.readOnlyHint'),
              checked: value.readOnly,
              disabled: !writable,
              onChange: (next) => commit('readOnly', next),
            }),
            h(TextField, {
              label: 'WorkBuddy home',
              hint: t('settings.homeHint'),
              value: value.workbuddyHome ?? '',
              placeholder: t('settings.homePlaceholder'),
              disabled: !writable,
              onCommit: (next) => commit('workbuddyHome', next),
            }),
            h(TextField, {
              label: t('settings.dataFolder'),
              hint: t('settings.dataFolderHint'),
              value: value.dataFolderName ?? '',
              placeholder: '.workbuddy',
              disabled: !writable,
              onCommit: (next) => commit('dataFolderName', next),
            }),
          ),
        ),
        h(
          'fieldset',
          { style: S.fieldset },
          h('legend', { style: S.legend }, t('settings.inject')),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h(Switch, {
              label: t('settings.injectMemory'),
              hint: t('settings.injectMemoryHint'),
              checked: inject.enabled,
              disabled: !writable,
              onChange: (next) => commit('inject.enabled', next),
            }),
            h(SelectField, {
              label: t('settings.injectMode'),
              hint: t('settings.injectModeHint'),
              value: inject.mode ?? 'layered',
              options: [
                { value: 'layered', label: t('settings.injectModeLayered') },
                { value: 'full', label: t('settings.injectModeFull') },
              ],
              disabled: !writable,
              onChange: (next) => commit('inject.mode', next),
            }),
            h(NumberField, {
              label: t('settings.coreBudget'),
              hint: t('settings.coreBudgetHint'),
              // Shown clamped, because the schema does not clamp: see
              // `effectiveCoreBudget`. A stored 1000 runs at 4000, so the field
              // has to show 4000 rather than a number that is not in force.
              value: effectiveCoreBudget(inject.coreBudget),
              min: CORE_BUDGET_MIN,
              max: CORE_BUDGET_MAX,
              disabled: !writable,
              onCommit: (next) => commit('inject.coreBudget', next),
            }),
            h(NumberField, {
              label: t('settings.userLimit'),
              hint: t('settings.userLimitHint'),
              value: limits.user ?? 8000,
              min: 0,
              max: 200000,
              disabled: !writable,
              onCommit: (next) => commit('inject.limits.user', next),
            }),
            h(NumberField, {
              label: t('settings.distillAbove'),
              hint: t('settings.distillAboveHint'),
              // 0 is the stored sentinel for "derive from the limit", not a
              // usable threshold. Showing the raw 0 would read as "distillation
              // off" when it is actually running at twice the limit.
              value: inject.distillAbove > 0 ? inject.distillAbove : (limits.user ?? 8000) * 2,
              min: 0,
              max: 2000000,
              disabled: !writable,
              onCommit: (next) => commit('inject.distillAbove', next),
            }),
            h(NumberField, {
              label: t('settings.projectLimit'),
              hint: t('settings.projectLimitHint'),
              value: limits.project ?? 10000,
              min: 0,
              max: 200000,
              disabled: !writable,
              onCommit: (next) => commit('inject.limits.project', next),
            }),
            h(Switch, {
              label: t('settings.allowWrite'),
              hint: t('settings.allowWriteHint'),
              checked: write.enabled,
              disabled: !writable,
              onChange: (next) => commit('write.enabled', next),
            }),
            h(Switch, {
              label: t('settings.guardSection'),
              hint: t('settings.guardHint'),
              checked: uiGuard.enabled,
              disabled: !writable,
              onChange: (next) => commit('guard.enabled', next),
            }),
            h(Switch, {
              label: t('settings.searchSection'),
              hint: t('settings.searchHint'),
              checked: search.enabled,
              disabled: !writable,
              onChange: (next) => commit('search.enabled', next),
            }),
          ),
        ),
        h(
          'fieldset',
          { style: S.fieldset },
          h('legend', { style: S.legend }, t('settings.panelSection')),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h(Switch, {
              label: t('settings.panelWrite'),
              hint: t('settings.panelHint'),
              checked: ui.allowWriteActions,
              disabled: !writable,
              onChange: (next) => commit('ui.allowWriteActions', next),
            }),
            h(Switch, {
              label: t('settings.globalPanel'),
              hint: t('settings.globalPanelHint'),
              checked: ui.globalPanel !== false,
              disabled: !writable,
              onChange: (next) => commit('ui.globalPanel', next),
            }),
            h(Switch, {
              label: t('settings.projectTab'),
              hint: t('settings.projectTabHint'),
              checked: ui.projectTab !== false,
              disabled: !writable,
              onChange: (next) => commit('ui.projectTab', next),
            }),
            h(Switch, {
              label: t('settings.sessionAction'),
              hint: t('settings.sessionActionHint'),
              checked: ui.sessionAction !== false,
              disabled: !writable,
              onChange: (next) => commit('ui.sessionAction', next),
            }),
            h(NumberField, {
              label: t('settings.refreshMs'),
              hint: t('settings.refreshMsHint'),
              value: ui.refreshMs ?? 3000,
              min: 500,
              max: 60000,
              disabled: !writable,
              onCommit: (next) => commit('ui.refreshMs', next),
            }),
            h(NumberField, {
              label: t('settings.maxProjects'),
              hint: t('settings.maxProjectsHint'),
              value: ui.maxProjects ?? 50,
              min: 1,
              max: 500,
              disabled: !writable,
              onCommit: (next) => commit('ui.maxProjects', next),
            }),
          ),
        ),
        error ? h('div', { style: S.error }, error) : null,
        h(
          'div',
          { style: S.status },
          `revision ${snap.revision ?? '—'} · ${snap.writable ? t('settings.writable') : t('file.readOnly')} · ${snap.user ? t('settings.overridden') : t('settings.followDefault')}`,
        ),
      )
    }

    // ── pure helpers ────────────────────────────────────────────────────────

    function humanBytes(n) {
      if (!Number.isFinite(n)) return '—'
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    function ratio(bytes, limit) {
      const b = Number(bytes) || 0
      const l = Number(limit) || 0
      if (l <= 0) return { value: 0, percent: 0, level: 'none' }
      const raw = b / l
      return { value: Math.min(raw, 1), percent: Math.round(raw * 100), level: raw >= 1 ? 'over' : raw >= 0.8 ? 'warn' : 'ok' }
    }

    function filterEntries(entries, query) {
      const q = String(query ?? '').trim().toLowerCase()
      if (!q) return entries
      return entries.filter((entry) => entry.text.toLowerCase().includes(q))
    }

    function highlightParts(text, query) {
      const q = String(query ?? '').trim()
      if (!q) return { before: text, hit: '', after: '' }
      const at = text.toLowerCase().indexOf(q.toLowerCase())
      if (at < 0) return { before: text, hit: '', after: '' }
      return { before: text.slice(0, at), hit: text.slice(at, at + q.length), after: text.slice(at + q.length) }
    }

    function lineDiff(before, after, max = 400) {
      const a = String(before ?? '').split('\n')
      const b = String(after ?? '').split('\n')
      if (a.length > max || b.length > max) {
        return { truncated: true, rows: [], reason: 'too_large', added: 0, removed: 0 }
      }
      const n = a.length
      const m = b.length
      const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
      }
      const rows = []
      let added = 0
      let removed = 0
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          rows.push({ type: 'same', text: a[i] })
          i += 1
          j += 1
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          rows.push({ type: 'del', text: a[i] })
          removed += 1
          i += 1
        } else {
          rows.push({ type: 'add', text: b[j] })
          added += 1
          j += 1
        }
      }
      while (i < n) {
        rows.push({ type: 'del', text: a[i] })
        removed += 1
        i += 1
      }
      while (j < m) {
        rows.push({ type: 'add', text: b[j] })
        added += 1
        j += 1
      }
      return { truncated: false, rows, added, removed }
    }

    async function getJson(url, options) {
      const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...(options ?? {}) })
      const body = await response.json().catch(() => ({ ok: false, code: 'bad_json' }))
      if (!response.ok) {
        const error = new Error(body?.code ?? `http_${response.status}`)
        error.code = body?.code
        error.status = response.status
        throw error
      }
      return body
    }

    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({ ok: false, code: 'bad_json' }))
      return { status: response.status, body }
    }

    // Status code → copy key. The lookup is deferred to `describeCode` so the
    // text follows the active language instead of whatever it was at load time.
    const MESSAGES = {
      write_actions_disabled: 'code.write_actions_disabled',
      read_only: 'code.read_only',
      write_disabled: 'code.write_disabled',
      conflict: 'code.conflict',
      stale_line: 'code.stale_line',
      not_an_entry: 'code.not_an_entry',
      no_section: 'code.no_section',
      ambiguous_section: 'code.ambiguous_section',
      empty_heading: 'code.empty_heading',
      multiline_text: 'code.multiline_text',
      invalid_body: 'code.invalid_body',
      invalid_structure: 'code.invalid_structure',
      too_large: 'code.too_large',
      empty_text: 'code.empty_text',
      ambiguous: 'code.ambiguous',
      lock_timeout: 'code.lock_timeout',
      revision_required: 'code.revision_required',
      nothing_to_prune: 'code.nothing_to_prune',
      no_project: 'code.no_project',
      no_store: 'code.no_store',
      no_profile: 'code.no_profile',
      ambiguous_profile: 'code.ambiguous_profile',
      not_found: 'code.not_found',
      unknown_project: 'state.projectGone',
      read_only_target: 'state.profileReadOnlyNote',
      body_too_large: 'code.body_too_large',
      json_required: 'code.json_required',
      unknown_action: 'code.unknown_action',
      no_route: 'code.no_route',
      unreadable: 'code.unreadable',
      backup_failed: 'code.backup_failed',
      write_failed: 'code.write_failed',
      action_failed: 'code.action_failed',
      untrusted: 'code.untrusted',
      cross_origin: 'code.cross_origin',
      plan_required: 'code.plan_required',
      plan_conflict: 'code.plan_conflict',
      partial: 'code.partial',
      outcome_unknown: 'code.outcome_unknown',
      operation_mismatch: 'code.operation_mismatch',
      operation_required: 'code.operation_required',
      no_revision: 'code.no_revision',
      archive_capacity: 'code.archive_capacity',
      archive_failed: 'code.archive_failed',
      rename_failed: 'code.rename_failed',
      backup_required: 'code.backup_required',
      backup_name_collision: 'code.backup_name_collision',
      layering_confirmation_required: 'code.layering_confirmation_required',
      receipt_capacity: 'code.receipt_capacity',
      operation_id_too_long: 'code.operation_id_too_long',
      read_conflict: 'code.read_conflict',
      bad_offset: 'code.bad_offset',
      profile_not_found: 'code.profile_not_found',
      unknown_target: 'code.unknown_target',
      bad_target: 'code.bad_target',
      bad_section: 'code.bad_section',
      bad_date: 'code.bad_date',
      bad_request: 'code.bad_request',
      bad_json: 'code.bad_json',
      internal: 'code.internal',
      method_not_allowed: 'code.method_not_allowed',
      empty_query: 'code.empty_query',
      search_disabled: 'code.search_disabled',
      no_path: 'code.no_path',
      not_a_file: 'code.not_a_file',
      no_match: 'code.no_match',
    }

    /**
     * The receipt directory, with the separator the path itself uses.
     *
     * The message is read by someone who is about to open that folder, so a
     * Windows path with a forward slash glued on is a path they have to fix
     * before it works.
     *
     * @param {string|undefined} stateDir
     * @returns {string}
     */
    function receiptsDir(stateDir) {
      const base = String(stateDir || '').trim().replace(/[\\/]+$/, '')
      if (!base) return '~/.dsh/workbuddy-memory/receipts/'
      const separator = /\\|^[a-zA-Z]:/.test(base) ? '\\' : '/'
      return `${base}${separator}receipts${separator}`
    }

    /**
     * Refusal copy, with the one variable a few of them need.
     *
     * `receipt_capacity` is the only refusal a person cannot get past by
     * retrying: the receipt store is full and every further write is refused
     * until something is cleaned up. Naming the directory is the difference
     * between "the plugin is broken" and "delete the finished receipts".
     *
     * @param {string} code
     * @param {{ stateDir?: string }} [vars]
     */
    function describeCode(code, vars = {}) {
      const key = MESSAGES[code]
      if (!key) return String(code ?? t('state.unknownError'))
      return t(key, { receiptsDir: receiptsDir(vars.stateDir) })
    }

    /**
     * One idempotency key per click.
     *
     * `crypto.randomUUID` is missing in a non-secure context on some hosts, so
     * this falls back to random base36. Uniqueness is all that matters: the
     * store only compares the id against its recent ledger.
     */
    function newOperationId() {
      try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
      } catch {
        // Fall through to the manual form.
      }
      return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    /** Last two segments of a long path; short paths are left readable. */
    function shortPath(path) {
      if (!path) return '—'
      const parts = String(path).split(/[\\/]/).filter(Boolean)
      if (parts.length <= 3) return path
      return `…/${parts.slice(-2).join('/')}`
    }

    /** Windows folds case and accepts both separators; compare the same way. */
    function samePath(a, b) {
      if (!a || !b) return false
      const norm = (value) => {
        const text = String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
        return /^[a-zA-Z]:\//.test(text) ? text.toLowerCase() : text
      }
      return norm(a) === norm(b)
    }

    function relativeTime(value) {
      const ts = Number(value) || 0
      if (!ts) return '—'
      const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
      if (seconds < 60) return t('time.justNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('time.minutesAgo', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('time.hoursAgo', { n: hours })
      const days = Math.round(hours / 24)
      if (days < 45) return t('time.daysAgo', { n: days })
      return new Date(ts).toLocaleDateString()
    }

    /** Tone + label for one project row. */
    function projectState(row) {
      if (row.current) return { tone: 'accent', label: t('state.current') }
      if (row.status === 'missing') return { tone: 'bad', label: t('state.missing') }
      if (row.status === 'unreadable') return { tone: 'bad', label: t('file.unreadable') }
      if (row.status === 'over-limit') return { tone: 'warn', label: t('state.overLimit') }
      if (row.status === 'stale') return { tone: 'warn', label: t('stats.pendingArchive') }
      if (row.status === 'daily-only') return { tone: 'warn', label: t('state.dailyOnly') }
      if (row.status === 'empty') return { tone: 'empty', label: t('rail.noMemory') }
      return { tone: 'ok', label: t('state.hasMemory') }
    }

    // ── config and navigation ───────────────────────────────────────────────

    const DEFAULT_FLAGS = {
      allowWriteActions: true,
      globalPanel: true,
      projectTab: true,
      sessionAction: true,
      refreshMs: 3000,
      maxProjects: 50,
    }

    function flagsFrom(value) {
      const ui = value?.ui ?? {}
      return {
        allowWriteActions: ui.allowWriteActions !== false,
        globalPanel: ui.globalPanel !== false,
        projectTab: ui.projectTab !== false,
        sessionAction: ui.sessionAction !== false,
        refreshMs: Math.min(Math.max(Number(ui.refreshMs) || 3000, 500), 60000),
        maxProjects: Math.min(Math.max(Number(ui.maxProjects) || 50, 1), 500),
      }
    }

    /** The config form is captured once by `apply`; panels read flags live. */
    const runtime = {
      ctx: null,
      form: null,
      flags: { ...DEFAULT_FLAGS },
      sidebarRight: null,
      sidebarRightTabs: null,
      layout: null,
      /**
       * Translate for the whole module.
       *
       * `apply` replaces this with the host-bound version as soon as the client
       * mounts. The module-level default keeps every component renderable when
       * one is instantiated outside `apply` (the unit tests do exactly that).
       */
      t: (key, vars) => bindCopy(null)(key, vars),
      /** Bumped on every locale change so panels re-render with new copy. */
      localeRevision: 0,
    }

    /** Module-level translate; components call this directly. */
    const t = (key, vars) => runtime.t(key, vars)

    /**
     * Re-render a component when the host switches language.
     *
     * The host publishes a `locale/change` event and a subscribable snapshot.
     * A panel that reads `t()` during render must re-render on that change, or
     * it keeps the copy from whenever it happened to mount.
     *
     * @returns {number} the current revision, as a render dependency.
     */
    function useLocaleRevision() {
      const [revision, setRevision] = React.useState(() => runtime.localeRevision)
      React.useEffect(() => {
        const locale = runtime.ctx?.locale
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        const sync = () => {
          runtime.localeRevision += 1
          setRevision(runtime.localeRevision)
        }
        // A dictionary registration bumps the revision too, so a late-arriving
        // dictionary still refreshes an already-mounted panel.
        return locale.subscribe(sync)
      }, [])
      return revision
    }

    function readFlags() {
      const snap = runtime.form?.getSnapshot?.()
      if (snap?.status === 'ready' && snap.value) runtime.flags = flagsFrom(snap.value)
      return runtime.flags
    }

    function useFlags() {
      const [flags, setFlags] = React.useState(() => readFlags())
      React.useEffect(() => {
        const form = runtime.form
        if (!form) return undefined
        return form.subscribe(() => setFlags(readFlags()))
      }, [])
      return flags
    }

    /** Write one panel-level setting from inside the panel. */
    async function setFlag(field, value) {
      const form = runtime.form
      if (!form) return false
      try {
        return await writeConfigField(form, field, value)
      } catch {
        return false
      }
    }

    // ── icons ───────────────────────────────────────────────────────────────

    function IconBase({ size = 16, children } = {}) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        children,
      )
    }

    function OverviewIcon({ size = 20 } = {}) {
      return h(
        IconBase,
        { size },
        h('circle', { cx: 12, cy: 12, r: 8.5 }),
        h('path', { d: 'M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5S14.4 18.2 12 20.5C9.6 18.2 8.4 15.3 8.4 12S9.6 5.8 12 3.5Z' }),
      )
    }

    function ProjectIcon({ size = 20 } = {}) {
      return h(
        IconBase,
        { size },
        h('path', { d: 'M4.5 5.5h5l1.6 2h8.4v11a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z' }),
        h('path', { d: 'M8 12h8M8 15.5h5' }),
      )
    }

    function ChevronIcon({ size = 12, open } = {}) {
      return h(IconBase, { size }, h('path', { d: open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6' }))
    }

    function RefreshIcon({ size = 15 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M20 11a8 8 0 1 0-2.3 6.7' }), h('path', { d: 'M20 5v6h-6' }))
    }

    function SparkIcon({ size = 15 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M12 3.5l1.7 4.8L18.5 10l-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7L12 3.5Z' }), h('path', { d: 'M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z' }))
    }

    function LockIcon({ size = 14 } = {}) {
      return h(IconBase, { size }, h('rect', { x: 5, y: 10.5, width: 14, height: 9.5, rx: 1.6 }), h('path', { d: 'M8 10.5V7a4 4 0 0 1 8 0v3.5' }))
    }

    function SearchIcon({ size = 14 } = {}) {
      return h(IconBase, { size }, h('circle', { cx: 10.5, cy: 10.5, r: 6 }), h('path', { d: 'M15 15l4 4' }))
    }

    function PlusIcon({ size = 15 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M12 5v14M5 12h14' }))
    }

    function PencilIcon({ size = 14 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M4.5 19.5l4.2-.9 9-9a2.1 2.1 0 0 0-3-3l-9 9-.9 4.2Z' }), h('path', { d: 'M13.5 6.5l3 3' }))
    }

    function TrashIcon({ size = 14 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7' }))
    }

    function CloseIcon({ size = 14 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
    }

    function SourceIcon({ size = 15 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M9 7l-4 5 4 5M15 7l4 5-4 5' }))
    }

    function CheckIcon({ size = 14 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M5 12.5l4.5 4.5L19 6.5' }))
    }

    function HistoryIcon({ size = 14 } = {}) {
      return h(
        IconBase,
        { size },
        h('path', { d: 'M4 12a8 8 0 1 0 2.4-5.7' }),
        h('path', { d: 'M4 4.5V9h4.5' }),
        h('path', { d: 'M12 8.5V12l2.6 1.6' }),
      )
    }

    function DraftIcon({ size = 14 } = {}) {
      return h(IconBase, { size }, h('path', { d: 'M6 3.5h8l4 4v13H6Z' }), h('path', { d: 'M14 3.5V8h4M9 12h6M9 16h4' }))
    }

    // ── current project resolution ──────────────────────────────────────────

    /**
     * The project this surface is about.
     *
     * A right-sidebar tab knows its session; a main panel knows which session
     * the operator is looking at (`retainedBy.mainView`). Falling back to the
     * workspace registry keeps the project correct even when a session has no
     * cwd of its own.
     */
    function useCurrentCwd(props, sessionId) {
      const useSessions = props?.useSessions
      const useWorkspaces = props?.useWorkspaces
      const sessions = typeof useSessions === 'function' ? useSessions((snapshot) => snapshot) : null
      const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces((snapshot) => snapshot) : null
      return React.useMemo(() => {
        const byId = sessions?.byId ?? {}
        const main = Object.values(byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)
        const id = sessionId ?? main?.id
        const row = id ? byId[id] : null
        if (row?.cwd) return row.cwd
        const workspace = (workspaces?.items ?? []).find((item) => id && item.sessionIds?.includes(id))
        return workspace?.path ?? null
      }, [sessions, workspaces, sessionId])
    }

    /** Read the acknowledgement once per browser session. */
    function sourceAcknowledged() {
      try {
        return window.sessionStorage.getItem(SOURCE_ACK_KEY) === '1'
      } catch {
        return false
      }
    }

    function acknowledgeSource() {
      try {
        window.sessionStorage.setItem(SOURCE_ACK_KEY, '1')
      } catch {
        // Private mode: the confirmation simply repeats next time.
      }
    }

    /** A diff block, or a line saying the diff was too large to build. */
    function diffBlock(diff, title) {
      if (!diff) return null
      return h(
        'div',
        null,
        h('div', { style: { fontSize: '12px', fontWeight: 600, margin: '4px 0 6px' } }, title),
        diff.truncated
          ? h('div', { className: 'wbm-note', style: { padding: 0 } }, t('editor.tooLargeStatsOnly'))
          : h(
              'div',
              { className: 'wbm-diff' },
              diff.rows.slice(0, 240).map((row, index) =>
                h('div', { key: index, className: row.type }, `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} ${row.text}`),
              ),
            ),
      )
    }

    // ── the shared workspace ────────────────────────────────────────────────

    const TARGET_LABEL = {
      'project-memory': t('target.projectMemory'),
      'project-daily': t('target.projectDaily'),
      'user-memory': t('target.userMemory'),
      profile: t('target.profile'),
    }

    function MemoryWorkspace(props) {
      const mode = props?.mode === 'project' ? 'project' : 'overview'
      const layout = props?.layout === 'narrow' ? 'narrow' : 'wide'
      // Re-render when the host switches language: every string below is read
      // through `t()` during render, so a stale render keeps the old copy.
      useLocaleRevision()
      const flags = useFlags()
      const sessionCwd = useCurrentCwd(props, props?.sessionId)

      const [state, setState] = React.useState(null)
      const [activeKey, setActiveKey] = React.useState(null)
      const [expanded, setExpanded] = React.useState(() => new Set())
      const [details, setDetails] = React.useState({})
      const [selected, setSelected] = React.useState(null)
      const [doc, setDoc] = React.useState(null)
      const [docLoading, setDocLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [railQuery, setRailQuery] = React.useState('')
      const [onlyMemory, setOnlyMemory] = React.useState(false)
      const [editing, setEditing] = React.useState(null)
      const [adding, setAdding] = React.useState(null)
      const [newSection, setNewSection] = React.useState(null)
      const [sectionEdit, setSectionEdit] = React.useState(null)
      const [sourceEdit, setSourceEdit] = React.useState(null)
      const [confirmSource, setConfirmSource] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [conflict, setConflict] = React.useState(null)
      const [dialog, setDialog] = React.useState(null)
      const [undo, setUndo] = React.useState(null)
      const [stale, setStale] = React.useState(false)
      const [railOpen, setRailOpen] = React.useState(false)
      // Both management surfaces keep their own frozen target: a list or a diff
      // is about one file, and it must not be reused for another one that
      // happens to be open when the response arrives.
      const [history, setHistory] = React.useState(null)
      const [draft, setDraft] = React.useState(null)

      const noticeTimer = React.useRef(null)
      const contentSeq = React.useRef(0)
      const searchRef = React.useRef(null)
      // Request generation for the two async management surfaces. Anything that
      // changes which file is on screen — including closing it — bumps this, so a
      // late response is dropped instead of being applied to the new file.
      const manageSeq = React.useRef(0)

      const flash = React.useCallback((text) => {
        setNotice(text)
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(''), 3200)
      }, [])

      // A shortcut from the sidebar no longer pins a project: the project tab
      // follows its own session, and the overview can select any project inline.
      const baseCwd = mode === 'project' ? sessionCwd || state?.cwd || null : null
      const resolvedRow = (state?.projects ?? []).find((row) => samePath(row.path, baseCwd)) ?? null
      const resolvedKey = resolvedRow?.key ?? null
      const effectiveKey = mode === 'project' ? resolvedKey || activeKey : activeKey

      // If there is no session cwd yet, the host's last assembly is the fallback.
      React.useEffect(() => {
        if (mode !== 'project' || effectiveKey || !state) return
        const rows = state.projects ?? []
        const match = rows.find((row) => row.current) ?? rows.find((row) => samePath(row.path, state.cwd))
        if (match) setActiveKey(match.key)
      }, [mode, effectiveKey, state])

      const refresh = React.useCallback(async () => {
        const suffix = effectiveKey ? `?project=${encodeURIComponent(effectiveKey)}` : ''
        try {
          const next = await getJson(`${API}/state${suffix}`)
          setState(next)
          setError('')
          if (effectiveKey && next.stores?.project) {
            setDetails((current) => ({ ...current, [effectiveKey]: next.stores.project }))
          }
          return next
        } catch (cause) {
          const code = String(cause?.message ?? cause)
          setError(describeCode(code))
          return null
        }
      }, [effectiveKey])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          if (!document.hidden) refresh()
        }, flags.refreshMs)
        return () => clearInterval(timer)
      }, [refresh, flags.refreshMs])

      React.useEffect(() => () => noticeTimer.current && clearTimeout(noticeTimer.current), [])

      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'f' && selected) {
            event.preventDefault()
            searchRef.current?.focus?.()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [selected])

      React.useEffect(() => {
        if (!undo) return undefined
        const timer = setTimeout(() => setUndo(null), Math.max(0, undo.until - Date.now()))
        return () => clearTimeout(timer)
      }, [undo])

      const project = effectiveKey ? (state?.projects ?? []).find((row) => row.key === effectiveKey) ?? null : null

      // The project surface is a single project: when the session resolves (or a
      // fallback picker changes it), start from the file a person most likely
      // wants instead of a blank summary.
      React.useEffect(() => {
        if (mode !== 'project') return
        setSelected(null)
        setDoc(null)
        setEditing(null)
        setAdding(null)
        setNewSection(null)
        setSectionEdit(null)
        setSourceEdit(null)
        dropManagement()
      }, [mode, effectiveKey])

      React.useEffect(() => {
        if (mode !== 'project' || !project || selected) return
        if (project.hasMemory) openFile('project-memory', undefined, project.key)
        else if (project.latestDaily) openFile('project-daily', project.latestDaily, project.key)
      }, [mode, project, selected])

      const projectDetail = effectiveKey
        ? details[effectiveKey] ?? (mode === 'project' ? state?.stores?.project ?? null : null)
        : null
      const user = state?.stores?.user ?? null
      const profile = state?.stores?.profile ?? null
      const limits = state?.limits ?? {}
      const totals = state?.totals ?? { projects: 0, withMemory: 0, entries: 0, dailyFiles: 0, overLimit: 0, stale: 0 }

      const panelWriteOn = Boolean(flags.allowWriteActions && state?.allowWriteActions !== false)
      const writable = Boolean(panelWriteOn && state?.writeEnabled !== false && !state?.readOnly && selected?.target !== 'profile' && selected?.target !== 'project-daily')
      const canSource = Boolean(panelWriteOn && state?.writeEnabled !== false && !state?.readOnly && selected && doc && selected.target !== 'profile' && selected.target !== 'project-daily' && !doc?.truncated)
      const canAppend = Boolean(panelWriteOn && state?.writeEnabled !== false && !state?.readOnly && selected?.target === 'project-daily')

      // A different revision on disk than the one on screen is the one thing a
      // person cannot see by looking: flag it instead of letting the next save
      // fail with a code they have to decode.
      React.useEffect(() => {
        if (!doc || !state || !selected) return
        const live =
          selected.target === 'project-memory'
            ? projectDetail?.revision ?? null
            : selected.target === 'user-memory'
              ? user?.revision ?? null
              : null
        setStale(Boolean(live && doc.revision && live !== doc.revision))
      }, [state, doc, selected, projectDetail, user])

      /**
       * Invalidate every in-flight management request.
       *
       * Called whenever the surface stops pointing at one file — a different
       * file, a different project, or no file at all. Waiting for `openFile` to
       * bump the counter is not enough: `selectProject` for a project with no
       * memory clears `selected` without opening anything, and a response that
       * lands after that would render a backup list for a file nobody is
       * looking at.
       */
      function dropManagement() {
        manageSeq.current += 1
        setHistory(null)
        setDraft(null)
      }

      async function openFile(target, date, key = effectiveKey) {
        if (!target) return
        const seq = contentSeq.current + 1
        contentSeq.current = seq
        if (key && key !== effectiveKey) setActiveKey(key)
        setSelected({ target, date, key: key ?? null })
        setDoc(null)
        setDocLoading(true)
        setEditing(null)
        setAdding(null)
        setNewSection(null)
        setSectionEdit(null)
        setSourceEdit(null)
        setQuery('')
        setRailOpen(false)
        dropManagement()
        try {
          const params = new URLSearchParams({ target })
          if (date) params.set('date', date)
          if (key) params.set('project', key)
          const body = await getJson(`${API}/content?${params.toString()}`)
          if (seq !== contentSeq.current) return
          setDoc(body)
          setError('')
        } catch (cause) {
          if (seq !== contentSeq.current) return
          const code = String(cause?.message ?? cause)
          setError(describeCode(code))
        } finally {
          if (seq === contentSeq.current) setDocLoading(false)
        }
      }

      async function reload() {
        await refresh()
        if (selected) await openFile(selected.target, selected.date, selected.key ?? effectiveKey)
      }

      function enableEditing() {
        setFlag('ui.allowWriteActions', true).then((ok) => {
          if (ok) {
            runtime.flags.allowWriteActions = true
            flash(t('editor.enabledEditing'))
            refresh()
          } else {
            setError(t('source.cannotEnableWrite'))
          }
        })
      }

      /**
       * Open source mode with the revision it started from.
       *
       * A whole-file edit is the one place a person can delete a section by
       * accident, so the editor records the revision it opened with and the
       * original text. Saving then shows the diff against that original and
       * submits that revision — not whatever the document says by then, which a
       * background refresh may have moved.
       */
      function openSource() {
        if (!canSource) return
        if (doc?.truncated) {
          setError(t('source.tooLargeToEdit'))
          return
        }
        // Source mode is always available; the confirmation is a risk notice
        // shown once per browser session, not a feature gate.
        if (!sourceAcknowledged()) {
          setConfirmSource(true)
          return
        }
        beginSource()
      }

      /** Start source mode from the document currently on screen. */
      function beginSource() {
        const text = doc?.text ?? ''
        setSourceEdit({
          text,
          original: text,
          baseRevision: doc?.revision ?? null,
          preview: null,
          message: '',
          operationId: newOperationId(),
        })
        setSectionEdit(null)
        setNewSection(null)
      }

      function openSourceAfterConfirm() {
        acknowledgeSource()
        setConfirmSource(false)
        beginSource()
      }

      /**
       * Open the draft panel.
       *
       * A draft is written with `replace-document`, which needs no separate
       * switch: `readOnly` and `write.enabled` are the only gates, and the panel
       * already knows whether either is in force before offering the entry.
       */
      function openDraftAfterConfirm() {
        setConfirmDraft(false)
        openDraft()
      }

      /**
       * One action against the store, with the panel's shared error handling.
       *
       * `payload.key` names the project the write belongs to; everything else is
       * forwarded verbatim, so an action that freezes a revision or an operation
       * id keeps it. A successful write records an undo entry bound to *that*
       * write — the file, the project, the backup it produced and the revision it
       * left behind — rather than to whatever document happens to be on screen
       * ten seconds later.
       *
       * `options.owned` says the caller renders its own failure inside a modal.
       * The banner is in the normal flow with no z-index while a modal mask is
       * `position:fixed; z-index:55`, so a refusal written there during a dialog
       * is a refusal nobody can read or dismiss. A modal caller therefore also
       * keeps `conflict` out of the global dialog: it owns its conflict too, which
       * is what stops two masks stacking at the same z-index.
       *
       * @param {object} payload
       * @param {{ owned?: boolean, conflictDialog?: boolean }} [options]
       */
      async function act(payload, options = {}) {
        const owned = options.owned === true
        // `conflictDialog` is for the one caller that is inline but still owns its
        // other refusals: source mode. Its editor sits in the page flow, so opening
        // the conflict dialog over it stacks nothing — and a conflict has three
        // exits (see the diff, reload, keep editing) that a banner cannot offer.
        // Without it, a source save that loses the race either drops the draft or
        // has to invent a conflict UI of its own.
        const conflictDialog = owned && options.conflictDialog === true
        setBusy(true)
        if (!owned) setError('')
        const key = payload.key ?? selected?.key ?? effectiveKey
        const body = { ...payload }
        delete body.key
        // One id per click. A caller that supplies its own (a retry, or a frozen
        // draft/archive request) keeps it, so a repeated request replays the
        // operation the store may already have committed instead of writing
        // twice.
        if (!body.operationId) body.operationId = newOperationId()
        const suffix = key ? `?project=${encodeURIComponent(key)}` : ''
        try {
          const response = await postJson(`${API}/action${suffix}`, body)
          const result = response.body
          if (result.ok) {
            if (result.backup) {
              setUndo({
                key: key ?? null,
                target: payload.target,
                name: String(result.backup).split(/[\\/]/).pop(),
                // The revision this write produced. The undo must name it: using
                // the document's current revision would either fail the CAS (if
                // the file moved on) or, worse, target a different file.
                revision: result.revision,
                until: Date.now() + 10000,
              })
            }
            return result
          }
          if (result.code === 'conflict') {
            if (owned && !conflictDialog) return result
            setConflict({ payload: body, body: result })
            return result
          }
          if (owned) return result
          const detail = result.issues?.length ? t('misc.issuesDetail', { lines: result.issues.map((row) => row.line).join(', ') }) : ''
          setError(`${describeCode(result.code, { stateDir: state?.stateDir })}${detail}`)
          return result
        } catch (cause) {
          if (!owned) setError(String(cause?.message ?? cause))
          return owned ? { ok: false, code: String(cause?.message ?? cause) } : null
        } finally {
          setBusy(false)
        }
      }

      async function saveEntry(section, line, value, original) {
        if (value.trim() === original.trim()) {
          setEditing(null)
          return
        }
        const result = await act({
          type: 'edit',
          target: selected.target,
          section,
          line,
          replacement: value,
          expectedRevision: doc?.revision,
        })
        if (result?.ok) {
          setEditing(null)
          flash(t('flash.saved'))
          await reload()
        }
      }

      async function removeEntry(section, line) {
        const result = await act({ type: 'remove', target: selected.target, section, line, expectedRevision: doc?.revision })
        if (result?.ok) {
          flash(t('flash.removed'))
          await reload()
        }
      }

      async function addEntry(section, value, keepOpen = false) {
        const result = await act({
          type: 'add',
          target: selected.target,
          date: selected.date,
          section,
          text: value,
          expectedRevision: doc?.revision,
        })
        if (result?.ok) {
          flash(t('flash.added'))
          if (!keepOpen) setAdding(null)
          await reload()
        }
      }

      async function saveSection(section, body) {
        const result = await act({
          type: 'replace-section',
          target: selected.target,
          section,
          body,
          expectedRevision: doc?.revision,
        })
        if (result?.ok) {
          setSectionEdit(null)
          flash(t('flash.sectionSaved'))
          await reload()
        }
      }

      /**
       * Save a source edit against the revision it opened with.
       *
       * The first click on save builds the diff against the original text and
       * stops there: a whole-file write is exactly the shape that needs a look
       * before it lands. The second click writes, and it writes with the frozen
       * base — a stale base is refused by the store instead of overwriting
       * whatever arrived in the meantime.
       */
      async function saveSource(text) {
        if (!sourceEdit) return
        if (!sourceEdit.preview) {
          const diff = lineDiff(sourceEdit.original ?? '', text)
          setSourceEdit({ ...sourceEdit, text, preview: diff, message: '' })
          return
        }
        const result = await act({
          type: 'replace-document',
          target: selected.target,
          text,
          expectedRevision: sourceEdit.baseRevision,
          operationId: sourceEdit.operationId,
        }, { owned: true, conflictDialog: true })
        if (result?.ok) {
          setSourceEdit(null)
          flash(t('flash.documentSaved'))
          await reload()
          return
        }
        if (!result) return
        if (result.code === 'conflict') {
          // The conflict dialog owns this one: it is the only surface that offers
          // all three exits (view the on-disk diff, reload and drop the draft,
          // keep editing). The editor is inline, not a mask, so opening it stacks
          // nothing. What is left here is the line the editor keeps for after the
          // dialog closes, and no armed save button — the base it would send is
          // the one that just lost the race.
          setSourceEdit((current) => (current ? { ...current, preview: null, message: t('code.conflict') } : current))
          return
        }
        const message = describeCode(result.code)
        setSourceEdit((current) => (current ? { ...current, preview: null, message } : current))
      }

      async function removeSection(section) {
        const result = await act({
          type: 'remove-section',
          target: selected.target,
          section,
          expectedRevision: doc?.revision,
        })
        // The confirmation closes whatever the write did. Leaving it open on a
        // refusal stacks two masks at the same z-index (the confirmation renders
        // last, so it covers the conflict dialog's three exits), and on a plain
        // refusal it covers the banner that says what went wrong. Either way the
        // failure belongs to a surface that can be read: the conflict dialog for a
        // lost race, the banner for everything else.
        setDialog(null)
        if (result?.ok) {
          flash(t('flash.sectionRemoved'))
          await reload()
        }
      }

      /**
       * Put the file back the way the last write found it.
       *
       * The undo entry carries its own project, target, backup name and the
       * revision that write produced. Reading any of those from the current
       * document would restore the wrong file the moment a person switches
       * files inside the ten-second window — and the store would happily accept
       * it, because that revision really does belong to that other file.
       */
      async function undoLast() {
        if (!undo) return
        const result = await act({
          type: 'restore',
          target: undo.target,
          name: undo.name,
          expectedRevision: undo.revision,
          key: undo.key,
        })
        if (result?.ok) {
          setUndo(null)
          flash(t('misc.undo'))
          await reload()
        }
      }

      function selectProject(row) {
        setActiveKey(row.key)
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(row.key)) next.delete(row.key)
          else next.add(row.key)
          return next
        })
        if (!details[row.key]) loadDetail(row.key)
        if (row.hasMemory) openFile('project-memory', undefined, row.key)
        else if (row.latestDaily) openFile('project-daily', row.latestDaily, row.key)
        else {
          setSelected(null)
          setDoc(null)
          setSourceEdit(null)
          dropManagement()
        }
      }

      async function loadDetail(key) {
        try {
          const body = await getJson(`${API}/state?project=${encodeURIComponent(key)}`)
          if (body.stores?.project) setDetails((current) => ({ ...current, [key]: body.stores.project }))
        } catch {
          // The tree row keeps its summary; a failed expansion is not fatal.
        }
      }

      function detailFor(key) {
        return details[key] ?? (key === effectiveKey ? state?.stores?.project ?? null : null)
      }

      // ── version history ────────────────────────────────────────────────────

      /** The frozen identity of the file a management surface is about. */
      function frozenTarget() {
        if (!selected) return null
        return {
          projectKey: selected.key ?? effectiveKey ?? null,
          target: selected.target,
          date: selected.date ?? undefined,
          name: null,
          // The revision the diff is computed against. Frozen with the request:
          // reading `doc.revision` when the restore button is clicked would let a
          // refresh in between move the base out from under the preview.
          currentRevision: doc?.revision ?? null,
        }
      }

      /** Open the backup list for the file on screen. */
      async function openHistory() {
        const frozen = frozenTarget()
        if (!frozen) return
        const seq = manageSeq.current + 1
        manageSeq.current = seq
        setHistory({ ...frozen, status: 'loading', revisions: [], picked: null, diff: null, message: '' })
        const params = new URLSearchParams({ target: frozen.target })
        if (frozen.projectKey) params.set('project', frozen.projectKey)
        try {
          const body = await getJson(`${API}/revisions?${params.toString()}`)
          if (seq !== manageSeq.current) return
          setHistory((current) =>
            current && current.target === frozen.target && current.projectKey === frozen.projectKey
              ? { ...current, status: 'ready', revisions: body.revisions ?? [], message: '' }
              : current,
          )
        } catch (cause) {
          if (seq !== manageSeq.current) return
          setHistory((current) => (current ? { ...current, status: 'error', message: describeCode(String(cause?.message ?? cause)) } : current))
        }
      }

      /** Read one backup and diff it against the file on disk. */
      async function previewRevision(name) {
        const frozen = history
        if (!frozen) return
        const seq = manageSeq.current + 1
        manageSeq.current = seq
        setHistory({ ...frozen, picked: name, status: 'loading-diff', diff: null, message: '' })
        const params = new URLSearchParams({ target: frozen.target, name })
        if (frozen.projectKey) params.set('project', frozen.projectKey)
        try {
          const body = await getJson(`${API}/revision?${params.toString()}`)
          if (seq !== manageSeq.current) return
          setHistory((current) => {
            if (!current || current.target !== frozen.target || current.projectKey !== frozen.projectKey) return current
            const currentText = body.current?.text ?? ''
            return {
              ...current,
              status: 'ready',
              picked: name,
              // The restore base is the revision the diff was built against, not
              // whatever the document reports later.
              baseRevision: body.current?.revision ?? null,
              diff: lineDiff(currentText, body.text ?? ''),
              message: body.current?.revision ? '' : t('history.noBase'),
            }
          })
        } catch (cause) {
          if (seq !== manageSeq.current) return
          setHistory((current) => (current ? { ...current, status: 'ready', diff: null, message: describeCode(String(cause?.message ?? cause)) } : current))
        }
      }

      /**
       * Restore the previewed backup, against the revision its diff used.
       *
       * The dialog owns its own failures: every refusal lands in the dialog's
       * `message`, and the preview is dropped so the restore button goes back to
       * disabled. The banner would be hidden behind the mask, and a button that
       * still looks ready after a refusal invites the same click again.
       */
      async function restoreRevision() {
        const frozen = history
        if (!frozen?.picked || !frozen.baseRevision) return
        const result = await act({
          type: 'restore',
          target: frozen.target,
          name: frozen.picked,
          expectedRevision: frozen.baseRevision,
          key: frozen.projectKey,
        }, { owned: true })
        if (result?.ok) {
          setHistory(null)
          flash(t('history.restored'))
          await reload()
          return
        }
        if (!result) return
        const message = result.code === 'conflict' ? t('history.stale') : describeCode(result.code)
        // A preview that just failed is not a preview that is ready to submit:
        // dropping it also disables the restore button, which is the honest
        // state — re-previewing is one click away.
        setHistory((current) => (current ? { ...current, status: 'ready', diff: null, baseRevision: null, message } : current))
      }

      // ── drafts ─────────────────────────────────────────────────────────────

      /**
       * Open the draft surface for the file on screen.
       *
       * A draft is a whole-file body the model produced plus the revision it read
       * it from. The panel cannot verify the body, but it can refuse to preview
       * one whose base is not the file it is looking at right now — which is the
       * difference between "the model read the current file" and "the model read
       * something three writes ago".
       */
      function openDraft() {
        const frozen = frozenTarget()
        if (!frozen) return
        manageSeq.current += 1
        setHistory(null)
        // The panel already knows whether this source can be drafted against: a
        // truncated read has no revision, so the base field would start empty and
        // every preview would fail. Saying so up front is cheaper than letting the
        // person paste a body first.
        const unusable = !frozen.currentRevision
        setDraft({
          ...frozen,
          body: '',
          base: frozen.currentRevision ?? '',
          preview: null,
          message: unusable ? t('draft.truncated') : '',
          status: 'editing',
          operationId: newOperationId(),
        })
      }

      /** Read the full original and diff the draft against it, or refuse. */
      async function previewDraft() {
        const frozen = draft
        if (!frozen) return
        const base = String(frozen.base ?? '').trim()
        if (!base) {
          // An empty base has two causes, and they need different advice: the
          // source cannot be read whole, or the person has not pasted one yet.
          const message = frozen.currentRevision ? t('draft.needBase') : t('draft.truncated')
          setDraft({ ...frozen, status: 'editing', preview: null, message })
          return
        }
        if (!String(frozen.body ?? '').trim()) return
        const seq = manageSeq.current + 1
        manageSeq.current = seq
        setDraft({ ...frozen, status: 'loading', preview: null, message: '' })
        const params = new URLSearchParams({ target: frozen.target })
        if (frozen.date) params.set('date', frozen.date)
        if (frozen.projectKey) params.set('project', frozen.projectKey)
        try {
          const body = await getJson(`${API}/content?${params.toString()}`)
          if (seq !== manageSeq.current) return
          setDraft((current) => {
            if (!current || current.target !== frozen.target || current.projectKey !== frozen.projectKey) return current
            // The two ways a draft can be unusable, both refused before a diff:
            // the source is not whole, or the base is not what is on disk.
            if (body.truncated || !body.revision) return { ...current, status: 'editing', preview: null, message: t('draft.truncated') }
            if (body.revision !== base) return { ...current, status: 'editing', preview: null, message: t('draft.staleBase', { disk: body.revision, base }) }
            const diff = lineDiff(body.text ?? '', String(current.body ?? ''))
            if (!diff.truncated && diff.added === 0 && diff.removed === 0) return { ...current, status: 'editing', preview: null, message: t('draft.noDiff') }
            return { ...current, status: 'previewed', baseRevision: base, preview: diff, message: '' }
          })
        } catch (cause) {
          if (seq !== manageSeq.current) return
          setDraft((current) => (current ? { ...current, status: 'editing', preview: null, message: describeCode(String(cause?.message ?? cause)) } : current))
        }
      }

      /**
       * Apply the previewed draft: frozen base, frozen body, one operation id.
       *
       * Same contract as `restoreRevision`: the dialog owns its refusal. The
       * failure is written into the dialog's own message, and the preview is
       * dropped so apply goes back to disabled — a refused apply that still
       * looked ready would read as "the click did nothing".
       */
      async function applyDraft() {
        const frozen = draft
        if (!frozen || frozen.status !== 'previewed') return
        const result = await act({
          type: 'replace-document',
          target: frozen.target,
          text: frozen.body,
          expectedRevision: frozen.baseRevision,
          // The same id for this draft, so a retry of the click replays instead
          // of writing the body twice.
          operationId: frozen.operationId,
          key: frozen.projectKey,
        }, { owned: true })
        if (result?.ok) {
          setDraft(null)
          flash(t('draft.applied'))
          await reload()
          return
        }
        if (!result) return
        const message = result.code === 'conflict' ? t('history.stale') : describeCode(result.code)
        setDraft((current) => (current ? { ...current, status: 'editing', preview: null, baseRevision: null, message } : current))
      }

      /**
       * Edit one field of the draft, discarding any preview built from the old
       * values.
       *
       * A preview is a statement about one body against one base. Keeping it
       * after either changes would let the apply button write something the
       * person never saw.
       */
      function editDraft(patch) {
        // A preview already in flight was built against the values being
        // replaced. Bumping the generation is what makes its response get
        // dropped: without it the late callback re-armed apply and set
        // `baseRevision` back to the base the request was sent with, while the
        // field on screen kept what the person had just typed — the panel then
        // displayed one baseline and submitted another.
        if ('body' in patch || 'base' in patch) manageSeq.current += 1
        setDraft((current) => {
          if (!current) return current
          const next = { ...current, ...patch, status: 'editing', preview: null, message: '' }
          // A fresh body or base means a fresh operation: replaying the previous
          // id would be refused as an operation_mismatch, which reads as a bug.
          if ('body' in patch || 'base' in patch) next.operationId = newOperationId()
          return next
        })
      }

      // ── rail ──────────────────────────────────────────────────────────────

      const filteredProjects = (state?.projects ?? []).filter((row) => {
        if (onlyMemory && !row.hasMemory) return false
        const q = railQuery.trim().toLowerCase()
        if (!q) return true
        return `${row.title ?? ''} ${row.name ?? ''} ${row.path ?? ''}`.toLowerCase().includes(q)
      })

      function fileRow(key, target, date, label, meta, active) {
        return h(
          'button',
          {
            key: `${key ?? 'global'}-${target}-${date ?? ''}`,
            type: 'button',
            className: `wbm-file${active ? ' active' : ''}`,
            onClick: () => openFile(target, date, key),
            title: label,
          },
          h('span', { className: 'wbm-name' }, label),
          meta ? h('span', { className: 'wbm-meta' }, meta) : null,
        )
      }

      function dailyRows(key, detail) {
        const rows = detail?.daily ?? []
        if (!rows.length) return null
        return rows.map((file) =>
          fileRow(
            key,
            'project-daily',
            file.date,
            file.date,
            `${humanBytes(file.bytes)}${file.ageDays > 30 ? ` · ${t('time.daysAgo', { n: file.ageDays })}` : ''}`,
            selected?.target === 'project-daily' && selected?.date === file.date && selected?.key === key,
          ),
        )
      }

      function projectTree() {
        if (!filteredProjects.length) {
          return h('div', { className: 'wbm-note' }, railQuery ? t('state.noMatchingProject') : t('state.noWorkspaces'))
        }
        return filteredProjects.map((row) => {
          const tone = projectState(row)
          const isOpen = expanded.has(row.key)
          const detail = detailFor(row.key)
          return h(
            'div',
            { key: row.key },
            h(
              'button',
              {
                type: 'button',
                className: `wbm-project${row.key === effectiveKey ? ' active' : ''}`,
                onClick: () => selectProject(row),
                title: `${row.title || row.name}\n${row.path}`,
              },
              h(ChevronIcon, { size: 11, open: isOpen }),
              h('span', { className: `wbm-dot ${tone.tone === 'empty' ? 'empty' : tone.tone}` }),
              h('span', { className: 'wbm-name' }, row.title || row.name),
              h('span', { className: 'wbm-meta' }, row.hasMemory ? t('count.entries', { n: row.entries ?? 0 }) : row.daily ? t('count.days', { n: row.daily }) : tone.label),
            ),
            isOpen
              ? h(
                  'div',
                  { className: 'wbm-tree-children' },
                  fileRow(
                    row.key,
                    'project-memory',
                    undefined,
                    t('target.projectMemory'),
                    row.hasMemory ? t('count.entries', { n: row.entries ?? 0 }) : t('file.notCreated'),
                    selected?.target === 'project-memory' && selected?.key === row.key,
                  ),
                  dailyRows(row.key, detail),
                )
              : null,
          )
        })
      }

      function projectFiles() {
        if (!project) {
          return h('div', { className: 'wbm-note' }, t('editor.pickProjectHint'))
        }
        const projectRatio = ratio(project.chars, limits.project)
        return h(
          'div',
          null,
          fileRow(
            project.key,
            'project-memory',
            undefined,
            t('target.projectMemory'),
            project.hasMemory ? t('count.entriesPercent', { n: project.entries ?? 0, percent: projectRatio.percent }) : t('file.notCreated'),
            selected?.target === 'project-memory',
          ),
          dailyRows(project.key, projectDetail),
        )
      }

      function globalRows() {
        const userRatio = ratio(user?.chars, limits.user)
        return h(
          'div',
          null,
          user?.memoryExists
            ? fileRow(null, 'user-memory', undefined, t('target.userMemory'), t('count.entriesPercent', { n: user.entries ?? 0, percent: userRatio.percent }), selected?.target === 'user-memory')
            : h('div', { className: 'wbm-note' }, t('state.noUserMemory')),
          profile?.exists
            ? fileRow(null, 'profile', undefined, t('target.profile'), profile.ambiguous ? t('state.multipleCandidates') : t('file.readOnly'), selected?.target === 'profile')
            : null,
        )
      }

      function rail() {
        if (mode === 'overview') {
          return h(
            'div',
            { className: `wbm-rail${railOpen ? ' open' : ''}` },
            h(
              'div',
              { className: 'wbm-rail-head' },
              h('input', {
                className: 'wbm-search',
                type: 'search',
                value: railQuery,
                placeholder: t('rail.searchProjects'),
                onChange: (event) => setRailQuery(event.target.value),
              }),
              h(
                'label',
                { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', fontSize: '11px', color: 'var(--wbm-text-3)' } },
                h('input', { type: 'checkbox', checked: onlyMemory, onChange: (event) => setOnlyMemory(event.target.checked) }),
                t('rail.onlyWithMemory'),
              ),
            ),
            h('div', { className: 'wbm-rail-group' }, t('count.allProjects', { n: state?.projectsTotal ?? state?.projects?.length ?? 0 })),
            state?.projectsTruncated
              ? h('div', { className: 'wbm-note' }, t('count.truncatedProjects', { n: state.projects?.length ?? 0 }))
              : null,
            projectTree(),
            h('div', { className: 'wbm-rail-group' }, t('rail.global')),
            globalRows(),
          )
        }
        return h(
          'div',
          { className: `wbm-rail${railOpen ? ' open' : ''}` },
          h('div', { className: 'wbm-rail-group' }, t('state.currentProject')),
          projectFiles(),
          h('div', { className: 'wbm-rail-group' }, t('rail.global')),
          globalRows(),
          !project && (state?.projects?.length ?? 0) > 0
            ? h(
                'div',
                null,
                h('div', { className: 'wbm-rail-group' }, t('state.pickProject')),
                state.projects.map((row) =>
                  h(
                    'button',
                    { key: row.key, type: 'button', className: 'wbm-project', onClick: () => selectProject(row) },
                    h('span', { className: `wbm-dot ${row.hasMemory ? 'ok' : 'empty'}` }),
                    h('span', { className: 'wbm-name' }, row.title || row.name),
                    h('span', { className: 'wbm-meta' }, row.hasMemory ? t('count.entries', { n: row.entries ?? 0 }) : t('rail.noMemory')),
                  ),
                ),
              )
            : null,
        )
      }

      // ── header ────────────────────────────────────────────────────────────

      function header() {
        const title = mode === 'overview' ? t('panel.memory') : t('panel.projectMemory')
        const scope = mode === 'overview' ? t('rail.allProjects') : project ? project.title || project.name : t('state.undetermined')
        const projectRatio = project ? ratio(project.chars, limits.project) : null
        return h(
          'div',
          { className: 'wbm-header' },
          h('span', { className: 'wbm-title' }, title),
          h('span', { className: 'wbm-crumb' }, '·'),
          h('span', { className: 'wbm-crumb' }, scope),
          h(
            'div',
            { className: 'wbm-chips' },
            mode === 'overview'
              ? [
                  h('span', { key: 'p', className: 'wbm-chip' }, t('count.chipProjects', { n: totals.projects })),
                  h('span', { key: 'm', className: 'wbm-chip ok' }, t('count.chipWithMemory', { n: totals.withMemory })),
                  h('span', { key: 'e', className: 'wbm-chip' }, t('count.chipEntries', { n: totals.entries })),
                  totals.overLimit > 0 ? h('span', { key: 'o', className: 'wbm-chip warn' }, t('count.chipOverLimit', { n: totals.overLimit })) : null,
                  totals.stale > 0 ? h('span', { key: 's', className: 'wbm-chip warn' }, t('count.chipPending', { n: totals.stale })) : null,
                ]
              : [
                  project ? h('span', { key: 'e', className: 'wbm-chip' }, t('count.memoryLine', { n: project.entries ?? 0, bytes: humanBytes(project.bytes) })) : null,
                  projectRatio
                    ? h(
                        'span',
                        { key: 'u', className: `wbm-chip ${projectRatio.level === 'over' ? 'bad' : projectRatio.level === 'warn' ? 'warn' : ''}` },
                        t('count.usedPercent', { percent: projectRatio.percent }),
                      )
                    : null,
                  project?.overLimit ? h('span', { key: 'o', className: 'wbm-chip bad' }, t('editor.overLimitChip')) : null,
                  project?.revision ? h('span', { key: 'r', className: 'wbm-chip' }, `rev ${project.revision}`) : null,
                ],
          ),
          h('span', { className: 'wbm-spacer' }),
          mode === 'overview' && activeKey
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'wbm-btn',
                  onClick: () => {
                    setActiveKey(null)
                    setSelected(null)
                    setDoc(null)
                    setEditing(null)
                    setAdding(null)
                    setNewSection(null)
                    setSectionEdit(null)
                    setSourceEdit(null)
                    setExpanded(new Set())
                    dropManagement()
                  },
                },
                t('rail.allProjects'),
              )
            : null,
          layout === 'wide' && !props?.tab && mode === 'project' && flags.globalPanel
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'wbm-btn',
                  onClick: () => {
                    try {
                      runtime.layout?.selectPanel?.(PANEL_OVERVIEW)
                    } catch {
                      // No layout service: the left rail still has both entries.
                    }
                  },
                },
                t('panel.globalOverview'),
              )
            : null,
          h('button', { type: 'button', className: 'wbm-icon', title: t('panel.refresh'), onClick: refresh }, h(RefreshIcon)),
        )
      }

      // ── dashboard ─────────────────────────────────────────────────────────

      function dashboard() {
        const rows = state?.projects ?? []
        const attention = []
        for (const row of rows) {
          if (row.status === 'over-limit') attention.push({ row, text: t('attention.overLimit') })
          else if (row.status === 'stale') attention.push({ row, text: t('attention.stale', { date: row.oldestDaily ?? t('target.projectDaily'), days: row.oldestDailyAgeDays }) })
          else if (row.status === 'missing') attention.push({ row, text: t('attention.missing') })
          else if (row.status === 'unreadable') attention.push({ row, text: t('attention.unreadable') })
        }
        const recent = rows.filter((row) => row.hasMemory).slice(0, 6)
        return h(
          'div',
          { className: 'wbm-content' },
          h(
            'div',
            { className: 'wbm-stats' },
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, t('stats.projects')), h('div', { className: 'v' }, totals.projects)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, t('stats.entries')), h('div', { className: 'v' }, totals.entries)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, t('stats.dailyFiles')), h('div', { className: 'v' }, totals.dailyFiles)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, t('stats.pendingArchive')), h('div', { className: 'v' }, totals.stale)),
          ),
          attention.length
            ? h(
                'div',
                null,
                h('div', { className: 'wbm-h2' }, t('dash.needsAttention')),
                h(
                  'div',
                  { className: 'wbm-list' },
                  attention.slice(0, 6).map((item) =>
                    h(
                      'div',
                      { className: 'wbm-list-row', key: item.row.key },
                      h('span', { className: 'wbm-dot warn' }),
                      h('span', { className: 'wbm-name' }, item.row.title || item.row.name),
                      h('span', { className: 'wbm-meta' }, item.text),
                      h('button', { type: 'button', className: 'wbm-btn', onClick: () => selectProject(item.row) }, t('common.view')),
                    ),
                  ),
                ),
              )
            : h('div', { className: 'wbm-note', style: { padding: '12px 0' } }, t('attention.none')),
          h('div', { className: 'wbm-h2' }, t('dash.recentActivity')),
          recent.length
            ? h(
                'div',
                { className: 'wbm-list' },
                recent.map((row) =>
                  h(
                    'div',
                    { className: 'wbm-list-row', key: row.key },
                    h('span', { className: `wbm-dot ${row.status === 'ok' ? 'ok' : 'empty'}` }),
                    h('span', { className: 'wbm-name' }, row.title || row.name),
                    h('span', { className: 'wbm-meta' }, `${t('count.entries', { n: row.entries ?? 0 })} · ${humanBytes(row.bytes)} · ${relativeTime(row.lastActiveAt)}`),
                    h('button', { type: 'button', className: 'wbm-btn', onClick: () => selectProject(row) }, t('common.open')),
                  ),
                ),
              )
            : h('div', { className: 'wbm-note', style: { padding: '12px 0' } }, t('attention.noActivity')),
          h(
            'div',
            { className: 'wbm-h2' },
            t('dash.globalMemory'),
          ),
          h(
            'div',
            { className: 'wbm-list' },
            h(
              'div',
              { className: 'wbm-list-row' },
              h('span', { className: 'wbm-name' }, t('target.userMemory')),
              h('span', { className: 'wbm-meta' }, user ? t('count.entriesPercent', { n: user.entries ?? 0, percent: ratio(user.chars, limits.user).percent }) : t('file.unreadable')),
              h('button', { type: 'button', className: 'wbm-btn', onClick: () => openFile('user-memory', undefined, null) }, t('common.open')),
            ),
            profile?.exists
              ? h(
                  'div',
                  { className: 'wbm-list-row' },
                  h('span', { className: 'wbm-name' }, t('target.profile')),
                  h('span', { className: 'wbm-meta' }, profile.ambiguous ? t('state.multipleCandidatesUnused') : `${humanBytes(profile.bytes)} · ${t('file.readOnly')}`),
                  h('button', { type: 'button', className: 'wbm-btn', onClick: () => openFile('profile', undefined, null) }, t('common.view')),
                )
              : null,
          ),
        )
      }

      // ── document view ─────────────────────────────────────────────────────

      function docTitle() {
        if (!selected) return ''
        if (selected.target === 'project-daily') return selected.date ?? t('target.projectDaily')
        return TARGET_LABEL[selected.target] ?? selected.target
      }

      function renderEntry(section, entry) {
        const key = `${section.heading}-${entry.line}`
        if (editing && editing.line === entry.line && editing.section === section.heading) {
          return h(
            'div',
            { className: 'wbm-inline', key },
            h('span', { className: 'wbm-entry-mark' }, '›'),
            h('input', {
              className: 'wbm-input',
              autoFocus: true,
              value: editing.value,
              spellCheck: false,
              onChange: (event) => setEditing({ ...editing, value: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') saveEntry(section.heading, entry.line, editing.value, entry.text)
                if (event.key === 'Escape') setEditing(null)
              },
            }),
            h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => saveEntry(section.heading, entry.line, editing.value, entry.text) }, t('common.save')),
            h('button', { type: 'button', className: 'wbm-btn', onClick: () => setEditing(null) }, t('common.cancel')),
          )
        }

        const parts = highlightParts(entry.text, query)
        return h(
          'div',
          { className: 'wbm-entry', key },
          h('span', { className: 'wbm-entry-mark' }, '•'),
          h(
            'span',
            {
              className: 'wbm-entry-text',
              title: writable ? t('doc.clickToEdit') : undefined,
              onClick: () => writable && setEditing({ section: section.heading, line: entry.line, value: entry.text }),
            },
            parts.hit
              ? [parts.before, h('mark', { key: 'hit', className: 'wbm-mark' }, parts.hit), parts.after]
              : entry.text,
          ),
          writable
            ? h(
                'span',
                { className: 'wbm-entry-actions' },
                h('button', { type: 'button', className: 'wbm-icon', title: t('editor.edit'), onClick: () => setEditing({ section: section.heading, line: entry.line, value: entry.text }) }, h(PencilIcon)),
                h('button', { type: 'button', className: 'wbm-icon', title: t('common.delete'), onClick: () => removeEntry(section.heading, entry.line) }, h(TrashIcon)),
              )
            : null,
        )
      }

      function renderSection(section) {
        const entries = filterEntries(section.entries, query)
        const isEditingSection = sectionEdit?.section === section.heading
        const stepEditVisible = writable && !doc?.truncated
        return h(
          'div',
          { className: 'wbm-section', key: `${section.heading}-${section.line}` },
          h(
            'div',
            { className: 'wbm-section-head' },
            h('span', { className: 'wbm-section-title' }, `## ${section.heading}`),
            h('span', { className: 'wbm-count' }, t('count.entries', { n: entries.length })),
            h('span', { className: 'wbm-spacer' }),
            stepEditVisible
              ? h(
                  'button',
                  { type: 'button', className: 'wbm-icon', title: t('doc.editSection'), onClick: () => setSectionEdit({ section: section.heading, body: sectionRaw(section) }) },
                  h(PencilIcon),
                )
              : null,
            writable
              ? h(
                  'button',
                  { type: 'button', className: 'wbm-icon', title: t('doc.removeSection'), onClick: () => setDialog({ kind: 'remove-section', section: section.heading }) },
                  h(TrashIcon),
                )
              : null,
            writable
              ? h(
                  'button',
                  { type: 'button', className: 'wbm-icon', title: t('editor.addToSection'), onClick: () => setAdding({ section: section.heading, value: '' }) },
                  h(PlusIcon),
                )
              : null,
          ),
          isEditingSection
            ? h(
                'div',
                { className: 'wbm-editor' },
                  h('textarea', {
                    className: 'wbm-textarea',
                    value: sectionEdit.body,
                    spellCheck: false,
                    onKeyDown: (event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') saveSection(section.heading, sectionEdit.body)
                      if (event.key === 'Escape') setSectionEdit(null)
                    },
                    onChange: (event) => setSectionEdit({ ...sectionEdit, body: event.target.value }),
                  }),
                h(
                  'div',
                  { className: 'wbm-editor-bar' },
                  h('span', { className: 'wbm-note', style: { padding: 0 } }, t('editor.bodyHint')),
                  h('span', { className: 'wbm-spacer' }),
                  h('button', { type: 'button', className: 'wbm-btn', onClick: () => setSectionEdit(null) }, t('common.cancel')),
                  h('button', { type: 'button', className: 'wbm-btn primary', disabled: busy, onClick: () => saveSection(section.heading, sectionEdit.body) }, t('editor.saveSection')),
                ),
              )
            : null,
          !isEditingSection && entries.length === 0
            ? h('div', { className: 'wbm-note' }, query ? t('editor.noMatchingEntry') : t('editor.emptySection'))
            : null,
          !isEditingSection ? entries.map((entry) => renderEntry(section, entry)) : null,
          !isEditingSection && adding && adding.section === section.heading
            ? h(
                'div',
                { className: 'wbm-inline' },
                h('span', { className: 'wbm-entry-mark' }, '›'),
                h('input', {
                  className: 'wbm-input',
                  autoFocus: true,
                  value: adding.value,
                  placeholder: t('editor.newEntryPlaceholder'),
                  onChange: (event) => setAdding({ ...adding, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !event.shiftKey && adding.value.trim()) {
                      addEntry(section.heading, adding.value, event.metaKey || event.ctrlKey)
                    }
                    if (event.key === 'Escape') setAdding(null)
                  },
                }),
                h('button', { type: 'button', className: 'wbm-btn primary', disabled: busy || !adding.value.trim(), onClick: () => addEntry(section.heading, adding.value) }, t('common.save')),
                h('button', { type: 'button', className: 'wbm-btn', onClick: () => setAdding(null) }, t('common.cancel')),
              )
            : null,
        )
      }

      /** Raw body of a section, from the lines the panel already rendered. */
      function sectionRaw(section) {
        const lines = String(doc?.text ?? '').split(/\r?\n/)
        return lines.slice(section.line + 1, section.endLine + 1).join('\n')
      }

      function renderSource() {
        const current = sourceEdit.text
        const validation = current.length > 262144 ? t('editor.fileTooLarge') : null
        const previewed = Boolean(sourceEdit.preview)
        return h(
          'div',
          { className: 'wbm-editor' },
          h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } }, t('dialog.sourceTitle')),
          h('textarea', {
            className: 'wbm-textarea',
            style: { minHeight: '320px' },
            value: current,
            spellCheck: false,
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') saveSource(current)
              if (event.key === 'Escape') setSourceEdit(null)
            },
            onChange: (event) =>
              setSourceEdit((entry) =>
                entry ? { ...entry, text: event.target.value, preview: null, message: '', operationId: newOperationId() } : entry,
              ),
          }),
          validation ? h('div', { className: 'wbm-banner warn' }, validation) : null,
          sourceEdit.message ? h('div', { className: 'wbm-banner warn' }, sourceEdit.message) : null,
          diffBlock(sourceEdit.preview, t('draft.diffTitle')),
          h(
            'div',
            { className: 'wbm-editor-bar' },
            h('span', { className: 'wbm-note', style: { padding: 0 } }, t('editor.saveHint')),
            h('span', { className: 'wbm-spacer' }),
            h('button', { type: 'button', className: 'wbm-btn', onClick: () => setSourceEdit(null) }, t('common.cancel')),
            h(
              'button',
              { type: 'button', className: 'wbm-btn primary', disabled: busy || Boolean(validation), onClick: () => saveSource(current) },
              previewed ? t('editor.saveDocument') : t('draft.preview'),
            ),
          ),
        )
      }

      function newSectionEditor() {
        if (!newSection) return null
        const daily = selected?.target === 'project-daily'
        return h(
          'div',
          { className: 'wbm-editor' },
          h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } }, daily ? t('editor.addDailyEntry') : t('doc.newSection')),
          daily
            ? null
            : h('input', {
                className: 'wbm-input',
                autoFocus: true,
                value: newSection.heading,
                placeholder: t('editor.sectionPlaceholder'),
                onChange: (event) => setNewSection({ ...newSection, heading: event.target.value }),
              }),
          daily ? null : h('div', { style: { height: '6px' } }),
          h('input', {
            className: 'wbm-input',
            autoFocus: daily,
            value: newSection.text,
            placeholder: daily ? t('doc.entryText') : t('editor.firstEntryPlaceholder'),
            onChange: (event) => setNewSection({ ...newSection, text: event.target.value }),
          }),
          h(
            'div',
            { className: 'wbm-editor-bar' },
            h('span', { className: 'wbm-spacer' }),
            h('button', { type: 'button', className: 'wbm-btn', onClick: () => setNewSection(null) }, t('common.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wbm-btn primary',
                disabled: busy || (daily ? !newSection.text.trim() : !newSection.heading.trim()),
                onClick: async () => {
                  const result = await act({
                    type: 'add',
                    target: selected.target,
                    date: selected.date,
                    section: daily ? '' : newSection.heading.trim(),
                    text: newSection.text.trim() || t('editor.pending'),
                    expectedRevision: doc?.revision,
                  })
                  if (result?.ok) {
                    setNewSection(null)
                    flash(daily ? t('flash.added') : t('editor.sectionCreated'))
                    await reload()
                  }
                },
              },
              daily ? t('editor.add') : t('editor.create'),
            ),
          ),
        )
      }

      function docView() {
        const sections = (doc?.sections ?? []).map((section) => ({ ...section, entries: filterEntries(section.entries, query) }))
        const target = selected?.target
        const isSource = Boolean(sourceEdit)
        return h(
          'div',
          { className: 'wbm-content' },
          stale
            ? h(
                'div',
                { className: 'wbm-banner warn' },
                h('span', null, t('editor.changedElsewhere')),
                h('button', { type: 'button', className: 'wbm-btn', onClick: reload }, t('common.reload')),
              )
            : null,
          !panelWriteOn && selected?.target !== 'profile'
            ? h(
                'div',
                { className: 'wbm-banner lock' },
                h(LockIcon),
                h('span', null, state?.readOnly ? t('editor.readOnlyOn') : state?.writeEnabled === false ? t('code.write_disabled') : t('editor.panelEditOff')),
                h('span', { className: 'wbm-spacer' }),
                !state?.readOnly && state?.writeEnabled !== false
                  ? h('button', { type: 'button', className: 'wbm-btn primary', onClick: enableEditing }, t('editor.enableEditing'))
                  : null,
              )
            : null,
          target === 'project-daily'
            ? h('div', { className: 'wbm-banner' }, t('editor.dailyAppendOnly'))
            : null,
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '10px 0' } },
            h('input', {
              ref: searchRef,
              className: 'wbm-search',
              type: 'search',
              value: query,
              placeholder: t('editor.searchPlaceholder'),
              onChange: (event) => setQuery(event.target.value),
            }),
            query ? h('span', { className: 'wbm-count' }, t('count.matches', { n: sections.reduce((sum, section) => sum + section.entries.length, 0) })) : null,
          ),
          isSource ? renderSource() : null,
          !isSource ? newSectionEditor() : null,
          selected?.target === 'project-daily' && !isSource && !newSection && canAppend
            ? h(
                'div',
                { className: 'wbm-inline' },
                h(
                  'button',
                  { type: 'button', className: 'wbm-btn primary', onClick: () => setNewSection({ heading: '', text: '' }) },
                  h(PlusIcon),
                  t('editor.addOne'),
                ),
              )
            : null,
          !isSource && doc?.entries === 0 && (doc?.sections ?? []).length === 0 && !newSection
            ? h(
                'div',
                { className: 'wbm-empty' },
                h(ProjectIcon, { size: 28 }),
                h('div', { className: 't' }, t('editor.emptyFile')),
                writable
                  ? h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => setNewSection({ heading: t('editor.sectionDefault'), text: '' }) }, t('doc.addFirst'))
                  : null,
              )
            : null,
          !isSource ? sections.map((section) => renderSection(section)) : null,
        )
      }

      // ── detail shell ──────────────────────────────────────────────────────

      function docHeader() {
        const target = selected?.target
        // History and drafts are whole-file surfaces: they need a full revision
        // to freeze as their base, and a daily note has none (it is appended to,
        // never rewritten). The profile is read-only. Both are gated by the same
        // write conditions — there is no separate full-text switch to consult.
        const canHistory = Boolean(panelWriteOn && state?.writeEnabled !== false && !state?.readOnly && selected && doc && target !== 'profile' && target !== 'project-daily')
        const canDraft = canHistory
        return h(
          'div',
          { className: 'wbm-doc-head' },
          h(
            'div',
            { className: 'wbm-doc-title' },
            h('span', null, docTitle()),
            target === 'profile' ? h('span', { className: 'wbm-chip' }, t('file.readOnly')) : null,
            target === 'project-daily' ? h('span', { className: 'wbm-chip' }, t('editor.append')) : null,
            doc ? h('span', { className: 'wbm-chip' }, t('count.entriesPercent', { n: doc.entries ?? 0, percent: humanBytes(doc.bytes) })) : null,
            doc?.revision ? h('span', { className: 'wbm-chip' }, `rev ${doc.revision}`) : null,
          ),
          doc?.path ? h('div', { className: 'wbm-doc-path' }, doc.path) : null,
          h(
            'div',
            { className: 'wbm-doc-actions' },
            selected && doc && writable && target !== 'profile' && target !== 'project-daily'
              ? h('button', { type: 'button', className: 'wbm-btn', onClick: () => setNewSection({ heading: '', text: '' }) }, h(PlusIcon), t('doc.newSection'))
              : null,
            canSource
              ? h('button', { type: 'button', className: 'wbm-btn', onClick: openSource }, h(SourceIcon), t('editor.source'))
              : null,
            canHistory
              ? h('button', { type: 'button', className: 'wbm-btn', title: t('doc.history'), onClick: openHistory }, h(HistoryIcon), t('doc.history'))
              : null,
            canHistory
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wbm-btn',
                    title: t('doc.draft'),
                    onClick: openDraft,
                  },
                  h(DraftIcon),
                  t('doc.draft'),
                )
              : null,
            selected && writable && target === 'project-memory'
              ? h('button', { type: 'button', className: 'wbm-btn', title: t('doc.archiveOld'), onClick: () => setDialog({ kind: 'prune' }) }, h(SparkIcon), t('doc.archiveOld'))
              : null,
            h('span', { className: 'wbm-spacer' }),
            h('button', { type: 'button', className: 'wbm-btn', onClick: reload, disabled: busy }, h(RefreshIcon), t('common.reload')),
          ),
        )
      }

      function projectSummary() {
        if (!project) {
          const rows = state?.projects ?? []
          return h(
            'div',
            { className: 'wbm-content' },
            h(
              'div',
              { className: 'wbm-empty' },
              h(ProjectIcon, { size: 30 }),
              h('div', { className: 't' }, t('editor.noCurrentProject')),
              h('div', { className: 'd' }, t('editor.pickProjectHint')),
              rows.length
                ? h(
                    'div',
                    { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' } },
                    rows.slice(0, 8).map((row) =>
                      h('button', { key: row.key, type: 'button', className: 'wbm-btn', onClick: () => selectProject(row) }, row.title || row.name),
                    ),
                  )
                : null,
            ),
          )
        }
        return h(
          'div',
          { className: 'wbm-content' },
          h(
            'div',
            { className: 'wbm-stats' },
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, t('stats.entries')), h('div', { className: 'v' }, project.entries)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, t('count.bytes')), h('div', { className: 'v' }, humanBytes(project.bytes))),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, t('stats.dailyFiles')), h('div', { className: 'v' }, project.daily)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, t('dash.recentActivity')), h('div', { className: 'v', style: { fontSize: '13px' } }, relativeTime(project.lastActiveAt))),
          ),
          h(
            'div',
            { className: 'wbm-banner' },
            h('span', null, project.path),
            h('span', { className: 'wbm-spacer' }),
            project.hasMemory
              ? h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => openFile('project-memory', undefined, project.key) }, t('editor.openMemory'))
              : h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => openFile('project-memory', undefined, project.key) }, t('editor.createMemory')),
            project.latestDaily
              ? h('button', { type: 'button', className: 'wbm-btn', onClick: () => openFile('project-daily', project.latestDaily, project.key) }, t('count.latestDaily', { date: project.latestDaily }))
              : null,
          ),
          project.overLimit
            ? h('div', { className: 'wbm-banner warn' }, t('editor.limitWarning', { chars: project.chars, limit: limits.project }))
            : null,
        )
      }

      function detail() {
        if (!selected) {
          return h('div', { className: 'wbm-doc-body' }, mode === 'project' || activeKey ? projectSummary() : dashboard())
        }
        return h(
          'div',
          { className: 'wbm-detail', style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
          docHeader(),
          h(
            'div',
            { className: 'wbm-doc-body' },
            docLoading
              ? h('div', null, h('div', { className: 'wbm-skeleton', style: { width: '60%' } }), h('div', { className: 'wbm-skeleton' }), h('div', { className: 'wbm-skeleton', style: { width: '80%' } }))
              : doc
                ? docView()
                : h(
                    'div',
                    { className: 'wbm-empty' },
                    h(ProjectIcon, { size: 28 }),
                    h('div', { className: 't' }, t('editor.fileMissing')),
                    h('div', { className: 'd' }, t('editor.fileMissingHint')),
                    writable || canAppend
                      ? h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => setNewSection({ heading: selected.target === 'project-daily' ? '' : t('editor.sectionDefault'), text: '' }) }, t('doc.addFirst'))
                      : null,
                    newSection ? newSectionEditor() : null,
                  ),
          ),
        )
      }

      function picker() {
        if (layout !== 'narrow' && !props?.tab) return null
        const options = [{ value: '', label: t('editor.pickFile') }]
        if (project) options.push({ value: 'project-memory', label: t('target.projectMemory') })
        for (const file of projectDetail?.daily ?? []) options.push({ value: `project-daily:${file.date}`, label: `${file.date}（${humanBytes(file.bytes)}）` })
        if (user?.memoryExists) options.push({ value: 'user-memory', label: t('target.userMemory') })
        if (profile?.exists) options.push({ value: 'profile', label: t('editor.profileReadOnly') })
        const value = selected ? selected.target === 'project-daily' ? `project-daily:${selected.date}` : selected.target : ''
        return h(
          'div',
          { className: 'wbm-picker' },
          h(
            'select',
            {
              value,
              onChange: (event) => {
                const next = event.target.value
                if (!next) return
                if (next === 'project-daily') return
                if (next.startsWith('project-daily:')) openFile('project-daily', next.slice('project-daily:'.length))
                else openFile(next)
              },
            },
            options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
        )
      }

      return h(
        'div',
        { className: `wbm-root ${layout === 'narrow' ? 'wbm-narrow' : ''}${props?.tab ? ' wbm-tab' : ''}` },
        header(),
        picker(),
        notice
          ? h(
              'div',
              { className: 'wbm-toast' },
              h('span', null, notice),
              undo
                ? h('button', { type: 'button', className: 'wbm-btn', onClick: undoLast, disabled: busy }, t('flash.undo'))
                : null,
            )
          : null,
        error
          ? h(
              'div',
              { className: 'wbm-banner warn', style: { margin: '8px 16px 0' } },
              h('span', null, error),
              h('span', { className: 'wbm-spacer' }),
              h('button', { type: 'button', className: 'wbm-icon', title: t('common.close'), onClick: () => setError('') }, h(CloseIcon)),
            )
          : null,
        h('div', { className: 'wbm-layout' }, rail(), detail()),
        conflict ? h(ConflictDialog, { conflict, doc, getJson, selected, projectKey: effectiveKey, onClose: () => setConflict(null), reload }) : null,
        confirmSource
          ? h(SourceConfirmDialog, {
              onClose: () => setConfirmSource(false),
              onConfirm: openSourceAfterConfirm,
            })
          : null,
        dialog?.kind === 'prune'
          ? h(PruneDialog, { projectKey: effectiveKey, act, onClose: () => setDialog(null), flash, reload })
          : null,
        history
          ? h(HistoryDialog, {
              state: history,
              onPick: previewRevision,
              onRestore: restoreRevision,
              onClose: () => {
                manageSeq.current += 1
                setHistory(null)
              },
              busy,
            })
          : null,
        draft
          ? h(DraftDialog, {
              state: draft,
              onEdit: editDraft,
              onPreview: previewDraft,
              onApply: applyDraft,
              onClose: () => {
                manageSeq.current += 1
                setDraft(null)
              },
              busy,
            })
          : null,
        dialog?.kind === 'remove-section'
          ? h(ConfirmDialog, {
              title: t('doc.removeSection'),
              message: t('misc.confirmDeleteSectionBody', { section: dialog.section }),
              confirmLabel: t('common.delete'),
              danger: true,
              onClose: () => setDialog(null),
              onConfirm: () => removeSection(dialog.section),
            })
          : null,
      )
    }

    function MemoryOverviewPanel(props) {
      return h(MemoryWorkspace, { ...props, mode: 'overview', layout: 'wide' })
    }

    /** Backwards-compatible names for hosts/tests written against the first panel. */
    function MemoryPanel(props) {
      return h(MemoryOverviewPanel, props)
    }

    const MemoryIcon = OverviewIcon
    const PANEL = PANEL_OVERVIEW

    function MemoryProjectTab(props) {
      return h(MemoryWorkspace, { ...props, mode: 'project', layout: 'wide', tab: true, sessionId: props?.sessionId })
    }

    function ProjectTabTitle(props) {
      const cwd = useCurrentCwd(props, props?.sessionId)
      const name = cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : t('panel.projectMemory')
      return h('span', { title: cwd ?? '' }, t('misc.panelTitleWithName', { name }))
    }

    // ── dialogs ─────────────────────────────────────────────────────────────

    function ConfirmDialog({ title, message, confirmLabel, danger, onClose, onConfirm }) {
      return h(
        'div',
        {
          className: 'wbm-mask',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'wbm-modal' },
          h('div', { className: 'h' }, title),
          h('div', { className: 'd' }, message),
          h(
            'div',
            { className: 'row', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, t('common.cancel')),
            h('button', { type: 'button', className: `wbm-btn ${danger ? 'danger' : 'primary'}`, onClick: onConfirm }, confirmLabel),
          ),
        ),
      )
    }

    /**
     * The risk notice shown the first time source mode is opened in a session.
     *
     * Source mode rewrites the whole file, bypassing the entry model, so the
     * person is told once — this is not a feature gate, and there is no setting
     * behind it. Cancelling leaves the document untouched.
     */
    function SourceConfirmDialog({ onClose, onConfirm }) {
      return h(
        'div',
        { className: 'wbm-mask' },
        h(
          'div',
          { className: 'wbm-modal' },
          h('div', { className: 'h' }, t('source.title')),
          h('div', { className: 'd' }, t('source.bodyAllowed')),
          h(
            'div',
            { className: 'row', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, t('common.cancel')),
            h('button', { type: 'button', className: 'wbm-btn primary', onClick: onConfirm }, t('source.confirmAllowed')),
          ),
        ),
      )
    }

    /**
     * A write was refused because the file moved.
     *
     * The three ways out are: reload (lose the draft, see the file as it is),
     * keep the draft and keep editing (the next save is refused again until it
     * is reloaded), and view the diff. There is deliberately no "overwrite
     * anyway": that button deleted `expectedRevision` and wrote regardless, which
     * is the one outcome the version fence exists to prevent — and it discards
     * whatever the other client had just written.
     */
    function ConflictDialog({ conflict, doc, getJson, selected, projectKey, onClose, reload }) {
      const [diff, setDiff] = React.useState(null)
      const diskRevision = conflict?.body?.revision

      async function showDiff() {
        try {
          const params = new URLSearchParams({ target: selected.target })
          if (selected.date) params.set('date', selected.date)
          if (projectKey) params.set('project', projectKey)
          const body = await getJson(`${API}/content?${params.toString()}`)
          setDiff(lineDiff(doc?.text ?? '', body.text ?? ''))
        } catch (cause) {
          setDiff({ error: String(cause?.message ?? cause) })
        }
      }

      return h(
        'div',
        { className: 'wbm-mask' },
        h(
          'div',
          { className: 'wbm-modal' },
          h('div', { className: 'h' }, t('dialog.conflictTitle')),
          h('div', { className: 'd' }, t('misc.conflictDetail', { mine: doc?.revision ?? '—', disk: diskRevision ?? '—' })),
          diff?.error ? h('div', { className: 'wbm-banner warn' }, diff.error) : null,
          diff && !diff.error
            ? h(
                'div',
                { className: 'wbm-diff' },
                diff.truncated
                  ? h('div', null, t('editor.tooLargeStatsOnly'))
                  : diff.rows.slice(0, 240).map((row, index) =>
                      h('div', { key: index, className: row.type }, `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} ${row.text}`),
                    ),
              )
            : null,
          h(
            'div',
            { className: 'row' },
            h('button', { type: 'button', className: 'wbm-btn', onClick: showDiff }, t('editor.viewDiskDiff')),
            h('span', { className: 'wbm-spacer', style: { flex: 1 } }),
            h(
              'button',
              {
                type: 'button',
                className: 'wbm-btn primary',
                onClick: async () => {
                  onClose()
                  await reload()
                },
              },
              t('editor.reloadDiscard'),
            ),
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, t('editor.keepDraft')),
          ),
        ),
      )
    }

    /**
     * Archive old daily files, in two steps: a preview, then an apply bound to it.
     *
     * The apply freezes `{projectKey, planId, dates, operationId}` on the first
     * click. That matters for the retry: the store resolves an archive by
     * operation id first, and only then consults the plan, so a retry with the
     * same id and the same full date set replays whatever already moved instead
     * of moving a second copy. Retrying with only the dates that failed would
     * leave the unresolved ones without the receipt that decides their fate, and
     * minting a new plan would re-enumerate a set nobody previewed.
     *
     * A stale plan (`plan_conflict` / expired / `unknown_plan`) is different: it
     * cannot be replayed at all, so the only honest answer is a fresh preview.
     */
    function PruneDialog({ projectKey, act, onClose, flash, reload }) {
      const [plan, setPlan] = React.useState(null)
      const [picked, setPicked] = React.useState(null)
      const [beforeDays, setBeforeDays] = React.useState(30)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      // The frozen apply request. Cleared by a new preview or a changed pick,
      // because either means the person is looking at a different set.
      const [frozen, setFrozen] = React.useState(null)
      const [outcome, setOutcome] = React.useState(null)

      const load = React.useCallback(
        async (days) => {
          setBusy(true)
          setError('')
          setFrozen(null)
          setOutcome(null)
          const body = await act({ type: 'prune', dryRun: true, beforeDays: days, key: projectKey })
          setBusy(false)
          if (body?.ok) {
            setPlan(body)
            setPicked(new Set((body.candidates ?? []).map((row) => row.date)))
          } else {
            setError(describeCode(body?.code ?? 'failed'))
          }
        },
        [act, projectKey],
      )

      React.useEffect(() => {
        load(beforeDays)
      }, [])

      const candidates = plan?.candidates ?? []
      const pickedRows = candidates.filter((row) => !picked || picked.has(row.date))

      /**
       * Run one archive request, and classify what came back.
       *
       * Only three outcomes leave the request reusable: success (with or without
       * `duplicate`), a partial move, and an unconfirmed one. Everything that
       * says the plan itself is stale drops it.
       */
      async function apply(request) {
        setBusy(true)
        setError('')
        setOutcome(null)
        const body = await act(request)
        setBusy(false)
        if (body?.ok) {
          setOutcome({ kind: 'done', pruned: body.pruned ?? [] })
          flash(t('prune.archived', { n: body.pruned?.length ?? 0 }))
          onClose()
          await reload()
          return
        }
        const code = String(body?.code ?? 'failed')
        const stale = code === 'plan_conflict' || code === 'plan_required' || code === 'operation_mismatch'
        if (stale) {
          // The plan cannot be replayed at all, so keeping the frozen request
          // would only offer a button that must fail again.
          setFrozen(null)
          setPlan(null)
          setPicked(null)
          setError(t(code === 'plan_required' ? 'prune.planGone' : 'prune.stalePlan'))
          return
        }
        if (code === 'partial' || code === 'outcome_unknown') {
          setOutcome({ kind: 'unresolved', done: (body.pruned ?? []).length, left: (body.failed ?? []).length })
          await reload()
          return
        }
        setError(describeCode(code))
      }

      /** The apply button: freeze the request on the first click, then retry it. */
      async function submit() {
        if (frozen) {
          await apply(frozen)
          return
        }
        const request = {
          type: 'prune',
          dryRun: false,
          planId: plan?.planId,
          beforeDays,
          dates: pickedRows.map((row) => row.date),
          operationId: newOperationId(),
          key: projectKey,
        }
        setFrozen(request)
        await apply(request)
      }

      const pick = (next) => {
        setPicked(next)
        // A different selection is a different request: the frozen one names the
        // set it was built from.
        setFrozen(null)
        setOutcome(null)
      }

      const retryable = Boolean(frozen)

      return h(
        'div',
        { className: 'wbm-mask' },
        h(
          'div',
          { className: 'wbm-modal' },
          h('div', { className: 'h' }, t('dialog.pruneTitle')),
          h('div', { className: 'd' }, t('prune.description')),
          h(
            'div',
            { className: 'row' },
            h('span', { className: 'wbm-meta' }, t('prune.before')),
            h('input', {
              className: 'wbm-input',
              style: { width: '80px' },
              type: 'number',
              min: 1,
              value: beforeDays,
              onChange: (event) => setBeforeDays(Number(event.target.value) || 1),
            }),
            h('span', { className: 'wbm-meta' }, t('rail.dayUnit')),
            h('button', { type: 'button', className: 'wbm-btn', onClick: () => load(beforeDays), disabled: busy }, t('prune.replan')),
          ),
          error ? h('div', { className: 'wbm-banner warn' }, error) : null,
          outcome?.kind === 'unresolved'
            ? h('div', { className: 'wbm-banner warn' }, t('prune.partial', { done: outcome.done, left: outcome.left }))
            : null,
          !plan
            ? h('div', { className: 'wbm-note' }, busy ? t('prune.scanning') : t('prune.noResults'))
            : candidates.length === 0
              ? h('div', { className: 'wbm-note' }, t('prune.noneOlder', { days: beforeDays }))
              : h(
                  'div',
                  { className: 'wbm-list' },
                  candidates.map((row) =>
                    h(
                      'label',
                      { key: row.date, className: 'wbm-list-row', style: { alignItems: 'flex-start' } },
                      h('input', {
                        type: 'checkbox',
                        checked: !picked || picked.has(row.date),
                        onChange: (event) => {
                          const next = new Set(picked ?? [])
                          if (event.target.checked) next.add(row.date)
                          else next.delete(row.date)
                          pick(next)
                        },
                      }),
                      h(
                        'span',
                        { style: { minWidth: 0, flex: 1 } },
                        h('span', { style: { fontWeight: 600, display: 'block' } }, t('prune.row', { date: row.date, n: row.entries ?? 0, bytes: humanBytes(row.bytes) })),
                      ),
                    ),
                  ),
                ),
          h(
            'div',
            { className: 'row', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, t('common.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wbm-btn primary',
                disabled: busy || (!retryable && (pickedRows.length === 0 || !plan)),
                onClick: submit,
              },
              busy ? t('prune.running') : retryable ? t('prune.retry') : t('prune.action', { n: pickedRows.length }),
            ),
          ),
        ),
      )
    }

    /**
     * Browse the backups of the file on screen and restore one.
     *
     * The state it renders is frozen by the caller: `{projectKey, target, name,
     * currentRevision}`. Nothing here reads the live document, so a list that
     * arrives after the person switched files cannot be previewed or restored
     * against the new one — the caller drops it instead of rendering it.
     */
    function HistoryDialog({ state, onPick, onRestore, onClose, busy }) {
      const frozen = state ?? {}
      const revisions = frozen.revisions ?? []
      const diff = frozen.diff
      const ready = frozen.status === 'ready'
      return h(
        'div',
        { className: 'wbm-mask' },
        h(
          'div',
          { className: 'wbm-modal' },
          h('div', { className: 'h' }, t('history.title')),
          h('div', { className: 'd' }, t('history.subtitle', { target: TARGET_LABEL[frozen.target] ?? frozen.target ?? '' })),
          frozen.status === 'loading' && !revisions.length ? h('div', { className: 'wbm-note' }, t('history.loading')) : null,
          frozen.message ? h('div', { className: 'wbm-banner warn' }, frozen.message) : null,
          ready && revisions.length === 0 ? h('div', { className: 'wbm-note' }, t('history.empty')) : null,
          revisions.length
            ? h(
                'div',
                { className: 'wbm-list' },
                revisions.map((row) =>
                  h(
                    'button',
                    {
                      key: row.name,
                      type: 'button',
                      className: `wbm-list-row${frozen.picked === row.name ? ' wbm-row-active' : ''}`,
                      style: { textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 'none', font: 'inherit' },
                      onClick: () => onPick(row.name),
                    },
                    h('span', { className: 'wbm-name' }, row.name),
                    h('span', { className: 'wbm-meta' }, `${relativeTime(row.mtime)} · ${humanBytes(row.bytes)}`),
                  ),
                ),
              )
            : null,
          diff ? diffBlock(diff, t('history.diffTitle')) : null,
          diff && !diff.truncated
            ? h('div', { className: 'wbm-note', style: { padding: 0 } }, t('history.stats', { added: diff.added, removed: diff.removed }))
            : null,
          frozen.baseRevision && frozen.picked
            ? h('div', { className: 'wbm-note', style: { padding: 0 } }, t('history.base', { revision: frozen.baseRevision }))
            : null,
          h(
            'div',
            { className: 'row', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, t('common.close')),
            h(
              'button',
              {
                type: 'button',
                className: 'wbm-btn primary',
                disabled: busy || !diff || !frozen.baseRevision,
                onClick: onRestore,
              },
              t('history.restore'),
            ),
          ),
        ),
      )
    }

    /**
     * Paste a draft body plus the revision it was written against.
     *
     * The panel owns the two checks the model cannot make for itself: the file
     * must be readable whole, and its revision must be exactly the base the draft
     * names. A diff is only built after both pass, and the apply submits that
     * same base — so a draft is never written on top of a file the person has not
     * seen.
     */
    function DraftDialog({ state, onEdit, onPreview, onApply, onClose, busy }) {
      const frozen = state ?? {}
      const previewed = frozen.status === 'previewed'
      const canPreview = String(frozen.body ?? '').trim().length > 0 && String(frozen.base ?? '').trim().length > 0
      return h(
        'div',
        { className: 'wbm-mask' },
        h(
          'div',
          { className: 'wbm-modal' },
          h('div', { className: 'h' }, t('draft.title')),
          h('div', { className: 'd' }, t('draft.subtitle')),
          h('div', { style: { fontSize: '12px', fontWeight: 600 } }, t('draft.body')),
          h('textarea', {
            className: 'wbm-textarea',
            style: { minHeight: '220px' },
            value: frozen.body ?? '',
            spellCheck: false,
            placeholder: t('draft.bodyPlaceholder'),
            onChange: (event) => onEdit({ body: event.target.value }),
          }),
          h('div', { style: { fontSize: '12px', fontWeight: 600 } }, t('draft.base')),
          h('input', {
            className: 'wbm-input',
            value: frozen.base ?? '',
            spellCheck: false,
            onChange: (event) => onEdit({ base: event.target.value }),
          }),
          h('div', { className: 'wbm-note', style: { padding: 0 } }, t('draft.baseHint')),
          frozen.message ? h('div', { className: 'wbm-banner warn' }, frozen.message) : null,
          frozen.preview ? diffBlock(frozen.preview, t('draft.diffTitle')) : null,
          frozen.preview && !frozen.preview.truncated
            ? h('div', { className: 'wbm-note', style: { padding: 0 } }, t('draft.stats', { added: frozen.preview.added, removed: frozen.preview.removed }))
            : null,
          h(
            'div',
            { className: 'row', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, t('common.cancel')),
            h('button', { type: 'button', className: 'wbm-btn', disabled: busy || !canPreview, onClick: onPreview }, t('draft.preview')),
            h('button', { type: 'button', className: 'wbm-btn primary', disabled: busy || !previewed, onClick: onApply }, t('draft.apply')),
          ),
        ),
      )
    }

    // ── secondary surfaces ──────────────────────────────────────────────────

    function HeaderMemoryButton() {
      return h(
        'button',
        {
          type: 'button',
          className: 'wbm-icon',
          title: t('panel.projectMemory'),
          'aria-label': t('panel.projectMemory'),
          onClick: () => {
            try {
              runtime.sidebarRight?.openTab?.(TAB_KIND)
            } catch {
              // A host that has the utilities seat but not the tab kind is left quiet.
            }
          },
        },
        h(ProjectIcon, { size: 16 }),
      )
    }

    // ── registration ────────────────────────────────────────────────────────

    function registerSurfaces(ctx, flags) {
      if (flags.globalPanel) {
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_OVERVIEW, order: 26, locale: NS, label: () => t('panel.memory') },
              OverviewIcon,
            ),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_OVERVIEW, locale: NS }, MemoryOverviewPanel),
          ),
        )
      }

      if (flags.projectTab || flags.sessionAction) {
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scoped) => {
          runtime.sidebarRight = scoped.sidebarRight
          runtime.sidebarRightTabs = scoped.sidebarRightTabs

          if (flags.projectTab) {
            scoped.effect(() =>
              scoped.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                priority: 'extension',
                title: () => t('panel.projectMemory'),
                guide: [
                  {
                    id: 'memory',
                    order: 40,
                    title: () => t('panel.projectMemory'),
                    description: () => t('misc.projectTabDesc'),
                  },
                ],
              }),
            )
            scoped.effect(() =>
              scoped.slots.inject('sidebar.right.pane.tab', () =>
                scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, MemoryProjectTab),
              ),
            )
            scoped.effect(() =>
              scoped.slots.inject('sidebar.right.pane.tab.title', () =>
                scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, ProjectTabTitle),
              ),
            )
          }

          if (flags.sessionAction && flags.projectTab) {
            scoped.effect(() =>
              scoped.slots.inject('conversation.session.header.utilities', () =>
                scoped.slots.register(
                  { name: 'conversation.session.header.utilities', id: TAB_ID, order: 40, locale: NS },
                  HeaderMemoryButton,
                ),
              ),
            )
          }
        })
      }
    }

    function apply(ctx) {
      runtime.ctx = ctx
      ensureStyles()
      ctx.effect(() => () => removeStyles())

      // Register both dictionaries with the host, then bind. Registration is
      // what makes the panel follow the app language; binding without it would
      // resolve every key to itself and fall back to English.
      try {
        if (typeof ctx.locale?.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'workbuddy-memory: dictionaries')
        }
      } catch {
        // An older host without the locale service still gets a working panel
        // through the module's own dictionaries.
      }
      runtime.t = bindCopy(ctx)

      ctx.inject(['layout'], (scoped) => {
        runtime.layout = scoped.layout
      })

      let started = false
      let disposed = false
      ctx.effect(() => () => {
        disposed = true
      })
      const start = (flags) => {
        if (started || disposed) return
        started = true
        runtime.flags = flags
        registerSurfaces(ctx, flags)
      }

      // The configuration decides which entries exist. `configForms` may be
      // absent on an older host, and the snapshot may still be loading on a
      // fresh page; the defaults register every entry, and a slower ready
      // snapshot replaces the decision before the fallback timer fires.
      ctx.inject(['configForms'], (scoped) => {
        try {
          const form = scoped.configForms.get(ENTRY)
          runtime.form = form
          form.subscribe(() => {
            readFlags()
          })
          const snap = form.getSnapshot()
          if (snap.status === 'ready' && snap.value) {
            start(flagsFrom(snap.value))
          } else if (snap.status === 'unavailable') {
            start({ ...DEFAULT_FLAGS })
          } else {
            const off = form.subscribe(() => {
              const next = form.getSnapshot()
              if (next.status === 'ready') {
                off()
                start(flagsFrom(next.value ?? {}))
              } else if (next.status === 'unavailable') {
                off()
                start({ ...DEFAULT_FLAGS })
              }
            })
          }
        } catch {
          start({ ...DEFAULT_FLAGS })
        }
      })
      setTimeout(() => start({ ...DEFAULT_FLAGS }), 1800)

      // configForms is not guaranteed on every host version; registering the
      // card inside a child scope keeps the plugin alive when it is missing.
      ctx.inject(['configForms'], (scoped) => {
        const forms = scoped.configForms
        if (!forms || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
        if (typeof scoped.slots?.register !== 'function') return

        scoped.effect(() =>
          forms.whileServed([ENTRY], () => {
            const form = forms.get(ENTRY)
            return scoped.slots.inject('plugins.bundle.config', () =>
              scoped.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: NS,
                  locale: NS,
                  inject: () => ({ form }),
                },
                SettingsCard,
              ),
            )
          }),
        )
      })
    }

    // `__internals` exists for the unit tests: the host only reads `apply` and
    // `inject`. Keeping the pure pieces reachable is cheaper than a build step
    // that would have to split this file.
    return {
      apply,
      // `locale` is the service name, not a package name: the client runtime
      // injects services by name, and a missing name leaves `ctx.locale`
      // undefined — which is why the panel silently kept its own copy instead of
      // following the app language.
      inject: ['slots', 'locale'],
      __internals: {
        // Exposed so a test can point the module at a locale service without
        // mounting the whole client composition.
        runtime,
        ZH,
        EN,
        humanBytes,
        ratio,
        filterEntries,
        highlightParts,
        lineDiff,
        describeCode,
        bindCopy,
        shortPath,
        samePath,
        relativeTime,
        getJson,
        postJson,
        ensureStyles,
        MemoryWorkspace,
        MemoryOverviewPanel,
        MemoryPanel,
        MemoryIcon,
        PANEL,
        MemoryProjectTab,
        SettingsCard,
        writeConfigField,
        PruneDialog,
        HistoryDialog,
        DraftDialog,
        ConfirmDialog,
        SourceConfirmDialog,
        OverviewIcon,
        ProjectIcon,
        PANEL_OVERVIEW,
        TAB_ID,
        TAB_KIND,
        API,
        NS,
        ENTRY,
      },
    }
  },
})
