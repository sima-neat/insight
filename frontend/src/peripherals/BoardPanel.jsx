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
  onClose,
  shell = null,
  shellBusy = false,
  onOpenShell
}) {
  const cardRef = useRef(null)
  const closeRef = useRef(null)

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
            shell={shell}
            shellBusy={shellBusy}
            onOpenShell={onOpenShell}
          />
        </div>
      </div>
    </div>
  )
}
