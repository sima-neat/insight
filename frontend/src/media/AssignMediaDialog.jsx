import { useState } from 'react'

import FolderBrowser from './FolderBrowser.jsx'
import { nearestExistingFolder, parentPath } from './mediaTree.js'

// "Assign media to srcN" (issue #113). Opens in the folder of the current file so a swap inside
// one category is one click away. onAssign(value) is awaited and may throw; '' clears the slot.
// `cameras` ({value, label}) are offered above the folder browser; their value goes to onAssign
// like a file path does. `currentValue` is what the slot holds now (a file or a camera value).
export default function AssignMediaDialog({
  sourceIndex,
  currentFile,
  currentValue = currentFile,
  clearable = Boolean(currentValue),
  cameras = [],
  tree,
  onAssign,
  onClose,
}) {
  const [folder, setFolder] = useState(() => nearestExistingFolder(tree, parentPath(currentFile || '')))
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState(currentValue || '')
  const [busy, setBusy] = useState(false)
  // The folder can disappear while the dialog is open (a delete elsewhere); browse its nearest
  // surviving ancestor rather than an empty view.
  const view = nearestExistingFolder(tree, folder)
  const pickedCamera = cameras.find((camera) => camera.value === picked)

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

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Assign media to src${sourceIndex}`}>
      <div className="modal-card assign-dialog-card" data-testid="assign-dialog">
        <h3>Assign media to src{sourceIndex}</h3>
        <p className="hint">Selected: <span className="assign-target" data-testid="assign-picked">{pickedCamera ? pickedCamera.label : (picked || 'Not assigned')}</span></p>
        {cameras.length > 0 && (
          <div className="assign-cameras" role="group" aria-label="Cameras">
            <span className="hint">Cameras</span>
            {cameras.map((camera) => (
              <button
                key={camera.value}
                type="button"
                className={camera.value === picked ? 'assign-camera active' : 'assign-camera'}
                aria-pressed={camera.value === picked}
                onClick={() => setPicked(camera.value)}
              >
                {camera.label}
              </button>
            ))}
          </div>
        )}
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
          <button type="button" className="btn-ghost" onClick={() => commit('')} disabled={busy || !clearable}>Clear</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-tonal" onClick={() => commit(picked)} disabled={busy || !picked || picked === currentValue}>Assign</button>
        </div>
      </div>
    </div>
  )
}
