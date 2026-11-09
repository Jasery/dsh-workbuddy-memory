/*
 * Browser half of dsh-workbuddy-memory.
 *
 * Contributes the plugin's configuration card on the Plugins page. Only
 * `.volatile()` fields reach a settings form, and this card edits exactly
 * those: read-only, the two path overrides, and the per-capability switches.
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

    function humanBytes(n) {
      if (!Number.isFinite(n)) return '—'
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    async function getJson(url) {
      const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => ({ ok: false, code: 'bad_json' }))
      if (!response.ok) throw new Error(body?.code ?? `http_${response.status}`)
      return body
    }

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
        opacity: 0.8,
      },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      tree: {
        width: '240px',
        flexShrink: 0,
        overflowY: 'auto',
        borderRight: '1px solid rgba(127,127,127,0.18)',
        padding: '8px 6px',
      },
      detail: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '10px 14px' },
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
      chip: {
        display: 'inline-block',
        padding: '1px 6px',
        margin: '0 6px 6px 0',
        borderRadius: '4px',
        background: 'rgba(127,127,127,0.14)',
        fontSize: '11px',
      },
      pre: {
        margin: '10px 0 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.6,
      },
      note: { fontSize: '11.5px', opacity: 0.6, lineHeight: 1.6 },
      err: { fontSize: '11.5px', color: '#e06c75' },
    }

    function Row({ label, active, onClick }) {
      return h('button', { type: 'button', style: { ...P.item, ...(active ? P.itemActive : null) }, onClick }, label)
    }

    function MemoryPanel() {
      const [state, setState] = React.useState(null)
      const [doc, setDoc] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [error, setError] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const next = await getJson(`${API}/state`)
          setState(next)
          setError('')
          return next
        } catch (cause) {
          const code = String(cause?.message ?? cause)
          setError(
            code.includes('404') || code === 'no_route'
              ? '面板接口没有注册：确认插件配置里的「界面」是打开的，且宿主是 web profile。'
              : code,
          )
          return null
        }
      }, [])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          if (!document.hidden) refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [refresh])

      const open = React.useCallback(async (target, date) => {
        setSelected({ target, date })
        setDoc(null)
        try {
          const query = new URLSearchParams({ target })
          if (date) query.set('date', date)
          setDoc(await getJson(`${API}/content?${query.toString()}`))
          setError('')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      const project = state?.stores?.project
      const user = state?.stores?.user
      const profile = state?.stores?.profile

      const dailyRows = (project?.daily ?? []).map((file) =>
        h(Row, {
          key: `daily-${file.date}`,
          label: `${file.date} · ${humanBytes(file.bytes)}${file.ageDays > 30 ? ' · 建议合并' : ''}`,
          active: selected?.target === 'project-daily' && selected?.date === file.date,
          onClick: () => open('project-daily', file.date),
        }),
      )

      return h(
        'div',
        { style: P.wrap },
        h(
          'div',
          { style: P.bar },
          h('span', null, `home ${state?.home?.path ? state.home.path.replace(/^.*[\\/]/, '…/') : '—'}`),
          h('span', null, `项目 ${state?.cwd ? state.cwd.replace(/^.*[\\/]/, '…/') : '未确定'}`),
          h('span', null, state?.readOnly ? '只读模式' : state?.writeEnabled ? '可写' : '写入已关'),
          h('span', null, `备份 ${state?.backups?.length ?? 0}`),
          h('button', { type: 'button', style: { ...P.item, width: 'auto', padding: '2px 8px' }, onClick: refresh }, '刷新'),
        ),
        h(
          'div',
          { style: P.body },
          h(
            'div',
            { style: P.tree },
            h('div', { style: P.group }, '项目记忆'),
            project?.memoryExists
              ? h(Row, {
                  label: `MEMORY.md · ${humanBytes(project.bytes)}`,
                  active: selected?.target === 'project-memory',
                  onClick: () => open('project-memory'),
                })
              : h('div', { style: P.note }, '这个项目还没有 MEMORY.md'),
            dailyRows.length > 0 ? h('div', { style: P.group }, `日期笔记 ${dailyRows.length}`) : null,
            dailyRows,
            h('div', { style: P.group }, '全局'),
            user?.memoryExists
              ? h(Row, { label: `用户 MEMORY.md · ${humanBytes(user.bytes)}`, active: selected?.target === 'user-memory', onClick: () => open('user-memory') })
              : h('div', { style: P.note }, '  没有'),
            profile?.exists
              ? h(Row, {
                  label: `画像 ${profile.ambiguous ? '（多个候选，未使用）' : `· ${humanBytes(profile.bytes)}`}`,
                  active: selected?.target === 'profile',
                  onClick: () => open('profile'),
                })
              : null,
          ),
          h(
            'div',
            { style: P.detail },
            error ? h('div', { style: P.err }, error) : null,
            !selected
              ? h(
                  'div',
                  { style: P.note },
                  '从左边选一个文件查看内容。这里只读——要改记忆，让对话里的智能体调用 memory_append / memory_edit，或直接编辑文件。',
                )
              : doc
                ? h(
                    'div',
                    null,
                    h('div', { style: { fontWeight: 600, fontSize: '13px' } }, selected.date ?? selected.target),
                    h(
                      'div',
                      { style: P.note },
                      `${doc.path} · ${humanBytes(doc.bytes)} · revision ${doc.revision}${doc.truncated ? ' · 已截断' : ''}`,
                    ),
                    (doc.sections ?? []).map((section) =>
                      h('span', { key: `${section.line}-${section.heading}`, style: P.chip }, `${section.heading} ${section.entries}`),
                    ),
                    h('pre', { style: P.pre }, doc.text),
                  )
                : h('div', { style: P.note }, '读取中…'),
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
      __internals: { humanBytes, getJson, MemoryPanel, MemoryIcon, SettingsCard, PANEL, API, NS, ENTRY },
    }
  },
})
