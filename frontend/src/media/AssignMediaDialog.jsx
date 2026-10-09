import { useState } from 'react'

import FolderBrowser from './FolderBrowser.jsx'
import { nearestExistingFolder, parentPath } from './mediaTree.js'

const STREAM_URL_PATTERN = /^rtsps?:\/\//i

// "Source for srcN" (issue #113): a Video file tab with the folder browser, opening in the folder of
// the current file so a swap inside one category is one click away, a Camera tab for the browser's
// cameras, and a Stream URL tab that pulls a network stream (issue #127). onAssign(value) and
// onPull({url, username, password}) are awaited and may throw; '' clears the slot. A camera's value
// goes to onAssign like a file path does. `currentValue` is what the slot holds now.
export default function AssignMediaDialog({
  sourceIndex,
  currentFile,
  currentValue = currentFile,
  isWebcam = false,
  cameras = [],
  cameraProbing = false,
  cameraError = null,
  onEnableCameras,
  tree,
  onAssign,
  onPull,
  onClose,
}) {
  const [mode, setMode] = useState(isWebcam ? 'camera' : 'file')
  const [folder, setFolder] = useState(() => nearestExistingFolder(tree, parentPath(currentFile || '')))
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState(isWebcam ? '' : (currentFile || ''))
  const [pickedCamera, setPickedCamera] = useState(isWebcam ? (currentValue || '') : '')
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

  async function commit(value) {
    setBusy(true)
    try {
      await onAssign(value)
      close()
    } catch {
      setBusy(false) // the assignment already surfaced the error; keep the dialog open
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

  const tab = (id, label) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === id}
      className={mode === id ? 'assign-tab active' : 'assign-tab'}
      onClick={() => setMode(id)}
      data-testid={`assign-tab-${id}`}
    >
      {label}
    </button>
  )

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Source for src${sourceIndex}`}>
      <div className="modal-card assign-dialog-card" data-testid="assign-dialog">
        <h3>Source for src{sourceIndex}</h3>
        <div className="assign-tabs" role="tablist" aria-label="Source kind">
          {tab('file', 'Video file')}
          {tab('camera', 'Camera')}
          {tab('stream', 'Stream URL')}
        </div>
        {mode === 'file' && (
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
              <button type="button" className="btn-tonal" onClick={() => commit(picked)} disabled={busy || !picked || picked === currentValue}>Assign</button>
            </div>
          </>
        )}
        {mode === 'camera' && (
          <>
            <p className="hint">The browser publishes the camera to <code>rtsp://…:8554/src{sourceIndex}</code> while this tab stays open.</p>
            {cameras.length > 0 ? (
              <div className="assign-cameras" role="listbox" aria-label="Cameras" data-testid="assign-cameras">
                {cameras.map((camera) => (
                  <button
                    key={camera.value}
                    type="button"
                    role="option"
                    aria-selected={camera.value === pickedCamera}
                    className={camera.value === pickedCamera ? 'assign-camera active' : 'assign-camera'}
                    onClick={() => setPickedCamera(camera.value)}
                    data-testid="assign-camera"
                  >
                    {camera.label}
                  </button>
                ))}
              </div>
            ) : (
              !cameraError && <p className="hint" data-testid="assign-no-cameras">No cameras enabled yet. Insight needs this browser's permission to use them.</p>
            )}
            {cameraError && <p className="camera-optin-error" role="alert">{cameraError}</p>}
            <div className="modal-actions">
              {onEnableCameras && (
                <button type="button" className="btn-ghost assign-enable-cameras" onClick={onEnableCameras} disabled={busy || cameraProbing} data-testid="assign-enable-cameras">
                  {cameraProbing ? 'Requesting…' : (cameras.length ? 'Refresh cameras' : 'Enable camera access')}
                </button>
              )}
              {isWebcam && <button type="button" className="btn-ghost" onClick={() => commit('')} disabled={busy}>Clear</button>}
              <button type="button" onClick={close} disabled={busy}>Cancel</button>
              <button type="button" className="btn-tonal" onClick={() => commit(pickedCamera)} disabled={busy || !pickedCamera || pickedCamera === currentValue} data-testid="assign-camera-submit">Assign</button>
            </div>
          </>
        )}
        {mode === 'stream' && (
          <form className="pull-form" onSubmit={(e) => { e.preventDefault(); if (canPull) pull() }}>
            <p className="hint">Insight pulls the stream and forwards it unchanged to <code>rtsp://…:8554/src{sourceIndex}</code>. RTSP and RTSPS only.</p>
            {isWebcam && <p className="hint muted-text" data-testid="pull-webcam-note">This slot is a webcam source. Clear it on the Camera tab before pulling a stream into it.</p>}
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
              <button type="submit" className="btn-tonal" disabled={!canPull || isWebcam} data-testid="pull-submit">{busy ? 'Checking…' : 'Pull'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
