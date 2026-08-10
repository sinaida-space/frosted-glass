/** Small focus-trap helper shared by the welcome gate and the privacy panel. */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

/**
 * Traps Tab/Shift+Tab inside `root` while `active()` returns true. Escape is not
 * handled here — callers decide per-surface whether Escape does anything at all.
 */
export function trapFocus(root: HTMLElement, active: () => boolean): () => void {
  const onKeydown = (e: KeyboardEvent): void => {
    if (!active() || e.key !== 'Tab') return
    const items = focusableIn(root)
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
  document.addEventListener('keydown', onKeydown, true)
  return () => document.removeEventListener('keydown', onKeydown, true)
}

export function focusFirst(root: HTMLElement): void {
  const items = focusableIn(root)
  items[0]?.focus()
}
