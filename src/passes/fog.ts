/**
 * FogPass - the volumetric fog sitting behind the pane, rendered through a head-coupled
 * off-axis frustum.
 *
 * This is the parallax substrate for the whole piece. There is no geometry back there,
 * so the fog is the only thing that can shear when the viewer moves, and if it does not
 * shear the window illusion never arrives.
 *
 * The pass knows nothing about the person: no camera texture, no mask, no silhouette,
 * and it composites with nothing. It outputs the raw volume as rgb = in-scattered
 * radiance, alpha = transmittance (1 = clear).
 */

import type { GLContext } from '../gl/context'
import type { Pass, FrameContext } from '../gl/pass'
import type { TrackedFace } from '../tracking/types'
import { RenderTarget, PingPong, type TargetFormat } from '../gl/target'
import { Program, resolveIncludes } from '../gl/program'
import { drawFullscreen } from '../gl/quad'
import { getInverseViewProjection, getEyeWorld, setScreenAspect, updateEye } from './camera'

import commonGlsl from '../gl/shaders/common.glsl?raw'
import volumeGlsl from '../gl/shaders/volume.glsl?raw'
import fogFragSrc from '../gl/shaders/fog.frag.glsl?raw'

/**
 * Three levels, matching the app-wide quality ladder. The pass was written with two
 * (24 / 16); `medium` keeps that 16-step march and `low` drops to 12, which is where the
 * banding the temporal blend can still hide starts to become visible.
 */
export type FogQuality = 'high' | 'medium' | 'low'

const STEPS_FOR_QUALITY: Record<FogQuality, number> = { high: 24, medium: 16, low: 12 }

/** World-space frequency of the density field. Tuned against a ~2 m wide, 3.5 m deep slab. */
const NOISE_SCALE = 4.0

/** Weight of the previous frame in the temporal blend. */
const TEMPORAL_BLEND = 0.35

/**
 * Eye motion per frame, in metres, above which temporal reprojection is abandoned.
 * The history buffer is not reprojected, so blending it across real head motion smears
 * the fog behind the viewer instead of sharpening it.
 */
const EYE_MOTION_THRESHOLD = 0.01

/**
 * Blends the freshly marched volume with the previous frame. uBlend is the weight of
 * history, and is forced to 0 on the frame after a resize or a fast head movement.
 */
const TEMPORAL_FRAG_SRC = `#version 300 es
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform float uBlend;
void main() {
  vec4 cur = texture(uCurrent, vUv);
  vec4 prev = texture(uHistory, vUv);
  fragColor = mix(cur, prev, uBlend);
}
`

export class FogPass implements Pass {
  readonly name = 'fog'

  private ctx: GLContext
  private quality: FogQuality
  private volumeProgram: Program
  private temporalProgram: Program

  /** Freshly marched volume, before temporal smoothing. Half resolution. */
  private raw: RenderTarget
  /** Temporally smoothed result. Ping-ponged so the previous frame survives. */
  private history: PingPong

  private halfWidth: number
  private halfHeight: number

  /** True for the frame after a resize or a fast eye move: history is not trustworthy. */
  private historyInvalid = true

  private lastEye: [number, number, number] = getEyeWorld()

  /**
   * The temporally smoothed volume. This is a getter because the pass ping-pongs its
   * history, so the underlying target alternates every frame.
   */
  get output(): RenderTarget {
    return this.history.read
  }

  constructor(ctx: GLContext, width: number, height: number, quality: FogQuality = 'high') {
    this.ctx = ctx
    this.quality = quality

    this.halfWidth = Math.max(1, width >> 1)
    this.halfHeight = Math.max(1, height >> 1)

    // RGBA16F because alpha carries transmittance and rgb carries unclamped radiance;
    // rgba8 would quantise both and band the fog on its own.
    const format: TargetFormat = ctx.caps.colorBufferFloat ? 'rgba16f' : 'rgba8'
    if (format === 'rgba8') {
      console.warn('[fog] EXT_color_buffer_float missing; falling back to rgba8. Expect banding.')
    }

    const opts = { format, filter: 'linear' as const }
    this.raw = new RenderTarget(ctx, this.halfWidth, this.halfHeight, opts)
    this.history = new PingPong(ctx, this.halfWidth, this.halfHeight, opts)

    this.volumeProgram = this.buildVolumeProgram()
    this.temporalProgram = new Program(ctx, TEMPORAL_FRAG_SRC)

    setScreenAspect(width / height)
    console.log(
      `[fog] half-res target ${this.halfWidth}x${this.halfHeight} (main ${width}x${height}), ` +
        `format=${format}, STEPS=${STEPS_FOR_QUALITY[quality]}`
    )
  }

  private buildVolumeProgram(): Program {
    const src = resolveIncludes(fogFragSrc, {
      'common.glsl': commonGlsl,
      'volume.glsl': volumeGlsl,
    })
    return new Program(this.ctx, src, { STEPS: STEPS_FOR_QUALITY[this.quality] })
  }

  /** Drops the march under load. Recompiles, so do not call this per frame. */
  setQuality(quality: FogQuality): void {
    if (quality === this.quality) return
    this.quality = quality
    this.volumeProgram.dispose()
    this.volumeProgram = this.buildVolumeProgram()
    this.historyInvalid = true
    console.log(`[fog] quality=${quality} STEPS=${STEPS_FOR_QUALITY[quality]}`)
  }

  /**
   * Advances the damped off-axis eye. Call once per frame before render().
   *
   * Passing null (no face detected) does not freeze the view: the spring keeps running
   * and eases back to the neutral eye over about a second.
   */
  setEye(face: TrackedFace | null, dt: number, parallax = 1.0): void {
    updateEye(face, dt, parallax)

    const eye = getEyeWorld()
    const moved = Math.hypot(
      eye[0] - this.lastEye[0],
      eye[1] - this.lastEye[1],
      eye[2] - this.lastEye[2]
    )
    if (moved > EYE_MOTION_THRESHOLD) this.historyInvalid = true
    this.lastEye = eye
  }

  render(f: FrameContext): void {
    const { ctx, params } = f
    const gl = ctx.gl

    const el = params.lightElevation
    const az = params.lightAzimuth
    // Direction the light TRAVELS through the volume.
    const lightDir: [number, number, number] = [
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      -Math.cos(el) * Math.cos(az),
    ]
    const len = Math.hypot(lightDir[0], lightDir[1], lightDir[2]) || 1
    lightDir[0] /= len
    lightDir[1] /= len
    lightDir[2] /= len

    // --- 1. March the volume into the raw half-res target ---
    this.raw.bind()
    this.volumeProgram.use()
    this.volumeProgram.set('uInvViewProj', getInverseViewProjection())
    this.volumeProgram.set('uEyeWorld', getEyeWorld())
    this.volumeProgram.set('uTime', f.time)
    this.volumeProgram.set('uFogDensity', params.fogDensity)
    this.volumeProgram.set('uFogDepth', params.fogDepth)
    this.volumeProgram.set('uNoiseScale', NOISE_SCALE)
    this.volumeProgram.set('uLightDir', lightDir)
    this.volumeProgram.set('uLightColor', params.lightColor)
    this.volumeProgram.set('uLightIntensity', params.lightIntensity)
    this.volumeProgram.set('uShafts', params.shafts)
    drawFullscreen(ctx)

    // --- 2. Temporal smoothing, into the ping-pong write target ---
    this.history.write.bind()
    this.temporalProgram.use()
    this.temporalProgram.texture('uCurrent', this.raw.texture)
    this.temporalProgram.texture('uHistory', this.history.read.texture)
    this.temporalProgram.set('uBlend', this.historyInvalid ? 0.0 : TEMPORAL_BLEND)
    drawFullscreen(ctx)
    this.history.swap()

    this.historyInvalid = false

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  resize(width: number, height: number): void {
    const hw = Math.max(1, width >> 1)
    const hh = Math.max(1, height >> 1)
    if (hw === this.halfWidth && hh === this.halfHeight) return

    this.halfWidth = hw
    this.halfHeight = hh
    this.raw.resize(hw, hh)
    this.history.resize(hw, hh)
    setScreenAspect(width / height)
    this.historyInvalid = true

    console.log(`[fog] half-res target resized to ${hw}x${hh} (main ${width}x${height})`)
  }

  dispose(): void {
    this.volumeProgram.dispose()
    this.temporalProgram.dispose()
    this.raw.dispose()
    this.history.dispose()
  }
}
