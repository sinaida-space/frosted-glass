export interface GlassParams {
  // --- Glass / scatter physics ---
  glassDistance: number      // metres from the eye to the pane. 0.15..2.0
  scatter: number            // diffuser strength; blur radius scales with this × depth. 0..1
  maxScatterPx: number       // hard cap on scatter radius in pixels at 1080p. 4..128
  contactSharpness: number   // how fast focus returns as depth -> 0. 0..1
  absorption: number         // Beer-Lambert darkening of near-contact pixels. 0..1
  grain: number              // glass micro-roughness. 0..1
  condensation: number       // fog-film density on the pane surface. 0..1
  dispersion: number         // chromatic spread through the glass. 0..1
  // --- Fog volume behind the pane ---
  fogDensity: number         // 0..1
  fogDepth: number           // metres the volume extends behind the pane. 1..8
  lightAzimuth: number       // radians
  lightElevation: number     // radians
  lightIntensity: number     // 0..2
  shafts: number             // god-ray strength. 0..1
  // --- Colour (linear RGB, 0..1) ---
  glassColor: [number, number, number]
  silhouetteColor: [number, number, number]
  lightColor: [number, number, number]
  // --- Shatter ---
  shatterThreshold: number   // metres; hand closer than this breaks the pane
  shardCount: number         // 24..256
  healHoldMs: number         // how long both palms must be still to heal
  handRepulsion: number      // how hard hands push loose shards. 0..1
  // --- Head-coupled projection ---
  parallax: number           // off-axis strength multiplier. 0..1.5
  // --- Render ---
  renderScale: number        // 0.5..1.0
  mirror: boolean
  vignette: number           // 0..1
  filmGrain: number          // 0..1
}

export const DEFAULT_PARAMS: GlassParams = {
  glassDistance: 0.45,
  scatter: 0.55,
  maxScatterPx: 48,
  contactSharpness: 0.8,
  absorption: 0.6,
  grain: 0.35,
  condensation: 0.4,
  dispersion: 0.15,
  fogDensity: 0.5,
  fogDepth: 3.5,
  lightAzimuth: -0.7,
  lightElevation: 0.35,
  lightIntensity: 1.0,
  shafts: 0.7,
  glassColor: [0.94, 0.94, 0.95],
  silhouetteColor: [0.02, 0.02, 0.03],
  lightColor: [1.0, 0.97, 0.92],
  shatterThreshold: 0.06,
  shardCount: 96,
  healHoldMs: 2000,
  handRepulsion: 0.5,
  parallax: 1.0,
  renderScale: 1.0,
  mirror: true,
  vignette: 0.35,
  filmGrain: 0.2,
}

type Listener = (p: Readonly<GlassParams>, changedKey: keyof GlassParams) => void

/** Single mutable source of truth. UI writes, passes read. No framework, no proxies. */
export class ParamStore {
  private p: GlassParams = { ...DEFAULT_PARAMS }
  private listeners = new Set<Listener>()

  get(): Readonly<GlassParams> { return this.p }

  set<K extends keyof GlassParams>(key: K, value: GlassParams[K]): void {
    if (this.p[key] === value) return
    this.p[key] = value
    for (const l of this.listeners) l(this.p, key)
  }

  patch(partial: Partial<GlassParams>): void {
    for (const k of Object.keys(partial) as (keyof GlassParams)[]) {
      const v = partial[k]
      if (v !== undefined) this.set(k, v as GlassParams[typeof k])
    }
  }

  reset(): void { this.patch(DEFAULT_PARAMS) }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => { this.listeners.delete(l) }
  }
}

export const params = new ParamStore()
