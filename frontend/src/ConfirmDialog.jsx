import { useEffect, useId, useRef } from 'react'

// A yes-or-no question asked inside the page. The browser's own confirm() is
// blocked when Insight runs in a frame sandboxed without allow-modals, such as
// a Palette SDK editor tab (sima-neat/insight#221): it answers no at once, so
// the action never ran. Cancel, Esc and a click outside all answer no.
export default function ConfirmDialog({ title, message, confirmLabel = 'OK', danger = false, onConfirm, onCancel }) {
  const id = useId()
  const cancelButton = useRef(null)
  const confirmButton = useRef(null)

  useEffect(() => {
    // aria-modal tells assistive technology the page behind is inert, so focus
    // starts here and goes back where it came from. A destructive action is
    // never the default: Enter on the focused Cancel answers no.
    const opener = document.activeElement
    ;(danger ? cancelButton : confirmButton).current?.focus()
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
    }
  }, [danger])

  function onKeyDown(event) {
    // Handled here, not on window, so Esc answers this question without also
    // closing a dialog underneath it (SiMaSentry Solutions listens on window).
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const items = [cancelButton.current, confirmButton.current].filter(Boolean)
    const first = items[0]
    const last = items[items.length - 1]
    const current = document.activeElement
    if (event.shiftKey && (current === first || !items.includes(current))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (current === last || !items.includes(current))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        // Keeps the browser from moving focus to the page once the dialog is
        // gone, after it went back to the button that asked.
        event.preventDefault()
        onCancel()
      }}
    >
      {/* Focusable, so a click on the text keeps Esc and Tab working here. */}
      <div className="modal-card confirm-card" tabIndex={-1}>
        <h3 id={`${id}-title`}>{title}</h3>
        <p id={`${id}-message`}>{message}</p>
        <div className="modal-actions">
          <button type="button" ref={cancelButton} className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" ref={confirmButton} className={danger ? 'danger' : 'btn-tonal'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
