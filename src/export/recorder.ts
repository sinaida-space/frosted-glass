/**
 * Records the WebGL canvas via `canvas.captureStream()` + `MediaRecorder`.
 * No UI compositing happens here: the canvas excludes DOM overlays for free.
 */

export type RecorderState = 'idle' | 'recording' | 'encoding'

export interface RecorderInfo {
  mimeType: string
  extension: 'mp4' | 'webm'
  isFallback: boolean
}

/** Probed in order; first `MediaRecorder.isTypeSupported` hit wins. Never hard-code one. */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function timestamp(): string {
  const d = new Date()
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${date}-${time}`
}

export class CanvasRecorder {
  private canvas: HTMLCanvasElement
  private fps: number
  private bitsPerSecond: number
  private mediaRecorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: BlobPart[] = []
  private _state: RecorderState = 'idle'
  private startedAt = 0
  private elapsedAtStop = 0
  onStateChange: ((s: RecorderState) => void) | null = null

  constructor(canvas: HTMLCanvasElement, opts?: { fps?: number; bitsPerSecond?: number }) {
    this.canvas = canvas
    this.fps = opts?.fps ?? 60
    // Default 16 Mbps at 1080p (1920x1080), scaled by actual pixel count.
    const pixels = canvas.width * canvas.height
    const referencePixels = 1920 * 1080
    this.bitsPerSecond = opts?.bitsPerSecond ?? Math.round(16_000_000 * (pixels / referencePixels || 1))
  }

  static probe(): RecorderInfo {
    for (const mimeType of MIME_CANDIDATES) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType)) {
        const isWebm = mimeType.startsWith('video/webm')
        return { mimeType, extension: isWebm ? 'webm' : 'mp4', isFallback: isWebm }
      }
    }
    // Nothing supported — fall back to an unparameterized webm request.
    return { mimeType: 'video/webm', extension: 'webm', isFallback: true }
  }

  get state(): RecorderState {
    return this._state
  }

  get elapsedMs(): number {
    if (this._state === 'recording') return performance.now() - this.startedAt
    return this.elapsedAtStop
  }

  private setState(s: RecorderState): void {
    this._state = s
    this.onStateChange?.(s)
  }

  start(): void {
    if (this._state !== 'idle') return
    const info = CanvasRecorder.probe()
    this.stream = this.canvas.captureStream(this.fps)
    this.chunks = []
    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: info.mimeType,
      videoBitsPerSecond: this.bitsPerSecond,
    })
    this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data)
    }
    this.startedAt = performance.now()
    this.mediaRecorder.start(1000) // request data every 1000ms so a crash loses at most a second
    this.setState('recording')
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const mr = this.mediaRecorder
      if (!mr || this._state !== 'recording') {
        reject(new Error('CanvasRecorder.stop() called while not recording'))
        return
      }
      this.setState('encoding')
      this.elapsedAtStop = performance.now() - this.startedAt
      mr.onstop = () => {
        const mimeType = mr.mimeType || 'video/webm'
        const blob = new Blob(this.chunks, { type: mimeType })
        this.chunks = []
        this.stream?.getTracks().forEach((t) => t.stop())
        this.stream = null
        this.mediaRecorder = null
        this.setState('idle')
        resolve(blob)
      }
      mr.stop()
    })
  }

  /** Triggers the browser download. Filename: frosted-glass-YYYYMMDD-HHMMSS.mp4 */
  save(blob: Blob): void {
    const info = CanvasRecorder.probe()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `frosted-glass-${timestamp()}.${info.extension}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  dispose(): void {
    if (this.mediaRecorder && this._state === 'recording') {
      try {
        this.mediaRecorder.stop()
      } catch {
        // ignore
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.mediaRecorder = null
    this._state = 'idle'
    this.onStateChange = null
  }
}
