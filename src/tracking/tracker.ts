import {
  FilesetResolver,
  ImageSegmenter,
  HandLandmarker,
  FaceLandmarker,
} from '@mediapipe/tasks-vision'
import { Camera } from './camera'
import { OneEuroFilter, OneEuroFilter2, OneEuroFilter3, DISTANCE_ONE_EURO } from './oneEuro'
import {
  ProximityModel,
  palmSpanPx,
  palmFlatness as computePalmFlatness,
  landmarkSpanPx,
  RIGHT_IRIS_CENTER,
  LEFT_IRIS_CENTER,
} from './proximity'
import { params } from '../state/params'
import type { TrackedFace, TrackedHand, TrackingFrame } from './types'
import { EMPTY_FRAME } from './types'

// Match the installed @mediapipe/tasks-vision version so the wasm binary and
// the JS wrapper agree on wire format.
const FILESET_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const SEGMENTER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// Hand landmark indices (MediaPipe Hands topology).
const WRIST = 0
const INDEX_MCP = 5
const MIDDLE_MCP = 9
const PINKY_MCP = 17

// Half-angle tangent of the assumed 60 degree horizontal FOV, used to turn
// normalised screen position + depth back into a camera-space metric offset.
const HALF_FOV_TAN = Math.tan(Math.PI / 6)

const INFERENCE_BUDGET_MS = 14
const INFERENCE_WINDOW = 30

export interface TrackerOptions {
  deviceId?: string
  width?: number
  height?: number
  /**
   * Optional progress hook wired in before model downloads start. The
   * public `onLoadProgress` field can also be (re)assigned at any time —
   * assigning it replays the most recent progress value so a caller that
   * only obtains the `Tracker` after `create()` resolves still observes it
   * reach 1.
   */
  onLoadProgress?: (p: number, label: string) => void
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

interface HandFilterSet {
  centroid: OneEuroFilter2
  distance: OneEuroFilter
  prevCentroidNdc: [number, number]
  prevT: number | null
}

interface FaceFilterSet {
  eyeCenterNdc: OneEuroFilter2
  eyeCenterM: OneEuroFilter3
  ipdPx: OneEuroFilter
  distanceM: OneEuroFilter
}

function freshFaceFilters(): FaceFilterSet {
  return {
    eyeCenterNdc: new OneEuroFilter2(),
    eyeCenterM: new OneEuroFilter3(),
    ipdPx: new OneEuroFilter(DISTANCE_ONE_EURO),
    distanceM: new OneEuroFilter(DISTANCE_ONE_EURO),
  }
}

/**
 * Owns camera capture and the three MediaPipe tasks, and hands the renderer
 * a filled `TrackingFrame` once per animation frame via `update()`. Never
 * touches WebGL — the GL layer uploads `frame.video` itself.
 */
export class Tracker {
  private _onLoadProgress: ((p: number, label: string) => void) | null = null
  private lastProgress = 0
  private lastProgressLabel = ''

  get onLoadProgress(): ((p: number, label: string) => void) | null {
    return this._onLoadProgress
  }
  set onLoadProgress(fn: ((p: number, label: string) => void) | null) {
    this._onLoadProgress = fn
    if (fn && this.lastProgress > 0) fn(this.lastProgress, this.lastProgressLabel)
  }

  private camera: Camera
  private segmenter: ImageSegmenter
  private handLandmarker: HandLandmarker
  private faceLandmarker: FaceLandmarker
  private proximity: ProximityModel

  private frame: Readonly<TrackingFrame> = { ...EMPTY_FRAME }
  private maskData: Uint8Array | null = null
  private maskWidth = 0
  private maskHeight = 0
  private hands: TrackedHand[] = []
  private face: TrackedFace | null = null

  private handFilters = new Map<'Left' | 'Right', HandFilterSet>()
  private faceFilters: FaceFilterSet = freshFaceFilters()

  private lastVideoTs = -1
  private lastVideoWidth = 0
  private frameCounter = 0
  private inferenceHistory: number[] = []
  /** Rolling mean inference wall time in ms over the last INFERENCE_WINDOW frames. */
  inferenceMs = 0
  /** Set once the rolling mean exceeds the budget; face detection cadence backs off. */
  degraded = false

  private disposed = false

  private constructor(
    camera: Camera,
    segmenter: ImageSegmenter,
    handLandmarker: HandLandmarker,
    faceLandmarker: FaceLandmarker,
  ) {
    this.camera = camera
    this.segmenter = segmenter
    this.handLandmarker = handLandmarker
    this.faceLandmarker = faceLandmarker
    this.proximity = new ProximityModel(camera.video.videoWidth)
    this.lastVideoWidth = camera.video.videoWidth
  }

  static async create(opts: TrackerOptions = {}): Promise<Tracker> {
    const weights = { camera: 0.05, fileset: 0.15, segmenter: 0.35, hands: 0.25, face: 0.2 }
    const done: Record<keyof typeof weights, number> = { camera: 0, fileset: 0, segmenter: 0, hands: 0, face: 0 }
    const report = (label: keyof typeof weights, value: number) => {
      done[label] = value
      let total = 0
      for (const k of Object.keys(weights) as (keyof typeof weights)[]) total += weights[k] * done[k]
      opts.onLoadProgress?.(total, label)
    }

    const camera = await Camera.create({ deviceId: opts.deviceId, width: opts.width, height: opts.height })
    report('camera', 1)

    const fileset = await FilesetResolver.forVisionTasks(FILESET_URL)
    report('fileset', 1)

    const [segmenter, handLandmarker, faceLandmarker] = await Promise.all([
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEGMENTER_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }).then((s) => {
        report('segmenter', 1)
        return s
      }),
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
      }).then((h) => {
        report('hands', 1)
        return h
      }),
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
      }).then((f) => {
        report('face', 1)
        return f
      }),
    ])

    const tracker = new Tracker(camera, segmenter, handLandmarker, faceLandmarker)
    tracker.lastProgress = 1
    tracker.lastProgressLabel = 'ready'
    if (opts.onLoadProgress) tracker._onLoadProgress = opts.onLoadProgress
    tracker._onLoadProgress?.(1, 'ready')
    return tracker
  }

  /** Call once per animation frame, before rendering. Cheap and idempotent within a frame. */
  update(nowMs: number): Readonly<TrackingFrame> {
    if (this.disposed) return this.frame

    if (!this.camera.hasNewFrame()) {
      return this.frame
    }
    this.camera.consumeFrame()

    const video = this.camera.video
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw === 0 || vh === 0) return this.frame

    if (vw !== this.lastVideoWidth) {
      this.proximity.setVideoWidth(vw)
      this.lastVideoWidth = vw
    }

    // detectForVideo/segmentForVideo throw if called twice with the same
    // timestamp; force strictly increasing ms.
    const ts = Math.max(Math.round(nowMs), this.lastVideoTs + 1)
    this.lastVideoTs = ts

    const inferStart = performance.now()
    this.runSegmentation(video, ts)
    this.runHands(video, ts, vw, vh, nowMs)

    this.frameCounter++
    const faceCadence = this.degraded ? 3 : 2
    if (this.frameCounter % faceCadence === 0) {
      this.runFace(video, ts, vw, vh, nowMs)
    }
    this.pushInferenceMs(performance.now() - inferStart)

    this.frame = {
      t: nowMs,
      maskData: this.maskData,
      maskWidth: this.maskWidth,
      maskHeight: this.maskHeight,
      video,
      videoWidth: vw,
      videoHeight: vh,
      hands: this.hands,
      face: this.face,
      calibrated: this.proximity.calibrated,
    }
    return this.frame
  }

  private runSegmentation(video: HTMLVideoElement, ts: number): void {
    this.segmenter.segmentForVideo(video, ts, (result) => {
      const mask = result.confidenceMasks?.[0]
      if (!mask) return
      // MPMask is owned by MediaPipe and recycled after this callback:
      // copy the data out, then close it before returning.
      const arr = mask.getAsUint8Array()
      this.maskWidth = mask.width
      this.maskHeight = mask.height
      if (!this.maskData || this.maskData.length !== arr.length) {
        this.maskData = new Uint8Array(arr.length)
      }
      this.maskData.set(arr)
      mask.close()
    })
  }

  private runHands(video: HTMLVideoElement, ts: number, vw: number, vh: number, nowMs: number): void {
    const result = this.handLandmarker.detectForVideo(video, ts)
    const mirror = params.get().mirror
    const tSec = nowMs / 1000
    const seen = new Set<'Left' | 'Right'>()
    const hands: TrackedHand[] = []

    const count = Math.min(result.landmarks.length, 2)
    for (let i = 0; i < count; i++) {
      const lm = result.landmarks[i]
      if (!lm || lm.length <= PINKY_MCP) continue
      const handedCat = result.handedness[i]?.[0]
      const handedness: 'Left' | 'Right' = handedCat?.categoryName === 'Left' ? 'Left' : 'Right'
      if (seen.has(handedness)) continue
      seen.add(handedness)

      const wrist = lm[WRIST]
      const middleMcp = lm[MIDDLE_MCP]
      const indexMcp = lm[INDEX_MCP]
      const pinkyMcp = lm[PINKY_MCP]
      if (!wrist || !middleMcp || !indexMcp || !pinkyMcp) continue

      // Raw display proxy (wrist -> middle MCP only), per the types.ts contract.
      const rawSpanPx = landmarkSpanPx(wrist, middleMcp, vw, vh)
      // Foreshortening-robust span (max of the two palm axes) drives distance.
      const combinedSpanPx = palmSpanPx(wrist, middleMcp, indexMcp, pinkyMcp, vw, vh)
      const flatness = computePalmFlatness(wrist, indexMcp, pinkyMcp)
      const rawDistanceM = this.proximity.handDistanceM(combinedSpanPx)

      const cx = (wrist.x + indexMcp.x + middleMcp.x + pinkyMcp.x) / 4
      const cy = (wrist.y + indexMcp.y + middleMcp.y + pinkyMcp.y) / 4
      const ndcX = (cx * 2 - 1) * (mirror ? -1 : 1)
      const ndcY = 1 - cy * 2

      let filters = this.handFilters.get(handedness)
      if (!filters) {
        filters = {
          centroid: new OneEuroFilter2(),
          distance: new OneEuroFilter(DISTANCE_ONE_EURO),
          prevCentroidNdc: [ndcX, ndcY],
          prevT: null,
        }
        this.handFilters.set(handedness, filters)
      }

      const [sx, sy] = filters.centroid.filter(ndcX, ndcY, tSec)
      const sDist = filters.distance.filter(rawDistanceM, tSec)

      let vx = 0
      let vy = 0
      if (filters.prevT !== null) {
        const dt = Math.max(1 / 240, tSec - filters.prevT)
        vx = clamp((sx - filters.prevCentroidNdc[0]) / dt, -8, 8)
        vy = clamp((sy - filters.prevCentroidNdc[1]) / dt, -8, 8)
      }
      filters.prevCentroidNdc = [sx, sy]
      filters.prevT = tSec

      // Landmarks stay raw and un-mirrored/un-NDC'd — cheap, and task 5's
      // consumers want them unsmoothed.
      const flat = new Float32Array(21 * 3)
      for (let j = 0; j < 21; j++) {
        const p = lm[j]
        if (!p) continue
        flat[j * 3] = p.x
        flat[j * 3 + 1] = p.y
        flat[j * 3 + 2] = p.z
      }

      hands.push({
        handedness,
        landmarks: flat,
        centroidNdc: [sx, sy],
        distanceM: sDist,
        spanPx: rawSpanPx,
        palmFlatness: flatness,
        velocityNdc: [vx, vy],
        confidence: handedCat?.score ?? 0,
      })
    }

    // Hand loss: drop the stale filter state so a returning hand restarts clean.
    for (const key of Array.from(this.handFilters.keys())) {
      if (!seen.has(key)) this.handFilters.delete(key)
    }

    this.hands = hands
  }

  private runFace(video: HTMLVideoElement, ts: number, vw: number, vh: number, nowMs: number): void {
    const result = this.faceLandmarker.detectForVideo(video, ts)
    const lm = result.faceLandmarks?.[0]
    if (!lm || lm.length <= LEFT_IRIS_CENTER) {
      this.face = null
      this.faceFilters = freshFaceFilters()
      return
    }

    const rightIris = lm[RIGHT_IRIS_CENTER]
    const leftIris = lm[LEFT_IRIS_CENTER]
    if (!rightIris || !leftIris) {
      this.face = null
      this.faceFilters = freshFaceFilters()
      return
    }
    const ipdPx = landmarkSpanPx(rightIris, leftIris, vw, vh)
    const rawDistanceM = this.proximity.faceDistanceM(ipdPx)

    const mirror = params.get().mirror
    const cx = (rightIris.x + leftIris.x) / 2
    const cy = (rightIris.y + leftIris.y) / 2
    const ndcX = (cx * 2 - 1) * (mirror ? -1 : 1)
    const ndcY = 1 - cy * 2

    const aspect = vw / vh
    // Pinhole inverse: at depth z = distanceM, a point at normalised (u, v)
    // sits x = (u - 0.5) * 2 * z * tan(halfFov) metres off the optical axis
    // (mirrored to match the mirrored NDC above), y analogously with the
    // vertical half-FOV implied by aspect. +x right, +y up, +z toward viewer.
    const xM = (cx - 0.5) * 2 * rawDistanceM * HALF_FOV_TAN * (mirror ? -1 : 1)
    const yM = (-(cy - 0.5) * 2 * rawDistanceM * HALF_FOV_TAN) / aspect
    const zM = rawDistanceM

    const tSec = nowMs / 1000
    const [sNdcX, sNdcY] = this.faceFilters.eyeCenterNdc.filter(ndcX, ndcY, tSec)
    const [smX, smY, smZ] = this.faceFilters.eyeCenterM.filter(xM, yM, zM, tSec)
    const sIpdPx = this.faceFilters.ipdPx.filter(ipdPx, tSec)
    const sDistanceM = this.faceFilters.distanceM.filter(rawDistanceM, tSec)

    this.face = {
      eyeCenterNdc: [sNdcX, sNdcY],
      eyeCenterM: [smX, smY, smZ],
      ipdPx: sIpdPx,
      distanceM: sDistanceM,
      confidence: 1,
    }
  }

  private pushInferenceMs(ms: number): void {
    this.inferenceHistory.push(ms)
    if (this.inferenceHistory.length > INFERENCE_WINDOW) this.inferenceHistory.shift()
    let sum = 0
    for (const v of this.inferenceHistory) sum += v
    this.inferenceMs = sum / this.inferenceHistory.length
    if (this.inferenceHistory.length >= INFERENCE_WINDOW) {
      this.degraded = this.inferenceMs > INFERENCE_BUDGET_MS
    }
  }

  /** Solve the depth constants from the user standing at `metres` from the camera. */
  calibrate(metres: number): boolean {
    if (!this.face || !(this.face.ipdPx > 0)) return false
    return this.proximity.calibrate(metres, this.face.ipdPx)
  }

  get calibrated(): boolean {
    return this.proximity.calibrated
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    return Camera.listCameras()
  }

  async switchCamera(deviceId: string): Promise<void> {
    await this.camera.open({ deviceId })

    this.lastVideoTs = -1
    this.frameCounter = 0
    this.hands = []
    this.face = null
    this.handFilters.clear()
    this.faceFilters = freshFaceFilters()

    const vw = this.camera.video.videoWidth
    if (vw > 0) {
      this.proximity.setVideoWidth(vw)
      this.lastVideoWidth = vw
    }
  }

  dispose(): void {
    this.disposed = true
    this.camera.dispose()
    this.segmenter.close()
    this.handLandmarker.close()
    this.faceLandmarker.close()
  }
}
