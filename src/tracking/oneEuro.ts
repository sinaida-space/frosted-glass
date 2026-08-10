/**
 * One Euro filter (Casiez, Roussel, Vogel 2012).
 *
 * The filter low-pass-filters a noisy signal with a cutoff frequency that
 * adapts to the signal's speed: slow-moving signals get heavy smoothing
 * (low cutoff, less jitter), fast-moving signals get light smoothing (high
 * cutoff, less lag). `beta` controls how strongly speed raises the cutoff.
 */

function smoothingFactor(te: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * te
  return r / (r + 1)
}

function exponentialSmoothing(a: number, x: number, xPrev: number): number {
  return a * x + (1 - a) * xPrev
}

export interface OneEuroOptions {
  minCutoff?: number
  beta?: number
  dCutoff?: number
}

export const ONE_EURO_DEFAULTS: Required<OneEuroOptions> = {
  minCutoff: 0.8,
  beta: 0.02,
  dCutoff: 1.0,
}

/** Scalar One Euro filter. Feed it seconds-based timestamps. */
export class OneEuroFilter {
  private minCutoff: number
  private beta: number
  private dCutoff: number
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev: number | null = null

  constructor(opts: OneEuroOptions = {}) {
    this.minCutoff = opts.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff
    this.beta = opts.beta ?? ONE_EURO_DEFAULTS.beta
    this.dCutoff = opts.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff
  }

  /** @param t seconds */
  filter(x: number, t: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.tPrev = t
      this.xPrev = x
      this.dxPrev = 0
      return x
    }
    const te = Math.max(1e-6, t - this.tPrev)
    const dx = (x - this.xPrev) / te
    const aD = smoothingFactor(te, this.dCutoff)
    const dxHat = exponentialSmoothing(aD, dx, this.dxPrev)

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat)
    const a = smoothingFactor(te, cutoff)
    const xHat = exponentialSmoothing(a, x, this.xPrev)

    this.tPrev = t
    this.xPrev = xHat
    this.dxPrev = dxHat
    return xHat
  }

  reset(): void {
    this.xPrev = null
    this.dxPrev = 0
    this.tPrev = null
  }
}

/** Two independent OneEuroFilter channels for a 2-vector. */
export class OneEuroFilter2 {
  private fx: OneEuroFilter
  private fy: OneEuroFilter

  constructor(opts: OneEuroOptions = {}) {
    this.fx = new OneEuroFilter(opts)
    this.fy = new OneEuroFilter(opts)
  }

  filter(x: number, y: number, t: number): [number, number] {
    return [this.fx.filter(x, t), this.fy.filter(y, t)]
  }

  reset(): void {
    this.fx.reset()
    this.fy.reset()
  }
}

/** Three independent OneEuroFilter channels for a 3-vector. */
export class OneEuroFilter3 {
  private fx: OneEuroFilter
  private fy: OneEuroFilter
  private fz: OneEuroFilter

  constructor(opts: OneEuroOptions = {}) {
    this.fx = new OneEuroFilter(opts)
    this.fy = new OneEuroFilter(opts)
    this.fz = new OneEuroFilter(opts)
  }

  filter(x: number, y: number, z: number, t: number): [number, number, number] {
    return [this.fx.filter(x, t), this.fy.filter(y, t), this.fz.filter(z, t)]
  }

  reset(): void {
    this.fx.reset()
    this.fy.reset()
    this.fz.reset()
  }
}

/** Distance channels need to react instantly ("slam your palm at the glass"). */
export const DISTANCE_ONE_EURO: OneEuroOptions = { minCutoff: 0.8, beta: 0.05, dCutoff: 1.0 }
