/**
 * Depth model. Pure pinhole-camera math — no MediaPipe types, no `params`.
 *
 * Pinhole projection: an object of real width `W` metres, held perpendicular
 * to the optical axis at distance `d` metres, projects to `w` pixels on the
 * sensor where `w = fpx * W / d` (`fpx` the focal length in pixels). Invert:
 * `d = fpx * W / w`. Every distance estimate below is this one equation,
 * with different bodies substituted for `W`/`w`.
 */

export interface Vec3Like {
  x: number
  y: number
  z: number
}

/**
 * Iris-centre landmark indices in the 478-point FaceLandmarker output. The
 * iris pair is far more stable than the eye corners, so it is what `ipdPx`
 * is measured from.
 */
export const RIGHT_IRIS_CENTER = 468
export const LEFT_IRIS_CENTER = 473

/** Mean adult interocular (pupil-to-pupil) distance, metres. */
export const IPD_M = 0.063
/** Wrist to middle-finger-MCP length, metres — the "long axis" of the palm. */
export const WRIST_TO_MIDDLE_MCP_M = 0.097
/** Index-MCP to pinky-MCP width, metres — the "short axis" of the palm. */
export const INDEX_TO_PINKY_MCP_M = 0.084

/**
 * Focal length in pixels, derived from an assumed 60 degree horizontal FOV.
 * tan(30 deg) is the half-angle tangent; a wider sensor (more videoWidth
 * pixels) covering the same 60 degree cone means more pixels per metre of
 * real-world width, hence more focal-length pixels.
 * This is the uncalibrated fallback used before `calibrate()` succeeds.
 */
export function focalLengthPx(videoWidth: number): number {
  return videoWidth / (2 * Math.tan(Math.PI / 6))
}

/** Pinhole inversion: real width `realWidthM` appears `pixelWidth` px wide at distance d = fpx * W / w. */
export function pinholeDistanceM(fpx: number, realWidthM: number, pixelWidth: number): number {
  if (pixelWidth <= 0) return Infinity
  return (fpx * realWidthM) / pixelWidth
}

/** Euclidean pixel-space distance between two normalised (0..1) landmarks. */
export function landmarkSpanPx(
  a: { x: number; y: number },
  b: { x: number; y: number },
  videoWidth: number,
  videoHeight: number,
): number {
  const dx = (a.x - b.x) * videoWidth
  const dy = (a.y - b.y) * videoHeight
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Foreshortening-robust palm span. When the hand tilts so the wrist->MCP
 * axis foreshortens, the index->pinky axis (roughly perpendicular on the
 * palm plane) does not foreshorten as much, and vice versa. Scaling the
 * short axis up to the long axis's real-world length and taking the max
 * means whichever axis currently faces the camera dominates the estimate,
 * which is exactly the axis that is NOT foreshortened.
 */
export function palmSpanPx(
  wrist: { x: number; y: number },
  middleMcp: { x: number; y: number },
  indexMcp: { x: number; y: number },
  pinkyMcp: { x: number; y: number },
  videoWidth: number,
  videoHeight: number,
): number {
  const spanLong = landmarkSpanPx(wrist, middleMcp, videoWidth, videoHeight)
  const spanShort = landmarkSpanPx(indexMcp, pinkyMcp, videoWidth, videoHeight)
  return Math.max(spanLong, spanShort * (WRIST_TO_MIDDLE_MCP_M / INDEX_TO_PINKY_MCP_M))
}

/**
 * 1 = palm plane faces the camera (flat against the glass), 0 = edge-on.
 * The palm plane normal is the cross product of two in-plane edges from the
 * wrist; its z-component (along the optical axis) is 1 when the plane is
 * perpendicular to the view ray (facing the camera) and 0 when the plane
 * contains the view ray (edge-on).
 */
export function palmFlatness(wrist: Vec3Like, indexMcp: Vec3Like, pinkyMcp: Vec3Like): number {
  const ax = indexMcp.x - wrist.x
  const ay = indexMcp.y - wrist.y
  const az = indexMcp.z - wrist.z
  const bx = pinkyMcp.x - wrist.x
  const by = pinkyMcp.y - wrist.y
  const bz = pinkyMcp.z - wrist.z

  const nx = ay * bz - az * by
  const ny = az * bx - ax * bz
  const nz = ax * by - ay * bx

  const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
  if (len < 1e-9) return 0
  return Math.min(1, Math.max(0, Math.abs(nz / len)))
}

/**
 * Holds the calibration constants and converts pixel spans to metres.
 * Uncalibrated, it falls back to the assumed-FOV pinhole model.
 */
export class ProximityModel {
  private fpx: number
  private kFace: number | null = null
  private kHand: number | null = null

  constructor(videoWidth: number) {
    this.fpx = focalLengthPx(Math.max(1, videoWidth))
  }

  /** Re-derive the uncalibrated focal length if the capture resolution changes. */
  setVideoWidth(videoWidth: number): void {
    this.fpx = focalLengthPx(Math.max(1, videoWidth))
  }

  get calibrated(): boolean {
    return this.kFace !== null
  }

  /**
   * Capture the current ipdPx at a known real-world distance and solve
   * K_face = metres * ipdPx, so afterwards distanceM = K_face / ipdPx.
   * K_hand is derived from the same implied focal length so hands and face
   * agree on scale. Returns false (and leaves the fallback active) if no
   * face was visible when this was called.
   */
  calibrate(metres: number, ipdPx: number): boolean {
    if (!(ipdPx > 0) || !(metres > 0)) return false
    this.kFace = metres * ipdPx
    const impliedFpx = this.kFace / IPD_M
    this.kHand = impliedFpx * WRIST_TO_MIDDLE_MCP_M
    return true
  }

  faceDistanceM(ipdPx: number): number {
    if (!(ipdPx > 0)) return Infinity
    if (this.kFace !== null) return this.kFace / ipdPx
    return pinholeDistanceM(this.fpx, IPD_M, ipdPx)
  }

  handDistanceM(spanPx: number): number {
    if (!(spanPx > 0)) return Infinity
    if (this.kHand !== null) return this.kHand / spanPx
    return pinholeDistanceM(this.fpx, WRIST_TO_MIDDLE_MCP_M, spanPx)
  }
}
