export interface TrackedHand {
  handedness: 'Left' | 'Right'
  /** 21 × (x, y, z), x/y normalised 0..1 in video space, z wrist-relative and NOT metric. */
  landmarks: Float32Array
  /** Palm centre in NDC, -1..1, y up. */
  centroidNdc: [number, number]
  /** Estimated metres from the camera. Derived from landmark span, not from z. */
  distanceM: number
  /** Raw proxy: wrist -> middle-finger MCP length in video pixels. */
  spanPx: number
  /** 1 = palm plane parallel to the glass (flat against it), 0 = edge-on. */
  palmFlatness: number
  /** NDC units per second. */
  velocityNdc: [number, number]
  confidence: number
}

export interface TrackedFace {
  /** Midpoint between the eyes, NDC, -1..1, y up. */
  eyeCenterNdc: [number, number]
  /** Camera-space metres. THIS drives the off-axis frustum. +x right, +y up, +z toward viewer. */
  eyeCenterM: [number, number, number]
  /** Interocular distance in video pixels — the raw depth proxy. */
  ipdPx: number
  distanceM: number
  confidence: number
}

export interface TrackingFrame {
  /** performance.now() at capture. */
  t: number
  /** Person-confidence mask, 0..255, row-major, top-left origin. Null until the first inference. */
  maskData: Uint8Array | null
  maskWidth: number
  maskHeight: number
  /** Live video element — the GL layer uploads it, tracking never touches WebGL. */
  video: HTMLVideoElement | null
  videoWidth: number
  videoHeight: number
  /** 0..2 hands. */
  hands: TrackedHand[]
  face: TrackedFace | null
  /** False until the user completes the welcome-screen calibration. */
  calibrated: boolean
}

export const EMPTY_FRAME: TrackingFrame = {
  t: 0, maskData: null, maskWidth: 0, maskHeight: 0,
  video: null, videoWidth: 0, videoHeight: 0,
  hands: [], face: null, calibrated: false,
}
