/**
 * GlassPass - the image.
 *
 * Composites the fog volume, the scattered body and the pane's own surface into the final
 * frame. One draw. Renders into a target rather than to the screen, because task 8 consumes
 * the result as a texture.
 *
 * The compositing model lives in the shader, with its four numbered steps. The short
 * version: the body is an occluder inside the fog, and the fog between it and the pane is
 * what washes it out.
 */

import type { GLContext } from '../gl/context'
import type { FrameContext, Pass } from '../gl/pass'
import { RenderTarget } from '../gl/target'
import { Program, resolveIncludes } from '../gl/program'
import { drawFullscreen } from '../gl/quad'

import commonGlsl from '../gl/shaders/common.glsl?raw'
import surfaceGlsl from '../gl/shaders/surface.glsl?raw'
import glassFrag from '../gl/shaders/glass.frag.glsl?raw'

export type GlassQuality = 'high' | 'low'

const QUALITY_DEFINE: Record<GlassQuality, number> = { high: 1, low: 0 }

export interface GlassSources {
  /** ScatterPass.output. A getter, since upstream passes may ping-pong. */
  scatter: () => RenderTarget
  /** FogPass.output, at half resolution. Read with LINEAR, so the upsample is free. */
  fog: () => RenderTarget
}

/**
 * The default heal mask: one white texel, meaning "condensation everywhere at its normal
 * thickness". Task 8 replaces this binding with the real R8 mask, where a high value means
 * the glass has healed there and is re-fogging.
 */
function createDefaultHealMask(ctx: GLContext): WebGLTexture {
  const { gl } = ctx
  const tex = gl.createTexture()
  if (!tex) throw new Error('GlassPass: failed to create the default heal mask texture')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]))
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return tex
}

export class GlassPass implements Pass {
  readonly name = 'glass'

  private ctx: GLContext
  private sources: GlassSources
  private quality: GlassQuality

  private composite: RenderTarget
  private program: Program

  private defaultHealMask: WebGLTexture
  private healMask: WebGLTexture | null = null

  /** RGBA8, LINEAR, at render resolution. Task 8 consumes this as a texture. */
  get output(): RenderTarget {
    return this.composite
  }

  constructor(ctx: GLContext, sources: GlassSources, quality: GlassQuality = 'high') {
    this.ctx = ctx
    this.sources = sources
    this.quality = quality

    this.composite = new RenderTarget(ctx, ctx.width, ctx.height, {
      format: 'rgba8',
      filter: 'linear',
    })

    this.defaultHealMask = createDefaultHealMask(ctx)
    this.program = this.buildProgram()

    console.log(`[glass] ${ctx.width}x${ctx.height} rgba8 composite, quality=${quality}`)
  }

  private buildProgram(): Program {
    const src = resolveIncludes(glassFrag, {
      'common.glsl': commonGlsl,
      'surface.glsl': surfaceGlsl,
    })
    return new Program(this.ctx, src, { QUALITY: QUALITY_DEFINE[this.quality] })
  }

  /** Drops droplets and dispersion under load. Recompiles, so not per frame. */
  setQuality(quality: GlassQuality): void {
    if (quality === this.quality) return
    this.quality = quality
    this.program.dispose()
    this.program = this.buildProgram()
    console.log(`[glass] quality=${quality}`)
  }

  /** Task 8's hook. Pass null to go back to the default 1x1 white texel. */
  setHealMask(tex: WebGLTexture | null): void {
    this.healMask = tex
  }

  render(f: FrameContext): void {
    const { ctx, params } = f
    const gl = ctx.gl

    // Direction the light TRAVELS, built exactly as FogPass builds it. The two passes have
    // to agree: the pane's sheet and specular are lit by the same source as the volume.
    const el = params.lightElevation
    const az = params.lightAzimuth
    const lightDir: [number, number, number] = [
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      -Math.cos(el) * Math.cos(az),
    ]
    const len = Math.hypot(lightDir[0], lightDir[1], lightDir[2]) || 1
    lightDir[0] /= len
    lightDir[1] /= len
    lightDir[2] /= len

    this.composite.bind()
    const prog = this.program
    prog.use()
    prog.texture('uScatter', this.sources.scatter().texture)
    prog.texture('uFog', this.sources.fog().texture)
    prog.texture('uHealMask', this.healMask ?? this.defaultHealMask)
    prog.set('uResolution', [this.composite.width, this.composite.height])
    prog.set('uTime', f.time)
    prog.set('uGlassColor', params.glassColor)
    prog.set('uSilhouetteColor', params.silhouetteColor)
    prog.set('uLightColor', params.lightColor)
    prog.set('uLightIntensity', params.lightIntensity)
    prog.set('uLightDir', lightDir)
    prog.set('uFogDensity', params.fogDensity)
    prog.set('uFogDepth', params.fogDepth)
    prog.set('uAbsorption', params.absorption)
    prog.set('uGrain', params.grain)
    prog.set('uCondensation', params.condensation)
    prog.set('uDispersion', params.dispersion)
    prog.set('uVignette', params.vignette)
    prog.set('uFilmGrain', params.filmGrain)
    drawFullscreen(ctx)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  resize(w: number, h: number): void {
    this.composite.resize(w, h)
  }

  dispose(): void {
    this.composite.dispose()
    this.program.dispose()
    this.ctx.gl.deleteTexture(this.defaultHealMask)
  }
}
