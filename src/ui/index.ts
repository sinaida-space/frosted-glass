import { params } from '../state/params'
import type { Rig } from '../rig'
import type { CanvasRecorder } from '../export/recorder'
import { buildPanel, assertControlCoverage, type PanelDeps, type QualityChip } from './panel'
import { installShortcutsOverlay } from './shortcuts'
import { installToast } from './toast'
import './panel.css'

export interface UIHandle {
  dispose(): void
}

export interface UIDeps {
  rig?: Rig
  recorder?: CanvasRecorder
  /** Adaptive-quality readout and pin control. Absent when the panel mounts standalone. */
  quality?: QualityChip
  /** Real camera switch. Absent when the panel mounts standalone. */
  onSelectCamera?: (deviceId: string) => Promise<void>
}

/** Installs the Y2K control panel into `root` (#ui). Subscribes to `params`
 * once and calls sync() only on the affected control so a preset load does
 * not rebuild the DOM.
 *
 * `deps` is optional so the panel still mounts standalone (e.g. for isolated
 * testing) before task 12 wires the real `Rig`/`CanvasRecorder` instances in.
 * When `deps.rig` is absent, the Fullscreen/Projector buttons render disabled
 * rather than faking hotkey presses. */
export function installUI(root: HTMLElement, deps: UIDeps = {}): UIHandle {
  root.innerHTML = ''
  root.dataset.collapsed = 'false'

  const toastHandle = installToast(root)
  const shortcutsHandle = installShortcutsOverlay(root)

  const panelDeps: PanelDeps = {
    rig: deps.rig,
    recorder: deps.recorder,
    quality: deps.quality,
    onSelectCamera: deps.onSelectCamera,
  }
  const panelHandle = buildPanel(() => shortcutsHandle.toggle(), panelDeps)
  root.appendChild(panelHandle.el)

  // Collapse-to-tab affordance: a small chrome button that shows/hides the panel.
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = 'fg-btn fg-btn--icon fg-tab'
  tab.textContent = '☰'
  tab.setAttribute('aria-label', 'Toggle control panel')
  tab.hidden = true // only shown once the panel has been collapsed
  root.appendChild(tab)

  const collapseBtn = document.createElement('button')
  collapseBtn.type = 'button'
  collapseBtn.className = 'fg-btn fg-btn--icon'
  collapseBtn.textContent = '«'
  collapseBtn.setAttribute('aria-label', 'Collapse control panel')
  panelHandle.el.querySelector('.fg-header__buttons')?.prepend(collapseBtn)

  const setCollapsed = (collapsed: boolean) => {
    root.dataset.collapsed = String(collapsed)
    tab.hidden = !collapsed
  }
  collapseBtn.addEventListener('click', () => setCollapsed(true))
  tab.addEventListener('click', () => setCollapsed(false))

  // params -> controls. Re-sync only the section containing the changed key
  // by syncing every control (cheap: this is a fixed set of ~26 inputs, no
  // DOM rebuild happens here — each control's sync() just updates its own
  // element's value/aria-valuetext).
  const unsubscribe = params.subscribe(() => {
    for (const control of panelHandle.allControls) control.sync()
  })

  // Keyboard is owned entirely by src/rig/index.ts (H, ?, F, P, R, Space, C,
  // 1-5): panel.css reacts to html[data-ui-hidden] set by rig's `H`, and the
  // shortcuts overlay listens for rig's `fg:shortcuts-toggle` CustomEvent on
  // `?` (see src/ui/shortcuts.ts). No keydown listener here — exactly one
  // keyboard owner.

  // Dev-only coverage check. No vite/client ambient types are configured in
  // this project (tsconfig "types": []), so probe import.meta at runtime
  // instead of typing against ImportMetaEnv.
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
  if (env?.DEV) {
    assertControlCoverage(panelHandle.registeredKeys)
  }

  return {
    dispose(): void {
      unsubscribe()
      panelHandle.dispose()
      shortcutsHandle.dispose()
      toastHandle.dispose()
      root.innerHTML = ''
    },
  }
}
