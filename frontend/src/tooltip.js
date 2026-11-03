// Where a tooltip goes: on its preferred side of the button, on the other side when it wouldn't fit
// there, and always inside the window, so a long reason by the window's edge can still be read.
const GAP = 6
const MARGIN = 8

export function tipPosition(anchor, tip, view, placement = 'bottom') {
  const above = anchor.top - GAP - tip.height
  const below = anchor.bottom + GAP
  const fitsAbove = above >= MARGIN
  const fitsBelow = below + tip.height <= view.height - MARGIN
  const top = (placement === 'top' ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove) ? above : below
  const centred = anchor.left + anchor.width / 2 - tip.width / 2
  const left = Math.max(MARGIN, Math.min(centred, view.width - MARGIN - tip.width))
  return { top, left }
}
