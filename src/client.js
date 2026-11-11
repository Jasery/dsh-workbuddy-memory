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
      const [confirm, setConfirm] = React.useState(null)
      const value = snap.value ?? {}
      const inject = value.inject ?? {}
      const write = value.write ?? {}
      const search = value.search ?? {}
      const uiGuard = value.guard ?? {}
      const ui = value.ui ?? {}
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

      const toggleFullText = React.useCallback(
        async (next) => {
          if (!next) {
            await commit('ui.allowFullTextEdit', false)
            return
          }
          setConfirm('fullText')
        },
        [commit],
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
              hint: '打开后可以直接改条目、归档旧日期与撤销。默认开启；只读模式仍是总闸。',
              checked: ui.allowWriteActions,
              disabled: !writable,
              onChange: (next) => commit('ui.allowWriteActions', next),
            }),
            h(Switch, {
              label: '全文编辑',
              hint: '源码模式会绕过条目校验；默认开启，第一次进入时面板会二次确认。',
              checked: ui.allowFullTextEdit,
              disabled: !writable || !ui.allowWriteActions,
              onChange: toggleFullText,
            }),
            confirm === 'fullText'
              ? h(
                  'div',
                  { className: 'wbm-settings-confirm' },
                  h('div', { style: { fontWeight: 600, color: 'inherit' } }, '确认开启全文编辑？'),
                  h('div', null, '源码模式会整文件写入。结构校验、备份和撤销仍然生效，但一次误改可能同时影响多个小节。'),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
                    h('button', { type: 'button', style: { ...S.input, width: 'auto', cursor: 'pointer' }, onClick: () => setConfirm(null) }, '取消'),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...S.input, width: 'auto', cursor: 'pointer', fontWeight: 600 },
                        onClick: async () => {
                          setConfirm(null)
                          await commit('ui.allowFullTextEdit', true)
                        },
                      },
                      '仍然开启',
                    ),
                  ),
                )
              : null,
            h(Switch, {
              label: '左栏「记忆」总览',
              hint: '所有 DSH 工作区的汇总入口。关闭只隐藏界面，不删除任何文件。',
              checked: ui.globalPanel !== false,
              disabled: !writable,
              onChange: (next) => commit('ui.globalPanel', next),
            }),
            h(Switch, {
              label: '右侧栏页签',
              hint: '在右侧栏注册「项目记忆」原生页签，可边聊边看。',
              checked: ui.projectTab !== false,
              disabled: !writable,
              onChange: (next) => commit('ui.projectTab', next),
            }),
            h(Switch, {
              label: '会话头按钮',
              hint: '在会话头放一个记忆按钮，用来打开右栏页签。',
              checked: ui.sessionAction !== false,
              disabled: !writable,
              onChange: (next) => commit('ui.sessionAction', next),
            }),
            h(NumberField, {
              label: '刷新间隔（毫秒）',
              hint: '面板轮询 /state 的间隔，默认 3000。',
              value: ui.refreshMs ?? 3000,
              min: 500,
              max: 60000,
              disabled: !writable,
              onCommit: (next) => commit('ui.refreshMs', next),
            }),
            h(NumberField, {
              label: '最多展示项目',
              hint: '汇总最多拉取多少个工作区，默认 50。',
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
          `revision ${snap.revision ?? '—'} · ${snap.writable ? '可写' : '只读'} · ${snap.user ? '有本机覆盖' : '跟随默认'}`,
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

    const MESSAGES = {
      write_actions_disabled: '面板写操作未开启：到设置页把「面板写操作」打开。',
      read_only: '只读模式已开启，写入被拒绝。',
      write_disabled: '写入开关是关的。',
      full_text_disabled: '全文编辑未开启：到设置页把「全文编辑」打开。',
      conflict: '文件在你编辑期间被改过。',
      stale_line: '这一行已经不在原处了，重新加载后再改。',
      not_an_entry: '这一行不是条目，不能按条目改。',
      no_section: '小节找不到了。',
      invalid_body: '小节内容不合法：只能写 `- ` 条目和空行，不能写标题或普通段落。',
      invalid_structure: '整份文件结构不合法：检查代码围栏和文件大小。',
      too_large: '文件太大，无法在面板里编辑。',
      empty_text: '内容不能为空。',
      ambiguous: '同一个关键词匹配到多条，换一句更精确的。',
      lock_timeout: '文件正被另一个写入占用，稍后再试。',
      revision_required: '缺少 revision，无法安全写入。',
      nothing_to_prune: '没有可归档的旧日期文件。',
      no_project: '面板还没认到项目：先在这个项目的会话里发一句话，再回来刷新。',
      no_store: '这个项目没有记忆目录。',
      no_profile: '没有画像文件。',
      ambiguous_profile: '画像有多个候选，未指定用哪个。',
      not_found: '文件还不存在。',
      unknown_project: '这个项目已经不在最近会话里了，换一个。',
      read_only_target: '画像是蒸馏产物，这里只能看不能改。',
      body_too_large: '请求太大。',
      json_required: '请求格式不对。',
      unknown_action: '不支持的动作。',
      no_route: '面板接口没有注册：确认插件配置里的「界面」是打开的。',
    }

    function describeCode(code) {
      return MESSAGES[code] ?? String(code ?? '未知错误')
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
      if (seconds < 60) return '刚刚'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.round(hours / 24)
      if (days < 45) return `${days} 天前`
      return new Date(ts).toLocaleDateString()
    }

    /** Tone + label for one project row. */
    function projectState(row) {
      if (row.current) return { tone: 'accent', label: '当前' }
      if (row.status === 'missing') return { tone: 'bad', label: '目录不存在' }
      if (row.status === 'unreadable') return { tone: 'bad', label: '不可读' }
      if (row.status === 'over-limit') return { tone: 'warn', label: '超限' }
      if (row.status === 'stale') return { tone: 'warn', label: '待归档' }
      if (row.status === 'daily-only') return { tone: 'warn', label: '仅日期笔记' }
      if (row.status === 'empty') return { tone: 'empty', label: '无记忆' }
      return { tone: 'ok', label: '有记忆' }
    }

    // ── config and navigation ───────────────────────────────────────────────

    const DEFAULT_FLAGS = {
      allowWriteActions: true,
      allowFullTextEdit: true,
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
        allowFullTextEdit: ui.allowFullTextEdit !== false,
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
        return await form.set(field, value)
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

    // ── the shared workspace ────────────────────────────────────────────────

    const TARGET_LABEL = {
      'project-memory': 'MEMORY.md',
      'project-daily': '日期笔记',
      'user-memory': '用户 MEMORY.md',
      profile: '用户画像',
    }

    function MemoryWorkspace(props) {
      const mode = props?.mode === 'project' ? 'project' : 'overview'
      const layout = props?.layout === 'narrow' ? 'narrow' : 'wide'
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

      const noticeTimer = React.useRef(null)
      const contentSeq = React.useRef(0)
      const searchRef = React.useRef(null)

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
            flash('已开启面板编辑')
            refresh()
          } else {
            setError('无法写入宿主配置，请到设置页手动开启「面板写操作」。')
          }
        })
      }

      function openSource() {
        if (!canSource) return
        if (doc?.truncated) {
          setError('文件超过面板读取上限，不能在这里整文件编辑；请用逐条编辑或外部编辑器。')
          return
        }
        if (!flags.allowFullTextEdit) {
          setConfirmSource(true)
          return
        }
        if (!sourceAcknowledged()) {
          setConfirmSource(true)
          return
        }
        setSourceEdit({ text: doc?.text ?? '' })
        setSectionEdit(null)
        setNewSection(null)
      }

      async function openSourceAfterConfirm(withFlag) {
        if (withFlag) {
          const ok = await setFlag('ui.allowFullTextEdit', true)
          if (!ok) {
            setConfirmSource(false)
            setError('无法写入宿主配置，请到设置页手动开启「全文编辑」。')
            return
          }
          runtime.flags.allowFullTextEdit = true
        }
        acknowledgeSource()
        setConfirmSource(false)
        setSourceEdit({ text: doc?.text ?? '' })
        setSectionEdit(null)
        setNewSection(null)
      }

      async function act(payload) {
        setBusy(true)
        setError('')
        const key = payload.key ?? selected?.key ?? effectiveKey
        const body = { ...payload }
        delete body.key
        // One id per click. A caller that supplies its own (the conflict
        // dialog's retry) keeps it, so a retried request replays the operation
        // the store may already have committed instead of writing twice.
        if (!body.operationId) body.operationId = newOperationId()
        const suffix = key ? `?project=${encodeURIComponent(key)}` : ''
        try {
          const response = await postJson(`${API}/action${suffix}`, body)
          const result = response.body
          if (result.ok) {
            if (result.backup) {
              setUndo({
                target: payload.target,
                name: String(result.backup).split(/[\\/]/).pop(),
                revision: result.revision,
                until: Date.now() + 10000,
              })
            }
            return result
          }
          if (result.code === 'conflict') {
            setConflict({ payload: body, body: result })
            return result
          }
          const detail = result.issues?.length ? `（第 ${result.issues.map((row) => row.line).join('、')} 行）` : ''
          setError(`${describeCode(result.code)}${detail}`)
          return result
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          return null
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
          flash('已保存，下一轮对话生效')
          await reload()
        }
      }

      async function removeEntry(section, line) {
        const result = await act({ type: 'remove', target: selected.target, section, line, expectedRevision: doc?.revision })
        if (result?.ok) {
          flash('已删除，可在 10 秒内撤销')
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
          flash('已添加')
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
          flash('小节已保存')
          await reload()
        }
      }

      async function saveSource(text) {
        const result = await act({
          type: 'replace-document',
          target: selected.target,
          text,
          expectedRevision: doc?.revision,
        })
        if (result?.ok) {
          setSourceEdit(null)
          flash('整份文件已保存')
          await reload()
        }
      }

      async function removeSection(section) {
        const result = await act({
          type: 'remove-section',
          target: selected.target,
          section,
          expectedRevision: doc?.revision,
        })
        if (result?.ok) {
          setDialog(null)
          flash('小节已删除')
          await reload()
        }
      }

      async function undoLast() {
        if (!undo) return
        const result = await act({ type: 'restore', target: undo.target, name: undo.name, expectedRevision: doc?.revision })
        if (result?.ok) {
          setUndo(null)
          flash('已撤销')
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
            `${humanBytes(file.bytes)}${file.ageDays > 30 ? ` · ${file.ageDays} 天前` : ''}`,
            selected?.target === 'project-daily' && selected?.date === file.date && selected?.key === key,
          ),
        )
      }

      function projectTree() {
        if (!filteredProjects.length) {
          return h('div', { className: 'wbm-note' }, railQuery ? '没有匹配的项目' : '还没有工作区')
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
              h('span', { className: 'wbm-meta' }, row.hasMemory ? `${row.entries ?? 0} 条` : row.daily ? `${row.daily} 天` : tone.label),
            ),
            isOpen
              ? h(
                  'div',
                  { className: 'wbm-tree-children' },
                  fileRow(
                    row.key,
                    'project-memory',
                    undefined,
                    'MEMORY.md',
                    row.hasMemory ? `${row.entries ?? 0} 条` : '未创建',
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
          return h('div', { className: 'wbm-note' }, '还没有认到项目。先在一个项目的会话里发一句话，或在下面选一个项目。')
        }
        const projectRatio = ratio(project.chars, limits.project)
        return h(
          'div',
          null,
          fileRow(
            project.key,
            'project-memory',
            undefined,
            'MEMORY.md',
            project.hasMemory ? `${project.entries ?? 0} 条 · ${projectRatio.percent}%` : '未创建',
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
            ? fileRow(null, 'user-memory', undefined, '用户 MEMORY.md', `${user.entries ?? 0} 条 · ${userRatio.percent}%`, selected?.target === 'user-memory')
            : h('div', { className: 'wbm-note' }, '没有用户 MEMORY.md'),
          profile?.exists
            ? fileRow(null, 'profile', undefined, '用户画像', profile.ambiguous ? '多个候选' : '只读', selected?.target === 'profile')
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
                placeholder: '搜索项目…',
                onChange: (event) => setRailQuery(event.target.value),
              }),
              h(
                'label',
                { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', fontSize: '11px', color: 'var(--wbm-text-3)' } },
                h('input', { type: 'checkbox', checked: onlyMemory, onChange: (event) => setOnlyMemory(event.target.checked) }),
                '只看有记忆',
              ),
            ),
            h('div', { className: 'wbm-rail-group' }, `全部项目 ${state?.projectsTotal ?? state?.projects?.length ?? 0}`),
            state?.projectsTruncated
              ? h('div', { className: 'wbm-note' }, `只显示前 ${state.projects?.length ?? 0} 个，可在设置里调大「最多展示项目」`)
              : null,
            projectTree(),
            h('div', { className: 'wbm-rail-group' }, '全局'),
            globalRows(),
          )
        }
        return h(
          'div',
          { className: `wbm-rail${railOpen ? ' open' : ''}` },
          h('div', { className: 'wbm-rail-group' }, '当前项目'),
          projectFiles(),
          h('div', { className: 'wbm-rail-group' }, '全局'),
          globalRows(),
          !project && (state?.projects?.length ?? 0) > 0
            ? h(
                'div',
                null,
                h('div', { className: 'wbm-rail-group' }, '选择一个项目'),
                state.projects.map((row) =>
                  h(
                    'button',
                    { key: row.key, type: 'button', className: 'wbm-project', onClick: () => selectProject(row) },
                    h('span', { className: `wbm-dot ${row.hasMemory ? 'ok' : 'empty'}` }),
                    h('span', { className: 'wbm-name' }, row.title || row.name),
                    h('span', { className: 'wbm-meta' }, row.hasMemory ? `${row.entries ?? 0} 条` : '无记忆'),
                  ),
                ),
              )
            : null,
        )
      }

      // ── header ────────────────────────────────────────────────────────────

      function header() {
        const title = mode === 'overview' ? '记忆' : '项目记忆'
        const scope = mode === 'overview' ? '全部项目' : project ? project.title || project.name : '未确定项目'
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
                  h('span', { key: 'p', className: 'wbm-chip' }, `项目 ${totals.projects}`),
                  h('span', { key: 'm', className: 'wbm-chip ok' }, `有记忆 ${totals.withMemory}`),
                  h('span', { key: 'e', className: 'wbm-chip' }, `条目 ${totals.entries}`),
                  totals.overLimit > 0 ? h('span', { key: 'o', className: 'wbm-chip warn' }, `超限 ${totals.overLimit}`) : null,
                  totals.stale > 0 ? h('span', { key: 's', className: 'wbm-chip warn' }, `待归档 ${totals.stale}`) : null,
                ]
              : [
                  project ? h('span', { key: 'e', className: 'wbm-chip' }, `MEMORY ${project.entries ?? 0} 条 · ${humanBytes(project.bytes)}`) : null,
                  projectRatio
                    ? h(
                        'span',
                        { key: 'u', className: `wbm-chip ${projectRatio.level === 'over' ? 'bad' : projectRatio.level === 'warn' ? 'warn' : ''}` },
                        `已用 ${projectRatio.percent}%`,
                      )
                    : null,
                  project?.overLimit ? h('span', { key: 'o', className: 'wbm-chip bad' }, '超注入限额') : null,
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
                  },
                },
                '全部项目',
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
                '全局总览',
              )
            : null,
          h('button', { type: 'button', className: 'wbm-icon', title: '刷新', onClick: refresh }, h(RefreshIcon)),
        )
      }

      // ── dashboard ─────────────────────────────────────────────────────────

      function dashboard() {
        const rows = state?.projects ?? []
        const attention = []
        for (const row of rows) {
          if (row.status === 'over-limit') attention.push({ row, text: '已超注入限额，下一轮注入会截断' })
          else if (row.status === 'stale') attention.push({ row, text: `${row.oldestDaily ?? '日期笔记'} 已 ${row.oldestDailyAgeDays} 天未归档` })
          else if (row.status === 'missing') attention.push({ row, text: '工作区目录不存在' })
          else if (row.status === 'unreadable') attention.push({ row, text: 'MEMORY.md 不可读' })
        }
        const recent = rows.filter((row) => row.hasMemory).slice(0, 6)
        return h(
          'div',
          { className: 'wbm-content' },
          h(
            'div',
            { className: 'wbm-stats' },
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, '项目'), h('div', { className: 'v' }, totals.projects)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, '条目'), h('div', { className: 'v' }, totals.entries)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, '日期文件'), h('div', { className: 'v' }, totals.dailyFiles)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, '待归档'), h('div', { className: 'v' }, totals.stale)),
          ),
          attention.length
            ? h(
                'div',
                null,
                h('div', { className: 'wbm-h2' }, '需要关注'),
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
                      h('button', { type: 'button', className: 'wbm-btn', onClick: () => selectProject(item.row) }, '查看'),
                    ),
                  ),
                ),
              )
            : h('div', { className: 'wbm-note', style: { padding: '12px 0' } }, '没有需要立即处理的项目。'),
          h('div', { className: 'wbm-h2' }, '最近活跃'),
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
                    h('span', { className: 'wbm-meta' }, `${row.entries ?? 0} 条 · ${humanBytes(row.bytes)} · ${relativeTime(row.lastActiveAt)}`),
                    h('button', { type: 'button', className: 'wbm-btn', onClick: () => selectProject(row) }, '打开'),
                  ),
                ),
              )
            : h('div', { className: 'wbm-note', style: { padding: '12px 0' } }, '还没有任何项目写过记忆。'),
          h(
            'div',
            { className: 'wbm-h2' },
            '全局记忆',
          ),
          h(
            'div',
            { className: 'wbm-list' },
            h(
              'div',
              { className: 'wbm-list-row' },
              h('span', { className: 'wbm-name' }, '用户 MEMORY.md'),
              h('span', { className: 'wbm-meta' }, user ? `${user.entries ?? 0} 条 · ${ratio(user.chars, limits.user).percent}%` : '不可读'),
              h('button', { type: 'button', className: 'wbm-btn', onClick: () => openFile('user-memory', undefined, null) }, '打开'),
            ),
            profile?.exists
              ? h(
                  'div',
                  { className: 'wbm-list-row' },
                  h('span', { className: 'wbm-name' }, '用户画像'),
                  h('span', { className: 'wbm-meta' }, profile.ambiguous ? '多个候选，未使用' : `${humanBytes(profile.bytes)} · 只读`),
                  h('button', { type: 'button', className: 'wbm-btn', onClick: () => openFile('profile', undefined, null) }, '查看'),
                )
              : null,
          ),
        )
      }

      // ── document view ─────────────────────────────────────────────────────

      function docTitle() {
        if (!selected) return ''
        if (selected.target === 'project-daily') return selected.date ?? '日期笔记'
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
            h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => saveEntry(section.heading, entry.line, editing.value, entry.text) }, '保存'),
            h('button', { type: 'button', className: 'wbm-btn', onClick: () => setEditing(null) }, '取消'),
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
              title: writable ? '点击编辑' : undefined,
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
                h('button', { type: 'button', className: 'wbm-icon', title: '编辑', onClick: () => setEditing({ section: section.heading, line: entry.line, value: entry.text }) }, h(PencilIcon)),
                h('button', { type: 'button', className: 'wbm-icon', title: '删除', onClick: () => removeEntry(section.heading, entry.line) }, h(TrashIcon)),
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
            h('span', { className: 'wbm-count' }, `${entries.length} 条`),
            h('span', { className: 'wbm-spacer' }),
            stepEditVisible
              ? h(
                  'button',
                  { type: 'button', className: 'wbm-icon', title: '编辑小节', onClick: () => setSectionEdit({ section: section.heading, body: sectionRaw(section) }) },
                  h(PencilIcon),
                )
              : null,
            writable
              ? h(
                  'button',
                  { type: 'button', className: 'wbm-icon', title: '删除小节', onClick: () => setDialog({ kind: 'remove-section', section: section.heading }) },
                  h(TrashIcon),
                )
              : null,
            writable
              ? h(
                  'button',
                  { type: 'button', className: 'wbm-icon', title: '在这个小节加一条', onClick: () => setAdding({ section: section.heading, value: '' }) },
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
                  h('span', { className: 'wbm-note', style: { padding: 0 } }, '只写 `- ` 条目和空行；标题与普通段落会被拒绝。'),
                  h('span', { className: 'wbm-spacer' }),
                  h('button', { type: 'button', className: 'wbm-btn', onClick: () => setSectionEdit(null) }, '取消'),
                  h('button', { type: 'button', className: 'wbm-btn primary', disabled: busy, onClick: () => saveSection(section.heading, sectionEdit.body) }, '保存小节'),
                ),
              )
            : null,
          !isEditingSection && entries.length === 0
            ? h('div', { className: 'wbm-note' }, query ? '没有匹配的条目' : '（空小节）')
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
                  placeholder: '新条目内容，Enter 保存，Ctrl/Cmd+Enter 继续添加',
                  onChange: (event) => setAdding({ ...adding, value: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !event.shiftKey && adding.value.trim()) {
                      addEntry(section.heading, adding.value, event.metaKey || event.ctrlKey)
                    }
                    if (event.key === 'Escape') setAdding(null)
                  },
                }),
                h('button', { type: 'button', className: 'wbm-btn primary', disabled: busy || !adding.value.trim(), onClick: () => addEntry(section.heading, adding.value) }, '保存'),
                h('button', { type: 'button', className: 'wbm-btn', onClick: () => setAdding(null) }, '取消'),
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
        const validation = current.length > 262144 ? '文件超过 256 KB' : null
        return h(
          'div',
          { className: 'wbm-editor' },
          h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } }, '源码模式'),
          h('textarea', {
            className: 'wbm-textarea',
            style: { minHeight: '320px' },
            value: current,
            spellCheck: false,
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') saveSource(current)
              if (event.key === 'Escape') setSourceEdit(null)
            },
            onChange: (event) => setSourceEdit({ text: event.target.value }),
          }),
          validation ? h('div', { className: 'wbm-banner warn' }, validation) : null,
          h(
            'div',
            { className: 'wbm-editor-bar' },
            h('span', { className: 'wbm-note', style: { padding: 0 } }, '保存前会做结构校验；每次写入都会先备份。'),
            h('span', { className: 'wbm-spacer' }),
            h('button', { type: 'button', className: 'wbm-btn', onClick: () => setSourceEdit(null) }, '取消'),
            h('button', { type: 'button', className: 'wbm-btn primary', disabled: busy || Boolean(validation), onClick: () => saveSource(current) }, '保存整份文件'),
          ),
        )
      }

      function newSectionEditor() {
        if (!newSection) return null
        const daily = selected?.target === 'project-daily'
        return h(
          'div',
          { className: 'wbm-editor' },
          h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } }, daily ? '添加日期条目' : '新建小节'),
          daily
            ? null
            : h('input', {
                className: 'wbm-input',
                autoFocus: true,
                value: newSection.heading,
                placeholder: '小节标题，例如：工具环境坑',
                onChange: (event) => setNewSection({ ...newSection, heading: event.target.value }),
              }),
          daily ? null : h('div', { style: { height: '6px' } }),
          h('input', {
            className: 'wbm-input',
            autoFocus: daily,
            value: newSection.text,
            placeholder: daily ? '新条目内容' : '第一条内容（可留空，稍后再加）',
            onChange: (event) => setNewSection({ ...newSection, text: event.target.value }),
          }),
          h(
            'div',
            { className: 'wbm-editor-bar' },
            h('span', { className: 'wbm-spacer' }),
            h('button', { type: 'button', className: 'wbm-btn', onClick: () => setNewSection(null) }, '取消'),
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
                    text: newSection.text.trim() || '（待补充）',
                    expectedRevision: doc?.revision,
                  })
                  if (result?.ok) {
                    setNewSection(null)
                    flash(daily ? '已添加' : '小节已创建')
                    await reload()
                  }
                },
              },
              daily ? '添加' : '创建',
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
                h('span', null, '这个文件在别处被改过了，屏幕上是旧内容。'),
                h('button', { type: 'button', className: 'wbm-btn', onClick: reload }, '重新加载'),
              )
            : null,
          !panelWriteOn && selected?.target !== 'profile'
            ? h(
                'div',
                { className: 'wbm-banner lock' },
                h(LockIcon),
                h('span', null, state?.readOnly ? '只读模式已开启。' : state?.writeEnabled === false ? '写入开关是关的。' : '面板编辑未开启。'),
                h('span', { className: 'wbm-spacer' }),
                !state?.readOnly && state?.writeEnabled !== false
                  ? h('button', { type: 'button', className: 'wbm-btn primary', onClick: enableEditing }, '启用编辑')
                  : null,
              )
            : null,
          target === 'project-daily'
            ? h('div', { className: 'wbm-banner' }, '日期笔记是追加文件：可以加条目，不能按条目改写或删除。')
            : null,
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '10px 0' } },
            h('input', {
              ref: searchRef,
              className: 'wbm-search',
              type: 'search',
              value: query,
              placeholder: '搜索当前文件的条目…  Ctrl/Cmd+F',
              onChange: (event) => setQuery(event.target.value),
            }),
            query ? h('span', { className: 'wbm-count' }, `${sections.reduce((sum, section) => sum + section.entries.length, 0)} 条匹配`) : null,
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
                  '添加一条',
                ),
              )
            : null,
          !isSource && doc?.entries === 0 && (doc?.sections ?? []).length === 0 && !newSection
            ? h(
                'div',
                { className: 'wbm-empty' },
                h(ProjectIcon, { size: 28 }),
                h('div', { className: 't' }, '这个文件还是空的'),
                writable
                  ? h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => setNewSection({ heading: '记录', text: '' }) }, '添加第一条')
                  : null,
              )
            : null,
          !isSource ? sections.map((section) => renderSection(section)) : null,
        )
      }

      // ── detail shell ──────────────────────────────────────────────────────

      function docHeader() {
        const target = selected?.target
        return h(
          'div',
          { className: 'wbm-doc-head' },
          h(
            'div',
            { className: 'wbm-doc-title' },
            h('span', null, docTitle()),
            target === 'profile' ? h('span', { className: 'wbm-chip' }, '只读') : null,
            target === 'project-daily' ? h('span', { className: 'wbm-chip' }, '追加') : null,
            doc ? h('span', { className: 'wbm-chip' }, `${doc.entries ?? 0} 条 · ${humanBytes(doc.bytes)}`) : null,
            doc?.revision ? h('span', { className: 'wbm-chip' }, `rev ${doc.revision}`) : null,
          ),
          doc?.path ? h('div', { className: 'wbm-doc-path' }, doc.path) : null,
          h(
            'div',
            { className: 'wbm-doc-actions' },
            selected && doc && writable && target !== 'profile' && target !== 'project-daily'
              ? h('button', { type: 'button', className: 'wbm-btn', onClick: () => setNewSection({ heading: '', text: '' }) }, h(PlusIcon), '新建小节')
              : null,
            canSource
              ? h('button', { type: 'button', className: 'wbm-btn', onClick: openSource }, h(SourceIcon), '源码')
              : null,
            selected && writable && target === 'project-memory'
              ? h('button', { type: 'button', className: 'wbm-btn', onClick: () => setDialog({ kind: 'prune' }) }, h(SparkIcon), '归档旧日期')
              : null,
            h('span', { className: 'wbm-spacer' }),
            h('button', { type: 'button', className: 'wbm-btn', onClick: reload, disabled: busy }, h(RefreshIcon), '重新加载'),
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
              h('div', { className: 't' }, '还没有认到当前项目'),
              h('div', { className: 'd' }, '在某个项目的会话里发一句话，或者直接从下面选一个项目。'),
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
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, '条目'), h('div', { className: 'v' }, project.entries)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, '字节'), h('div', { className: 'v' }, humanBytes(project.bytes))),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, '日期文件'), h('div', { className: 'v' }, project.daily)),
            h('div', { className: 'wbm-stat' }, h('div', { className: 'k' }, '最近活跃'), h('div', { className: 'v', style: { fontSize: '13px' } }, relativeTime(project.lastActiveAt))),
          ),
          h(
            'div',
            { className: 'wbm-banner' },
            h('span', null, project.path),
            h('span', { className: 'wbm-spacer' }),
            project.hasMemory
              ? h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => openFile('project-memory', undefined, project.key) }, '打开 MEMORY.md')
              : h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => openFile('project-memory', undefined, project.key) }, '创建 MEMORY.md'),
            project.latestDaily
              ? h('button', { type: 'button', className: 'wbm-btn', onClick: () => openFile('project-daily', project.latestDaily, project.key) }, `最新日期 ${project.latestDaily}`)
              : null,
          ),
          project.overLimit
            ? h('div', { className: 'wbm-banner warn' }, `已用 ${project.chars} 字，超过注入限额 ${limits.project}，下一轮注入会截断。`)
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
                    h('div', { className: 't' }, '这个文件还不存在'),
                    h('div', { className: 'd' }, '可以直接添加第一条条目；写入时会自动创建文件。'),
                    writable || canAppend
                      ? h('button', { type: 'button', className: 'wbm-btn primary', onClick: () => setNewSection({ heading: selected.target === 'project-daily' ? '' : '记录', text: '' }) }, '添加第一条')
                      : null,
                    newSection ? newSectionEditor() : null,
                  ),
          ),
        )
      }

      function picker() {
        if (layout !== 'narrow' && !props?.tab) return null
        const options = [{ value: '', label: '选择文件…' }]
        if (project) options.push({ value: 'project-memory', label: 'MEMORY.md' })
        for (const file of projectDetail?.daily ?? []) options.push({ value: `project-daily:${file.date}`, label: `${file.date}（${humanBytes(file.bytes)}）` })
        if (user?.memoryExists) options.push({ value: 'user-memory', label: '用户 MEMORY.md' })
        if (profile?.exists) options.push({ value: 'profile', label: '用户画像（只读）' })
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
                ? h('button', { type: 'button', className: 'wbm-btn', onClick: undoLast, disabled: busy }, '撤销')
                : null,
            )
          : null,
        error
          ? h(
              'div',
              { className: 'wbm-banner warn', style: { margin: '8px 16px 0' } },
              h('span', null, error),
              h('span', { className: 'wbm-spacer' }),
              h('button', { type: 'button', className: 'wbm-icon', title: '关闭', onClick: () => setError('') }, h(CloseIcon)),
            )
          : null,
        h('div', { className: 'wbm-layout' }, rail(), detail()),
        conflict ? h(ConflictDialog, { conflict, doc, act, getJson, selected, projectKey: effectiveKey, onClose: () => setConflict(null), reload, flash }) : null,
        confirmSource
          ? h(SourceConfirmDialog, {
              allowed: flags.allowFullTextEdit,
              onClose: () => setConfirmSource(false),
              onConfirm: () => openSourceAfterConfirm(!flags.allowFullTextEdit),
            })
          : null,
        dialog?.kind === 'prune'
          ? h(PruneDialog, { projectKey: effectiveKey, act, onClose: () => setDialog(null), flash, reload })
          : null,
        dialog?.kind === 'remove-section'
          ? h(ConfirmDialog, {
              title: '删除小节',
              message: `确定删除「${dialog.section}」及它的全部条目？写入前会先备份。`,
              confirmLabel: '删除',
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
      const name = cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : '项目记忆'
      return h('span', { title: cwd ?? '' }, `${name} · 记忆`)
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
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: `wbm-btn ${danger ? 'danger' : 'primary'}`, onClick: onConfirm }, confirmLabel),
          ),
        ),
      )
    }

    function SourceConfirmDialog({ allowed, onClose, onConfirm }) {
      return h(
        'div',
        { className: 'wbm-mask' },
        h(
          'div',
          { className: 'wbm-modal' },
          h('div', { className: 'h' }, allowed ? '进入源码模式？' : '开启全文编辑？'),
          h(
            'div',
            { className: 'd' },
            allowed
              ? '源码模式会整文件写入。结构校验、备份和撤销仍然生效，但一次误改可能同时影响多个小节。确认后本次浏览器会话不再重复提示。'
              : '全文编辑当前是关闭的。开启后可以整文件编辑；保存前仍会做结构校验并先备份。确认后会同时打开源码模式。',
          ),
          h(
            'div',
            { className: 'row', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'wbm-btn primary', onClick: onConfirm }, allowed ? '我明白，打开源码' : '开启并打开'),
          ),
        ),
      )
    }

    function ConflictDialog({ conflict, doc, act, getJson, selected, projectKey, onClose, reload, flash }) {
      const [busy, setBusy] = React.useState(false)
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
          h('div', { className: 'h' }, '文件已被改动'),
          h('div', { className: 'd' }, `你看到的是 ${doc?.revision ?? '—'}，磁盘上是 ${diskRevision ?? '—'}。草稿没有丢，选一个：`),
          diff?.error ? h('div', { className: 'wbm-banner warn' }, diff.error) : null,
          diff && !diff.error
            ? h(
                'div',
                { className: 'wbm-diff' },
                diff.truncated
                  ? h('div', null, '文件太大，只给统计。')
                  : diff.rows.slice(0, 240).map((row, index) =>
                      h('div', { key: index, className: row.type }, `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} ${row.text}`),
                    ),
              )
            : null,
          h(
            'div',
            { className: 'row' },
            h('button', { type: 'button', className: 'wbm-btn', onClick: showDiff }, '查看磁盘差异'),
            h('span', { className: 'wbm-spacer', style: { flex: 1 } }),
            h(
              'button',
              {
                type: 'button',
                className: 'wbm-btn primary',
                onClick: async () => {
                  onClose()
                  setBusy(false)
                  await reload()
                },
              },
              '重新加载（丢弃草稿）',
            ),
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, '保留草稿继续编辑'),
            h(
              'button',
              {
                type: 'button',
                className: 'wbm-btn danger',
                disabled: busy,
                onClick: async () => {
                  setBusy(true)
                  const payload = { ...conflict.payload }
                  delete payload.expectedRevision
                  const result = await act({ ...payload, key: projectKey })
                  setBusy(false)
                  if (result?.ok) {
                    onClose()
                    flash('已覆盖写入')
                    await reload()
                  }
                },
              },
              '覆盖磁盘（先备份）',
            ),
          ),
        ),
      )
    }

    function PruneDialog({ projectKey, act, onClose, flash, reload }) {
      const [plan, setPlan] = React.useState(null)
      const [picked, setPicked] = React.useState(null)
      const [beforeDays, setBeforeDays] = React.useState(30)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const load = React.useCallback(
        async (days) => {
          setBusy(true)
          setError('')
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
      const totals = pickedRows.reduce((sum, row) => sum + (row.entries ?? 0), 0)

      return h(
        'div',
        { className: 'wbm-mask' },
        h(
          'div',
          { className: 'wbm-modal' },
          h('div', { className: 'h' }, '归档旧日期文件'),
          h('div', { className: 'd' }, '把早于指定天数的日期流水移动到 memory/archive/，不写入 MEMORY.md。请先确认已把值得长期保留的结论蒸馏进 MEMORY.md；归档后原始流水仍可在 archive/ 找回。'),
          h(
            'div',
            { className: 'row' },
            h('span', { className: 'wbm-meta' }, '早于'),
            h('input', {
              className: 'wbm-input',
              style: { width: '80px' },
              type: 'number',
              min: 1,
              value: beforeDays,
              onChange: (event) => setBeforeDays(Number(event.target.value) || 1),
            }),
            h('span', { className: 'wbm-meta' }, '天'),
            h('button', { type: 'button', className: 'wbm-btn', onClick: () => load(beforeDays), disabled: busy }, '重新出计划'),
          ),
          error ? h('div', { className: 'wbm-banner warn' }, error) : null,
          !plan
            ? h('div', { className: 'wbm-note' }, busy ? '正在扫描…' : '没有结果')
            : candidates.length === 0
              ? h('div', { className: 'wbm-note' }, `${beforeDays} 天以前没有日期文件。`)
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
                          setPicked(next)
                        },
                      }),
                      h(
                        'span',
                        { style: { minWidth: 0, flex: 1 } },
                        h('span', { style: { fontWeight: 600, display: 'block' } }, `${row.date} · ${row.entries ?? 0} 条 · ${humanBytes(row.bytes)}`),
                      ),
                    ),
                  ),
                ),
          h(
            'div',
            { className: 'row', style: { justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'wbm-btn', onClick: onClose }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'wbm-btn primary',
                disabled: busy || pickedRows.length === 0,
                onClick: async () => {
                  setBusy(true)
                  const dates = pickedRows.map((row) => row.date)
                  const body = await act({ type: 'prune', dryRun: false, beforeDays, dates, key: projectKey })
                  setBusy(false)
                  if (body?.ok) {
                    flash(`已归档 ${body.pruned?.length ?? 0} 个日期文件`)
                    onClose()
                    await reload()
                  } else {
                    setError(describeCode(body?.code ?? 'failed'))
                  }
                },
              },
              busy ? '执行中…' : `归档 ${pickedRows.length} 个文件`,
            ),
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
          title: '项目记忆',
          'aria-label': '项目记忆',
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
              { name: 'sidebar.panellist', id: PANEL_OVERVIEW, order: 26, locale: NS, label: () => '记忆' },
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
                title: () => '项目记忆',
                guide: [
                  {
                    id: 'memory',
                    order: 40,
                    title: () => '项目记忆',
                    description: () => '当前项目的 MEMORY.md、日期笔记与全局用户记忆',
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
      inject: ['slots'],
      __internals: {
        humanBytes,
        ratio,
        filterEntries,
        highlightParts,
        lineDiff,
        describeCode,
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
        PruneDialog,
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
