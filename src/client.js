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
      const writable = snap.writable && snap.mode === 'host'

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
          `revision ${snap.revision ?? '—'} · ${snap.writable ? '可写' : '只读'} · ${snap.mode === 'host' ? '跟随宿主配置' : '仅本进程'}`,
        ),
      )
    }

    function apply(ctx) {
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

    return { apply, inject: ['slots'] }
  },
})
