import { useState } from 'react'

import FolderBrowser from './FolderBrowser.jsx'
import { nearestExistingFolder, parentPath } from './mediaTree.js'

// "Source for srcN" (issue #113): a Video file tab with the folder browser, opening in the folder of
// the current file so a swap inside one category is one click away, and a Camera tab for the
// browser's cameras. onAssign(value) is awaited and may throw; '' clears the slot. A camera's
// value goes to onAssign like a file path does. `currentValue` is what the slot holds now.
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
  onClose,
}) {
  const [mode, setMode] = useState(isWebcam ? 'camera' : 'file')
  const [folder, setFolder] = useState(() => nearestExistingFolder(tree, parentPath(currentFile || '')))
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState(isWebcam ? '' : (currentFile || ''))
  const [pickedCamera, setPickedCamera] = useState(isWebcam ? (currentValue || '') : '')
  const [busy, setBusy] = useState(false)
  // The folder can disappear while the dialog is open (a delete elsewhere); browse its nearest
  // surviving ancestor rather than an empty view.
  const view = nearestExistingFolder(tree, folder)

  function navigate(path) {
    setFolder(path)
    setFilter('')
  }

  async function commit(value) {
    setBusy(true)
    try {
      await onAssign(value)
      onClose()
    } catch {
      setBusy(false) // the assignment already surfaced the error; keep the dialog open
    }
  }

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
              <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn-tonal" onClick={() => commit(picked)} disabled={busy || !picked || picked === currentValue}>Assign</button>
            </div>
          </>
        ) : (
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
              <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn-tonal" onClick={() => commit(pickedCamera)} disabled={busy || !pickedCamera || pickedCamera === currentValue} data-testid="assign-camera-submit">Assign</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
