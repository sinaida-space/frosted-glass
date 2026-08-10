/**
 * Head-coupled off-axis projection (Robert Kooima, "Generalized Perspective Projection").
 *
 * The spatial model, fixed for the whole project:
 *   The physical screen IS the pane. World origin sits at the screen centre,
 *   +x right, +y up, +z out toward the viewer. The webcam sits at the origin.
 *   The tracked eye is at TrackedFace.eyeCenterM, so +z, in front of the pane.
 *   The fog volume occupies z in [-fogDepth, 0], behind the pane.
 *
 * The point of the whole file is that the frustum is ASYMMETRIC. A symmetric frustum
 * with a translated eye gives head-tracked panning, which looks superficially similar
 * and is wrong: it swings the whole world instead of shearing it against the window
 * frame. Only l/r/b/t computed independently from the eye position produce the shear
 * that reads as looking through a hole in the wall.
 *
 * 4x4 maths is written out inline here on purpose - no gl-matrix, no math module.
 * All matrices are column-major Float32Array, i.e. GL/uniformMatrix4fv order:
 * m[col * 4 + row].
 */

import type { TrackedFace } from '../tracking/types'

/** Assumed physical width of the screen in metres. Sets how strong the parallax feels. */
export const SCREEN_WIDTH_M = 0.30

const NEAR = 0.05
const FAR = 20.0

/** Where the eye rests when nobody is tracked: centred, 0.6 m in front of the pane. */
const NEUTRAL_EYE: [number, number, number] = [0.0, 0.0, 0.6]

/** Critically-damped spring stiffness while a face is tracked. Settles in ~0.4 s. */
const OMEGA_TRACKED = 12.0
/**
 * Slower spring used while no face is tracked, so losing the face eases the view back
 * to neutral over roughly a second (settling time of a critically damped spring is
 * about 5 / omega) instead of yanking it. It is never frozen: the spring always runs.
 */
const OMEGA_NEUTRAL = 4.5

/** Spring integration substep. Guards against instability on a long frame. */
const MAX_SUBSTEP = 1 / 120
/** Ignore absurd frame times (tab was backgrounded) rather than exploding the spring. */
const MAX_DT = 0.25

// --- Minimal inline 4x4 maths ---------------------------------------------

type Vec3 = [number, number, number]

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  if (len < 1e-9) return [0, 0, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

/** Standard glFrustum. Asymmetric whenever l != -r or b != -t. Column-major. */
function frustum(out: Float32Array, l: number, r: number, b: number, t: number, n: number, f: number): void {
  out.fill(0)
  out[0] = (2 * n) / (r - l)
  out[5] = (2 * n) / (t - b)
  out[8] = (r + l) / (r - l)
  out[9] = (t + b) / (t - b)
  out[10] = -(f + n) / (f - n)
  out[11] = -1
  out[14] = -(2 * f * n) / (f - n)
}

/** out = a * b, both column-major. `out` must not alias `a` or `b`. */
function multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0]!
    const b1 = b[c * 4 + 1]!
    const b2 = b[c * 4 + 2]!
    const b3 = b[c * 4 + 3]!
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b0 + a[4 + r]! * b1 + a[8 + r]! * b2 + a[12 + r]! * b3
    }
  }
}

/** General cofactor inverse. Returns false (and leaves `out` as identity) if singular. */
function invert(out: Float32Array, m: Float32Array): boolean {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!

  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (Math.abs(det) < 1e-12) {
    identity(out)
    return false
  }
  const id = 1.0 / det

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * id
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * id
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * id
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * id
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * id
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * id
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * id
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * id
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * id
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * id
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * id
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * id
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * id
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * id
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * id
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * id
  return true
}

function identity(out: Float32Array): void {
  out.fill(0)
  out[0] = 1
  out[5] = 1
  out[10] = 1
  out[15] = 1
}

// --- Camera state ----------------------------------------------------------

/** Screen aspect (width / height). Drives the physical screen height. */
let aspect = 16 / 9

/** Damped eye position in world metres, and its velocity. */
const eye: Vec3 = [...NEUTRAL_EYE]
const eyeVel: Vec3 = [0, 0, 0]

const projMat = new Float32Array(16)
const viewMat = new Float32Array(16)
const viewProjMat = new Float32Array(16)
const invViewProjMat = new Float32Array(16)

let dirty = true

identity(viewProjMat)
identity(invViewProjMat)

/**
 * Sets the screen aspect. The physical screen is SCREEN_WIDTH_M wide and its height
 * follows from the canvas aspect, so the frustum matches what the viewer actually sees.
 */
export function setScreenAspect(a: number): void {
  const next = a > 0 && Number.isFinite(a) ? a : 16 / 9
  if (next === aspect) return
  aspect = next
  dirty = true
}

/**
 * Advances the damped eye toward the tracked face (or toward neutral when there is none)
 * and marks the matrices for rebuild.
 *
 * `parallax` scales the lateral eye offset only: pe = (x * parallax, y * parallax, z).
 * At parallax = 0 the eye sits on the screen axis and the frustum goes symmetric, which
 * is exactly the "no shear" reference case.
 *
 * The damping is a critically-damped spring rather than a lerp on purpose. A lerp still
 * tracks a single-frame outlier at full rate; the spring carries velocity, so one dropped
 * detection does not snap the world sideways in front of an audience.
 */
export function updateEye(face: TrackedFace | null, dt: number, parallax: number): void {
  const step = Math.min(Math.max(dt, 0), MAX_DT)

  let target: Vec3
  let omega: number
  if (face) {
    const m = face.eyeCenterM
    target = [m[0] * parallax, m[1] * parallax, m[2]]
    omega = OMEGA_TRACKED
  } else {
    target = NEUTRAL_EYE
    omega = OMEGA_NEUTRAL
  }

  // Substepped so a long frame cannot make the explicit integrator diverge.
  let remaining = step
  while (remaining > 0) {
    const h = Math.min(remaining, MAX_SUBSTEP)
    remaining -= h
    for (let i = 0; i < 3; i++) {
      const x = eye[i]! + eyeVel[i]! * h
      const v = eyeVel[i]! + (-2.0 * omega * eyeVel[i]! - omega * omega * (x - target[i]!)) * h
      eye[i] = x
      eyeVel[i] = v
    }
  }

  // The eye must stay in front of the pane or the frustum degenerates (d -> 0).
  if (eye[2] < 0.05) {
    eye[2] = 0.05
    if (eyeVel[2] < 0) eyeVel[2] = 0
  }

  dirty = true
}

/** Snaps the eye to a position with zero velocity. Used by tests and synthetic eye paths. */
export function setEyeImmediate(x: number, y: number, z: number): void {
  eye[0] = x
  eye[1] = y
  eye[2] = Math.max(0.05, z)
  eyeVel[0] = 0
  eyeVel[1] = 0
  eyeVel[2] = 0
  dirty = true
}

function rebuild(): void {
  const w = SCREEN_WIDTH_M
  const h = SCREEN_WIDTH_M / aspect

  // Screen corners in world metres: lower-left, lower-right, upper-left.
  const pa: Vec3 = [-w / 2, -h / 2, 0]
  const pb: Vec3 = [w / 2, -h / 2, 0]
  const pc: Vec3 = [-w / 2, h / 2, 0]
  const pe: Vec3 = [eye[0]!, eye[1]!, eye[2]!]

  // Orthonormal basis of the screen. vn points out of the screen, toward the viewer.
  const vr = normalize(sub(pb, pa))
  const vu = normalize(sub(pc, pa))
  const vn = normalize(cross(vr, vu))

  // Eye-to-corner vectors.
  const va = sub(pa, pe)
  const vb = sub(pb, pe)
  const vc = sub(pc, pe)

  // Perpendicular distance from the eye to the screen plane.
  const d = -dot(vn, va)

  // Frustum extents on the near plane. These are what make it asymmetric.
  const l = (dot(vr, va) * NEAR) / d
  const r = (dot(vr, vb) * NEAR) / d
  const b = (dot(vu, va) * NEAR) / d
  const t = (dot(vu, vc) * NEAR) / d

  frustum(projMat, l, r, b, t, NEAR, FAR)

  // View = M * translate(-pe), where M has vr/vu/vn as its rows (world -> eye basis).
  // Column-major, so the rows of M land in m[0,4,8], m[1,5,9], m[2,6,10].
  viewMat[0] = vr[0]; viewMat[4] = vr[1]; viewMat[8] = vr[2]; viewMat[12] = -dot(vr, pe)
  viewMat[1] = vu[0]; viewMat[5] = vu[1]; viewMat[9] = vu[2]; viewMat[13] = -dot(vu, pe)
  viewMat[2] = vn[0]; viewMat[6] = vn[1]; viewMat[10] = vn[2]; viewMat[14] = -dot(vn, pe)
  viewMat[3] = 0; viewMat[7] = 0; viewMat[11] = 0; viewMat[15] = 1

  multiply(viewProjMat, projMat, viewMat)
  invert(invViewProjMat, viewProjMat)

  dirty = false
}

/** View-projection matrix, column-major. Rebuilt lazily. */
export function getViewProjection(): Float32Array {
  if (dirty) rebuild()
  return viewProjMat
}

/** Inverse view-projection, column-major. Fragment shaders unproject NDC rays with this. */
export function getInverseViewProjection(): Float32Array {
  if (dirty) rebuild()
  return invViewProjMat
}

/** Current damped eye position in world metres. */
export function getEyeWorld(): [number, number, number] {
  return [eye[0]!, eye[1]!, eye[2]!]
}
