/**
 * dsh-handoff — browser half.
 *
 * One contribution to `conversation.session.header.utilities`: a "handoff to"
 * control. Clicking it opens a small dialog that
 *
 *   1. picks a focus directory with the native macOS folder chooser (`/api/handoff.pick`)
 *   2. exports the session to `<workspace>/.dsh-handoff/dsh-<ts>-<uuid8>.md` (`/api/handoff.export`)
 *   3. shows the paste-ready prompt and copies it
 *   4. can clear earlier exports of this workspace (`/api/handoff.clear`)
 *
 * The dialog is plain DOM inside a fixed overlay: it needs no router, no portal
 * and no host dialog primitive, so it keeps working if `dsh-client-ui-primitives`
 * changes shape.
 *
 * @module dsh-plugin-handoff/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-handoff',
  factory(require) {
    const React = require('react')

    /** Host primitives are optional at runtime; the dialog must still render without them. */
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch {
      primitives = {}
    }

    const h = React.createElement

    function FallbackButton({ children, onClick, disabled, title }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        title,
        style: {
          appearance: 'none',
          border: '1px solid var(--dsw-alias-border-l1, #d8d8dc)',
          background: 'transparent',
          color: 'inherit',
          borderRadius: 8,
          padding: '5px 12px',
          fontSize: 13,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        },
      }, children)
    }

    const Button = primitives.Button ?? FallbackButton

    /**
     * Copy through the host primitive only when it *confirms* success; an
     * undefined return is not a confirmation, so the async Clipboard API is tried
     * as well. A silently dead copy button is the one outcome this must avoid.
     */
    async function writeClipboard(text) {
      try {
        if (typeof primitives.writeClipboard === 'function') {
          const ok = await primitives.writeClipboard(text)
          if (ok === true) return true
        }
      } catch { /* fall through to the platform API */ }
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    async function post(name, body) {
      const response = await fetch(`/api/handoff.${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `request failed (${response.status})`)
      }
      return payload
    }

    const S = {
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgb(0 0 0 / 32%)',
      },
      card: {
        width: 640,
        maxWidth: 'calc(100vw - 48px)',
        maxHeight: 'calc(100vh - 96px)',
        overflow: 'auto',
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l1, #d8d8dc)',
        background: 'var(--dsw-alias-bg-overlay, #fff)',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        boxShadow: '0 18px 48px rgb(0 0 0 / 24%)',
        padding: 20,
        fontSize: 13,
        lineHeight: 1.5,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 },
      path: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        padding: '6px 8px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-l1, #f4f4f6)',
      },
      area: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 190,
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1, #d8d8dc)',
        background: 'var(--dsw-alias-bg-l1, #f4f4f6)',
        color: 'inherit',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        resize: 'vertical',
      },
      muted: { color: 'var(--dsw-alias-label-secondary, #6b6b72)', fontSize: 12 },
      error: { color: 'var(--dsw-alias-state-error-primary, #c0392b)', fontSize: 12 },
    }

    /**
     * The header control plus its dialog.
     * @param props.sessionId - the Session currently open (standard slot prop).
     */
    /** Quick client-side check; the host re-lints authoritatively on save. */
    function quickLint(text, placeholders) {
      const problems = []
      const body = String(text ?? '')
      const known = new Set((placeholders ?? []).map((p) => p.key))
      if (body.trim() === '') problems.push({ level: 'error', message: '模板不能为空' })
      for (const match of body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
        const key = match[1]
        if (key === '') problems.push({ level: 'error', message: '有空占位符 {{}}' })
        else if (!known.has(key)) problems.push({ level: 'error', message: `未知占位符 {{${key}}}` })
      }
      const stripped = body.replace(/\{\{\s*[^}]*?\s*\}\}/g, '')
      if (stripped.includes('{{') || stripped.includes('}}')) {
        problems.push({ level: 'error', message: '有未闭合的 {{ 或多余的 }}' })
      }
      const used = [...body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1])
      const onlyNullable = used.length > 0 && used.every((key) => key === 'focus_block')
      if (onlyNullable && body.replace(/\{\{\s*[^}]*?\s*\}\}/g, '').trim() === '') {
        problems.push({ level: 'error', message: '模板只有 {{focus_block}}：focus 等于工作区时会渲染成空 prompt' })
      }
      if (!/\{\{\s*file\s*\}\}/.test(body)) problems.push({ level: 'warn', message: '没有引用 {{file}}：接收方可能不知道要读哪个文件' })
      if (!/\{\{\s*workspace\s*\}\}/.test(body)) problems.push({ level: 'warn', message: '没有引用 {{workspace}}：接收方不知道沙盒边界' })
      return problems
    }

    const LINT_COLOR = {
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      warn: 'var(--dsw-alias-state-warn-label, #b26b00)',
      info: 'var(--dsw-alias-label-secondary, #6b6b72)',
    }

    /**
     * The header control and its two-pane dialog: handoff, and the prompt template.
     * @param props.sessionId - the Session currently open (standard slot prop).
     */
    function HandoffControl({ sessionId }) {
      const [open, setOpen] = React.useState(false)
      const [view, setView] = React.useState('main')
      const [focus, setFocus] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [count, setCount] = React.useState(null)
      const [copied, setCopied] = React.useState(false)
      const [template, setTemplate] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [placeholders, setPlaceholders] = React.useState([])
      const [templatePath, setTemplatePath] = React.useState('')
      const [templateResolved, setTemplateResolved] = React.useState(null)
      const [lint, setLint] = React.useState([])
      const [saved, setSaved] = React.useState(false)

      const run = async (label, fn) => {
        setPending(label)
        setError(null)
        try {
          await fn()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setPending(null)
        }
      }

      const loadTemplate = async () => {
        const payload = await post('template', {})
        setTemplate(payload.template ?? '')
        setDraft(payload.template ?? '')
        setPlaceholders(payload.placeholders ?? [])
        setTemplatePath(payload.path ?? '')
        setTemplateResolved(payload.resolved ?? null)
        setLint(payload.lint ?? [])
      }

      const show = () => {
        setView('main')
        setFocus(null)
        setResult(null)
        setError(null)
        setCopied(false)
        setSaved(false)
        setOpen(true)
        // Count and template are independent: a missing session log must not leave
        // the editor with an empty template and every placeholder "unknown".
        void run('count', async () => {
          const payload = await post('clear', { session: sessionId, dryRun: true })
          setCount(payload.count)
        })
        void run('template', async () => { await loadTemplate() })
      }

      const close = () => setOpen(false)

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (view === 'template') setView('main')
          else close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, view])

      const pick = () => run('pick', async () => {
        const payload = await post('pick', { session: sessionId })
        if (payload.cancelled) return
        setFocus(payload.focus)
      })

      const generate = () => run('export', async () => {
        const payload = await post('export', { session: sessionId, focus: focus ?? undefined })
        setResult(payload)
        setCount((previous) => (typeof previous === 'number' ? previous + 1 : previous))
      })

      const copy = () => run('copy', async () => {
        if (!result) return
        const ok = await writeClipboard(result.prompt)
        if (!ok) throw new Error('复制失败，请手动选中文本复制')
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      })

      const clearAll = () => run('clear', async () => {
        const payload = await post('clear', { session: sessionId })
        setCount(0)
        setResult(null)
        setError(payload.count === 0 ? '没有可清除的导出' : null)
      })

      const openTemplate = () => {
        setError(null)
        setSaved(false)
        setView('template')
        // Refresh on every open: another window (or the CLI) may have saved since.
        void run('template', async () => { await loadTemplate() })
      }

      const insertPlaceholder = (key) => {
        setDraft((previous) => `${previous}${previous.endsWith(' ') || previous === '' ? '' : ' '}{{${key}}}`)
        setSaved(false)
      }

      const saveTemplate = () => run('save', async () => {
        const payload = await post('template.save', { template: draft })
        setTemplate(draft)
        setLint(payload.lint ?? [])
        setSaved(true)
        setTimeout(() => setSaved(false), 1600)
      })

      const resetTemplate = () => run('reset', async () => {
        const payload = await post('template.reset', {})
        setTemplate(payload.template ?? '')
        setDraft(payload.template ?? '')
        setLint(payload.lint ?? [])
      })

      const label = 'handoff to'

      const control = h(
        Button,
        { size: 'sm', 'aria-label': label, title: label, onClick: show },
        primitives.IconArrowUpRightRegular === undefined ? '↗' : h(primitives.IconArrowUpRightRegular, {}),
      )

      if (!open) return control

      const draftLint = view === 'template' ? quickLint(draft, placeholders) : []
      const shownLint = view === 'template' ? draftLint : lint
      const blocked = shownLint.some((p) => p.level === 'error')

      const editor = h(
        'div',
        { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'handoff prompt 模板', style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, 'handoff prompt 模板'),
          h('div', { style: S.muted }, '保存后下一次“生成 handoff”就用它')),
        h('div', { style: { ...S.muted, marginTop: 6 } },
          '可用占位符（点一下插入到末尾）：'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
          ...(placeholders ?? []).map((p) => h('button', {
            key: p.key,
            type: 'button',
            title: p.description,
            onClick: () => insertPlaceholder(p.key),
            style: {
              appearance: 'none',
              border: '1px solid var(--dsw-alias-border-l1, #d8d8dc)',
              background: 'var(--dsw-alias-bg-l1, #f4f4f6)',
              color: 'inherit',
              borderRadius: 999,
              padding: '2px 9px',
              fontSize: 12,
              cursor: 'pointer',
            },
          }, `{{${p.key}}}`))),
        h('div', { style: { ...S.muted, marginTop: 6, lineHeight: 1.6 } },
          (placeholders ?? []).map((p) => `${p.key}：${p.description}`).join('　·　')),
        h('textarea', {
          style: { ...S.area, minHeight: 260, marginTop: 10 },
          value: draft,
          spellCheck: false,
          onChange: (event) => { setDraft(event.target.value); setSaved(false) },
        }),
        shownLint.length > 0 && h('div', { style: { marginTop: 8, display: 'grid', gap: 3 } },
          ...shownLint.map((p, index) => h('div', {
            key: `${p.level}-${index}`,
            style: { fontSize: 12, color: LINT_COLOR[p.level] ?? 'inherit' },
          }, `${p.level === 'error' ? '错误' : p.level === 'warn' ? '警告' : '提示'}：${p.message}`))),
        shownLint.length === 0 && h('div', { style: { ...S.muted, marginTop: 8 } }, '检查通过'),
        h('div', { style: S.row },
          h(Button, { onClick: saveTemplate, disabled: pending !== null || blocked }, saved ? '已保存' : '保存'),
          h(Button, { onClick: resetTemplate, disabled: pending !== null }, '恢复默认'),
          h(Button, { onClick: () => setView('main') }, '返回')),
        templatePath !== '' && h('div', { style: { ...S.muted, marginTop: 10 } },
          templateResolved !== null && templateResolved !== templatePath
            ? `保存在 ${templatePath}（符号链接 → ${templateResolved}）`
            : `保存在 ${templatePath}`),
        error !== null && h('div', { style: { ...S.error, marginTop: 10 } }, error),
      )

      const main = h(
        'div',
        { role: 'dialog', 'aria-modal': 'true', 'aria-label': label, style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, label),
          h('div', { style: S.muted }, '导出当前会话为一个 Markdown 文件，并生成可粘贴的 prompt')),
        h('div', { style: S.row },
          h('div', { style: S.path, title: focus ?? undefined }, focus ?? '（默认：工作区根目录）'),
          h(Button, { onClick: pick, disabled: pending !== null }, pending === 'pick' ? '选择中…' : '选择文件夹…')),
        h('div', { style: S.row },
          h(Button, { onClick: generate, disabled: pending !== null }, pending === 'export' ? '生成中…' : '生成 handoff'),
          h(Button, { onClick: clearAll, disabled: pending !== null || count === 0 },
            count === null ? '清除旧导出' : `清除旧导出（${count}）`),
          h(Button, { onClick: openTemplate }, '模板…')),
        result !== null && h('div', { style: { marginTop: 12 } },
          h('div', { style: S.path, title: result.file }, result.file),
          h('div', { style: { ...S.muted, marginTop: 4 } },
            `${(result.bytes / 1024).toFixed(1)} KB · ${result.lines} 行 · ${result.turns} 轮`
            + (result.truncated ? ' · 日志尾部不完整（导出缺最后几轮）' : '')),
          h('textarea', {
            style: S.area,
            readOnly: true,
            value: result.prompt,
            onFocus: (event) => event.target.select(),
          }),
          h('div', { style: S.row },
            h(Button, { onClick: copy, disabled: pending !== null }, copied ? '已复制' : '复制 prompt'),
            h(Button, { onClick: close }, '关闭'))),
        result === null && h('div', { style: { ...S.muted, marginTop: 14 } },
          '生成后这里会显示文件路径和 prompt。'),
        error !== null && h('div', { style: { ...S.error, marginTop: 10 } }, error),
      )

      return h(React.Fragment, null, control, h(
        'div',
        { style: S.overlay, onClick: (event) => { if (event.target === event.currentTarget) close() } },
        view === 'template' ? editor : main,
      ))
    }


    /** Client services this plugin needs before it can register anything. */
    const inject = ['slots']

    /**
     * Register the header control.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'dsh-handoff.header',
            // Left of the shipped "..." menu (0), right of the copy-session-id control (-5).
            order: -3,
          },
          HandoffControl,
        ))
    }

    return { inject, apply }
  },
})
