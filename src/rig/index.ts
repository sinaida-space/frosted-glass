import type { CanvasRecorder } from '../export/recorder'
import { BUILTIN_PRESETS, loadPreset } from './presets'

export interface Rig {
  toggleFullscreen(): void
  toggleUI(): void
  get uiHidden(): boolean
  openProjector(): void
  closeProjector(): void
  get projectorOpen(): boolean
  dispose(): void
}

/** Shared source of truth for hotkey labels — task 10 and task 11 render from this. */
export const SHORTCUTS: { key: string; label: string }[] = [
  { key: 'F', label: 'Fullscreen' },
  { key: 'H', label: 'Hide / show UI' },
  { key: 'R', label: 'Reset the glass' },
  { key: 'Space', label: 'Shatter at centre' },
  { key: 'C', label: 'Start / stop recording' },
  { key: 'P', label: 'Projector popout' },
  { key: '1–5', label: 'Load preset 1–5' },
  { key: '?', label: 'Toggle this overlay' },
]

interface FullscreenDoc extends Document {
  webkitExitFullscreen?: () => Promise<void>
  mozCancelFullScreen?: () => Promise<void>
  msExitFullscreen?: () => Promise<void>
  webkitFullscreenElement?: Element | null
}
interface FullscreenEl extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>
  mozRequestFullScreen?: () => Promise<void>
  msRequestFullscreen?: () => Promise<void>
}

function requestFullscreen(el: HTMLElement): void {
  const e = el as FullscreenEl
  if (e.requestFullscreen) {
    e.requestFullscreen().catch((err: unknown) => {
      // Swallowing this left "F does nothing" with no way to tell why.
      window.dispatchEvent(
        new CustomEvent('fg:notice', {
          detail: `Fullscreen was refused by the browser: ${String((err as Error)?.message ?? err)}`,
        }),
      )
    })
  }
  else if (e.webkitRequestFullscreen) e.webkitRequestFullscreen()
  else if (e.mozRequestFullScreen) e.mozRequestFullScreen()
  else if (e.msRequestFullscreen) e.msRequestFullscreen()
}

function exitFullscreen(): void {
  const d = document as FullscreenDoc
  if (document.exitFullscreen) document.exitFullscreen().catch(() => {})
  else if (d.webkitExitFullscreen) d.webkitExitFullscreen()
  else if (d.mozCancelFullScreen) d.mozCancelFullScreen()
  else if (d.msExitFullscreen) d.msExitFullscreen()
}

function currentFullscreenElement(): Element | null {
  const d = document as FullscreenDoc
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null
}

const CURSOR_IDLE_MS = 2000

export function installRig(canvas: HTMLCanvasElement, uiRoot: HTMLElement, recorder: CanvasRecorder): Rig {
  let projectorWin: Window | null = null
  let cursorIdleTimer: ReturnType<typeof setTimeout> | null = null

  function toggleFullscreen(): void {
    if (currentFullscreenElement()) exitFullscreen()
    // The document element, not the canvas. Fullscreening the canvas alone takes the
    // panel, footer and every overlay out of the visible tree, because they are its
    // siblings - so the operator lost every control and had to press F again blind to
    // get them back. H already exists for hiding the UI deliberately.
    else requestFullscreen(document.documentElement)
  }

  function armCursorIdle(): void {
    if (cursorIdleTimer !== null) clearTimeout(cursorIdleTimer)
    canvas.style.cursor = ''
    if (!document.documentElement.hasAttribute('data-ui-hidden')) return
    cursorIdleTimer = setTimeout(() => {
      canvas.style.cursor = 'none'
    }, CURSOR_IDLE_MS)
  }

  function onMouseMove(): void {
    armCursorIdle()
  }
  window.addEventListener('mousemove', onMouseMove)

  function toggleUI(): void {
    const html = document.documentElement
    const hidden = html.hasAttribute('data-ui-hidden')
    if (hidden) {
      html.removeAttribute('data-ui-hidden')
      canvas.style.cursor = ''
      if (cursorIdleTimer !== null) clearTimeout(cursorIdleTimer)
    } else {
      html.setAttribute('data-ui-hidden', '')
      if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1')
      canvas.focus()
      armCursorIdle()
    }
  }

  function projectorDocument(win: Window): void {
    win.document.title = 'Frosted Glass — Projector'
    win.document.body.style.margin = '0'
    win.document.body.style.background = '#000'
    win.document.body.style.overflow = 'hidden'

    const video = win.document.createElement('video')
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.style.width = '100vw'
    video.style.height = '100vh'
    video.style.objectFit = 'contain'
    video.style.display = 'block'
    video.srcObject = canvas.captureStream(60)

    const fsButton = win.document.createElement('button')
    fsButton.textContent = 'Fullscreen'
    fsButton.style.position = 'fixed'
    fsButton.style.top = '12px'
    fsButton.style.right = '12px'
    fsButton.style.zIndex = '10'
    fsButton.addEventListener('click', () => {
      requestFullscreen(win.document.documentElement)
    })

    win.document.body.appendChild(video)
    win.document.body.appendChild(fsButton)
  }

  function openProjector(): void {
    if (projectorWin && !projectorWin.closed) {
      projectorWin.focus()
      return
    }
    const win = window.open('', 'frosted-glass-projector', 'width=1280,height=720')
    if (!win) {
      window.dispatchEvent(
        new CustomEvent('fg:notice', { detail: 'Popup blocked — allow popups for this site.' }),
      )
      return
    }
    projectorWin = win
    projectorDocument(win)
  }

  function closeProjector(): void {
    if (projectorWin && !projectorWin.closed) projectorWin.close()
    projectorWin = null
  }

  function onBeforeUnload(): void {
    closeProjector()
  }
  window.addEventListener('beforeunload', onBeforeUnload)

  /**
   * Only text entry should swallow hotkeys. Treating every <input> as a typing target
   * meant that touching any slider - the first thing anyone does - left it focused and
   * silently killed F, H, R, Space, C, P and the preset keys until the user clicked
   * somewhere else. A range, colour, checkbox or button input eats no letters.
   */
  const TEXT_ENTRY_TYPES = new Set([
    'text', 'search', 'email', 'password', 'url', 'tel', 'number',
    'date', 'datetime-local', 'month', 'week', 'time',
  ])

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.isContentEditable) return true
    const tag = target.tagName
    if (tag === 'TEXTAREA') return true
    if (tag !== 'INPUT') return false
    const type = (target as HTMLInputElement).type.toLowerCase()
    return TEXT_ENTRY_TYPES.has(type)
  }

  async function toggleRecording(): Promise<void> {
    if (recorder.state === 'idle') {
      recorder.start()
    } else if (recorder.state === 'recording') {
      const blob = await recorder.stop()
      recorder.save(blob)
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return
    if (e.ctrlKey || e.altKey || e.metaKey) return

    switch (e.key) {
      case 'f':
      case 'F':
        toggleFullscreen()
        break
      case 'h':
      case 'H':
        toggleUI()
        break
      case 'r':
      case 'R':
        window.dispatchEvent(new CustomEvent('fg:reset'))
        break
      case ' ':
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('fg:shatter', { detail: { ndc: [0, 0] } }))
        break
      case 'c':
      case 'C':
        void toggleRecording()
        break
      case 'p':
      case 'P':
        if (projectorWin && !projectorWin.closed) closeProjector()
        else openProjector()
        break
      case '1':
      case '2':
      case '3':
      case '4':
      case '5': {
        const idx = Number(e.key) - 1
        const preset = BUILTIN_PRESETS[idx]
        if (preset) loadPreset(preset.name)
        break
      }
      case '?':
        window.dispatchEvent(new CustomEvent('fg:shortcuts-toggle'))
        break
      default:
        break
    }
  }
  window.addEventListener('keydown', onKeyDown)

  return {
    toggleFullscreen,
    toggleUI,
    get uiHidden() {
      return document.documentElement.hasAttribute('data-ui-hidden')
    },
    openProjector,
    closeProjector,
    get projectorOpen() {
      return !!projectorWin && !projectorWin.closed
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (cursorIdleTimer !== null) clearTimeout(cursorIdleTimer)
      closeProjector()
    },
  }
}
