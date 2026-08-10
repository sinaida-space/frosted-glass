const REPO_URL = 'https://github.com/sinaida-space/frosted-glass'

export interface FooterDeps {
  onOpenPrivacy: () => void
}

/**
 * A low, unobtrusive bar. Hides itself with the rest of the UI (see the
 * `html[data-ui-hidden]` and `:fullscreen` rules in site.css) — no JS needed for that.
 * "Shortcuts" opens task 10's overlay through the same `?` keyboard event the
 * shortcut key itself uses, so the footer needs no import from `src/rig/`.
 */
export function installFooter(root: HTMLElement, deps: FooterDeps): HTMLElement {
  const footer = document.createElement('footer')
  footer.className = 'fg-footer'
  footer.innerHTML = `
    <span>Frosted&nbsp;Glass</span>
    <span class="fg-dot" aria-hidden="true">·</span>
    <a href="https://sinaida.eu" target="_blank" rel="noopener">sinaida.eu</a>
    <span class="fg-dot" aria-hidden="true">·</span>
    <a href="${REPO_URL}" target="_blank" rel="noopener">Source</a>
    <span class="fg-dot" aria-hidden="true">·</span>
    <button type="button" data-action="privacy">Privacy</button>
    <span class="fg-dot" aria-hidden="true">·</span>
    <button type="button" data-action="shortcuts">Shortcuts</button>
    <span class="fg-dot" aria-hidden="true">·</span>
    <span>GPL-3.0</span>
  `
  root.appendChild(footer)

  footer.querySelector('[data-action="privacy"]')?.addEventListener('click', () => {
    deps.onOpenPrivacy()
  })

  footer.querySelector('[data-action="shortcuts"]')?.addEventListener('click', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
  })

  return footer
}
