import { useEffect, useRef, useState } from 'react'
import { copyText, requestJson } from './api.js'
import {
  connectionStateInfo,
  createFocusReturn,
  defaultTargetText,
  formatRelativeTime,
  initialBoardForm,
  normalizeError,
  sourceLabel,
  validateBoardForm
} from './model.js'
import { Callout, ErrorNotice, Pill } from './ui.jsx'

const IDENTITY_FIELDS = [['hostname', 'Hostname'], ['build_version', 'Build'], ['machine', 'Machine']]

function Facts({ rows }) {
  return (
    <dl className="periph-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function BoardTargetCard({
  board,
  loading = false,
  error = null,
  connectionError = null,
  description = 'Insight discovers peripherals on this board.',
  onBoardChange,
  onRetry,
  onReload,
  onStatus,
  onError,
  shell = null,
  shellBusy = false,
  onOpenShell
}) {
  const target = board?.target || null
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState('')
  const [actionError, setActionError] = useState(null)
  const [formError, setFormError] = useState(null)
  const [confirmTrust, setConfirmTrust] = useState(false)
  const sectionRef = useRef(null)
  const changeRef = useRef(null)
  const trustRef = useRef(null)
  const testRef = useRef(null)
  const hostRef = useRef(null)
  const focusReturn = useRef(null)
  if (!focusReturn.current) focusReturn.current = createFocusReturn()

  // Cancel, Save and Trust remove the button that has focus; give it back to the opener (or the
  // nearest control still shown) so the next Tab continues from there, not from the panel's top.
  useEffect(() => {
    focusReturn.current.flush()
  })

  function returnFocus(...refs) {
    focusReturn.current.request(() => [...refs, sectionRef].map((ref) => ref.current))
  }

  const values = form || initialBoardForm(board)
  const formOpen = Boolean(board) && (editing || !target)
  const problem = actionError || connectionError || normalizeError(board?.status?.error)
  const state = connectionStateInfo(board?.status)
  const checked = formatRelativeTime(board?.status?.checked_at)
  const identity = IDENTITY_FIELDS.filter(([key]) => board?.board?.[key]).map(([key, label]) => [label, board.board[key]])
  const defaultText = defaultTargetText(board?.defaults)
  const presented = problem?.details?.presented_fingerprint

  async function post(kind, url, body) {
    setBusy(kind)
    setActionError(null)
    setFormError(null)
    try {
      const data = await requestJson(url, { method: 'POST', body })
      onBoardChange(data)
      return data
    } catch (err) {
      if (kind === 'select') setFormError(normalizeError(err))
      else setActionError(normalizeError(err))
      if (kind === 'test') onReload?.()
      return null
    } finally {
      setBusy('')
    }
  }

  async function testConnection() {
    const data = await post('test', '/api/board/test')
    if (data) onStatus?.(`Connected to ${data.board?.hostname || data.target?.label || 'the board'}.`)
  }

  async function save(event) {
    event.preventDefault()
    const result = validateBoardForm(values)
    if (result.error) {
      setFormError({ message: result.error, hint: '' })
      return
    }
    const data = await post('select', '/api/board/select', result.body)
    if (data) closeForm(`Board set to ${data.target?.label || result.body.host}. Test the connection or refresh.`)
  }

  async function useDefault() {
    const data = await post('select', '/api/board/select', { reset: true })
    if (data) closeForm(data.target ? `Using ${data.target.label}.` : 'Manual board cleared.')
  }

  async function trustKey() {
    const data = await post('trust', '/api/board/trust-host-key', { fingerprint: presented })
    if (data) {
      setConfirmTrust(false)
      returnFocus(trustRef, testRef, changeRef)
      onStatus?.('Host key updated. Test the connection or refresh.')
    }
  }

  function closeForm(message) {
    setEditing(false)
    setForm(null)
    setConfirmTrust(false)
    // With no board left to use, the form stays open: continue in it.
    returnFocus(changeRef, hostRef)
    onStatus?.(message)
  }

  function cancelForm() {
    setEditing(false)
    setForm(null)
    setFormError(null)
    returnFocus(changeRef)
  }

  function cancelTrust() {
    setConfirmTrust(false)
    returnFocus(trustRef, changeRef)
  }

  function copyCommand(text) {
    copyText(text).then(() => onStatus?.(`Copied: ${text}`), (err) => onError?.(err.message))
  }

  return (
    <section className="panel periph-board" aria-labelledby="periph-board-title" ref={sectionRef} tabIndex={-1}>
      <h2 id="periph-board-title" className="sr-only">Selected board</h2>

      {loading && !board && <p className="hint" role="status">Loading board…</p>}
      <ErrorNotice error={error}>
        {onRetry && <button type="button" className="btn-ghost" onClick={onRetry}>Retry</button>}
      </ErrorNotice>

      {target && (
        <>
          <div className="periph-board-summary">
            <span className="periph-board-label">{target.label}</span>
            {sourceLabel(target.source) && <Pill tone="periph-info">{sourceLabel(target.source)}</Pill>}
            <Pill tone={state.tone}>{state.label}</Pill>
          </div>
          <p className="section-note">{description}</p>
          {/* Identity and the last check read as one list rather than a line of prose and a grid. */}
          <Facts rows={[...identity, ...(checked ? [['Checked', checked]] : [])]} />
          <div className="periph-actions periph-board-actions">
            {onOpenShell && shell?.launch_supported && (
              <button
                type="button"
                className="btn-tonal"
                onClick={onOpenShell}
                disabled={shellBusy || !shell.available}
                title={shell.available ? undefined : 'webssh is not installed in this Insight environment'}
              >
                {shellBusy ? 'Opening shell…' : 'Open shell'}
              </button>
            )}
            {/* A board that just answered needs no test; the button is for when it did not. */}
            {state.tone !== 'ok' && (
              <button type="button" className="btn-tonal" ref={testRef} onClick={testConnection} disabled={Boolean(busy)}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
            )}
            <button type="button" className="btn-ghost" ref={changeRef} aria-expanded={formOpen} onClick={() => setEditing(!editing)}>
              Change board
            </button>
          </div>
        </>
      )}

      {board && !target && (
        <Callout tone="info" title="No board selected">
          <p>Insight needs a board to discover peripherals. Any of these gives it one:</p>
          <ol>
            <li>Run Insight on the board itself; it then uses that board automatically.</li>
            <li>Pair the SDK with a DevKit: run <code>sima-cli sdk setup --devkit &lt;ip&gt;</code>, then reload this page.</li>
            <li>Enter a board below. Insight connects with your SSH key; it never asks for a password.</li>
          </ol>
        </Callout>
      )}

      {target && problem && (
        <p className="sr-only" role="alert">{problem.message}</p>
      )}
      {target && problem && (
        <Callout tone="danger" title={problem.message}>
          {problem.hint && <p>{problem.hint}</p>}
          {problem.code === 'auth_failed' && problem.details?.command && (
            <div className="periph-command">
              <pre className="periph-code"><code>{problem.details.command}</code></pre>
              <button type="button" className="btn-ghost" onClick={() => copyCommand(problem.details.command)}>Copy command</button>
            </div>
          )}
          {problem.code === 'host_key_changed' && (
            <>
              <Facts rows={[['Expected', problem.details?.expected_fingerprint || 'unknown'], ['Presented', presented || 'unknown']]} />
              {confirmTrust ? (
                <div className="periph-confirm">
                  <p>
                    Trust the new key only if {problem.details?.host || 'this board'} was reflashed or replaced.
                    Otherwise a different device may be answering at this address.
                  </p>
                  <div className="periph-actions">
                    <button type="button" className="btn-ghost danger" onClick={trustKey} disabled={Boolean(busy)}>Trust new key</button>
                    <button type="button" className="btn-ghost" onClick={cancelTrust} autoFocus>Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn-ghost" ref={trustRef} onClick={() => setConfirmTrust(true)} disabled={!presented}>Trust new key…</button>
              )}
            </>
          )}
        </Callout>
      )}

      {formOpen && (
        <form className="periph-form" onSubmit={save} aria-label="Board connection">
          <div className="periph-form-fields">
            <label>
              Host or IP address
              <input ref={hostRef} value={values.host} onChange={(e) => setForm({ ...values, host: e.target.value })} placeholder="192.168.2.2" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              SSH port
              <input type="number" min="1" max="65535" value={values.port} onChange={(e) => setForm({ ...values, port: e.target.value })} />
            </label>
            <label>
              User
              <input value={values.user} onChange={(e) => setForm({ ...values, user: e.target.value })} autoComplete="off" spellCheck={false} />
            </label>
          </div>
          <p className="hint">
            Default: {defaultText || 'none (Insight is not on a board and the SDK is not paired with a DevKit)'}.
          </p>
          <ErrorNotice error={formError} />
          <div className="periph-actions">
            <button type="submit" className="btn-tonal" disabled={Boolean(busy)}>{busy === 'select' ? 'Saving…' : 'Save'}</button>
            {board?.saved && <button type="button" className="btn-ghost" onClick={useDefault} disabled={Boolean(busy)}>Use default</button>}
            {target && <button type="button" className="btn-ghost" onClick={cancelForm}>Cancel</button>}
          </div>
        </form>
      )}
    </section>
  )
}
