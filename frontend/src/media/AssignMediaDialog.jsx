import { useState } from 'react'

import FolderBrowser from './FolderBrowser.jsx'
import { nearestExistingFolder, parentPath } from './mediaTree.js'

// "Assign media to srcN" (issue #113). Opens in the folder of the current file so a swap inside
// one category is one click away. onAssign(path) is awaited and may throw; '' clears the slot.
export default function AssignMediaDialog({ sourceIndex, currentFile, tree, onAssign, onClose }) {
  const [folder, setFolder] = useState(() => nearestExistingFolder(tree, parentPath(currentFile || '')))
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState(currentFile || '')
  const [busy, setBusy] = useState(false)

  function navigate(path) {
    setFolder(path)
    setFilter('')
  }

  async function commit(path) {
    setBusy(true)
    try {
      await onAssign(path)
      onClose()
    } catch {
      setBusy(false) // updateSource already surfaced the error; keep the dialog open
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Assign media to src${sourceIndex}`} onClick={(e) => e.stopPropagation()}>
      <div className="modal-card assign-dialog-card" data-testid="assign-dialog">
        <h3>Assign media to src{sourceIndex}</h3>
        <p className="hint">Selected: <span className="assign-target" data-testid="assign-picked">{picked || 'Not assigned'}</span></p>
        <FolderBrowser
          tree={tree}
          folder={folder}
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
          <button type="button" className="btn-tonal" onClick={() => commit(picked)} disabled={busy || !picked || picked === currentFile}>Assign</button>
        </div>
      </div>
    </div>
  )
}
