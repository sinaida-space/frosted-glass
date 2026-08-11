import { focusFirst, trapFocus } from './a11y'
import { breakDiagram, healDiagram, touchDiagram } from './diagrams'

const WELCOME_KEY = 'frosted-glass:welcomed'

export interface SiteDeps {
  onGrantCamera: () => Promise<void>
  onCalibrate: (metres: number) => boolean
  getDistance: () => number | null
  loadProgress: (cb: (p: number, label: string) => void) => void
}

type DistanceChoice = 0.6 | 1.0 | 2.0

interface CameraFailure {
  title: string
  body: string
}

function classifyCameraError(err: unknown): CameraFailure {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      title: 'Camera access denied',
      body: 'This tool cannot run without the camera. Allow it in your browser’s site settings, then try again.',
    }
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      title: 'No camera found',
      body: 'Connect a camera, or check that one is enabled for this browser, then try again.',
    }
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      title: 'Camera already in use',
      body: 'Another application or browser tab is using the camera. Close it, then try again.',
    }
  }
  return {
    title: 'Could not start the camera',
    body: 'Something on this device blocked the camera. Try again or reload.',
  }
}

function compatibilityIssue(): CameraFailure | null {
  if (!window.isSecureContext) {
    return {
      title: 'This connection is not secure',
      body: 'Cameras only work on HTTPS or on localhost. Open this site over a secure address, then reload.',
    }
  }
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) {
    return {
      title: 'This browser lacks WebGL2',
      body: 'The glass is rendered with WebGL2. Update your browser or switch to a recent version of Chrome, Firefox, Edge, or Safari, then reload.',
    }
  }
  return null
}

const DISTANCE_LABELS: Record<DistanceChoice, string> = {
  0.6: 'Arm’s length: 0.6 m',
  1.0: 'Sitting back: 1.0 m',
  2.0: 'Standing back: 2.0 m',
}

export interface PrivacyHandle {
  open: () => void
  readonly isOpen: boolean
}

export async function runWelcome(root: HTMLElement, deps: SiteDeps, privacy: PrivacyHandle): Promise<void> {
  const params = new URLSearchParams(location.search)
  const forceFull = params.get('welcome') === '1'
  const alreadyWelcomed = !forceFull && localStorage.getItem(WELCOME_KEY) !== null

  const issue = compatibilityIssue()
  if (issue) {
    // Never resolves: nothing further can run until the page is reloaded.
    return showBlocking(root, issue)
  }

  if (alreadyWelcomed) {
    const entered = await showResume(root, deps)
    if (entered) return
    // "replay the full gate" was chosen — fall through to the full sequence
  }

  await showFullGate(root, deps, privacy)
}

/* ---------------------------------------------------------------------- */
/* Blocking incompatibility screen                                         */
/* ---------------------------------------------------------------------- */

function showBlocking(root: HTMLElement, issue: CameraFailure): Promise<void> {
  const overlay = document.createElement('div')
  overlay.className = 'fg-overlay'
  overlay.innerHTML = `
    <div class="fg-panel" role="dialog" aria-modal="true" aria-labelledby="fg-block-title">
      <p class="fg-step-label">Frosted Glass</p>
      <h1 id="fg-block-title">${issue.title}</h1>
      <p>${issue.body}</p>
      <div class="fg-actions">
        <button type="button" class="fg-btn fg-btn-primary" data-action="retry">Reload</button>
      </div>
    </div>
  `
  root.appendChild(overlay)
  const panel = overlay.querySelector('.fg-panel') as HTMLElement
  overlay.querySelector('[data-action="retry"]')?.addEventListener('click', () => location.reload())
  trapFocus(panel, () => true)
  focusFirst(panel)
  return new Promise(() => {})
}

/* ---------------------------------------------------------------------- */
/* Compact resume prompt for returning visitors                           */
/* ---------------------------------------------------------------------- */

function showResume(root: HTMLElement, deps: SiteDeps): Promise<boolean> {
  return new Promise((resolve) => {
    const bar = document.createElement('div')
    bar.className = 'fg-resume'
    bar.setAttribute('role', 'dialog')
    bar.setAttribute('aria-modal', 'false')
    bar.setAttribute('aria-labelledby', 'fg-resume-text')
    bar.innerHTML = `
      <p id="fg-resume-text">Welcome back. Grant the camera to step behind the glass.</p>
      <div class="fg-actions">
        <button type="button" class="fg-btn fg-btn-primary" data-action="grant">Allow the camera</button>
        <button type="button" class="fg-btn" data-action="replay">Replay the full gate</button>
      </div>
      <p class="fg-notice" data-role="error" hidden></p>
    `
    root.appendChild(bar)

    const grantBtn = bar.querySelector('[data-action="grant"]') as HTMLButtonElement
    const replayBtn = bar.querySelector('[data-action="replay"]') as HTMLButtonElement
    const errorEl = bar.querySelector('[data-role="error"]') as HTMLElement

    grantBtn.addEventListener('click', () => {
      void (async () => {
        grantBtn.disabled = true
        errorEl.hidden = true
        try {
          await deps.onGrantCamera()
          bar.remove()
          resolve(true)
        } catch (err) {
          const failure = classifyCameraError(err)
          errorEl.hidden = false
          errorEl.textContent = `${failure.title}. ${failure.body}`
          grantBtn.disabled = false
        }
      })()
    })

    replayBtn.addEventListener('click', () => {
      bar.remove()
      resolve(false)
    })

    trapFocus(bar, () => document.body.contains(bar))
  })
}

/* ---------------------------------------------------------------------- */
/* The full four-step gate                                                */
/* ---------------------------------------------------------------------- */

function showFullGate(root: HTMLElement, deps: SiteDeps, privacy: PrivacyHandle): Promise<void> {
  return new Promise((resolve) => {
    const STEP_LABELS = ['What this is', 'What it costs you', 'Calibration', 'The three rites']
    let stepIndex = 0
    let chosenDistance: DistanceChoice = 1.0
    let loadedFraction = 0
    let loadedLabel = 'Waiting to start'

    const overlay = document.createElement('div')
    overlay.className = 'fg-overlay'
    overlay.innerHTML = `
      <div class="fg-panel" role="dialog" aria-modal="true" aria-labelledby="fg-gate-title">
        <ul class="fg-progress" aria-hidden="true">
          ${STEP_LABELS.map(() => '<li data-state="upcoming"></li>').join('')}
        </ul>
        <div data-step="0" class="fg-step">
          <p class="fg-step-label">Step 1 of 4: What this is</p>
          <h1 id="fg-gate-title">Frosted Glass</h1>
          <p>Frosted Glass is a camera instrument. It reads your body through your webcam and renders you as a shape behind fogged, breathing glass, built for stage backdrops and for footage you keep.</p>
          <p>It will not recognise you. No face ID, no name, no account. Only a shape in the fog.</p>
          <div class="fg-actions">
            <button type="button" class="fg-btn fg-btn-primary" data-action="next">Continue</button>
          </div>
        </div>

        <div data-step="1" class="fg-step">
          <p class="fg-step-label">Step 2 of 4: What it costs you</p>
          <h2>Before you allow the camera</h2>
          <p>The camera runs entirely inside this browser tab. No video ever leaves your device, and nothing is recorded unless you press record and choose to save it. The only thing kept beyond that is the presets you decide to save, held in this browser until you clear them.</p>
          <p class="fg-small">This site itself is served through Cloudflare. Its analytics are cookieless and see page visits only. <a href="#" data-action="open-privacy">Read the full privacy panel.</a></p>
          <div class="fg-actions">
            <button type="button" class="fg-btn fg-btn-primary" data-action="grant">Allow the camera</button>
          </div>
          <p class="fg-notice" data-role="camera-error" hidden></p>
        </div>

        <div data-step="2" class="fg-step">
          <p class="fg-step-label">Step 3 of 4: Calibration</p>
          <h2>Find your place</h2>
          <p>Sit or stand where you will actually be for the piece, facing the camera. Then choose that distance below.</p>
          <div class="fg-loadbar" data-role="loadbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Waiting to start"><span></span></div>
          <p class="fg-small" data-role="load-label" aria-live="polite">Waiting to start</p>
          <fieldset class="fg-distance-choices" data-role="distance-fieldset">
            <legend class="fg-step-label" style="margin:0">Distance</legend>
            ${([0.6, 1.0, 2.0] as DistanceChoice[])
              .map(
                (d, i) => `
              <label>
                <input type="radio" name="fg-distance" value="${d}" ${i === 1 ? 'checked' : ''} />
                ${DISTANCE_LABELS[d]}
              </label>`,
              )
              .join('')}
          </fieldset>
          <p class="fg-readout" data-role="readout" aria-live="polite">Detected distance: not yet visible</p>
          <div class="fg-actions">
            <button type="button" class="fg-btn fg-btn-primary" data-action="calibrate">Calibrate</button>
            <button type="button" class="fg-btn" data-action="skip-calibration">Skip: stay approximate</button>
          </div>
          <p class="fg-notice" data-role="calibrate-error" hidden></p>
        </div>

        <div data-step="3" class="fg-step">
          <p class="fg-step-label">Step 4 of 4: The three rites</p>
          <h2>Learn the glass</h2>
          <div class="fg-rites">
            <div class="fg-rite">
              ${touchDiagram()}
              <p class="fg-rite-line">Bring your palm close, and the fog answers first.</p>
              <p class="fg-rite-note">Move a hand toward the camera. The glass sharpens as your hand nears.</p>
            </div>
            <div class="fg-rite">
              ${breakDiagram()}
              <p class="fg-rite-line">Push past the pane, and it will not hold.</p>
              <p class="fg-rite-note">Bring a hand close enough to the lens and the glass gives way, breaking into shards.</p>
            </div>
            <div class="fg-rite">
              ${healDiagram()}
              <p class="fg-rite-line">Hold still with both hands, and the wound closes over.</p>
              <p class="fg-rite-note">Keep both palms steady near the break for a couple of seconds and the fog seals it again.</p>
            </div>
          </div>
          <div class="fg-actions">
            <button type="button" class="fg-btn fg-btn-primary" data-action="enter">Enter</button>
          </div>
          <p class="fg-small">This gate will not ask again. It comes back as a one-line prompt next time, with a link here to replay it in full.</p>
        </div>
      </div>
    `
    root.appendChild(overlay)

    const panel = overlay.querySelector('.fg-panel') as HTMLElement
    const progressItems = Array.from(overlay.querySelectorAll<HTMLLIElement>('.fg-progress li'))
    const steps = Array.from(overlay.querySelectorAll<HTMLElement>('.fg-step'))

    const loadbar = overlay.querySelector('[data-role="loadbar"]') as HTMLElement
    const loadbarSpan = loadbar.querySelector('span') as HTMLElement
    const loadLabel = overlay.querySelector('[data-role="load-label"]') as HTMLElement
    const readout = overlay.querySelector('[data-role="readout"]') as HTMLElement
    const cameraError = overlay.querySelector('[data-role="camera-error"]') as HTMLElement
    const calibrateError = overlay.querySelector('[data-role="calibrate-error"]') as HTMLElement

    deps.loadProgress((p, label) => {
      loadedFraction = p
      loadedLabel = label
      renderLoad()
    })

    function renderLoad(): void {
      const pct = Math.round(Math.min(1, Math.max(0, loadedFraction)) * 100)
      const text = loadedFraction >= 1 ? 'Ready' : loadedLabel
      loadbarSpan.style.width = `${pct}%`
      loadLabel.textContent = text
      loadbar.setAttribute('aria-valuenow', String(pct))
      loadbar.setAttribute('aria-valuetext', text)
    }
    renderLoad()

    function renderProgress(): void {
      progressItems.forEach((li, i) => {
        li.dataset.state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'upcoming'
      })
      steps.forEach((s) => {
        s.dataset.active = String(Number(s.dataset.step) === stepIndex)
      })
      const active = steps[stepIndex]
      if (active) focusFirst(active)
    }
    renderProgress()

    function goTo(i: number): void {
      stepIndex = i
      renderProgress()
    }

    // --- Step 1: what this is ---
    steps[0]?.querySelector('[data-action="next"]')?.addEventListener('click', () => goTo(1))

    // --- Step 2: what it costs / camera grant ---
    steps[1]?.querySelector('[data-action="open-privacy"]')?.addEventListener('click', (e) => {
      e.preventDefault()
      privacy.open()
    })
    const grantBtn = steps[1]?.querySelector('[data-action="grant"]') as HTMLButtonElement
    grantBtn?.addEventListener('click', () => {
      void (async () => {
        grantBtn.disabled = true
        cameraError.hidden = true
        try {
          await deps.onGrantCamera()
          goTo(2)
        } catch (err) {
          const failure = classifyCameraError(err)
          cameraError.hidden = false
          cameraError.textContent = `${failure.title}. ${failure.body}`
        } finally {
          grantBtn.disabled = false
        }
      })()
    })

    // --- Step 3: calibration ---
    let readoutTimer: number | undefined
    function startReadout(): void {
      stopReadout()
      readoutTimer = window.setInterval(() => {
        const d = deps.getDistance()
        readout.textContent = d === null
          ? 'Detected distance: not yet visible'
          : `Detected distance: ${d.toFixed(2)} m`
      }, 200)
    }
    function stopReadout(): void {
      if (readoutTimer !== undefined) window.clearInterval(readoutTimer)
      readoutTimer = undefined
    }

    overlay.querySelectorAll<HTMLInputElement>('input[name="fg-distance"]').forEach((input) => {
      input.addEventListener('change', () => {
        chosenDistance = Number(input.value) as DistanceChoice
      })
    })

    steps[2]?.querySelector('[data-action="calibrate"]')?.addEventListener('click', () => {
      calibrateError.hidden = true
      const ok = deps.onCalibrate(chosenDistance)
      if (ok) {
        goTo(3)
      } else {
        calibrateError.hidden = false
        calibrateError.textContent = 'No hand or face is visible yet. Move into frame and try again, or skip and stay approximate.'
      }
    })
    steps[2]?.querySelector('[data-action="skip-calibration"]')?.addEventListener('click', () => goTo(3))

    // --- Step 4: enter ---
    steps[3]?.querySelector('[data-action="enter"]')?.addEventListener('click', () => {
      localStorage.setItem(WELCOME_KEY, String(Date.now()))
      stopReadout()
      document.removeEventListener('keydown', onEscape)
      overlay.remove()
      resolve()
    })

    // Focus trap for the whole gate. Escape never dismisses it — the gate is
    // dismissible only by completing it, on every step, not only the permission one.
    // Stands down while the privacy panel is open on top of it, so the two
    // overlays don't fight over Tab.
    trapFocus(panel, () => document.body.contains(overlay) && !privacy.isOpen)
    function onEscape(e: KeyboardEvent): void {
      if (e.key === 'Escape' && document.body.contains(overlay) && !privacy.isOpen) e.preventDefault()
    }
    document.addEventListener('keydown', onEscape)

    // Start/stop the live readout only while the calibration step is on screen.
    const observer = new MutationObserver(() => {
      if (steps[2]?.dataset.active === 'true') startReadout()
      else stopReadout()
    })
    if (steps[2]) observer.observe(steps[2], { attributes: true, attributeFilter: ['data-active'] })

    focusFirst(panel)
  })
}

export function hasWelcomed(): boolean {
  return localStorage.getItem(WELCOME_KEY) !== null
}
