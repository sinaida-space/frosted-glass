import { focusFirst, trapFocus } from './a11y'

const REPO_URL = 'https://github.com/sinaida-space/frosted-glass'

export interface PrivacyPanel {
  open(): void
  close(): void
  readonly isOpen: boolean
}

/**
 * The privacy panel. Not a separate page — an overlay reachable from the welcome
 * gate and the footer. Written plainly, no legalese, no cookie banner: there is
 * nothing here that needs consent, only disclosure.
 */
export function installPrivacyPanel(root: HTMLElement): PrivacyPanel {
  const overlay = document.createElement('div')
  // fg-overlay-top: the privacy panel can be opened from inside the welcome gate
  // (also an .fg-overlay), so it needs to stack above it — see site.css.
  overlay.className = 'fg-overlay fg-overlay-top'
  overlay.hidden = true
  overlay.innerHTML = `
    <div class="fg-panel" role="dialog" aria-modal="true" aria-labelledby="fg-privacy-title">
      <h1 id="fg-privacy-title">Privacy</h1>
      <p>This tool is built to need almost nothing from you. Here is exactly what happens to what it sees.</p>

      <h2>Video and audio</h2>
      <p>Your camera feed is read and processed frame by frame inside this browser tab. No frame is ever sent anywhere. Nothing is recorded unless you press record, and only leaves your device when you save the take.</p>

      <h2>Account</h2>
      <p>There is none. No sign-up, no login, no email address collected.</p>

      <h2>Cookies</h2>
      <p>This tool sets none.</p>

      <h2>Local storage</h2>
      <p>Your browser keeps a small amount of data on this device, tied to this site only: the presets you save, the current control-panel layout, and whether you have completed this welcome gate. Clear it below, or through your browser’s site settings.</p>
      <div class="fg-actions">
        <button type="button" class="fg-btn" data-action="clear-storage">Clear saved data on this device</button>
      </div>
      <p class="fg-small" data-role="clear-status" role="status" aria-live="polite"></p>

      <h2>Cloudflare Web Analytics</h2>
      <p>The only third party involved in serving this site. It is cookieless and sees page visits: which page loaded, roughly where from, and what kind of device. It never sees your camera or your hands.</p>

      <h2>Model files</h2>
      <p>The first time you load this tool, it fetches hand- and body-tracking model files from Google’s storage (storage.googleapis.com) and from jsDelivr (cdn.jsdelivr.net). Loading a file from either reveals your IP address to that service, the same way loading any file from any server does. The files themselves contain no tracking code of their own.</p>

      <h2>Source and licence</h2>
      <p>Frosted Glass is free software, licensed GPL-3.0. Read or fork the code at <a href="${REPO_URL}" target="_blank" rel="noopener">github.com/sinaida-space/frosted-glass</a>.</p>

      <h2>Contact</h2>
      <p>Questions or concerns reach Sinaida Krivchenko through <a href="https://sinaida.eu" target="_blank" rel="noopener">sinaida.eu</a>.</p>

      <div class="fg-actions">
        <button type="button" class="fg-btn fg-btn-primary" data-action="close">Close</button>
      </div>
    </div>
  `
  root.appendChild(overlay)

  const panel = overlay.querySelector('.fg-panel') as HTMLElement
  const closeBtn = overlay.querySelector('[data-action="close"]') as HTMLButtonElement
  const clearBtn = overlay.querySelector('[data-action="clear-storage"]') as HTMLButtonElement
  const clearStatus = overlay.querySelector('[data-role="clear-status"]') as HTMLElement

  let open = false
  let lastFocused: HTMLElement | null = null

  trapFocus(panel, () => open)

  function onKeydown(e: KeyboardEvent): void {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
  document.addEventListener('keydown', onKeydown)

  clearBtn.addEventListener('click', () => {
    const keys = ['frosted-glass:welcomed', 'frosted-glass:presets', 'frosted-glass:camera-device']
    for (const key of keys) localStorage.removeItem(key)
    clearStatus.textContent = 'Cleared. Presets and this gate’s progress are gone from this browser.'
  })

  closeBtn.addEventListener('click', () => close())
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })

  function open_(): void {
    if (open) return
    open = true
    lastFocused = document.activeElement as HTMLElement | null
    overlay.hidden = false
    clearStatus.textContent = ''
    focusFirst(panel)
  }

  function close(): void {
    if (!open) return
    open = false
    overlay.hidden = true
    lastFocused?.focus()
  }

  return {
    open: open_,
    close,
    get isOpen() { return open },
  }
}
