import { useEffect } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]'

// aria-modal tells assistive technology the page behind is inert, so keyboard
// focus has to behave that way too. Tab goes round the dialog's controls, and
// focus that gets out anyway, as it does past the end of a frame whose keys never
// reach this page, comes back. A dialog opened over this one looks after itself.
export function useDialogFocus(box, active = true) {
  useEffect(() => {
    if (!active) return undefined
    const onTop = () => [...document.querySelectorAll('[aria-modal="true"]')].pop() === box.current
    const controls = () => [...box.current.querySelectorAll(FOCUSABLE)]
      .filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0)

    function onKeyDown(event) {
      if (event.key !== 'Tab' || !onTop()) return
      const items = controls()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (document.activeElement === (event.shiftKey ? first : last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }

    function onFocusIn(event) {
      if (onTop() && !box.current.contains(event.target)) controls()[0]?.focus()
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [active, box])
}
