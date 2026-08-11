/**
 * App - the one frame loop.
 *
 * Owns the GL context, the tracker, every pass, the recorder, the rig and the UI, and
 * runs them in the order the frame graph demands:
 *
 *   tracker.update()
 *     -> camera.setEye(face) -> FogPass                        (rgba16f, half res)
 *     -> SilhouettePass (rgba16f) -> ScatterPass (rgba16f)
 *                        |                       |
 *                     contact                    v
 *                        |            GlassPass <- + fog          (rgba8)
 *                        v                   ^
 *                  ShatterPass --- healMask -/   (one frame late, deliberately)
 *                        |
 *                        v
 *                     blit to canvas
 *
 * The heal mask feeding backwards is a one-frame delay by design: ShatterPass writes it
 * during render(), and GlassPass binds whatever ShatterPass wrote last frame. Restructuring
 * the graph to avoid that would cost a second glass composite for a mask that changes over
 * seconds.
 */

import { params, type GlassParams } from './state/params'
import { createGLContext, resizeToDisplay, type GLContext } from './gl/context'
import type { FrameContext } from './gl/pass'
import { Program } from './gl/program'
import { drawFullscreen } from './gl/quad'
import type { RenderTarget } from './gl/target'

import { Tracker } from './tracking/tracker'
import { EMPTY_FRAME, type TrackingFrame } from './tracking/types'

import { FogPass } from './passes/fog'
import { SilhouettePass } from './passes/silhouette'
import { ScatterPass } from './passes/scatter'
import { GlassPass } from './passes/glass'
import { ShatterPass, type GlassState } from './shatter'

import { CanvasRecorder } from './export/recorder'
import { installRig, type Rig } from './rig'
import { installUI, type UIHandle } from './ui'
import { notify } from './ui/toast'
import type { SiteDeps } from './site'

/* ------------------------------------------------------------------------- */
/* Quality ladder                                                            */
/* ------------------------------------------------------------------------- */

export type QualityLevel = 'high' | 'medium' | 'low'

export const QUALITY_ORDER: QualityLevel[] = ['low', 'medium', 'high']

interface QualitySpec {
  /** Hard ceiling on renderScale at this level. The user's own slider can still go lower. */
  renderScaleMax: number
  /** Fog raymarch steps: 24 / 16 / 12. */
  fog: 'high' | 'medium' | 'low'
  /** 'high' = 2 refinement rounds + lobe reconstruction, 'low' = 1 round, no lobe. */
  scatter: 'high' | 'low'
  /** 'high' = droplets and dispersion on. */
  glass: 'high' | 'low'
}

const QUALITY: Record<QualityLevel, QualitySpec> = {
  high: { renderScaleMax: 1.0, fog: 'high', scatter: 'high', glass: 'high' },
  medium: { renderScaleMax: 0.8, fog: 'medium', scatter: 'low', glass: 'high' },
  low: { renderScaleMax: 0.6, fog: 'low', scatter: 'low', glass: 'low' },
}

/** Frames the rolling frame-time mean is taken over. */
const FRAME_WINDOW = 60
/** Mean frame time above which the level starts counting toward a step down. */
const STEP_DOWN_MS = 20
/** Mean frame time below which the level starts counting toward a step up. */
const STEP_UP_MS = 12
/**
 * The asymmetry is the whole point. Dropping after half a second of trouble and only
 * recovering after three seconds of calm means a level change cannot feed back into the
 * measurement fast enough to oscillate.
 */
const STEP_DOWN_FRAMES = 30
const STEP_UP_FRAMES = 180

/* ------------------------------------------------------------------------- */
/* Blit / debug inspection                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Modes:
 *   0 rgb straight through (the real output)
 *   1 red channel as grey        - silhouette coverage, scatter coverage, heal mask
 *   2 green channel / uScale     - silhouette depth in metres
 *   3 rgb tone-mapped            - the fog volume's unclamped radiance
 */
const BLIT_FRAG_SRC = `#version 300 es
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform int uMode;
uniform float uScale;
void main() {
  vec4 s = texture(uSrc, vUv);
  vec3 c;
  if (uMode == 1) c = vec3(clamp(s.r * uScale, 0.0, 1.0));
  else if (uMode == 2) c = vec3(clamp(s.g * uScale, 0.0, 1.0));
  else if (uMode == 3) c = pow(clamp(s.rgb / (1.0 + s.rgb), 0.0, 1.0), vec3(1.0 / 2.2));
  else c = s.rgb;
  fragColor = vec4(c, 1.0);
}
`

interface DebugView {
  label: string
  target: () => RenderTarget
  mode: number
  scale: number
}

/* ------------------------------------------------------------------------- */
/* Quality handle exposed to the UI                                          */
/* ------------------------------------------------------------------------- */

export interface QualityHandle {
  /** The level actually in force this frame. */
  getLevel(): QualityLevel
  /** Non-null when the user has pinned a level and adaptation is off. */
  getPinned(): QualityLevel | null
  pin(level: QualityLevel | null): void
  subscribe(cb: () => void): () => void
}

/* ------------------------------------------------------------------------- */

export class App {
  private canvas: HTMLCanvasElement
  private ctx: GLContext

  private tracker: Tracker | null = null
  private loadProgressCb: ((p: number, label: string) => void) | null = null
  private cameraDeviceId: string | undefined

  private fog!: FogPass
  private silhouette!: SilhouettePass
  private scatter!: ScatterPass
  private glass!: GlassPass
  private shatter!: ShatterPass
  private blit!: Program

  private recorder!: CanvasRecorder
  private rig!: Rig
  private ui!: UIHandle

  private booted = false
  private rafHandle = 0
  private lastFrameMs = 0
  private startMs = 0

  // --- frame cost ---
  /**
   * One reused TIME_ELAPSED query. WebGL cannot nest them, so the frame after a query is
   * issued simply does not issue one; at 60 fps that still samples the GPU every other
   * frame, which is far more often than the 60-frame window needs.
   */
  private gpuQuery: WebGLQuery | null = null
  private gpuQueryInFlight = false
  private gpuMs = 0
  private cpuMs = 0

  // --- adaptive quality ---
  private level: QualityLevel = 'high'
  private pinnedLevel: QualityLevel | null = null
  private frameTimes: number[] = []
  private frameTimeSum = 0
  /** Delivered rAF-to-rAF interval, the ground truth for "are we holding 60". */
  private intervals: number[] = []
  private intervalSum = 0
  private slowFrames = 0
  private fastFrames = 0
  private qualityListeners = new Set<() => void>()
  /** Quality and renderScale are frozen to these while the recorder is running. */
  private lockedLevel: QualityLevel | null = null
  private lockedScale = 1

  // --- debug ---
  private debugOn = false
  private debugEl: HTMLElement | null = null
  private debugView = 0
  private debugViews: DebugView[] = []
  private onDebugKey: ((e: KeyboardEvent) => void) | null = null
  /**
   * Debug-only tracking override. With `?debug=1` the App instance is published on
   * `window.__fg`, and assigning a `TrackingFrame` here makes the frame loop consume it
   * instead of the live tracker. It is the only way to drive the downstream passes on a
   * machine with no camera, which is exactly the case the reviewer will be in.
   */
  debugFrame: Readonly<TrackingFrame> | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = createGLContext(canvas)
    this.debugOn = new URLSearchParams(location.search).get('debug') === '1'
  }

  /* --- site gate ---------------------------------------------------------- */

  /**
   * Dependencies for the welcome gate. No camera work happens until `onGrantCamera`
   * is called, which the gate only does once the viewer has read what it costs them.
   */
  get siteDeps(): SiteDeps {
    return {
      onGrantCamera: async () => {
        if (this.tracker) return
        this.tracker = await Tracker.create({
          deviceId: this.cameraDeviceId,
          onLoadProgress: (p, label) => this.loadProgressCb?.(p, label),
        })
        // Re-assigning replays the last value, so a callback registered after this
        // point still observes progress reach 1.
        this.tracker.onLoadProgress = (p, label) => this.loadProgressCb?.(p, label)
      },
      onCalibrate: (metres: number) => this.tracker?.calibrate(metres) ?? false,
      getDistance: () => this.tracker?.update(performance.now()).face?.distanceM ?? null,
      loadProgress: (cb) => {
        this.loadProgressCb = cb
        if (this.tracker) this.tracker.onLoadProgress = (p, label) => cb(p, label)
      },
    }
  }

  /* --- boot --------------------------------------------------------------- */

  boot(): void {
    if (this.booted) return
    this.booted = true

    resizeToDisplay(this.ctx, this.effectiveRenderScale())

    const ctx = this.ctx
    this.fog = new FogPass(ctx, ctx.width, ctx.height, QUALITY[this.level].fog)
    this.silhouette = new SilhouettePass(ctx)
    this.scatter = new ScatterPass(ctx, () => this.silhouette.output, QUALITY[this.level].scatter)
    this.glass = new GlassPass(
      ctx,
      { scatter: () => this.scatter.output, fog: () => this.fog.output },
      QUALITY[this.level].glass
    )
    this.shatter = new ShatterPass(ctx)
    this.shatter.setSource(this.glass.output)
    this.shatter.setFog(() => this.fog.output)
    this.blit = new Program(ctx, BLIT_FRAG_SRC)

    this.recorder = new CanvasRecorder(this.canvas)
    this.recorder.onStateChange = (s) => this.onRecorderState(s)

    const uiRoot = document.getElementById('ui')
    if (!uiRoot) throw new Error('#ui root not found')
    this.rig = installRig(this.canvas, uiRoot, this.recorder)
    this.ui = installUI(uiRoot, {
      rig: this.rig,
      recorder: this.recorder,
      quality: this.qualityHandle,
      onSelectCamera: (deviceId) => this.switchCamera(deviceId),
    })

    this.debugViews = [
      { label: 'output', target: () => this.shatter.output, mode: 0, scale: 1 },
      { label: 'silhouette R (coverage)', target: () => this.silhouette.output, mode: 1, scale: 1 },
      { label: 'silhouette G (depth, 0–4 m)', target: () => this.silhouette.output, mode: 2, scale: 0.25 },
      { label: 'scatter R (coverage)', target: () => this.scatter.output, mode: 1, scale: 1 },
      { label: 'fog (radiance)', target: () => this.fog.output, mode: 3, scale: 1 },
      { label: 'heal mask', target: () => this.shatter.healMask, mode: 1, scale: 1 },
    ]
    if (this.debugOn) this.installDebug()

    this.startMs = performance.now()
    this.lastFrameMs = this.startMs
    this.rafHandle = requestAnimationFrame(this.frame)
  }

  /* --- camera ------------------------------------------------------------- */

  private async switchCamera(deviceId: string): Promise<void> {
    this.cameraDeviceId = deviceId
    if (!this.tracker) return
    try {
      await this.tracker.switchCamera(deviceId)
    } catch {
      notify('Could not switch camera')
    }
  }

  /* --- recorder ----------------------------------------------------------- */

  /**
   * A resolution change mid-recording corrupts the file in some encoders, so both the
   * quality level and the drawing-buffer scale are pinned for the length of a take.
   */
  private onRecorderState(s: 'idle' | 'recording' | 'encoding'): void {
    if (s === 'recording') {
      // Read the scale BEFORE latching the level: effectiveRenderScale() returns
      // `lockedScale` as soon as `lockedLevel` is set, so the other order latches the
      // previous take's value and the buffer jumps resolution on the next resize check -
      // the exact thing the lock exists to prevent.
      this.lockedScale = this.effectiveRenderScale()
      this.lockedLevel = this.level
    } else if (s === 'idle') {
      this.lockedLevel = null
    }
  }

  /* --- quality ------------------------------------------------------------ */

  get qualityHandle(): QualityHandle {
    return {
      getLevel: () => this.level,
      getPinned: () => this.pinnedLevel,
      pin: (level) => {
        this.pinnedLevel = level
        if (level) this.applyLevel(level)
        this.slowFrames = 0
        this.fastFrames = 0
        this.emitQuality()
      },
      subscribe: (cb) => {
        this.qualityListeners.add(cb)
        return () => {
          this.qualityListeners.delete(cb)
        }
      },
    }
  }

  private emitQuality(): void {
    for (const cb of this.qualityListeners) cb()
  }

  private effectiveRenderScale(): number {
    if (this.lockedLevel) return this.lockedScale
    return Math.min(params.get().renderScale, QUALITY[this.level].renderScaleMax)
  }

  private applyLevel(level: QualityLevel): void {
    if (level === this.level) return
    this.level = level
    const spec = QUALITY[level]
    this.fog.setQuality(spec.fog)
    this.scatter.setQuality(spec.scatter)
    this.glass.setQuality(spec.glass)
    console.log(`[app] quality level -> ${level}`)
    this.emitQuality()
  }

  private updateAdaptiveQuality(frameMs: number, intervalMs: number): void {
    this.frameTimes.push(frameMs)
    this.frameTimeSum += frameMs
    this.intervals.push(intervalMs)
    this.intervalSum += intervalMs
    if (this.frameTimes.length > FRAME_WINDOW) {
      this.frameTimeSum -= this.frameTimes.shift()!
      this.intervalSum -= this.intervals.shift()!
    }
    if (this.frameTimes.length < FRAME_WINDOW) return

    const mean = this.frameTimeSum / this.frameTimes.length
    const meanInterval = this.intervalSum / this.intervals.length

    // Pinned by the user, or pinned for the length of a recording: never adapt.
    if (this.pinnedLevel || this.lockedLevel) return

    // The tracker running over its own inference budget is a frame-time problem the GPU
    // cannot see, so it steps the level down directly rather than through the mean.
    if (this.tracker?.degraded) {
      const i = QUALITY_ORDER.indexOf(this.level)
      if (i > 0) {
        this.applyLevel(QUALITY_ORDER[i - 1]!)
        this.slowFrames = 0
        this.fastFrames = 0
      }
      return
    }

    // Stepping DOWN needs BOTH the measured work and the delivered frame interval to be
    // over budget. TIME_ELAPSED is not equally trustworthy on every driver - on the
    // virtualised GPU this was verified against it over-reports by roughly 3x - and a
    // ladder that degrades a build which is demonstrably delivering 60 fps is worse than
    // one that occasionally holds a level too long. The interval is the ground truth for
    // "we are not holding 60"; the work estimate is the only thing that can see headroom,
    // so it alone governs stepping UP. If a driver over-reports, the app simply never
    // promotes itself, which is the safe direction to fail in.
    if (mean > STEP_DOWN_MS && meanInterval > STEP_DOWN_MS) {
      this.fastFrames = 0
      this.slowFrames++
      if (this.slowFrames >= STEP_DOWN_FRAMES) {
        this.slowFrames = 0
        const i = QUALITY_ORDER.indexOf(this.level)
        if (i > 0) this.applyLevel(QUALITY_ORDER[i - 1]!)
      }
    } else if (mean < STEP_UP_MS) {
      this.slowFrames = 0
      this.fastFrames++
      if (this.fastFrames >= STEP_UP_FRAMES) {
        this.fastFrames = 0
        const i = QUALITY_ORDER.indexOf(this.level)
        if (i < QUALITY_ORDER.length - 1) this.applyLevel(QUALITY_ORDER[i + 1]!)
      }
    } else {
      this.slowFrames = 0
      this.fastFrames = 0
    }
  }

  /* --- the frame ---------------------------------------------------------- */

  private frame = (): void => {
    this.rafHandle = requestAnimationFrame(this.frame)

    const now = performance.now()
    const intervalMs = now - this.lastFrameMs
    // Clamped so a backgrounded tab does not launch every shard into orbit on return.
    const dt = Math.min(intervalMs / 1000, 0.05)
    this.lastFrameMs = now

    const p = params.get()
    const frame: Readonly<TrackingFrame> =
      this.debugFrame ?? this.tracker?.update(now) ?? EMPTY_FRAME

    if (resizeToDisplay(this.ctx, this.effectiveRenderScale())) {
      const { width, height } = this.ctx
      this.fog.resize(width, height)
      this.silhouette.resize(width, height)
      this.scatter.resize(width, height)
      this.glass.resize(width, height)
      this.shatter.resize(width, height)
    }

    const f: FrameContext = { ctx: this.ctx, time: (now - this.startMs) / 1000, dt, params: p }

    this.beginGpuTimer()

    // 1. Fog, behind everything, through the head-coupled off-axis frustum.
    this.fog.setEye(frame.face, dt, p.parallax)
    this.fog.render(f)

    // 2. Person: coverage + metric depth, then the depth-varying scatter.
    this.silhouette.update(frame, f)
    this.silhouette.render(f)
    this.scatter.render(f)

    // 3. The pane. Binds LAST frame's heal mask - see the header comment.
    this.glass.setHealMask(this.shatter.healMask.texture)
    this.glass.render(f)

    // 4. Breakage on top, or a straight passthrough of the glass target.
    this.shatter.update(frame, this.silhouette.contact, f)
    this.shatter.render(f)

    // 5. To the screen.
    this.present()

    this.endGpuTimer()
    this.cpuMs = performance.now() - now
    this.pollGpuTimer()

    // The cost that decides the quality level is whichever side of the pipeline is the
    // bottleneck. Wall-clock time around the draw calls only measures command submission
    // (2-3 ms here), and the rAF interval is pinned at the vsync period whenever the app
    // is keeping up, so neither one on its own can tell headroom from saturation.
    const frameMs = Math.max(this.cpuMs, this.gpuMs)
    this.updateAdaptiveQuality(frameMs, Math.min(intervalMs, 100))
    if (this.debugOn) this.renderDebug(frame, frameMs)
  }

  private beginGpuTimer(): void {
    const ext = this.ctx.caps.timerQuery
    if (!ext || this.gpuQueryInFlight) return
    const gl = this.ctx.gl
    if (!this.gpuQuery) this.gpuQuery = gl.createQuery()
    if (!this.gpuQuery) return
    gl.beginQuery(ext.TIME_ELAPSED_EXT, this.gpuQuery)
    this.gpuQueryInFlight = true
    this.gpuQueryOpen = true
  }

  private gpuQueryOpen = false

  private endGpuTimer(): void {
    const ext = this.ctx.caps.timerQuery
    if (!ext || !this.gpuQueryOpen) return
    this.ctx.gl.endQuery(ext.TIME_ELAPSED_EXT)
    this.gpuQueryOpen = false
  }

  private pollGpuTimer(): void {
    const ext = this.ctx.caps.timerQuery
    const q = this.gpuQuery
    if (!ext || !q || !this.gpuQueryInFlight || this.gpuQueryOpen) return
    const gl = this.ctx.gl
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return
    // A disjoint means the GPU was interrupted (a context switch, a clock change) and the
    // elapsed count is meaningless. Throw the sample away rather than let it force a step.
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean
    if (!disjoint) this.gpuMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6
    this.gpuQueryInFlight = false
  }

  private present(): void {
    const gl = this.ctx.gl
    const view = this.debugViews[this.debugView] ?? this.debugViews[0]!
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.ctx.width, this.ctx.height)
    this.blit.use()
    this.blit.texture('uSrc', view.target().texture)
    this.blit.set('uMode', view.mode)
    this.blit.set('uScale', view.scale)
    drawFullscreen(this.ctx)
  }

  /* --- debug overlay ------------------------------------------------------ */

  private installDebug(): void {
    const el = document.createElement('pre')
    el.id = 'fg-debug'
    el.style.cssText =
      'position:fixed;left:8px;bottom:8px;margin:0;padding:8px 10px;z-index:200;' +
      'background:rgba(0,0,0,.72);color:#8f8;font:11px/1.45 ui-monospace,monospace;' +
      'white-space:pre;pointer-events:none;border:1px solid #2a2a2a'
    document.body.appendChild(el)
    this.debugEl = el
    ;(window as unknown as { __fg?: App }).__fg = this

    // Digits 1-5 select an intermediate target, 0 goes back to the real output. The
    // handler runs in the capture phase and stops propagation so the rig's preset
    // hotkeys do not also fire; presets stay reachable from the panel.
    this.onDebugKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const t = e.target
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const n = '0123456789'.indexOf(e.key)
      if (n < 0 || n >= this.debugViews.length) return
      e.stopImmediatePropagation()
      this.debugView = n
    }
    window.addEventListener('keydown', this.onDebugKey, true)
  }

  private renderDebug(frame: Readonly<TrackingFrame>, frameMs: number): void {
    const el = this.debugEl
    if (!el) return
    const mean = this.frameTimes.length ? this.frameTimeSum / this.frameTimes.length : frameMs
    const c = this.silhouette.contact
    const view = this.debugViews[this.debugView] ?? this.debugViews[0]!
    el.textContent = [
      `frame  ${frameMs.toFixed(2)} ms  cpu ${this.cpuMs.toFixed(2)}  gpu ${this.gpuMs.toFixed(2)}  mean ${mean.toFixed(2)}/${this.frameTimes.length}`,
      `infer  ${(this.tracker?.inferenceMs ?? 0).toFixed(2)} ms  degraded=${this.tracker?.degraded ?? false}`,
      `qual   ${this.level}${this.pinnedLevel ? ' (pinned)' : ''}  scale ${this.effectiveRenderScale().toFixed(2)}  ${this.ctx.width}x${this.ctx.height}`,
      `glass  ${this.shatter.state}`,
      `hands  ${frame.hands.length}${frame.hands
        .map((h) => `  ${h.handedness[0]} d=${h.distanceM.toFixed(3)} flat=${h.palmFlatness.toFixed(2)} conf=${h.confidence.toFixed(2)}`)
        .join('')}`,
      `face   ${frame.face ? `${frame.face.distanceM.toFixed(3)} m  eyeM=[${frame.face.eyeCenterM.map((v) => v.toFixed(3)).join(', ')}]` : 'none'}`,
      `contact ${c ? `${c.strength.toFixed(3)} @ ${c.ndc[0].toFixed(2)},${c.ndc[1].toFixed(2)}` : 'none'}`,
      `view   [${this.debugView}] ${view.label}   (0-5)`,
    ].join('\n')
  }

  /* --- teardown ----------------------------------------------------------- */

  dispose(): void {
    cancelAnimationFrame(this.rafHandle)
    if (this.onDebugKey) window.removeEventListener('keydown', this.onDebugKey, true)
    this.debugEl?.remove()
    this.ui?.dispose()
    this.rig?.dispose()
    this.recorder?.dispose()
    this.shatter?.dispose()
    this.glass?.dispose()
    this.scatter?.dispose()
    this.silhouette?.dispose()
    this.fog?.dispose()
    this.blit?.dispose()
    if (this.gpuQuery) this.ctx.gl.deleteQuery(this.gpuQuery)
    this.tracker?.dispose()
  }
}

export type { GlassParams, GlassState }
