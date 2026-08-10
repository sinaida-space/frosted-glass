import { DEFAULT_PARAMS, params, type GlassParams } from '../state/params'

export interface Preset {
  name: string
  params: Partial<GlassParams>
  savedAt: number
}

const STORAGE_KEY = 'frosted-glass:presets'
const MAX_HASH_LEN = 1500

/** Documented (or reasonably inferred, where the type comment gives none) numeric ranges. */
const RANGES: Partial<Record<keyof GlassParams, [number, number]>> = {
  glassDistance: [0.15, 2.0],
  scatter: [0, 1],
  maxScatterPx: [4, 128],
  contactSharpness: [0, 1],
  absorption: [0, 1],
  grain: [0, 1],
  condensation: [0, 1],
  dispersion: [0, 1],
  fogDensity: [0, 1],
  fogDepth: [1, 8],
  lightAzimuth: [-Math.PI, Math.PI],
  lightElevation: [-Math.PI / 2, Math.PI / 2],
  lightIntensity: [0, 2],
  shafts: [0, 1],
  shatterThreshold: [0.01, 0.5],
  shardCount: [24, 256],
  healHoldMs: [100, 10000],
  handRepulsion: [0, 1],
  parallax: [0, 1.5],
  renderScale: [0.5, 1.0],
  vignette: [0, 1],
  filmGrain: [0, 1],
}

const COLOR_KEYS: (keyof GlassParams)[] = ['glassColor', 'silhouetteColor', 'lightColor']
const BOOLEAN_KEYS: (keyof GlassParams)[] = ['mirror']

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function validateColor(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const [r, g, b] = v
  if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b)) return null
  return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)]
}

/** Validates one raw key/value pair against DEFAULT_PARAMS' shape, clamping numbers to range. */
function validateEntry<K extends keyof GlassParams>(
  key: K,
  value: unknown,
): GlassParams[K] | undefined {
  if (!(key in DEFAULT_PARAMS)) return undefined
  if (COLOR_KEYS.includes(key)) {
    const c = validateColor(value)
    return c === null ? undefined : (c as GlassParams[K])
  }
  if (BOOLEAN_KEYS.includes(key)) {
    return typeof value === 'boolean' ? (value as GlassParams[K]) : undefined
  }
  if (!isFiniteNumber(value)) return undefined
  const range = RANGES[key]
  const num = range ? clamp(value, range[0], range[1]) : value
  return num as GlassParams[K]
}

function readStore(): Preset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is Preset =>
        !!p && typeof p === 'object' && typeof (p as Preset).name === 'string' && typeof (p as Preset).params === 'object',
    )
  } catch {
    return []
  }
}

function writeStore(presets: Preset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
  } catch {
    // storage full or unavailable — silently drop, nothing else to do here
  }
}

export function listPresets(): Preset[] {
  return readStore()
}

export function savePreset(name: string): Preset {
  const current = params.get()
  const diff: Partial<GlassParams> = {}
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof GlassParams)[]) {
    ;(diff as Record<string, unknown>)[k] = current[k]
  }
  const preset: Preset = { name, params: diff, savedAt: Date.now() }
  const existing = readStore().filter((p) => p.name !== name)
  writeStore([...existing, preset])
  return preset
}

export function loadPreset(name: string): boolean {
  const found = BUILTIN_PRESETS.find((p) => p.name === name) ?? readStore().find((p) => p.name === name)
  if (!found) return false
  const validated: Partial<GlassParams> = {}
  for (const k of Object.keys(found.params) as (keyof GlassParams)[]) {
    const v = validateEntry(k, found.params[k])
    if (v !== undefined) (validated as Record<string, unknown>)[k] = v
  }
  params.patch(validated)
  return true
}

export function deletePreset(name: string): boolean {
  const existing = readStore()
  const next = existing.filter((p) => p.name !== name)
  if (next.length === existing.length) return false
  writeStore(next)
  return true
}

/**
 * Five built-in looks. Gothic register, no exclamation marks — names from the
 * project's own vocabulary. Each is a coherent set of values across the whole
 * GlassParams range, distinct at a glance from the others and from DEFAULT_PARAMS.
 */
export const BUILTIN_PRESETS: Preset[] = [
  {
    name: 'Mortuary',
    savedAt: 0,
    params: {
      glassDistance: 0.4,
      scatter: 0.35,
      maxScatterPx: 32,
      contactSharpness: 0.9,
      absorption: 0.5,
      grain: 0.15,
      condensation: 0.2,
      dispersion: 0.08,
      fogDensity: 0.25,
      fogDepth: 2.5,
      lightAzimuth: 0,
      lightElevation: 0.9,
      lightIntensity: 1.6,
      shafts: 0.2,
      glassColor: [0.97, 0.97, 0.98],
      silhouetteColor: [0.03, 0.03, 0.04],
      lightColor: [1.0, 1.0, 0.98],
      vignette: 0.2,
      filmGrain: 0.1,
    },
  },
  {
    name: 'Breath',
    savedAt: 0,
    params: {
      scatter: 0.2,
      grain: 0.4,
      condensation: 0.85,
      dispersion: 0.1,
      fogDensity: 0.35,
      fogDepth: 3.0,
      lightAzimuth: -1.0,
      lightElevation: 0.4,
      lightIntensity: 1.1,
      shafts: 0.3,
      glassColor: [0.9, 0.86, 0.78],
      silhouetteColor: [0.05, 0.03, 0.02],
      lightColor: [1.0, 0.85, 0.6],
      vignette: 0.3,
      filmGrain: 0.15,
    },
  },
  {
    name: 'Interrogation',
    savedAt: 0,
    params: {
      scatter: 0.15,
      grain: 0.5,
      contactSharpness: 1.0,
      absorption: 0.8,
      condensation: 0.1,
      fogDensity: 0.1,
      fogDepth: 1.5,
      lightAzimuth: -0.5,
      lightElevation: 1.1,
      lightIntensity: 1.9,
      shafts: 0.95,
      glassColor: [0.85, 0.85, 0.87],
      silhouetteColor: [0.0, 0.0, 0.0],
      lightColor: [1.0, 0.98, 0.9],
      vignette: 0.55,
      filmGrain: 0.3,
    },
  },
  {
    name: 'Drowned',
    savedAt: 0,
    params: {
      scatter: 0.9,
      maxScatterPx: 96,
      grain: 0.3,
      condensation: 0.5,
      dispersion: 0.3,
      fogDensity: 0.85,
      fogDepth: 7.0,
      lightAzimuth: 1.2,
      lightElevation: 0.2,
      lightIntensity: 0.7,
      shafts: 0.5,
      glassColor: [0.55, 0.65, 0.72],
      silhouetteColor: [0.02, 0.04, 0.06],
      lightColor: [0.7, 0.85, 0.95],
      vignette: 0.5,
      filmGrain: 0.2,
    },
  },
  {
    name: 'Reliquary',
    savedAt: 0,
    params: {
      scatter: 0.4,
      absorption: 0.9,
      grain: 0.85,
      condensation: 0.3,
      fogDensity: 0.6,
      fogDepth: 4.0,
      lightAzimuth: -2.2,
      lightElevation: 0.15,
      lightIntensity: 0.4,
      shafts: 0.15,
      glassColor: [0.3, 0.27, 0.25],
      silhouetteColor: [0.01, 0.01, 0.01],
      lightColor: [0.9, 0.75, 0.55],
      vignette: 0.75,
      filmGrain: 0.6,
    },
  },
]

/** Serialises only the params that differ from DEFAULT_PARAMS. Sets location.hash and returns the full URL. */
export function encodeParamsToUrl(): string {
  const current = params.get()
  const diff: Partial<GlassParams> = {}
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof GlassParams)[]) {
    const a = current[k]
    const b = DEFAULT_PARAMS[k]
    const changed = Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a) !== JSON.stringify(b) : a !== b
    if (changed) (diff as Record<string, unknown>)[k] = a
  }
  let encoded = encodeURIComponent(JSON.stringify(diff))
  if (encoded.length > MAX_HASH_LEN) {
    // Truncation would corrupt the JSON; better to drop to an empty diff than ship a broken link.
    encoded = encodeURIComponent(JSON.stringify({}))
  }
  const hash = `#p=${encoded}`
  location.hash = hash
  const base = location.href.split('#')[0]
  return `${base}${hash}`
}

/** Reads location.hash at boot, validates every key against DEFAULT_PARAMS, clamps numbers, and patches the store. */
export function applyParamsFromUrl(): boolean {
  const hash = location.hash
  if (!hash || !hash.startsWith('#p=')) return false
  const raw = hash.slice(3)
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false

  const validated: Partial<GlassParams> = {}
  let any = false
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = validateEntry(key as keyof GlassParams, value)
    if (v !== undefined) {
      ;(validated as Record<string, unknown>)[key] = v
      any = true
    }
  }
  if (!any) return false
  params.patch(validated)
  return true
}
