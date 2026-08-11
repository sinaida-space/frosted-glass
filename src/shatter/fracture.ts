/**
 * Fracture generation: impact point -> Voronoi shards + a crack line set.
 *
 * All geometry is NDC (-1..1 both axes). NDC-x is stretched relative to NDC-y by the
 * canvas aspect, so every radius here is divided by the aspect on x - otherwise the rings
 * come out as ellipses and the break reads as a squashed spider rather than an impact.
 */

/** Boundary vertices every shard is resampled to, so one instanced draw can cover them all. */
export const FAN_VERTS = 12

export interface Shard {
  /** Voronoi seed, and the fan apex the boundary offsets are measured from. NDC. */
  restCentroid: [number, number]
  /** FAN_VERTS boundary points as offsets from restCentroid, NDC. */
  offsets: Float32Array
  area: number
  distanceFromImpact: number
}

export interface CrackSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  distanceFromImpact: number
}

export interface Fracture {
  shards: Shard[]
  cracks: CrackSegment[]
  impact: [number, number]
}

type Pt = [number, number]

/**
 * Radial ring layout. Spacing grows with radius, so the impact point is finely shattered
 * and the far field is a few big plates - which is what a real impact looks like. A
 * uniform random layout gives a pane that reads as crazed all over instead.
 */
function ringSeeds(cx: number, cy: number, count: number, aspect: number, rand: () => number): Pt[] {
  const seeds: Pt[] = [[cx, cy]]
  let k = 1
  let prevR = 0
  while (seeds.length < count && k < 64) {
    const r = 0.06 * Math.pow(k, 1.35)
    const spacing = Math.max(r - prevR, 0.03)
    const n = Math.max(3, Math.round((2 * Math.PI * r) / spacing))
    const phase = rand() * Math.PI * 2
    for (let i = 0; i < n && seeds.length < count; i++) {
      // Angular jitter of up to half a slot, so the rings do not read as a dartboard.
      const a = phase + ((i + (rand() - 0.5) * 0.7) / n) * Math.PI * 2
      const rr = r * (0.88 + rand() * 0.24)
      seeds.push([cx + (Math.cos(a) * rr) / aspect, cy + Math.sin(a) * rr])
    }
    prevR = r
    k++
  }
  return seeds
}

/** Sutherland-Hodgman clip of a convex polygon against the half-plane n·p <= d. */
function clipHalfPlane(poly: Pt[], nx: number, ny: number, d: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const da = nx * a[0] + ny * a[1] - d
    const db = nx * b[0] + ny * b[1] - d
    if (da <= 0) out.push(a)
    if (da * db < 0) {
      const t = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

function polygonArea(poly: Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    s += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(s) * 0.5
}

/**
 * Pad or decimate a cell boundary to exactly FAN_VERTS points.
 *
 * Padding repeats the last corner, which emits degenerate triangles and leaves the shape
 * pixel-exact. Resampling by arc length would round every corner off, and a shard with
 * rounded corners does not read as glass.
 */
function toFixedFan(poly: Pt[], cx: number, cy: number): Float32Array {
  const out = new Float32Array(FAN_VERTS * 2)
  const n = poly.length
  for (let i = 0; i < FAN_VERTS; i++) {
    // When the cell has more corners than the fan holds, drop the ones that matter least
    // by walking the boundary at a constant index stride.
    const src = n <= FAN_VERTS ? poly[Math.min(i, n - 1)]! : poly[Math.floor((i * n) / FAN_VERTS)]!
    out[i * 2] = src[0] - cx
    out[i * 2 + 1] = src[1] - cy
  }
  return out
}

/** Deterministic per-impact PRNG, so a replayed break is the same break. */
function makeRand(seed: number): () => number {
  let s = (seed * 1103515245 + 12345) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function generateFracture(
  ndc0: [number, number],
  shardCount: number,
  aspect: number
): Fracture {
  const rand = makeRand(Math.floor((ndc0[0] + 2) * 7919 + (ndc0[1] + 2) * 104729))
  const seeds = ringSeeds(ndc0[0], ndc0[1], Math.max(8, shardCount), aspect, rand)

  const shards: Shard[] = []
  const cracks: CrackSegment[] = []
  const seenEdge = new Set<string>()

  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!
    let poly: Pt[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]
    for (let j = 0; j < seeds.length && poly.length > 2; j++) {
      if (j === i) continue
      const o = seeds[j]!
      const nx = o[0] - s[0]
      const ny = o[1] - s[1]
      // Perpendicular bisector of s and o: keep the side nearer to s.
      const d = (nx * (s[0] + o[0]) + ny * (s[1] + o[1])) * 0.5
      if (nx * nx + ny * ny < 1e-12) continue
      poly = clipHalfPlane(poly, nx, ny, d)
    }
    if (poly.length < 3) continue

    const dx = (s[0] - ndc0[0]) * aspect
    const dy = s[1] - ndc0[1]
    const dist = Math.hypot(dx, dy)

    shards.push({
      restCentroid: [s[0], s[1]],
      offsets: toFixedFan(poly, s[0], s[1]),
      area: polygonArea(poly),
      distanceFromImpact: dist,
    })

    // Crack lines are the cell boundaries, minus the pane's own border and minus the
    // second copy of every shared edge.
    for (let e = 0; e < poly.length; e++) {
      const a = poly[e]!
      const b = poly[(e + 1) % poly.length]!
      const onBorder =
        (Math.abs(a[0]) > 0.9999 && Math.abs(b[0]) > 0.9999) ||
        (Math.abs(a[1]) > 0.9999 && Math.abs(b[1]) > 0.9999)
      if (onBorder) continue
      const mx = (a[0] + b[0]) * 0.5
      const my = (a[1] + b[1]) * 0.5
      const key = `${Math.round(mx * 2000)},${Math.round(my * 2000)}`
      if (seenEdge.has(key)) continue
      seenEdge.add(key)
      const emx = (mx - ndc0[0]) * aspect
      const emy = my - ndc0[1]
      cracks.push({
        x0: a[0],
        y0: a[1],
        x1: b[0],
        y1: b[1],
        distanceFromImpact: Math.hypot(emx, emy),
      })
    }
  }

  return { shards, cracks, impact: [ndc0[0], ndc0[1]] }
}
