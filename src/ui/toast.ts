const TOAST_MS = 4000

export interface ToastHandle {
  dispose(): void
}

/** Listens for CustomEvent('fg:notice', { detail: string }) and shows a
 * chrome-bevelled message for 4s. Also used for "share link copied" and
 * recorder errors dispatched from elsewhere in the UI. */
export function installToast(root: HTMLElement): ToastHandle {
  const el = document.createElement('div')
  el.className = 'fg-toast'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.hidden = true
  root.appendChild(el)

  let hideTimer: ReturnType<typeof setTimeout> | null = null

  const show = (message: string) => {
    el.textContent = message
    el.hidden = false
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      el.hidden = true
    }, TOAST_MS)
  }

  const onNotice = (e: Event) => {
    const detail = (e as CustomEvent<string>).detail
    if (typeof detail === 'string') show(detail)
  }

  window.addEventListener('fg:notice', onNotice)

  return {
    dispose(): void {
      window.removeEventListener('fg:notice', onNotice)
      if (hideTimer) clearTimeout(hideTimer)
      el.remove()
    },
  }
}

export function notify(message: string): void {
  window.dispatchEvent(new CustomEvent('fg:notice', { detail: message }))
}
