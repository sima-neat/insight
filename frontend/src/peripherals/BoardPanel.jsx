import { useEffect, useRef } from 'react'
import BoardTargetCard from './BoardTargetCard.jsx'

export default function BoardPanel({
  board,
  loading = false,
  error = null,
  onBoardChange,
  onRetry,
  onReload,
  onStatus,
  onError,
  onClose
}) {
  const cardRef = useRef(null)
  const closeRef = useRef(null)

  useEffect(() => {
    closeRef.current?.focus()
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
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
          <div>
            <p className="sysinfo-eyebrow">Board</p>
            <h3>Selected board</h3>
          </div>
          <button type="button" ref={closeRef} onClick={onClose} aria-label="Close board settings">Close</button>
        </header>
        <div className="board-panel-body">
          <BoardTargetCard
            board={board}
            loading={loading}
            error={error}
            description="Insight discovers peripherals and reads device statistics over this connection."
            onBoardChange={onBoardChange}
            onRetry={onRetry}
            onReload={onReload}
            onStatus={onStatus}
            onError={onError}
          />
        </div>
      </div>
    </div>
  )
}
