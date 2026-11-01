/**
 * Client half of @yg/dsh-archived-delete.
 *
 * Two surfaces, one action:
 *
 *   - a row in a Session's "..." menu (`sidebar.workspaces.session.menu.item`)
 *     that renders only while that Session is archived, because a live
 *     conversation is not something a menu row should be able to destroy;
 *   - a confirmation card in `shell.overlay`, since the delete is permanent and
 *     the row is one stray click away from the archive toggle above it.
 *
 * The row owns no policy of its own: it posts the Session id to the Host
 * endpoint, and the Host re-checks that the Session is neither live nor
 * unarchived before it touches anything.
 */

window.__ModuleLoader__.load({
  id: '@yg/dsh-archived-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MENU_ID = 'yg-archived-delete'
    const OVERLAY_ID = 'yg-archived-delete-dialog'
    const MENU_ORDER = 500
    const OVERLAY_ORDER = 940
    const ROW_CLASS = 'yg-ad-menu-row'

    let hostContext = null

    const TEXT = {
      zh: {
        menuLabel: '删除对话',
        title: '删除已归档对话',
        untitled: '未命名对话',
        body: '这条对话的归档记录、会话日志和投影缓存会一起删掉。删除后无法恢复。',
        keep: '取消',
        confirm: '永久删除',
        pending: '正在删除…',
        done: '已删除，界面即将刷新',
        failed: '删除失败',
        escape: '按 Esc 取消',
      },
      en: {
        menuLabel: 'Delete conversation',
        title: 'Delete archived conversation',
        untitled: 'Untitled conversation',
        body: 'The archived entry, the session log and its projection cache are removed together. This cannot be undone.',
        keep: 'Cancel',
        confirm: 'Delete permanently',
        pending: 'Deleting…',
        done: 'Deleted, refreshing the sidebar',
        failed: 'Delete failed',
        escape: 'Press Esc to cancel',
      },
    }

    function text() {
      try {
        const active = hostContext.locale.getLocale().active
        return typeof active === 'string' && active.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en
      } catch {
        return TEXT.en
      }
    }

    /** The web app may be served from a sub-path, so the route hangs off the base directory. */
    function apiUrl(method) {
      const base = new URL(document.baseURI)
      const path = base.pathname
      const directory = path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1)
      return `${base.origin}${directory}yg-archived-delete/api/${method}`
    }

    /* --------------------------------------------------------- shared state -- */

    // One factory instance serves both slots, so a tiny emitter is enough to
    // hand the pending Session from the menu row to the overlay card.
    const pending = {
      value: null,
      listeners: new Set(),
      set(next) {
        pending.value = next
        for (const listener of [...pending.listeners]) listener()
      },
      subscribe(listener) {
        pending.listeners.add(listener)
        return () => pending.listeners.delete(listener)
      },
    }

    function usePending() {
      const [, bump] = React.useState(0)
      React.useEffect(() => pending.subscribe(() => bump((value) => value + 1)), [])
      return pending.value
    }

    function isArchived(snapshot, sessionId) {
      const ids = snapshot?.archivedSessionIds
      if (ids === undefined || ids === null) return false
      if (typeof ids.has === 'function') return ids.has(sessionId)
      if (Array.isArray(ids)) return ids.includes(sessionId)
      return false
    }

    /* ----------------------------------------------------------------- icon -- */

    function TrashIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2.6 4.3h10.8' }),
        h('path', { d: 'M6.4 4.3V3.1a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.2' }),
        h('path', { d: 'M4.1 4.3l.7 8.4a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.7-8.4' }),
        h('path', { d: 'M6.7 6.9v4.2M9.3 6.9v4.2' }),
      )
    }

    /* -------------------------------------------------------------- the row -- */

    function rowStyles() {
      // Inline styles cannot express :hover, and the menu owns its own hover
      // paint, so the row ships one scoped rule rendered with the component.
      return `.${ROW_CLASS}{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;
padding:7px 10px;border:0;border-radius:7px;background:transparent;cursor:pointer;text-align:left;
font:13px/1.35 system-ui,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#ededed);
transition:background 110ms ease,color 110ms ease;}
.${ROW_CLASS}:hover,.${ROW_CLASS}:focus-visible{background:color-mix(in oklab,var(--dsw-alias-label-primary,#ededed) 9%,transparent);
outline:none;}
.${ROW_CLASS}:hover{color:var(--dsw-alias-state-error-primary,#ff5f5f);}
.${ROW_CLASS}[disabled]{opacity:.55;cursor:default;}
.${ROW_CLASS} svg{flex:none;}
.${ROW_CLASS}-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`
    }

    // The shipped rows above carry their own separators, so this row draws one
    // top border to read as the end of the menu rather than a stray extra.
    const ROW_FRAME = { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))', paddingTop: '9px' }

    function DeleteArchivedMenuItem(props) {
      // Slot injections are declared by whoever owns the slot; source our two
      // hooks off props so a missing injection degrades to "row hidden" instead
      // of taking the whole "..." menu down with a destructuring error.
      const { sessionId, displayTitle, useMenuOpenState, useWorkspaces } = props
      const [, setMenuOpen] = typeof useMenuOpenState === 'function' ? useMenuOpenState() : [false, () => {}]
      const archived = typeof useWorkspaces === 'function' ? useWorkspaces((state) => isArchived(state, sessionId)) : false
      if (archived !== true) return null
      const labels = text()
      return h(
        React.Fragment,
        null,
        h('style', { key: 'yg-ad-style' }, rowStyles()),
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: ROW_CLASS,
            'data-yg-archived-delete': sessionId,
            title: labels.menuLabel,
            style: ROW_FRAME,
            onClick: () => {
              setMenuOpen(false)
              pending.set({ sessionId, title: displayTitle ?? '' })
            },
          },
          h(TrashIcon, null),
          h('span', { className: `${ROW_CLASS}-label` }, labels.menuLabel),
        ),
      )
    }

    /* ----------------------------------------------------------- the dialog -- */

    const S = {
      layer: {
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'rgba(0,0,0,0.42)',
      },
      card: {
        width: 'min(420px, 100%)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '18px',
        borderRadius: '13px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-overlay, #1f1f22)',
        boxShadow: '0 22px 60px rgba(0,0,0,0.42)',
        color: 'var(--dsw-alias-label-primary, #ededed)',
        font: '13px/1.5 system-ui, "Segoe UI", sans-serif',
      },
      title: { fontSize: '14px', fontWeight: 600 },
      subject: {
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
        background: 'var(--dsw-alias-bg-layer-1, #26262a)',
        fontSize: '12.5px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      body: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary, #9a9a9a)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #ff5f5f)' },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #9a9a9a)' },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '2px' },
      button: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #ededed)',
        font: '13px/1.2 system-ui, "Segoe UI", sans-serif',
        cursor: 'pointer',
      },
      danger: {
        border: '1px solid var(--dsw-alias-state-error-primary, #ff5f5f)',
        background: 'color-mix(in oklab, var(--dsw-alias-state-error-primary, #ff5f5f) 16%, transparent)',
        color: 'var(--dsw-alias-state-error-primary, #ff5f5f)',
      },
    }

    function DeleteArchivedDialog() {
      const request = usePending()
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const cancelRef = React.useRef(null)

      const close = React.useCallback(() => {
        if (busy === true) return
        pending.set(null)
        setError(null)
        setStatus(null)
      }, [busy])

      React.useEffect(() => {
        if (request === null) return undefined
        setError(null)
        setStatus(null)
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        const focus = window.setTimeout(() => cancelRef.current?.focus?.(), 0)
        return () => {
          window.removeEventListener('keydown', onKeyDown, true)
          window.clearTimeout(focus)
        }
      }, [request, close])

      if (request === null) return null
      const labels = text()

      const confirm = async () => {
        setBusy(true)
        setError(null)
        setStatus(labels.pending)
        try {
          const response = await fetch(apiUrl('delete'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: request.sessionId }),
          })
          const payload = await response.json()
          if (payload !== null && payload.ok === true) {
            setStatus(labels.done)
            // The sidebar's session catalog is a client-side snapshot: the Host
            // deleting files cannot reach into it, so re-mount the surface once
            // the record is gone.
            window.setTimeout(() => window.location.reload(), 520)
            return
          }
          const detail = payload?.error?.message ?? `HTTP ${response.status}`
          setError(`${labels.failed}: ${detail}`)
          setStatus(null)
        } catch (failure) {
          setError(`${labels.failed}: ${failure?.message ?? String(failure)}`)
          setStatus(null)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        {
          style: S.layer,
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          { style: S.card, role: 'dialog', 'aria-modal': 'true', 'aria-label': labels.title },
          h('div', { style: S.title }, labels.title),
          h('div', { style: S.subject }, request.title === '' ? labels.untitled : request.title),
          h('div', { style: S.body }, labels.body),
          error === null ? null : h('div', { style: S.error }, error),
          status === null ? null : h('div', { style: S.status }, status),
          h(
            'div',
            { style: S.footer },
            h(
              'button',
              {
                type: 'button',
                ref: cancelRef,
                style: S.button,
                disabled: busy,
                onClick: close,
                title: labels.escape,
              },
              labels.keep,
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.button, ...S.danger },
                disabled: busy,
                onClick: confirm,
              },
              labels.confirm,
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'workspaces', 'locale'],
      apply(ctx) {
        hostContext = ctx
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: MENU_ID, order: MENU_ORDER },
            DeleteArchivedMenuItem,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: OVERLAY_ORDER }, DeleteArchivedDialog),
        )
        return () => {
          hostContext = null
          pending.set(null)
          pending.listeners.clear()
        }
      },
    }
  },
})
