import { useEffect, useRef } from 'react'
import BoardTargetCard from './BoardTargetCard.jsx'

export default function BoardPanel({ onClose, ...cardProps }) {
  const cardRef = useRef(null)
  const closeRef = useRef(null)

  useEffect(() => {
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
          <BoardTargetCard {...cardProps} />
        </div>
      </div>
    </div>
  )
}
