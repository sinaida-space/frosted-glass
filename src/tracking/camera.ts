/** Camera acquisition and frame-freshness detection. No MediaPipe here. */

export interface CameraOptions {
  deviceId?: string
  width?: number
  height?: number
}

export class Camera {
  readonly video: HTMLVideoElement
  private stream: MediaStream | null = null
  private dirty = false
  private lastCurrentTime = -1
  private rvfcHandle: number | null = null
  private usingRvfc = false

  private constructor(video: HTMLVideoElement) {
    this.video = video
  }

  static async create(opts: CameraOptions = {}): Promise<Camera> {
    const video = document.createElement('video')
    video.playsInline = true
    video.muted = true
    const camera = new Camera(video)
    await camera.open(opts)
    return camera
  }

  async open(opts: CameraOptions = {}): Promise<void> {
    this.stopTracks()
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        width: { ideal: opts.width ?? 1280 },
        height: { ideal: opts.height ?? 720 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    })
    this.stream = stream
    this.video.srcObject = stream

    await new Promise<void>((resolve) => {
      if (this.video.readyState >= 1 && this.video.videoWidth > 0) {
        resolve()
        return
      }
      const onLoaded = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded)
        resolve()
      }
      this.video.addEventListener('loadedmetadata', onLoaded)
    })

    await this.video.play()
    this.armFrameWatcher()
  }

  private armFrameWatcher(): void {
    this.dirty = true
    this.lastCurrentTime = -1
    if (this.rvfcHandle !== null) {
      this.video.cancelVideoFrameCallback?.(this.rvfcHandle)
      this.rvfcHandle = null
    }
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.usingRvfc = true
      const tick: VideoFrameRequestCallback = () => {
        this.dirty = true
        this.rvfcHandle = this.video.requestVideoFrameCallback(tick)
      }
      this.rvfcHandle = this.video.requestVideoFrameCallback(tick)
    } else {
      this.usingRvfc = false
    }
  }

  /** True if the video has advanced since the last call that consumed it. Call `consumeFrame()` to clear. */
  hasNewFrame(): boolean {
    if (this.usingRvfc) return this.dirty
    const t = this.video.currentTime
    if (t !== this.lastCurrentTime) return true
    return false
  }

  /** Mark the current frame as consumed. */
  consumeFrame(): void {
    this.dirty = false
    this.lastCurrentTime = this.video.currentTime
  }

  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput')
  }

  private stopTracks(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
  }

  dispose(): void {
    if (this.rvfcHandle !== null) {
      this.video.cancelVideoFrameCallback?.(this.rvfcHandle)
      this.rvfcHandle = null
    }
    this.stopTracks()
    this.video.srcObject = null
  }
}
