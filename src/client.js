/*
 * Browser half of dsh-workbuddy-memory.
 *
 * Two surfaces, one rule: nothing here writes a file directly. The panel turns
 * a click into one `POST /action`, and the host runs it through the same store
 * the tools use — same lock, same revision check, same backup, same ledger.
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

    /** Subscribe to a settings form and re-render on each new snapshot. */
    function useSnapshot(form) {
      const [snap, setSnap] = React.useState(() => form.getSnapshot())
      React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])
      return snap
    }

    /** Keep a text draft local, commit on blur, and never fight a live write. */
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
     * The config card.
     *
     * Every value it shows is the schema-resolved one — what the plugin will
     * actually use — so an empty path field never looks "unset" when the
     * environment already provides it.
     */
    function SettingsCard({ form }) {
      const snap = useSnapshot(form)
      const [error, setError] = React.useState('')
      const value = snap.value ?? {}
      const inject = value.inject ?? {}
      const write = value.write ?? {}
      const search = value.search ?? {}
      const uiGuard = value.guard ?? {}
      const ui = value.ui ?? {}
      // 0.2.2 dropped `mode` from the snapshot: `writable` is now the only
      // signal, and requiring `mode === 'host'` left every control disabled on
      // hosts that no longer send it.
      const writable = Boolean(snap.writable)

      const commit = React.useCallback(
        async (field, next) => {
          setError('')
          try {
            const ok = await form.set(field, next)
            if (!ok) setError('宿主拒绝了这次修改（值不合法或已被更高层覆盖）')
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          }
        },
        [form],
      )

      if (snap.status === 'loading') return h('div', { style: S.status }, '读取配置…')
      if (snap.status === 'unavailable') {
        return h('div', { style: S.status }, '当前连接无法写入宿主配置。请直接编辑 profile 的 cordis.patch.yml 后重载插件。')
      }

      return h(
        'div',
        { style: S.wrap },
        h(
          'fieldset',
          { style: S.fieldset },
          h('legend', { style: S.legend }, '通用'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h(Switch, {
              label: '只读模式',
              hint: '打开后所有写入被拒绝：工具返回 read_only，面板隐藏写操作，裸写守卫放行。',
              checked: value.readOnly,
              disabled: !writable,
              onChange: (next) => commit('readOnly', next),
            }),
            h(TextField, {
              label: 'WorkBuddy home',
              hint: '留空跟随环境变量（WORKBUDDY_CONFIG_DIR → CODEBUDDY_CONFIG_DIR → ~/.workbuddy）。',
              value: value.workbuddyHome ?? '',
              placeholder: '留空 = 跟随环境变量',
              disabled: !writable,
              onCommit: (next) => commit('workbuddyHome', next),
            }),
            h(TextField, {
              label: '项目记忆目录名',
              hint: '留空跟随 WORKBUDDY_DATA_FOLDER_NAME，再退到 .workbuddy。',
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
          h('legend', { style: S.legend }, '注入与写入'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h(Switch, {
              label: '注入记忆',
              hint: '把项目记忆、规则、用户记忆与画像写进 system prompt。',
              checked: inject.enabled,
              disabled: !writable,
              onChange: (next) => commit('inject.enabled', next),
            }),
            h(Switch, {
              label: '允许写入',
              hint: '关闭后 memory_append / memory_edit 一律拒绝；只读模式是更高一级的总闸。',
              checked: write.enabled,
              disabled: !writable,
              onChange: (next) => commit('write.enabled', next),
            }),
            h(Switch, {
              label: '拦截裸写',
              hint: '阻止 write / edit 直接改记忆文件，强制走 memory_* 工具。',
              checked: uiGuard.enabled,
              disabled: !writable,
              onChange: (next) => commit('guard.enabled', next),
            }),
            h(Switch, {
              label: '启用检索',
              hint: 'memory_search 是否可用。',
              checked: search.enabled,
              disabled: !writable,
              onChange: (next) => commit('search.enabled', next),
            }),
          ),
        ),
        h(
          'fieldset',
          { style: S.fieldset },
          h('legend', { style: S.legend }, '记忆面板'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h(Switch, {
              label: '面板写操作',
              hint: '打开后侧栏「记忆」面板才能改条目、整理与回滚。默认关闭——一个能改文件的未认证 POST 端点不该默认存在。',
              checked: ui.allowWriteActions,
              disabled: !writable,
              onChange: (next) => commit('ui.allowWriteActions', next),
            }),
            h(Switch, {
              label: '全文编辑',
              hint: '在面板里整文件编辑（源码模式）。会比逐条编辑更容易一次改坏结构，默认关闭。',
              checked: ui.allowFullTextEdit,
              disabled: !writable || !ui.allowWriteActions,
              onChange: (next) => commit('ui.allowFullTextEdit', next),
            }),
          ),
        ),
        error ? h('div', { style: S.error }, error) : null,
        h(
          'div',
          { style: S.status },
          `revision ${snap.revision ?? '—'} · ${snap.writable ? '可写' : '只读'} · ${snap.user ? '有本机覆盖' : '跟随默认'}`,
        ),
      )
    }

    /** Sidebar icon: a small stack of cards, the shape of a memory store. */
    function MemoryIcon() {
      return h(
        'svg',
        { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
        h('path', { d: 'M5 4.5h11a3 3 0 0 1 3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z', strokeLinejoin: 'round' }),
        h('path', { d: 'M9 8.5h6M9 12h6M9 15.5h4', strokeLinecap: 'round' }),
      )
    }

    const PANEL = 'workbuddy-memory-panel'
    const API = '/workbuddy-memory'

    // ── pure helpers (exported through __internals for the unit tests) ───────

    function humanBytes(n) {
      if (!Number.isFinite(n)) return '—'
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    /** Share of a limit, clamped to 0..1 for the bar and reported raw. */
    function ratio(bytes, limit) {
      const b = Number(bytes) || 0
      const l = Number(limit) || 0
      if (l <= 0) return { value: 0, percent: 0, level: 'none' }
      const raw = b / l
      return { value: Math.min(raw, 1), percent: Math.round(raw * 100), level: raw >= 1 ? 'over' : raw >= 0.8 ? 'warn' : 'ok' }
    }

    /** Case-insensitive filter over entry text. */
    function filterEntries(entries, query) {
      const q = String(query ?? '').trim().toLowerCase()
      if (!q) return entries
      return entries.filter((entry) => entry.text.toLowerCase().includes(q))
    }

    /** Three-part split of `text` around the first `query` hit. */
    function highlightParts(text, query) {
      const q = String(query ?? '').trim()
      if (!q) return { before: text, hit: '', after: '' }
      const at = text.toLowerCase().indexOf(q.toLowerCase())
      if (at < 0) return { before: text, hit: '', after: '' }
      return { before: text.slice(0, at), hit: text.slice(at, at + q.length), after: text.slice(at + q.length) }
    }

    /**
     * Line diff for the restore preview.
     *
     * Bounded on purpose: a memory file is small, but a backup could be any
     * size, and an O(n·m) table must not be the thing that freezes the panel.
     */
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

    async function getJson(url) {
      const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
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

    /** Short, human label for a refusal code. */
    const MESSAGES = {
      write_actions_disabled: '面板写操作未开启：到插件页把「面板写操作」打开。',
      read_only: '只读模式已开启，写入被拒绝。',
      write_disabled: '写入开关是关的。',
      conflict: '文件在你编辑期间被改过。',
      stale_line: '这一行已经不在原处了，重新加载后再改。',
      not_an_entry: '这一行不是条目，不能按条目改。',
      no_section: '小节找不到了。',
      empty_text: '内容不能为空。',
      ambiguous: '同一个关键词匹配到多条，换一句更精确的。',
      lock_timeout: '文件正被另一个写入占用，稍后再试。',
      revision_required: '缺少 revision，无法安全写入。',
      nothing_to_consolidate: '没有可整理的日期文件。',
      read_only_target: '画像是蒸馏产物，这里只能看不能改。',
      body_too_large: '请求太大。',
      json_required: '请求格式不对。',
      unknown_action: '不支持的动作。',
    }

    function describeCode(code) {
      return MESSAGES[code] ?? code
    }

    /** Last two segments of a long path; short paths are left readable. */
    function shortPath(path) {
      if (!path) return '—'
      const parts = String(path).split(/[\\/]/).filter(Boolean)
      if (parts.length <= 3) return path
      return `…/${parts.slice(-2).join('/')}`
    }

    // ── panel styles ────────────────────────────────────────────────────────

    const P = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: '12.5px' },
      bar: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px',
        alignItems: 'center',
        padding: '8px 12px',
        borderBottom: '1px solid rgba(127,127,127,0.18)',
        fontSize: '11.5px',
        opacity: 0.85,
      },
      meterWrap: { display: 'flex', alignItems: 'center', gap: '6px' },
      meter: { width: '54px', height: '4px', borderRadius: '2px', background: 'rgba(127,127,127,0.22)', overflow: 'hidden' },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      tree: {
        width: '236px',
        flexShrink: 0,
        overflowY: 'auto',
        borderRight: '1px solid rgba(127,127,127,0.18)',
        padding: '8px 6px',
      },
      detail: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
      detailHead: { padding: '10px 14px 6px', borderBottom: '1px solid rgba(127,127,127,0.14)' },
      detailBody: { flex: 1, overflowY: 'auto', padding: '8px 14px 18px' },
      group: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.5, padding: '8px 8px 4px' },
      item: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        padding: '5px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      itemActive: { background: 'rgba(127,127,127,0.16)' },
      section: { marginTop: '14px' },
      sectionHead: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', fontWeight: 600, marginBottom: '4px' },
      count: { fontSize: '11px', opacity: 0.55, fontWeight: 400 },
      entry: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
        padding: '3px 6px',
        borderRadius: '5px',
        lineHeight: 1.6,
      },
      entryText: { flex: 1, minWidth: 0, wordBreak: 'break-word', cursor: 'text', whiteSpace: 'pre-wrap' },
      iconBtn: {
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: 0.5,
        font: 'inherit',
        padding: '0 4px',
        lineHeight: 1.4,
      },
      inlineInput: { flex: 1, minWidth: 0, font: 'inherit', color: 'inherit', background: 'rgba(127,127,127,0.1)', border: '1px solid rgba(127,127,127,0.35)', borderRadius: '5px', padding: '3px 6px', outline: 'none' },
      search: { width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: '12px', color: 'inherit', background: 'rgba(127,127,127,0.08)', border: '1px solid rgba(127,127,127,0.24)', borderRadius: '6px', outline: 'none' },
      select: {
        fontSize: '11.5px',
        color: 'inherit',
        background: 'rgba(127,127,127,0.1)',
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: '5px',
        padding: '1px 4px',
        maxWidth: '170px',
      },
      btn: { border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '11.5px', padding: '3px 9px', borderRadius: '6px', cursor: 'pointer' },
      btnPrimary: { border: '1px solid rgba(127,127,127,0.5)', background: 'rgba(127,127,127,0.16)' },
      note: { fontSize: '11.5px', opacity: 0.6, lineHeight: 1.6 },
      err: { fontSize: '11.5px', color: '#e06c75' },
      ok: { fontSize: '11.5px', color: '#69b07a' },
      warnBar: { fontSize: '11.5px', padding: '6px 10px', borderRadius: '6px', background: 'rgba(224,168,80,0.14)', border: '1px solid rgba(224,168,80,0.4)' },
      hintBar: { fontSize: '11.5px', padding: '6px 10px', borderRadius: '6px', background: 'rgba(127,127,127,0.1)', border: '1px solid rgba(127,127,127,0.24)', lineHeight: 1.6 },
      errBar: { fontSize: '11.5px', padding: '6px 10px', borderRadius: '6px', background: 'rgba(224,108,117,0.12)', border: '1px solid rgba(224,108,117,0.4)' },
      modalWrap: {
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 30,
        padding: '20px',
      },
      modal: {
        maxWidth: '640px',
        width: '100%',
        maxHeight: '80%',
        overflow: 'auto',
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
      },
      diffRow: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '1px 6px', borderRadius: '3px' },
    }

    function Btn({ label, onClick, primary, disabled, title }) {
      return h(
        'button',
        {
          type: 'button',
          title,
          disabled,
          onClick,
          style: { ...P.btn, ...(primary ? P.btnPrimary : null), opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' },
        },
        label,
      )
    }

    /**
     * Which workspace the panel is looking at.
     *
     * The panel has no session of its own, so it can only offer the ones this
     * plugin has already assembled a prompt for. One workspace is a label;
     * several become a picker, because "your memory" is ambiguous once two
     * projects are open.
     */
    function ProjectPicker({ projects, cwd, value, onChange }) {
      if (!projects.length) {
        return h('span', { style: { opacity: 0.75 }, title: cwd ?? '' }, '项目 未确定')
      }
      const current = projects.find((row) => row.current) ?? projects[0]
      const active = value ?? current.key
      const shown = projects.find((row) => row.key === active) ?? current
      if (projects.length === 1) {
        return h('span', { title: shown.path }, `项目 ${shown.name}`)
      }
      return h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '4px' }, title: shown.path },
        '项目',
        h(
          'select',
          {
            style: P.select,
            value: active,
            onChange: (event) => onChange(event.target.value),
          },
          projects.map((row) =>
            h(
              'option',
              { key: row.key, value: row.key },
              `${row.name}${row.hasMemory ? '' : row.daily > 0 ? ` · 仅 ${row.daily} 天流水` : ' · 无记忆'}`,
            ),
          ),
        ),
      )
    }

    function Row({ label, sub, active, onClick }) {
      return h(
        'button',
        { type: 'button', style: { ...P.item, ...(active ? P.itemActive : null) }, onClick },
        h('span', { style: { display: 'block' } }, label),
        sub ? h('span', { style: { display: 'block', fontSize: '10.5px', opacity: 0.55 } }, sub) : null,
      )
    }

    function Meter({ label, bytes, limit }) {
      const r = ratio(bytes, limit)
      const tone = r.level === 'over' ? '#e06c75' : r.level === 'warn' ? '#e0a850' : 'currentColor'
      return h(
        'span',
        { style: P.meterWrap, title: `${label} ${humanBytes(bytes)} / ${humanBytes(limit)}` },
        h('span', { style: { opacity: 0.7 } }, label),
        h('span', { style: P.meter }, h('span', { style: { display: 'block', width: `${r.percent}%`, height: '100%', background: tone, opacity: r.level === 'ok' ? 0.5 : 0.9 } })),
        h('span', { style: { opacity: 0.62 } }, `${r.percent}%`),
      )
    }

    // ── panel ───────────────────────────────────────────────────────────────

    function MemoryPanel() {
      const [state, setState] = React.useState(null)
      const [doc, setDoc] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [editing, setEditing] = React.useState(null)
      const [adding, setAdding] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [conflict, setConflict] = React.useState(null)
      const [dialog, setDialog] = React.useState(null)
      const [undo, setUndo] = React.useState(null)
      const [stale, setStale] = React.useState(false)
      /** Which workspace the panel is showing; null follows the last session. */
      const [projectKey, setProjectKey] = React.useState(null)
      const noticeTimer = React.useRef(null)

      const flash = React.useCallback((text) => {
        setNotice(text)
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(''), 4000)
      }, [])

      /** Every request names its workspace, so a pinned pick survives polling. */
      const withProject = React.useCallback(
        (params) => {
          const query = new URLSearchParams(params ?? {})
          if (projectKey) query.set('project', projectKey)
          const suffix = query.toString()
          return suffix ? `?${suffix}` : ''
        },
        [projectKey],
      )

      const refresh = React.useCallback(async () => {
        try {
          const next = await getJson(`${API}/state${withProject()}`)
          setState(next)
          setError('')
          return next
        } catch (cause) {
          const code = String(cause?.message ?? cause)
          setError(
            code === 'unknown_project'
              ? '这个项目已经不在最近会话里了，换一个。'
              : code.includes('404') || code === 'no_route'
                ? '面板接口没有注册：确认插件配置里的「界面」是打开的，且宿主带 webServer。'
                : describeCode(code),
          )
          return null
        }
      }, [withProject])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          if (!document.hidden) refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [refresh])

      React.useEffect(() => () => noticeTimer.current && clearTimeout(noticeTimer.current), [])

      const open = React.useCallback(
        async (target, date) => {
          setSelected({ target, date })
          setDoc(null)
          setEditing(null)
          setAdding(null)
          setQuery('')
          setStale(false)
          try {
            const params = { target }
            if (date) params.date = date
            setDoc(await getJson(`${API}/content${withProject(params)}`))
            setError('')
          } catch (cause) {
            setError(describeCode(String(cause?.message ?? cause)))
          }
        },
        [withProject],
      )

      /** Reload just the open document, keeping the selection. */
      const reload = React.useCallback(async () => {
        if (!selected) return
        try {
          const params = { target: selected.target }
          if (selected.date) params.date = selected.date
          setDoc(await getJson(`${API}/content${withProject(params)}`))
          setStale(false)
        } catch (cause) {
          setError(describeCode(String(cause?.message ?? cause)))
        }
        await refresh()
      }, [selected, refresh, withProject])

      // A different revision on disk than the one on screen is the one thing a
      // person cannot see by looking: flag it instead of letting the next save
      // fail with a code they have to decode.
      React.useEffect(() => {
        if (!doc || !state || !selected) return
        const live =
          selected.target === 'project-memory'
            ? state.stores?.project?.revision
            : selected.target === 'user-memory'
              ? state.stores?.user?.revision
              : null
        if (live && doc.revision && live !== doc.revision) setStale(true)
      }, [state, doc, selected])

      const writable = Boolean(state?.allowWriteActions && !state?.readOnly && state?.writeEnabled) && selected?.target !== 'profile'

      const act = React.useCallback(
        async (payload) => {
          setBusy(true)
          setError('')
          try {
            const { body } = await postJson(`${API}/action${withProject()}`, payload)
            if (body.ok) {
              if (body.backup) {
                setUndo({ target: payload.target, name: String(body.backup).split(/[\\/]/).pop(), revision: body.revision, until: Date.now() + 10000 })
              }
              return body
            }
            if (body.code === 'conflict') {
              setConflict({ payload, body })
              return body
            }
            setError(describeCode(body.code))
            return body
          } catch (cause) {
            setError(String(cause?.message ?? cause))
            return null
          } finally {
            setBusy(false)
          }
        },
        [withProject],
      )

      const saveEntry = React.useCallback(
        async (section, line, value, original) => {
          if (value.trim() === original.trim()) {
            setEditing(null)
            return
          }
          const body = await act({
            type: 'edit',
            target: selected.target,
            section,
            line,
            replacement: value,
            expectedRevision: doc?.revision,
          })
          if (body?.ok) {
            setEditing(null)
            flash('已保存，下一轮对话生效')
            await reload()
          }
        },
        [act, selected, doc, reload, flash],
      )

      const removeEntry = React.useCallback(
        async (section, line) => {
          const body = await act({ type: 'remove', target: selected.target, section, line, expectedRevision: doc?.revision })
          if (body?.ok) {
            flash('已删除，可在 10 秒内撤销')
            await reload()
          }
        },
        [act, selected, doc, reload, flash],
      )

      const addEntry = React.useCallback(
        async (section, value) => {
          const body = await act({
            type: 'add',
            target: selected.target,
            date: selected.date,
            section,
            text: value,
            expectedRevision: doc?.revision,
          })
          if (body?.ok) {
            setAdding(null)
            flash('已添加')
            await reload()
          }
        },
        [act, selected, doc, reload, flash],
      )

      const undoLast = React.useCallback(async () => {
        if (!undo) return
        const body = await act({ type: 'restore', target: undo.target, name: undo.name, expectedRevision: doc?.revision })
        if (body?.ok) {
          setUndo(null)
          flash('已撤销')
          await reload()
        }
      }, [undo, act, doc, reload, flash])

      React.useEffect(() => {
        if (!undo) return
        const timer = setTimeout(() => setUndo(null), Math.max(0, undo.until - Date.now()))
        return () => clearTimeout(timer)
      }, [undo])

      const stores = state?.stores ?? {}
      const project = stores.project
      const user = stores.user
      const profile = stores.profile
      const limits = state?.limits ?? {}
      const backupCount = state?.backups?.count ?? 0
      const conflicts = state?.operations?.conflicts ?? 0

      const dailyRows = (project?.daily ?? []).map((file) =>
        h(Row, {
          key: `daily-${file.date}`,
          label: file.date,
          sub: `${humanBytes(file.bytes)}${file.ageDays > 30 ? ` · ${file.ageDays} 天前，建议合并` : ''}`,
          active: selected?.target === 'project-daily' && selected?.date === file.date,
          onClick: () => open('project-daily', file.date),
        }),
      )

      const tree = h(
        'div',
        { style: P.tree },
        h('div', { style: P.group }, '项目记忆'),
        project?.memoryExists
          ? h(Row, {
              label: 'MEMORY.md',
              sub: `${project.entries} 条 · ${humanBytes(project.bytes)}`,
              active: selected?.target === 'project-memory',
              onClick: () => open('project-memory'),
            })
          : h('div', { style: { ...P.note, padding: '2px 8px 6px' } }, '这个项目还没有 MEMORY.md'),
        dailyRows.length > 0 ? h('div', { style: P.group }, `日期笔记 ${dailyRows.length}`) : null,
        dailyRows,
        h('div', { style: P.group }, '全局'),
        user?.memoryExists
          ? h(Row, {
              label: '用户 MEMORY.md',
              sub: `${user.entries} 条 · ${humanBytes(user.bytes)}`,
              active: selected?.target === 'user-memory',
              onClick: () => open('user-memory'),
            })
          : h('div', { style: { ...P.note, padding: '2px 8px' } }, '没有'),
        profile?.exists
          ? h(Row, {
              label: '画像',
              sub: profile.ambiguous ? '多个候选，未使用' : `${humanBytes(profile.bytes)} · 只读`,
              active: selected?.target === 'profile',
              onClick: () => open('profile'),
            })
          : null,
      )

      const head = h(
        'div',
        { style: P.detailHead },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, fontSize: '13px' } }, selected ? (selected.date ?? selected.target) : '记忆'),
          selected && doc
            ? h('span', { style: P.note }, `${doc.entries ?? 0} 条 · ${humanBytes(doc.bytes)} · rev ${doc.revision}`)
            : null,
          h('span', { style: { flex: 1 } }),
          selected && writable ? h(Btn, { label: '整理…', onClick: () => setDialog({ kind: 'consolidate' }) }) : null,
          selected && writable && selected.target !== 'project-daily'
            ? h(Btn, { label: '历史…', onClick: () => setDialog({ kind: 'revisions' }) })
            : null,
          h(Btn, { label: '重新加载', onClick: reload }),
        ),
        doc?.path ? h('div', { style: { ...P.note, marginTop: '2px' } }, doc.path) : null,
        state && !state.allowWriteActions
          ? h(
              'div',
              { style: { ...P.hintBar, marginTop: '6px' } },
              h('span', null, '当前只读。要在这里改，去 '),
              h('b', null, '插件页 → dsh-workbuddy-memory → 记忆面板 → 面板写操作'),
              h('span', null, ' 打开开关；不想开也可以让对话里的智能体调 memory_append / memory_edit。'),
            )
          : null,
        h(
          'div',
          { style: { marginTop: '8px' } },
          h('input', {
            style: P.search,
            type: 'search',
            value: query,
            placeholder: '搜索条目（只过滤当前文件）',
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
      )

      const sections = React.useMemo(() => {
        if (!doc?.sections) return []
        return doc.sections.map((section) => ({ ...section, entries: filterEntries(section.entries, query) }))
      }, [doc, query])

      const renderEntry = (section, entry) => {
        const key = `${section.heading}-${entry.line}`
        if (editing && editing.line === entry.line && editing.section === section.heading) {
          return h(
            'div',
            { style: P.entry, key },
            h('span', { style: { opacity: 0.5, paddingTop: '3px' } }, '›'),
            h('input', {
              style: P.inlineInput,
              autoFocus: true,
              value: editing.value,
              spellCheck: false,
              onChange: (event) => setEditing({ ...editing, value: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') saveEntry(section.heading, entry.line, editing.value, entry.text)
                if (event.key === 'Escape') setEditing(null)
              },
            }),
            h(Btn, { label: '保存', primary: true, onClick: () => saveEntry(section.heading, entry.line, editing.value, entry.text) }),
            h(Btn, { label: '取消', onClick: () => setEditing(null) }),
          )
        }

        const parts = highlightParts(entry.text, query)
        return h(
          'div',
          {
            style: P.entry,
            key,
            onMouseEnter: (event) => {
              event.currentTarget.style.background = 'rgba(127,127,127,0.08)'
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.background = 'transparent'
            },
          },
          h('span', { style: { opacity: 0.5 } }, '›'),
          h(
            'span',
            {
              style: P.entryText,
              // The hint only applies when clicking actually does something.
              title: writable ? '点击编辑' : undefined,
              onClick: () => writable && setEditing({ section: section.heading, line: entry.line, value: entry.text }),
            },
            parts.hit
              ? [parts.before, h('mark', { key: 'hit', style: { background: 'rgba(224,168,80,0.45)', color: 'inherit', borderRadius: '2px' } }, parts.hit), parts.after]
              : entry.text,
          ),
          writable
            ? h(
                'span',
                { style: { display: 'flex', flexShrink: 0 } },
                h('button', { type: 'button', style: P.iconBtn, title: '编辑', onClick: () => setEditing({ section: section.heading, line: entry.line, value: entry.text }) }, '✎'),
                h('button', { type: 'button', style: P.iconBtn, title: '删除', onClick: () => removeEntry(section.heading, entry.line) }, '✕'),
              )
            : null,
        )
      }

      const body = !selected
        ? h(
            'div',
            { style: { ...P.note, padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: '10px' } },
            !state?.cwd
              ? h(
                  'div',
                  null,
                  h('div', { style: { fontWeight: 600, opacity: 1 } }, '面板还不知道你在哪个项目'),
                  h(
                    'div',
                    null,
                    '它没有自己的会话上下文，只能沿用「最近一次装配过提示词的工作目录」。在一个项目的会话里发一句话，回来点「刷新」就会认到；开过多个项目时，上方会变成可切换的下拉框。',
                  ),
                )
              : null,
            h(
              'div',
              null,
              h('div', { style: { fontWeight: 600, opacity: 1 } }, '项目记忆在左边'),
              h('div', null, `路径是 <项目>/${state?.dataFolderName ?? '.workbuddy'}/memory/。点 MEMORY.md 看长期记忆，点日期笔记看当天流水——它们是两个独立文件，没有 MEMORY.md 不代表这个项目没记录。`),
            ),
            writable
              ? h('div', null, '写操作已开：点条目可以直接改，行尾 ✕ 删，小节标题右边 ＋ 加。')
              : h(
                  'div',
                  null,
                  '现在只能看。要改，去 ',
                  h('b', null, '插件页 → dsh-workbuddy-memory → 记忆面板 → 面板写操作'),
                  ' 打开开关。',
                ),
          )
        : !doc
          ? h('div', { style: { ...P.note, padding: '18px 14px' } }, '读取中…')
          : h(
              'div',
              null,
              stale
                ? h('div', { style: { ...P.warnBar, marginBottom: '8px' } }, '这个文件在别处被改过了，屏幕上是旧内容。点「重新加载」拿最新的再改。')
                : null,
              (sections ?? []).map((section) =>
                h(
                  'div',
                  { style: P.section, key: `${section.heading}-${section.line}` },
                  h(
                    'div',
                    { style: P.sectionHead },
                    h('span', null, `## ${section.heading}`),
                    h('span', { style: P.count }, `${section.entries.length} 条`),
                    writable
                      ? h('button', {
                          type: 'button',
                          style: P.iconBtn,
                          title: '在这个小节加一条',
                          onClick: () => setAdding({ section: section.heading, value: '' }),
                        }, '＋')
                      : null,
                  ),
                  section.entries.length === 0 ? h('div', { style: P.note }, query ? '没有匹配的条目' : '（空小节）') : null,
                  section.entries.map((entry) => renderEntry(section, entry)),
                  adding && adding.section === section.heading
                    ? h(
                        'div',
                        { style: P.entry },
                        h('span', { style: { opacity: 0.5, paddingTop: '3px' } }, '›'),
                        h('input', {
                          style: P.inlineInput,
                          autoFocus: true,
                          value: adding.value,
                          placeholder: '新条目内容，Enter 保存',
                          onChange: (event) => setAdding({ ...adding, value: event.target.value }),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter' && adding.value.trim()) addEntry(section.heading, adding.value)
                            if (event.key === 'Escape') setAdding(null)
                          },
                        }),
                        h(Btn, { label: '保存', primary: true, onClick: () => adding.value.trim() && addEntry(section.heading, adding.value) }),
                        h(Btn, { label: '取消', onClick: () => setAdding(null) }),
                      )
                    : null,
                ),
              ),
              doc.entries === 0 && (sections ?? []).length === 0
                ? h('div', { style: { ...P.note, padding: '12px 0' } }, '这个文件还是空的。')
                : null,
            )

      return h(
        'div',
        { style: { ...P.wrap, position: 'relative' } },
        h(
          'div',
          { style: P.bar },
          h('span', { title: state?.home?.path ?? '' }, `home ${shortPath(state?.home?.path)}`),
          h(ProjectPicker, {
            projects: state?.projects ?? [],
            cwd: state?.cwd ?? null,
            value: projectKey,
            onChange: (key) => {
              setProjectKey(key)
              setSelected(null)
              setDoc(null)
              setStale(false)
            },
          }),
          h('span', null, state?.readOnly ? '只读模式' : state?.writeEnabled ? '可写' : '写入已关'),
          state?.allowWriteActions ? null : h('span', { style: { opacity: 0.6 } }, '面板只读'),
          h(Meter, { label: '项目', bytes: project?.bytes, limit: limits.project }),
          h(Meter, { label: '用户', bytes: user?.bytes, limit: limits.user }),
          h('span', null, `备份 ${backupCount}`),
          conflicts > 0 ? h('span', { style: { color: '#e0a850' } }, `冲突 ${conflicts}`) : null,
          h('span', { style: { flex: 1 } }),
          h(Btn, { label: '刷新', onClick: refresh }),
        ),
        notice ? h('div', { style: { ...P.ok, padding: '4px 12px' } }, notice) : null,
        error ? h('div', { style: { ...P.err, padding: '4px 12px' } }, error) : null,
        undo
          ? h(
              'div',
              { style: { padding: '4px 12px', display: 'flex', gap: '8px', alignItems: 'center', ...P.note } },
              '已保存',
              h(Btn, { label: '撤销', onClick: undoLast, disabled: busy }),
            )
          : null,
        h('div', { style: P.body }, tree, h('div', { style: P.detail }, head, h('div', { style: P.detailBody }, body))),
        conflict ? renderConflict() : null,
        dialog ? renderDialog() : null,
      )

      function renderConflict() {
        const diskRevision = conflict?.body?.revision
        return h(
          'div',
          { style: P.modalWrap },
          h(
            'div',
            { style: P.modal },
            h('div', { style: { fontWeight: 600 } }, '文件已被改动'),
            h(
              'div',
              { style: P.note },
              `你看到的是 ${doc?.revision ?? '—'}，磁盘上是 ${diskRevision ?? '—'}。草稿没有丢，选一个：`,
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              h(Btn, {
                label: '重新加载（丢弃草稿）',
                primary: true,
                onClick: async () => {
                  setConflict(null)
                  setEditing(null)
                  await reload()
                },
              }),
              h(Btn, {
                label: '保留草稿继续编辑',
                onClick: () => setConflict(null),
              }),
              h(Btn, {
                label: '覆盖磁盘（先备份）',
                onClick: async () => {
                  const payload = { ...conflict.payload }
                  delete payload.expectedRevision
                  setConflict(null)
                  const result = await act(payload)
                  if (result?.ok) {
                    flash('已覆盖写入')
                    await reload()
                  }
                },
              }),
            ),
          ),
        )
      }

      function renderDialog() {
        if (dialog.kind === 'consolidate') return h(ConsolidateDialog, { state, act, onClose: () => setDialog(null), flash, reload })
        return h(RevisionsDialog, { doc, selected, act, getJson, onClose: () => setDialog(null), flash, reload })
      }
    }

    /** Collapse old daily files into the project's MEMORY.md, plan first. */
    function ConsolidateDialog({ state, act, onClose, flash, reload }) {
      const [plan, setPlan] = React.useState(null)
      const [picked, setPicked] = React.useState(null)
      const [beforeDays, setBeforeDays] = React.useState(30)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const projectRevision = state?.stores?.project?.revision

      const load = React.useCallback(
        async (days) => {
          setBusy(true)
          setError('')
          const body = await act({ type: 'consolidate', dryRun: true, beforeDays: days })
          setBusy(false)
          if (body?.ok) {
            setPlan(body)
            setPicked(new Set((body.candidates ?? []).map((row) => row.date)))
          } else {
            setError(describeCode(body?.code ?? 'failed'))
          }
        },
        [act],
      )

      React.useEffect(() => {
        load(beforeDays)
      }, [])

      const candidates = plan?.candidates ?? []
      const totals = candidates.filter((row) => !picked || picked.has(row.date)).reduce((sum, row) => sum + row.entries.length, 0)

      return h(
        'div',
        { style: P.modalWrap },
        h(
          'div',
          { style: P.modal },
          h('div', { style: { fontWeight: 600 } }, '整理日期笔记'),
          h(
            'div',
            { style: P.note },
            '把早于指定天数的日期文件按日期成节并入项目 MEMORY.md，然后清掉源文件里已并入的行。先看计划，再执行。',
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('span', { style: P.note }, '早于'),
            h('input', {
              style: { ...P.search, width: '70px' },
              type: 'number',
              min: 1,
              value: beforeDays,
              onChange: (event) => setBeforeDays(Number(event.target.value) || 1),
            }),
            h('span', { style: P.note }, '天'),
            h(Btn, { label: '重新出计划', onClick: () => load(beforeDays), disabled: busy }),
          ),
          error ? h('div', { style: P.errBar }, error) : null,
          !plan
            ? h('div', { style: P.note }, busy ? '正在扫描…' : '没有结果')
            : candidates.length === 0
              ? h('div', { style: P.note }, `${beforeDays} 天以前没有带条目的日期文件。`)
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  candidates.map((row) =>
                    h(
                      'label',
                      { key: row.date, style: { display: 'flex', gap: '8px', alignItems: 'flex-start', ...P.entry } },
                      h('input', {
                        type: 'checkbox',
                        checked: !picked || picked.has(row.date),
                        onChange: (event) => {
                          const next = new Set(picked ?? [])
                          if (event.target.checked) next.add(row.date)
                          else next.delete(row.date)
                          setPicked(next)
                        },
                      }),
                      h(
                        'span',
                        { style: { minWidth: 0 } },
                        h('span', { style: { fontWeight: 600 } }, `${row.date} · ${row.entries.length} 条`),
                        h('span', { style: { ...P.note, display: 'block' } }, row.entries.slice(0, 3).join(' / ').slice(0, 160)),
                      ),
                    ),
                  ),
                ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h(Btn, { label: '取消', onClick: onClose }),
            h(Btn, {
              label: busy ? '执行中…' : `合并 ${totals} 条`,
              primary: true,
              disabled: busy || totals === 0,
              onClick: async () => {
                setBusy(true)
                const dates = candidates.filter((row) => !picked || picked.has(row.date)).map((row) => row.date)
                const body = await act({ type: 'consolidate', dryRun: false, beforeDays, dates, expectedRevision: projectRevision })
                setBusy(false)
                if (body?.ok) {
                  flash(`已合并 ${body.consolidated?.length ?? 0} 个日期文件`)
                  onClose()
                  await reload()
                } else {
                  setError(describeCode(body?.code ?? 'failed'))
                }
              },
            }),
          ),
        ),
      )
    }

    /** Pick a backup, look at the diff, put it back. */
    function RevisionsDialog({ doc, selected, act, getJson, onClose, flash, reload }) {
      const [rows, setRows] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const body = await getJson(`${API}/revisions?target=${encodeURIComponent(selected.target)}`)
            if (alive) setRows(body.revisions ?? [])
          } catch (cause) {
            if (alive) setError(describeCode(String(cause?.message ?? cause)))
          }
        })()
        return () => {
          alive = false
        }
      }, [selected, getJson])

      const openRevision = React.useCallback(
        async (name) => {
          setBusy(true)
          setError('')
          try {
            const body = await getJson(`${API}/revision?target=${encodeURIComponent(selected.target)}&name=${encodeURIComponent(name)}`)
            setSnapshot(body)
          } catch (cause) {
            setError(describeCode(String(cause?.message ?? cause)))
          } finally {
            setBusy(false)
          }
        },
        [selected, getJson],
      )

      const diff = React.useMemo(() => {
        if (!snapshot) return null
        return lineDiff(snapshot.current?.text ?? doc?.text ?? '', snapshot.text ?? '')
      }, [snapshot, doc])

      return h(
        'div',
        { style: P.modalWrap },
        h(
          'div',
          { style: P.modal },
          h('div', { style: { fontWeight: 600 } }, '历史版本'),
          h('div', { style: P.note }, '每次写入前都会留一份。选一份看差异，确认后整文件恢复到那一版。'),
          error ? h('div', { style: P.errBar }, error) : null,
          !rows
            ? h('div', { style: P.note }, '读取中…')
            : rows.length === 0
              ? h('div', { style: P.note }, '还没有备份。')
              : h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                  rows.map((row) =>
                    h(Btn, {
                      key: row.name,
                      label: `${new Date(row.mtime).toLocaleString()} · ${humanBytes(row.bytes)}`,
                      primary: snapshot?.name === row.name,
                      onClick: () => openRevision(row.name),
                    }),
                  ),
                ),
          snapshot
            ? h(
                'div',
                null,
                h('div', { style: { ...P.note, margin: '6px 0' } }, diff?.truncated ? '文件太大，只给统计：' : `相对当前：+${diff.added} / -${diff.removed} 行`),
                diff && !diff.truncated
                  ? h(
                      'div',
                      { style: { maxHeight: '260px', overflow: 'auto', border: '1px solid rgba(127,127,127,0.2)', borderRadius: '6px', padding: '4px' } },
                      diff.rows.map((row, index) =>
                        h(
                          'div',
                          {
                            key: `d-${index}`,
                            style: {
                              ...P.diffRow,
                              background: row.type === 'add' ? 'rgba(105,176,122,0.16)' : row.type === 'del' ? 'rgba(224,108,117,0.14)' : 'transparent',
                              opacity: row.type === 'same' ? 0.45 : 1,
                            },
                          },
                          `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} ${row.text}`,
                        ),
                      ),
                    )
                  : null,
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h(Btn, { label: '关闭', onClick: onClose }),
            h(Btn, {
              label: busy ? '恢复中…' : '恢复到这一版',
              primary: true,
              disabled: busy || !snapshot,
              onClick: async () => {
                setBusy(true)
                const body = await act({ type: 'restore', target: selected.target, name: snapshot.name, expectedRevision: snapshot.current?.revision })
                setBusy(false)
                if (body?.ok) {
                  flash('已恢复')
                  onClose()
                  await reload()
                } else {
                  setError(describeCode(body?.code ?? 'failed'))
                }
              },
            }),
          ),
        ),
      )
    }

    function apply(ctx) {
      // The panel is independent of settings: it only needs the sidebar and the
      // host routes, so it survives a host without configForms.
      if (typeof ctx.slots?.register === 'function') {
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL, order: 26, locale: NS, label: () => '记忆' },
              MemoryIcon,
            ),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, MemoryPanel),
          ),
        )
      }

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
      inject: ['slots'],
      __internals: {
        humanBytes,
        ratio,
        filterEntries,
        highlightParts,
        lineDiff,
        describeCode,
        shortPath,
        getJson,
        postJson,
        MemoryPanel,
        MemoryIcon,
        SettingsCard,
        ConsolidateDialog,
        RevisionsDialog,
        PANEL,
        API,
        NS,
        ENTRY,
      },
    }
  },
})
