import { useEffect, useRef, useState } from 'react'

import { requestJson } from './api.js'
import { connectionStateInfo, initialBoardForm, normalizeError, sourceLabel, validateBoardForm } from './model.js'
import { ErrorNotice, Pill } from './ui.jsx'

export default function BoardDialog({ board, error, loading, onChange, onClose, onReload, onStatus }) {
  const [form, setForm] = useState(() => initialBoardForm(board))
  const [actionError, setActionError] = useState(null)
  const [busy, setBusy] = useState('')
  const closeRef = useRef(null)
  const cardRef = useRef(null)

  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    const focusable = () => Array.from(cardRef.current?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) || []).filter((element) => element.offsetParent !== null)
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !cardRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
    }
  }, [onClose])

  async function post(kind, path, body) {
    setBusy(kind)
    setActionError(null)
    try {
      const next = await requestJson(path, { method: 'POST', body })
      onChange(next)
      return next
    } catch (nextError) {
      setActionError(normalizeError(nextError))
      return null
    } finally {
      setBusy('')
    }
  }

  async function save(event) {
    event.preventDefault()
    const validated = validateBoardForm(form)
    if (validated.error) {
      setActionError({ message: validated.error })
      return
    }
    const next = await post('save', '/api/board/select', validated.body)
    if (next) onStatus(`Selected ${next.target?.label || validated.body.host}.`)
  }

  async function reset() {
    const next = await post('reset', '/api/board/select', { reset: true })
    if (next) {
      setForm(initialBoardForm(next))
      onStatus(next.target ? `Using ${next.target.label}.` : 'Manual board selection cleared.')
    }
  }

  async function test() {
    const next = await post('test', '/api/board/test')
    if (next) onStatus(`Connected to ${next.board?.hostname || next.target?.label || 'the board'}.`)
  }

  async function trust() {
    const fingerprint = actionError?.details?.presented_fingerprint || error?.details?.presented_fingerprint
    if (!fingerprint) return
    const next = await post('trust', '/api/board/trust-host-key', { fingerprint })
    if (next) onStatus('Saved the board’s new SSH host key. Test the connection again.')
  }

  const target = board?.target
  const problem = actionError || error || normalizeError(board?.status?.error)
  const fingerprint = problem?.details?.presented_fingerprint
  const connection = connectionStateInfo(board?.status)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Board settings" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="board-dialog-card" ref={cardRef}>
        <header className="board-dialog-head">
          <div>
            <p className="sysinfo-eyebrow">Peripheral target</p>
            <h3>Selected board</h3>
          </div>
          <button type="button" ref={closeRef} onClick={onClose}>Close</button>
        </header>

        {loading && !board && <p className="hint">Loading board…</p>}
        {target && (
          <div className="board-dialog-current">
            <strong>{target.label}</strong>
            <Pill tone={connection.tone}>{connection.short}</Pill>
            {sourceLabel(target.source) && <Pill>{sourceLabel(target.source)}</Pill>}
            {board?.board?.hostname && <span>Hostname: {board.board.hostname}</span>}
          </div>
        )}

        <ErrorNotice error={problem}>
          {problem?.code === 'host_key_changed' && fingerprint && (
            <button type="button" className="btn-ghost danger" onClick={trust} disabled={Boolean(busy)}>Trust presented key</button>
          )}
        </ErrorNotice>

        <form className="board-dialog-form" onSubmit={save}>
          <label>Host or IP<input value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder="192.168.2.2" autoComplete="off" spellCheck={false} /></label>
          <label>SSH port<input type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} /></label>
          <label>User<input value={form.user} onChange={(event) => setForm({ ...form, user: event.target.value })} autoComplete="off" spellCheck={false} /></label>
          <div className="periph-actions">
            <button type="submit" className="btn-tonal" disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Use this board'}</button>
            {target && <button type="button" className="btn-ghost" onClick={test} disabled={Boolean(busy)}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>}
            {board?.saved && <button type="button" className="btn-ghost" onClick={reset} disabled={Boolean(busy)}>{busy === 'reset' ? 'Resetting…' : 'Use default'}</button>}
            <button type="button" className="btn-ghost" onClick={onReload} disabled={loading}>Reload</button>
          </div>
        </form>
      </div>
    </div>
  )
}
