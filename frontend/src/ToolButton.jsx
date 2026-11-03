import { useId, useLayoutEffect, useRef, useState } from 'react'

import { tipPosition } from './tooltip.js'

// An icon button with Insight's tooltip: its short label at once on hover and on keyboard focus.
// `blocked` is why the button can't be used now; it turns the button off and shows under the label.
// The button stays focusable (aria-disabled), or a keyboard could never reach that reason. `note`
// is a second line for a button that works. The tooltip stays inside the button's own element, so
// it also shows in full screen, where only the fullscreen element is drawn.
export default function ToolButton({ label, blocked = '', note = '', placement = 'bottom', type = 'button', onClick, children, ...button }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const anchor = useRef(null)
  const tip = useRef(null)
  const noteId = useId()
  const detail = blocked || note

  useLayoutEffect(() => {
    if (!open) return
    const { width, height } = tip.current.getBoundingClientRect()
    const view = { width: window.innerWidth, height: window.innerHeight }
    setPosition(tipPosition(anchor.current.getBoundingClientRect(), { width, height }, view, placement))
  }, [open, label, detail, placement])

  function click(e) {
    if (blocked) {
      e.preventDefault() // a submit button would still send its form
      return
    }
    setOpen(false) // what it opens shouldn't sit under the tooltip
    onClick?.(e)
  }

  return (
    <span
      ref={anchor}
      className="tip-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={(e) => { if (e.target.matches(':focus-visible')) setOpen(true) }}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
    >
      <button
        {...button}
        type={type}
        aria-label={label}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={detail ? noteId : undefined}
        onClick={click}
      >
        {children}
      </button>
      <span ref={tip} className="tip" role="tooltip" hidden={!open} style={position || undefined}>
        {label}
        {detail && <span id={noteId} className="tip-note">{detail}</span>}
      </span>
    </span>
  )
}
