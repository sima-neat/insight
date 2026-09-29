import { useState } from 'react'

import FolderBrowser from './FolderBrowser.jsx'
import { nearestExistingFolder, parentPath } from './mediaTree.js'

const STREAM_URL_PATTERN = /^rtsps?:\/\//i

// "Assign media to srcN" (issue #113) with a second tab that pulls a network stream (issue #127).
// Opens in the folder of the current file so a swap inside one category is one click away.
// onAssign(path) and onPull({url, username, password}) are awaited and may throw; '' clears the slot.
export default function AssignMediaDialog({ sourceIndex, currentFile, tree, onAssign, onPull, onClose }) {
  const [mode, setMode] = useState('file')
  const [folder, setFolder] = useState(() => nearestExistingFolder(tree, parentPath(currentFile || '')))
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState(currentFile || '')
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pullError, setPullError] = useState('')
  // The folder can disappear while the dialog is open (a delete elsewhere); browse its nearest
  // surviving ancestor rather than an empty view.
  const view = nearestExistingFolder(tree, folder)

  function navigate(path) {
    setFolder(path)
    setFilter('')
  }

  function close() {
    setPassword('') // never keep a credential in component state longer than the dialog
    onClose()
  }

  async function commit(path) {
    setBusy(true)
    try {
      await onAssign(path)
      close()
    } catch {
      setBusy(false) // updateSource already surfaced the error; keep the dialog open
    }
  }

  async function pull() {
    setBusy(true)
    setPullError('')
    try {
      await onPull({ url: url.trim(), username: username.trim(), password })
      close()
    } catch (e) {
      setPullError(e.message || 'Could not pull the stream.')
      setBusy(false)
    }
  }

  const canPull = STREAM_URL_PATTERN.test(url.trim()) && !busy

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Source for src${sourceIndex}`}>
      <div className="modal-card assign-dialog-card" data-testid="assign-dialog">
        <h3>Source for src{sourceIndex}</h3>
        <div className="assign-tabs" role="tablist" aria-label="Source kind">
          <button type="button" role="tab" aria-selected={mode === 'file'} className={mode === 'file' ? 'assign-tab active' : 'assign-tab'} onClick={() => setMode('file')} data-testid="assign-tab-file">Video file</button>
          <button type="button" role="tab" aria-selected={mode === 'stream'} className={mode === 'stream' ? 'assign-tab active' : 'assign-tab'} onClick={() => setMode('stream')} data-testid="assign-tab-stream">Stream URL</button>
        </div>
        {mode === 'file' ? (
          <>
            <p className="hint">Selected: <span className="assign-target" data-testid="assign-picked">{picked || 'Not assigned'}</span></p>
            <FolderBrowser
              tree={tree}
              folder={view}
              onNavigate={navigate}
              filter={filter}
              onFilterChange={setFilter}
              selectedPath={picked}
              onSelect={setPicked}
              idPrefix="assign"
            />
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => commit('')} disabled={busy || !currentFile}>Clear</button>
              <button type="button" onClick={close} disabled={busy}>Cancel</button>
              <button type="button" className="btn-tonal" onClick={() => commit(picked)} disabled={busy || !picked || picked === currentFile}>Assign</button>
            </div>
          </>
        ) : (
          <form className="pull-form" onSubmit={(e) => { e.preventDefault(); if (canPull) pull() }}>
            <p className="hint">Insight pulls the stream and forwards it unchanged to <code>rtsp://…:8554/src{sourceIndex}</code>. RTSP and RTSPS only.</p>
            <label className="pull-field">
              <span>Stream URL</span>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtsp://192.168.1.10:554/stream1" autoFocus data-testid="pull-url" />
            </label>
            <div className="pull-credentials">
              <label className="pull-field">
                <span>Username</span>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" data-testid="pull-username" />
              </label>
              <label className="pull-field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-testid="pull-password" />
              </label>
            </div>
            <p className="hint muted-text">Most IP cameras need a username and password. Credentials typed into the URL work too and are never shown again.</p>
            {pullError && <p className="pull-error" role="alert" data-testid="pull-error">{pullError}</p>}
            <div className="modal-actions">
              <button type="button" onClick={close} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-tonal" disabled={!canPull} data-testid="pull-submit">{busy ? 'Checking…' : 'Pull'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
