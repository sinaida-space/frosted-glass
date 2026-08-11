/**
 * ScatterPass - the frosted-glass physics.
 *
 * Turns the silhouette's (coverage, depth) field into a depth-varying scatter: a palm on
 * the pane stays razor sharp, the same hand 40 cm back is a soft cloud, the shoulder behind
 * it is milk. One MIP pyramid, one level chosen per pixel.
 *
 * Two draws: level 0 of the pyramid, then the gather. No readback, no colour, no
 * compositing - task 7 turns coverage and depth into light.
 */

import type { GLContext } from '../gl/context'
import type { FrameContext, Pass } from '../gl/pass'
import { RenderTarget } from '../gl/target'
import { Program, resolveIncludes } from '../gl/program'
import { drawFullscreen } from '../gl/quad'

import commonGlsl from '../gl/shaders/common.glsl?raw'
import scatterSourceFrag from '../gl/shaders/scatter-source.frag.glsl?raw'
import scatterFrag from '../gl/shaders/scatter.frag.glsl?raw'

export type ScatterQuality = 'high' | 'low'

const QUALITY_DEFINE: Record<ScatterQuality, number> = { high: 1, low: 0 }

/** Levels the pyramid holds for a w x h target - matches RenderTarget's own allocation. */
function levelCount(w: number, h: number): number {
  return 1 + Math.floor(Math.log2(Math.max(w, h)))
}

export class ScatterPass implements Pass {
  readonly name = 'scatter'

  private ctx: GLContext
  private source: () => RenderTarget
  private quality: ScatterQuality

  /** Mipmapped pyramid. Level 0 is written every frame, then generateMips() walks it up. */
  private pyramid: RenderTarget
  private scattered: RenderTarget

  private sourceProgram: Program
  private scatterProgram: Program

  /**
   * RGBA16F at render resolution, LINEAR, no mips.
   * R = scattered coverage · G = scattered depth in metres · B = contact factor · A = 1.
   */
  get output(): RenderTarget {
    return this.scattered
  }

  /**
   * `source` is a getter rather than a target because SilhouettePass ping-pongs its output,
   * so the underlying texture alternates every frame.
   */
  constructor(ctx: GLContext, source: () => RenderTarget, quality: ScatterQuality = 'high') {
    this.ctx = ctx
    this.source = source
    this.quality = quality

    if (!ctx.caps.colorBufferFloat) {
      throw new Error(
        'ScatterPass requires EXT_color_buffer_float: the pyramid carries metric depths ' +
          'and coverage-weighted depth products that an RGBA8 target cannot hold.'
      )
    }
    if (!ctx.caps.floatLinear) {
      // Without OES_texture_float_linear a float texture only filters NEAREST, and the
      // whole pass is trilinear reads of a float pyramid.
      throw new Error('ScatterPass requires OES_texture_float_linear to filter the MIP pyramid.')
    }

    this.pyramid = new RenderTarget(ctx, ctx.width, ctx.height, {
      format: 'rgba16f',
      filter: 'linear',
      mipmap: true,
    })
    this.scattered = new RenderTarget(ctx, ctx.width, ctx.height, {
      format: 'rgba16f',
      filter: 'linear',
    })

    this.sourceProgram = new Program(
      ctx,
      resolveIncludes(scatterSourceFrag, { 'common.glsl': commonGlsl })
    )
    this.scatterProgram = this.buildScatterProgram()

    console.log(
      `[scatter] ${ctx.width}x${ctx.height} pyramid, ${levelCount(ctx.width, ctx.height)} levels, quality=${quality}`
    )
  }

  private buildScatterProgram(): Program {
    return new Program(this.ctx, resolveIncludes(scatterFrag, { 'common.glsl': commonGlsl }), {
      QUALITY: QUALITY_DEFINE[this.quality],
    })
  }

  /** Drops to one refinement round and no lobe taps under load. Recompiles; not per frame. */
  setQuality(quality: ScatterQuality): void {
    if (quality === this.quality) return
    this.quality = quality
    this.scatterProgram.dispose()
    this.scatterProgram = this.buildScatterProgram()
    console.log(`[scatter] quality=${quality}`)
  }

  render(f: FrameContext): void {
    const { ctx, params } = f
    const gl = ctx.gl

    // --- 1. Pyramid level 0, then the mip chain ---
    this.pyramid.bind()
    this.sourceProgram.use()
    this.sourceProgram.texture('uSilhouette', this.source().texture)
    drawFullscreen(ctx)
    this.pyramid.generateMips()

    // --- 2. Per-pixel level selection and gather ---
    this.scattered.bind()
    const prog = this.scatterProgram
    prog.use()
    prog.texture('uSource', this.pyramid.texture)
    prog.set('uResolution', [this.scattered.width, this.scattered.height])
    prog.set('uScatter', params.scatter)
    prog.set('uMaxScatterPx', params.maxScatterPx)
    prog.set('uContactSharpness', params.contactSharpness)
    prog.set('uMaxLod', levelCount(this.pyramid.width, this.pyramid.height) - 1)
    drawFullscreen(ctx)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  resize(w: number, h: number): void {
    this.pyramid.resize(w, h)
    this.scattered.resize(w, h)
  }

  dispose(): void {
    this.pyramid.dispose()
    this.scattered.dispose()
    this.sourceProgram.dispose()
    this.scatterProgram.dispose()
  }
}
