import { SHORTCUTS } from '../rig'

export interface ShortcutsOverlayHandle {
  toggle(): void
  dispose(): void
}

/** Overlay listing SHORTCUTS, toggled by `?` and a [?] button. Dismisses on
 * Escape or click-outside. */
export function installShortcutsOverlay(root: HTMLElement): ShortcutsOverlayHandle {
  const overlay = document.createElement('div')
  overlay.className = 'fg-overlay'
  overlay.hidden = true
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Keyboard shortcuts')

  const panel = document.createElement('div')
  panel.className = 'fg-overlay__panel'

  const title = document.createElement('h2')
  title.className = 'fg-overlay__title'
  title.textContent = 'Shortcuts'

  const list = document.createElement('ul')
  list.className = 'fg-overlay__list'
  for (const s of SHORTCUTS) {
    const li = document.createElement('li')
    const key = document.createElement('span')
    key.className = 'fg-overlay__key'
    key.textContent = s.key
    const label = document.createElement('span')
    label.textContent = s.label
    li.appendChild(key)
    li.appendChild(label)
    list.appendChild(li)
  }

  panel.appendChild(title)
  panel.appendChild(list)
  overlay.appendChild(panel)
  root.appendChild(overlay)

  let lastFocused: HTMLElement | null = null

  const close = () => {
    if (overlay.hidden) return
    overlay.hidden = true
    lastFocused?.focus()
  }

  const open = () => {
    if (!overlay.hidden) return
    lastFocused = document.activeElement as HTMLElement | null
    overlay.hidden = false
    panel.setAttribute('tabindex', '-1')
    panel.focus()
  }

  const toggle = () => {
    if (overlay.hidden) open()
    else close()
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  const onKeydown = (e: KeyboardEvent) => {
    if (overlay.hidden) return
    if (e.key === 'Escape') close()
  }
  window.addEventListener('keydown', onKeydown)

  // src/rig/index.ts owns the `?` hotkey (it ignores typing targets and
  // modifier keys) and signals us via this event rather than us listening
  // for `?` ourselves, so there is exactly one keyboard owner.
  const onShortcutsToggle = () => toggle()
  window.addEventListener('fg:shortcuts-toggle', onShortcutsToggle)

  return {
    toggle,
    dispose(): void {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('fg:shortcuts-toggle', onShortcutsToggle)
      overlay.remove()
    },
  }
}
