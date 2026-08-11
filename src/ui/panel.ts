import { DEFAULT_PARAMS, type GlassParams } from '../state/params'
import { slider, toggle, colorControl, type Control } from './controls'
import { notify } from './toast'
import {
  BUILTIN_PRESETS,
  listPresets,
  savePreset,
  loadPreset,
  deletePreset,
  encodeParamsToUrl,
} from '../rig/presets'
import { installCameraControls } from '../rig/camera-controls'
import type { Rig } from '../rig'
import { CanvasRecorder } from '../export/recorder'

const OPEN_STATE_PREFIX = 'frosted-glass:section-open:'

function readOpenState(name: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(OPEN_STATE_PREFIX + name)
    if (raw === null) return defaultOpen
    return raw === '1'
  } catch {
    return defaultOpen
  }
}

function writeOpenState(name: string, open: boolean): void {
  try {
    localStorage.setItem(OPEN_STATE_PREFIX + name, open ? '1' : '0')
  } catch {
    // ignore
  }
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface SectionHandle {
  el: HTMLElement
  controls: Control[]
}

function section(name: string, label: string, defaultOpen: boolean, buildBody: (body: HTMLElement) => Control[]): SectionHandle {
  const el = document.createElement('section')
  el.className = 'fg-section'
  const open = readOpenState(name, defaultOpen)
  el.dataset.open = String(open)

  const toggleBtn = document.createElement('button')
  toggleBtn.type = 'button'
  toggleBtn.className = 'fg-section__toggle'
  toggleBtn.textContent = label
  toggleBtn.setAttribute('aria-expanded', String(open))

  const bodyId = `fg-body-${name}`
  const body = document.createElement('div')
  body.className = 'fg-section__body'
  body.id = bodyId
  toggleBtn.setAttribute('aria-controls', bodyId)

  toggleBtn.addEventListener('click', () => {
    const nowOpen = el.dataset.open !== 'true'
    el.dataset.open = String(nowOpen)
    toggleBtn.setAttribute('aria-expanded', String(nowOpen))
    writeOpenState(name, nowOpen)
    if (nowOpen && !reducedMotion()) {
      body.dataset.glitch = 'true'
      body.addEventListener('animationend', () => { delete body.dataset.glitch }, { once: true })
    }
  })

  el.appendChild(toggleBtn)
  el.appendChild(body)

  const controls = buildBody(body)

  return { el, controls }
}

function button(label: string, variant: '' | 'accent' | 'alarm', onClick: () => void, disabled = false): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = variant ? `fg-btn fg-btn--${variant}` : 'fg-btn'
  btn.textContent = label
  btn.disabled = disabled
  btn.addEventListener('click', onClick)
  return btn
}

/**
 * The App's adaptive-quality state, surfaced as a header chip. Structural rather than an
 * import from `../app` so the panel still mounts standalone with no renderer behind it.
 */
export interface QualityChip {
  getLevel(): 'high' | 'medium' | 'low'
  getPinned(): 'high' | 'medium' | 'low' | null
  pin(level: 'high' | 'medium' | 'low' | null): void
  subscribe(cb: () => void): () => void
}

export interface PanelDeps {
  rig?: Rig
  recorder?: CanvasRecorder
  quality?: QualityChip
  onSelectCamera?: (deviceId: string) => Promise<void>
}

export interface PanelHandle {
  el: HTMLElement
  registeredKeys: Set<keyof GlassParams>
  allControls: Control[]
  dispose(): void
}

export function buildPanel(onOpenShortcuts: () => void, deps: PanelDeps = {}): PanelHandle {
  const registeredKeys = new Set<keyof GlassParams>()
  const allControls: Control[] = []
  const disposers: (() => void)[] = []

  const track = (keys: (keyof GlassParams)[], sec: SectionHandle): SectionHandle => {
    for (const k of keys) registeredKeys.add(k)
    allControls.push(...sec.controls)
    return sec
  }

  const panelEl = document.createElement('div')
  panelEl.className = 'fg-panel'
  panelEl.setAttribute('role', 'region')
  panelEl.setAttribute('aria-label', 'Frosted glass controls')

  const header = document.createElement('div')
  header.className = 'fg-header'
  const title = document.createElement('div')
  title.className = 'fg-title'
  title.textContent = 'Frosted Glass'
  const headerButtons = document.createElement('div')
  headerButtons.className = 'fg-header__buttons'
  const helpBtn = button('?', '', onOpenShortcuts)
  helpBtn.className = 'fg-btn fg-btn--icon'
  helpBtn.setAttribute('aria-label', 'Show keyboard shortcuts')
  headerButtons.appendChild(helpBtn)
  header.appendChild(title)
  header.appendChild(headerButtons)
  panelEl.appendChild(header)

  // Adaptive-quality chip, on a row of its own: the header is only 240px wide and already
  // carries the collapse and help buttons. Click cycles auto -> high -> medium -> low ->
  // auto, so the level can be pinned for a take rather than left to move under a recording.
  const quality = deps.quality
  if (quality) {
    const bar = document.createElement('div')
    bar.className = 'fg-statusbar'
    const barLabel = document.createElement('span')
    barLabel.className = 'fg-statusbar__label'
    barLabel.textContent = 'Quality'
    bar.appendChild(barLabel)
    const CYCLE: (('high' | 'medium' | 'low') | null)[] = [null, 'high', 'medium', 'low']
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'fg-btn fg-chip fg-quality-chip'
    const syncChip = () => {
      const pinned = quality.getPinned()
      const level = quality.getLevel()
      chip.textContent = pinned ? `${pinned.toUpperCase()} · PINNED` : `${level.toUpperCase()} · AUTO`
      chip.dataset.level = level
      chip.dataset.pinned = String(pinned !== null)
      chip.setAttribute(
        'aria-label',
        pinned
          ? `Render quality pinned to ${pinned}. Activate to change.`
          : `Render quality ${level}, adapting automatically. Activate to pin.`,
      )
    }
    chip.addEventListener('click', () => {
      const i = CYCLE.indexOf(quality.getPinned())
      quality.pin(CYCLE[(i + 1) % CYCLE.length] ?? null)
    })
    syncChip()
    disposers.push(quality.subscribe(syncChip))
    bar.appendChild(chip)
    panelEl.appendChild(bar)
  }

  // --- GLASS ---
  const glass = track(
    ['glassDistance', 'scatter', 'maxScatterPx', 'contactSharpness', 'absorption', 'grain', 'condensation', 'dispersion'],
    section('glass', 'Glass', true, (body) => {
      const controls = [
        slider('glassDistance', { label: 'Distance', min: 0.15, max: 2.0, step: 0.01, unit: 'm' }),
        slider('scatter', { label: 'Scatter', min: 0, max: 1, step: 0.01 }),
        slider('maxScatterPx', { label: 'Max scatter', min: 4, max: 128, step: 1, unit: 'px' }),
        slider('contactSharpness', { label: 'Contact sharpness', min: 0, max: 1, step: 0.01 }),
        slider('absorption', { label: 'Absorption', min: 0, max: 1, step: 0.01 }),
        slider('grain', { label: 'Grain', min: 0, max: 1, step: 0.01 }),
        slider('condensation', { label: 'Condensation', min: 0, max: 1, step: 0.01 }),
        slider('dispersion', { label: 'Dispersion', min: 0, max: 1, step: 0.01 }),
      ]
      controls.forEach((c) => body.appendChild(c.el))
      return controls
    }),
  )

  // --- FOG ---
  const fog = track(
    ['fogDensity', 'fogDepth', 'lightAzimuth', 'lightElevation', 'lightIntensity', 'shafts'],
    section('fog', 'Fog', false, (body) => {
      const controls = [
        slider('fogDensity', { label: 'Density', min: 0, max: 1, step: 0.01 }),
        slider('fogDepth', { label: 'Depth', min: 1, max: 8, step: 0.05, unit: 'm' }),
        slider('lightAzimuth', { label: 'Light azimuth', min: -Math.PI, max: Math.PI, step: 0.01, unit: 'rad' }),
        slider('lightElevation', { label: 'Light elevation', min: -Math.PI / 2, max: Math.PI / 2, step: 0.01, unit: 'rad' }),
        slider('lightIntensity', { label: 'Light intensity', min: 0, max: 2, step: 0.01 }),
        slider('shafts', { label: 'Shafts', min: 0, max: 1, step: 0.01 }),
      ]
      controls.forEach((c) => body.appendChild(c.el))
      return controls
    }),
  )

  // --- COLOUR ---
  const colour = track(
    ['glassColor', 'silhouetteColor', 'lightColor'],
    section('colour', 'Colour', false, (body) => {
      const controls = [
        colorControl('glassColor', { label: 'Glass' }),
        colorControl('silhouetteColor', { label: 'Silhouette' }),
        colorControl('lightColor', { label: 'Light' }),
      ]
      controls.forEach((c) => body.appendChild(c.el))
      return controls
    }),
  )

  // --- BREAK ---
  const brk = track(
    ['shatterThreshold', 'shardCount', 'healHoldMs', 'handRepulsion'],
    section('break', 'Break', false, (body) => {
      const controls = [
        slider('shatterThreshold', { label: 'Shatter threshold', min: 0.01, max: 0.5, step: 0.005, unit: 'm' }),
        slider('shardCount', { label: 'Shard count', min: 24, max: 256, step: 1 }),
        slider('healHoldMs', { label: 'Heal hold', min: 100, max: 10000, step: 50, unit: 'ms' }),
        slider('handRepulsion', { label: 'Hand repulsion', min: 0, max: 1, step: 0.01 }),
      ]
      controls.forEach((c) => body.appendChild(c.el))

      const row = document.createElement('div')
      row.className = 'fg-row'
      const resetBtn = button('Reset glass', '', () => {
        window.dispatchEvent(new CustomEvent('fg:reset'))
      })
      const shatterBtn = button('Shatter', 'alarm', () => {
        window.dispatchEvent(new CustomEvent('fg:shatter', { detail: { ndc: [0, 0] } }))
      })
      row.appendChild(resetBtn)
      row.appendChild(shatterBtn)
      body.appendChild(row)

      return controls
    }),
  )

  // --- VIEW ---
  const view = track(
    ['parallax', 'mirror', 'renderScale', 'vignette', 'filmGrain'],
    section('view', 'View', false, (body) => {
      const controls = [
        slider('parallax', { label: 'Parallax', min: 0, max: 1.5, step: 0.01 }),
        toggle('mirror', { label: 'Mirror' }),
        slider('renderScale', { label: 'Render scale', min: 0.5, max: 1.0, step: 0.01 }),
        slider('vignette', { label: 'Vignette', min: 0, max: 1, step: 0.01 }),
        slider('filmGrain', { label: 'Film grain', min: 0, max: 1, step: 0.01 }),
      ]
      controls.forEach((c) => body.appendChild(c.el))

      const camLabel = document.createElement('label')
      camLabel.className = 'fg-control__label'
      camLabel.textContent = 'Camera'
      const camSelect = document.createElement('select')
      camSelect.className = 'fg-select'
      body.appendChild(camLabel)
      body.appendChild(camSelect)

      // The real switch lands in Tracker.switchCamera via App; installCameraControls
      // only remembers the choice. Absent deps, the select still persists the pick.
      const camControls = installCameraControls(async (deviceId) => {
        await deps.onSelectCamera?.(deviceId)
      })
      camControls
        .list()
        .then((devices) => {
          camSelect.innerHTML = ''
          for (const d of devices) {
            const opt = document.createElement('option')
            opt.value = d.deviceId
            opt.textContent = d.label || `Camera ${camSelect.length + 1}`
            camSelect.appendChild(opt)
          }
          if (camControls.currentId) camSelect.value = camControls.currentId
        })
        .catch(() => {
          // no camera permission yet — leave select empty
        })
      camSelect.addEventListener('change', () => {
        void camControls.select(camSelect.value)
      })

      return controls
    }),
  )

  // --- PRESETS ---
  const presetsBody = { current: null as HTMLElement | null }
  const presets = section('presets', 'Presets', false, (body) => {
    presetsBody.current = body

    const builtinRow = document.createElement('div')
    builtinRow.className = 'fg-row'
    for (const p of BUILTIN_PRESETS) {
      builtinRow.appendChild(
        button(p.name, '', () => {
          if (loadPreset(p.name)) notify(`Loaded ${p.name}`)
        }),
      )
    }
    body.appendChild(builtinRow)

    const saveRow = document.createElement('div')
    saveRow.className = 'fg-row'
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.className = 'fg-input'
    nameInput.placeholder = 'Preset name'
    nameInput.setAttribute('aria-label', 'New preset name')
    const saveBtn = button('Save', 'accent', () => {
      const name = nameInput.value.trim()
      if (!name) return
      savePreset(name)
      notify(`Saved ${name}`)
      nameInput.value = ''
      renderUserPresets()
    })
    saveRow.appendChild(nameInput)
    saveRow.appendChild(saveBtn)
    body.appendChild(saveRow)

    const userList = document.createElement('div')
    userList.className = 'fg-preset-list'
    body.appendChild(userList)

    const renderUserPresets = () => {
      userList.innerHTML = ''
      for (const p of listPresets()) {
        const row = document.createElement('div')
        row.className = 'fg-preset-row'
        row.appendChild(
          button(p.name, '', () => {
            if (loadPreset(p.name)) notify(`Loaded ${p.name}`)
          }),
        )
        const delBtn = button('✕', '', () => {
          deletePreset(p.name)
          renderUserPresets()
        })
        delBtn.className = 'fg-btn fg-btn--icon'
        delBtn.setAttribute('aria-label', `Delete preset ${p.name}`)
        row.appendChild(delBtn)
        userList.appendChild(row)
      }
    }
    renderUserPresets()

    const shareBtn = button('Copy share link', '', () => {
      const url = encodeParamsToUrl()
      navigator.clipboard
        ?.writeText(url)
        .then(() => notify('Share link copied'))
        .catch(() => notify('Could not copy link'))
    })
    body.appendChild(shareBtn)

    return []
  })

  // --- RECORD ---
  const recordState = { recorder: null as CanvasRecorder | null, timer: null as ReturnType<typeof setInterval> | null }
  const record = section('record', 'Record', false, (body) => {
    const row = document.createElement('div')
    row.className = 'fg-row'

    const dot = document.createElement('span')
    dot.className = 'fg-record-dot'

    const timerEl = document.createElement('span')
    timerEl.className = 'fg-timer'
    timerEl.textContent = '00:00'

    const formatChip = document.createElement('span')
    formatChip.className = 'fg-chip'
    formatChip.textContent = CanvasRecorder.probe().extension.toUpperCase()

    const recordBtn = button('Record', 'alarm', () => {
      if (!recordState.recorder) {
        if (deps.recorder) {
          // Shared with rig's `C` hotkey — one instance, one MediaRecorder, one stream.
          recordState.recorder = deps.recorder
        } else {
          const canvas = document.getElementById('stage') as HTMLCanvasElement | null
          if (!canvas) {
            notify('Canvas not found')
            return
          }
          recordState.recorder = new CanvasRecorder(canvas)
        }
        recordState.recorder.onStateChange = (s) => {
          dot.dataset.active = String(s === 'recording')
          recordBtn.textContent = s === 'recording' ? 'Stop' : 'Record'
          if (s === 'recording') {
            if (recordState.timer) clearInterval(recordState.timer)
            recordState.timer = setInterval(() => {
              const ms = recordState.recorder?.elapsedMs ?? 0
              const total = Math.floor(ms / 1000)
              const mm = String(Math.floor(total / 60)).padStart(2, '0')
              const ss = String(total % 60).padStart(2, '0')
              timerEl.textContent = `${mm}:${ss}`
            }, 250)
          } else if (recordState.timer) {
            clearInterval(recordState.timer)
            recordState.timer = null
          }
        }
      }
      const rec = recordState.recorder
      if (rec.state === 'idle') {
        try {
          rec.start()
        } catch {
          notify('Could not start recording')
        }
      } else if (rec.state === 'recording') {
        rec.stop()
          .then((blob) => {
            rec.save(blob)
            timerEl.textContent = '00:00'
          })
          .catch(() => notify('Recording failed'))
      }
    })

    row.appendChild(recordBtn)
    row.appendChild(dot)
    row.appendChild(timerEl)
    row.appendChild(formatChip)
    body.appendChild(row)

    const actionRow = document.createElement('div')
    actionRow.className = 'fg-row'
    const projectorBtn = button(
      'Projector',
      '',
      () => {
        if (!deps.rig) return
        if (deps.rig.projectorOpen) deps.rig.closeProjector()
        else deps.rig.openProjector()
      },
      !deps.rig,
    )
    const fullscreenBtn = button(
      'Fullscreen',
      '',
      () => {
        deps.rig?.toggleFullscreen()
      },
      !deps.rig,
    )
    actionRow.appendChild(projectorBtn)
    actionRow.appendChild(fullscreenBtn)
    body.appendChild(actionRow)

    return []
  })

  disposers.push(() => {
    if (recordState.timer) clearInterval(recordState.timer)
    // Only dispose a recorder this panel created itself — a shared deps.recorder
    // is owned by whoever constructed it (task 12 / rig's `C` hotkey) and must
    // outlive this panel.
    if (recordState.recorder && recordState.recorder !== deps.recorder) recordState.recorder.dispose()
  })

  for (const sec of [glass, fog, colour, brk, view, presets, record]) {
    panelEl.appendChild(sec.el)
  }

  const dispose = (): void => {
    for (const d of disposers) d()
  }

  return { el: panelEl, registeredKeys, allControls, dispose }
}

/** Dev-only: asserts every numeric/boolean/color key of GlassParams has
 * exactly one registered control. Warns on anything missing. */
export function assertControlCoverage(registeredKeys: Set<keyof GlassParams>): { missing: string[]; extra: string[] } {
  const expected = Object.keys(DEFAULT_PARAMS) as (keyof GlassParams)[]
  const missing = expected.filter((k) => !registeredKeys.has(k))
  const extra = [...registeredKeys].filter((k) => !expected.includes(k))
  if (missing.length > 0) {
    console.warn('[frosted-glass ui] missing controls for:', missing)
  }
  if (extra.length > 0) {
    console.warn('[frosted-glass ui] controls registered for unknown keys:', extra)
  }
  return { missing: missing as string[], extra: extra as string[] }
}
