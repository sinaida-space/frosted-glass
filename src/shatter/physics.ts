/**
 * Shard physics and the heal gesture. Plain TypeScript over an array of structs, stepped
 * once per frame. At `shardCount` <= 256 this is nothing; a GPU particle system would cost
 * more to set up than it saves.
 */

import type { GlassParams } from '../state/params'
import type { TrackedHand, TrackingFrame } from '../tracking/types'
import type { Fracture, Shard } from './fracture'

/** NDC units per second the crack front travels outward from the impact. */
export const CRACK_SPEED = 2.2
/**
 * How far from the impact glass actually comes loose, in NDC, at impact strength 0 and 1.
 *
 * Cracks run the whole width of the pane but the hole does not: past a certain radius the
 * fracture energy is spent and the plate stays in its frame, held by its own edges. Without
 * this the front detaches every shard within a third of a second and the entire pane falls
 * out, which also makes the spec's "cracks are visible even where no shard has detached"
 * impossible to ever see.
 */
const DETACH_RADIUS_MIN = 0.15
const DETACH_RADIUS_GAIN = 0.25
/** NDC/s^2 pulling shards down. */
const GRAVITY = -1.4
/** Per-frame velocity retention. */
const DRAG = 0.985
/** How fast a detached shard drifts toward the viewer. */
const Z_DRIFT = 0.35
/** Landmarks push shards within this NDC radius. */
const HAND_RADIUS = 0.18
/** Speed ceiling, NDC/s, so a swept hand cannot fling a shard off in one frame. */
const MAX_SPEED = 3.0
/** Retirement bounds. */
const RETIRE_Y = -1.6
const RETIRE_X = 1.8
/** Seconds a shard takes to spring home. */
const HEAL_RETURN_S = 1.2
/** A detection dropout shorter than this does not reset the heal timer. */
const HEAL_GRACE_MS = 300

export interface ShardState {
  pos: [number, number]
  vel: [number, number]
  rot: number
  angVel: number
  z: number
  detached: boolean
  retired: boolean
  alpha: number
}

export function initShards(fracture: Fracture): ShardState[] {
  return fracture.shards.map((s) => ({
    pos: [s.restCentroid[0], s.restCentroid[1]] as [number, number],
    vel: [0, 0] as [number, number],
    rot: 0,
    angVel: 0,
    z: 0,
    detached: false,
    retired: false,
    alpha: 1,
  }))
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Advances the crack front and detaches everything it has passed.
 * Returns the new front radius.
 */
export function propagate(
  shards: readonly Shard[],
  state: ShardState[],
  front: number,
  impactStrength: number,
  refArea: number,
  dt: number
): number {
  const next = front + CRACK_SPEED * dt
  const detachRadius = DETACH_RADIUS_MIN + DETACH_RADIUS_GAIN * clamp(impactStrength, 0, 1)
  for (let i = 0; i < shards.length; i++) {
    const s = shards[i]!
    const st = state[i]!
    if (st.detached || s.distanceFromImpact > next || s.distanceFromImpact > detachRadius) continue
    st.detached = true
    // Small shards fly further for the same impulse, area standing in for mass. Measured
    // RELATIVE to the mean cell rather than as a bare 1/sqrt(area): NDC areas run from
    // 0.002 to 0.4, so the raw form spans a factor of 15 and hands the small central
    // shards 2.7 NDC/s, which throws the whole pane off screen inside a second.
    const speed =
      (0.25 + 0.5 * impactStrength) *
      clamp(Math.sqrt(refArea / Math.max(s.area, 1e-5)), 0.5, 2.5)
    const dx = s.restCentroid[0] - shards[0]!.restCentroid[0]
    const dy = s.restCentroid[1] - shards[0]!.restCentroid[1]
    const len = Math.hypot(dx, dy) || 1
    st.vel[0] = (dx / len) * speed
    st.vel[1] = (dy / len) * speed
    // Deterministic per-shard spin rather than Math.random(): the same break has to
    // replay the same way, or nothing about it can be measured twice.
    st.angVel = (((Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5) * 6.0
  }
  return next
}

/** Gravity, drag, z drift and retirement. */
export function integrate(state: ShardState[], dt: number): void {
  const drag = Math.pow(DRAG, dt * 60)
  for (const st of state) {
    if (!st.detached || st.retired) continue
    st.vel[1] += GRAVITY * dt
    st.vel[0] *= drag
    st.vel[1] *= drag
    st.pos[0] += st.vel[0] * dt
    st.pos[1] += st.vel[1] * dt
    st.rot += st.angVel * dt
    st.angVel *= drag
    st.z += Z_DRIFT * dt
    if (st.pos[1] < RETIRE_Y || Math.abs(st.pos[0]) > RETIRE_X) {
      st.retired = true
      st.alpha = 0
    }
  }
}

/**
 * Hands scatter loose shards. Also drags them along with the hand's own screen velocity,
 * which is what makes a sweep feel like a sweep rather than a series of pokes.
 */
export function applyHands(
  state: ShardState[],
  hands: readonly TrackedHand[],
  params: Readonly<GlassParams>,
  dt: number
): void {
  for (const hand of hands) {
    if (hand.distanceM - params.glassDistance > params.shatterThreshold * 2) continue
    const lm = hand.landmarks
    for (const st of state) {
      if (!st.detached || st.retired) continue
      for (let j = 0; j < 21; j++) {
        const lx = lm[j * 3]
        const ly = lm[j * 3 + 1]
        if (lx === undefined || ly === undefined) continue
        // Landmarks are video-normalised, y down, and NOT mirrored - unlike
        // `centroidNdc`, which the tracker already mirrors. Screen NDC is y up and
        // mirrored, so the flip has to be applied here or a hand pushes the shards on
        // the wrong side of the pane from the one it appears on.
        const nx = (lx * 2 - 1) * (params.mirror ? -1 : 1)
        const ny = 1 - ly * 2
        const dx = st.pos[0] - nx
        const dy = st.pos[1] - ny
        const d = Math.hypot(dx, dy)
        if (d > HAND_RADIUS) continue
        const falloff = 1 - d / HAND_RADIUS
        const inv = 1 / Math.max(d, 1e-3)
        const push = params.handRepulsion * 2.5 * falloff * dt
        st.vel[0] += dx * inv * push + hand.velocityNdc[0] * 0.35 * falloff * dt
        st.vel[1] += dy * inv * push + hand.velocityNdc[1] * 0.35 * falloff * dt
      }
      const sp = Math.hypot(st.vel[0], st.vel[1])
      if (sp > MAX_SPEED) {
        st.vel[0] *= MAX_SPEED / sp
        st.vel[1] *= MAX_SPEED / sp
      }
    }
  }
}

/**
 * Critically damped return to rest. `weight` runs 0..1 over HEAL_RETURN_S, biased so the
 * shards nearest the palms arrive first, which reads as the glass being drawn back
 * together by the hands rather than snapping.
 */
export function easeHome(
  shards: readonly Shard[],
  state: ShardState[],
  elapsed: number,
  palms: readonly [number, number][]
): boolean {
  let allHome = true
  for (let i = 0; i < shards.length; i++) {
    const s = shards[i]!
    const st = state[i]!
    let near = 0
    for (const p of palms) {
      const d = Math.hypot(st.pos[0] - p[0], st.pos[1] - p[1])
      near = Math.max(near, 1 - clamp(d / 1.4, 0, 1))
    }
    const t = clamp((elapsed / HEAL_RETURN_S) * (0.7 + 0.6 * near), 0, 1)
    // Critically damped step response: 1 - (1 + kt) e^-kt, k = 5 puts it home at t = 1.
    const k = 5
    const e = 1 - (1 + k * t) * Math.exp(-k * t)
    st.pos[0] += (s.restCentroid[0] - st.pos[0]) * e
    st.pos[1] += (s.restCentroid[1] - st.pos[1]) * e
    st.rot += (0 - st.rot) * e
    st.z += (0 - st.z) * e
    st.retired = false
    st.alpha += (1 - st.alpha) * Math.max(e, 0.02)
    if (t < 1) allHome = false
  }
  return allHome
}

export interface HealGate {
  timer: number
  graceMs: number
}

/**
 * Accumulates the heal timer. All three conditions have to hold on BOTH hands: near the
 * glass, flat, and slow. Two hands merely present is the pose of somebody standing still,
 * and would fire this constantly.
 *
 * The grace window is not politeness. MediaPipe drops a hand for a frame or two regularly,
 * and without it a performer holding a perfect pose watches the timer reset under them.
 */
export function updateHealGate(
  gate: HealGate,
  frame: Readonly<TrackingFrame>,
  params: Readonly<GlassParams>,
  dtMs: number
): boolean {
  const hands = frame.hands
  let ok = hands.length >= 2
  if (ok) {
    for (const h of hands) {
      if (h.distanceM - params.glassDistance >= params.shatterThreshold * 2.5) ok = false
      if (h.palmFlatness <= 0.6) ok = false
      if (Math.hypot(h.velocityNdc[0], h.velocityNdc[1]) >= 0.15) ok = false
    }
  }

  if (ok) {
    gate.timer += dtMs
    gate.graceMs = 0
  } else if (gate.timer > 0) {
    gate.graceMs += dtMs
    if (gate.graceMs > HEAL_GRACE_MS) {
      gate.timer = 0
      gate.graceMs = 0
    } else {
      // Inside the grace window the timer neither advances nor resets.
    }
  }

  return gate.timer > params.healHoldMs
}
