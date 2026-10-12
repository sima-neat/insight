import { useEffect, useRef, useState } from 'react'
import BoardTargetCard from './BoardTargetCard.jsx'
import { requestJson } from './api.js'
import { boardCameraSetup } from './model.js'

export default function BoardPanel({
  board,
  loading = false,
  error = null,
  onBoardChange,
  onRetry,
  onReload,
  onStatus,
  onError,
  onClose,
  shell = null,
  shellBusy = false,
  onOpenShell
}) {
  const cardRef = useRef(null)
  const closeRef = useRef(null)
  const [snapshot, setSnapshot] = useState(null)

  useEffect(() => {
    // The last peripheral scan carries the board's camera setup. Reading it never connects to the
    // board, and it is an extra: without it the card simply omits those rows.
    let active = true
    requestJson('/api/peripherals').then((data) => active && setSnapshot(data), () => {})
    return () => {
      active = false
    }
  }, [board?.generation])

  useEffect(() => {
    // aria-modal tells assistive technology the page behind is inert, so keyboard focus has to
    // behave that way too: keep Tab inside the panel and give focus back where it came from.
    const opener = document.activeElement
    closeRef.current?.focus()

    function focusable() {
      const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      return Array.from(cardRef.current?.querySelectorAll(selector) || []).filter((el) => el.offsetParent !== null)
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      if (event.shiftKey && (current === first || !cardRef.current?.contains(current))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (current === last || !cardRef.current?.contains(current))) {
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

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Board settings"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="board-panel-card" ref={cardRef}>
        <header className="board-panel-head">
          <h3>Selected board</h3>
          <button type="button" ref={closeRef} onClick={onClose} aria-label="Close board settings">Close</button>
        </header>
        <div className="board-panel-body">
          <BoardTargetCard
            board={board}
            cameraSetup={boardCameraSetup(board, snapshot)}
            loading={loading}
            error={error}
            description="Insight discovers peripherals over this connection."
            onBoardChange={onBoardChange}
            onRetry={onRetry}
            onReload={onReload}
            onStatus={onStatus}
            onError={onError}
            shell={shell}
            shellBusy={shellBusy}
            onOpenShell={onOpenShell}
          />
        </div>
      </div>
    </div>
  )
}
