import { useId, useLayoutEffect, useRef, useState } from 'react'

import { tipPosition } from './tooltip.js'

// Insight's tooltip around a control: its short label at once on hover and on keyboard focus, and
// `note` as a second line. `children` gets the id to use as the control's aria-describedby. The
// tooltip stays inside the page's own elements, so it also shows in full screen, where only the
// fullscreen element is drawn.
export function Tooltip({ label, note = '', placement = 'bottom', children }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef(null)
  const tip = useRef(null)
  const noteId = useId()

  // Placed on every frame while open: the page can move under it. The tab's entrance animation
  // also makes that element the box `fixed` is measured from, so where (0, 0) lands is measured too.
  useLayoutEffect(() => {
    if (!open) return undefined
    let frame
    const place = () => {
      const { style } = tip.current
      style.top = '0'
      style.left = '0'
      const origin = tip.current.getBoundingClientRect()
      const view = { width: window.innerWidth, height: window.innerHeight }
      const { top, left } = tipPosition(anchor.current.getBoundingClientRect(), origin, view, placement)
      style.top = `${top - origin.top}px`
      style.left = `${left - origin.left}px`
      frame = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(frame)
  }, [open, label, note, placement])

  return (
    <span
      ref={anchor}
      className="tip-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={(e) => { if (e.target.matches(':focus-visible')) setOpen(true) }}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
      // What a control opens shouldn't sit under its tooltip; a disabled one keeps saying why.
      onClick={(e) => { if (!e.currentTarget.querySelector('[aria-disabled="true"]')) setOpen(false) }}
    >
      {children(note ? noteId : undefined)}
      <span ref={tip} className="tip" role="tooltip" hidden={!open}>
        {label}
        {note && <span id={noteId} className="tip-note">{note}</span>}
      </span>
    </span>
  )
}

// An icon button with that tooltip. `blocked` is why the button can't be used now; it turns the
// button off and shows under the label. The button stays focusable (aria-disabled), or a keyboard
// could never reach that reason. `note` is a second line for a button that works.
export default function ToolButton({ label, blocked = '', note = '', placement = 'bottom', type = 'button', onClick, children, ...button }) {
  function click(e) {
    if (blocked) {
      e.preventDefault() // a submit button would still send its form
      return
    }
    onClick?.(e)
  }

  return (
    <Tooltip label={label} note={blocked || note} placement={placement}>
      {(describedBy) => (
        <button
          {...button}
          type={type}
          aria-label={label}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={describedBy}
          onClick={click}
        >
          {children}
        </button>
      )}
    </Tooltip>
  )
}
