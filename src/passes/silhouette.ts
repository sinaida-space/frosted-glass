import type { GLContext } from '../gl/context'
import type { FrameContext, Pass } from '../gl/pass'
import { PingPong, RenderTarget } from '../gl/target'
import { Program, resolveIncludes } from '../gl/program'
import { drawFullscreen } from '../gl/quad'
import { createMaskTexture, createVideoTexture, uploadMask, uploadVideo } from '../gl/upload'
import type { TrackingFrame } from '../tracking/types'

import commonGlsl from '../gl/shaders/common.glsl?raw'
import silhouetteFrag from '../gl/shaders/silhouette.frag.glsl?raw'
import splatVert from '../gl/shaders/proximity-splat.vert.glsl?raw'
import splatFrag from '../gl/shaders/proximity-splat.frag.glsl?raw'

/** Low-res accumulation buffer for the landmark splats. Screen-aligned, 16:9. */
const PROXIMITY_W = 256
const PROXIMITY_H = 144

/** 2 hands x 21 landmarks, plus one face splat and one torso splat. */
const MAX_SPLATS = 2 * 21 + 2
/** centre.xy, radius.xy, dz, weight, confidence */
const FLOATS_PER_SPLAT = 7

/** Metres behind the pane assumed for the body when no face has been detected yet. */
const DEFAULT_FACE_DZ = 1.2
/** Shoulders read a little further back than the face; this is what gives the body volume. */
const TORSO_DEPTH_OFFSET = 0.18
/** Unattributed pixels sit behind the face so they blur out rather than snapping forward. */
const FALLBACK_DEPTH_OFFSET = 0.3
/** Torso splat centre, in video NDC below the eyes. */
const TORSO_NDC_DROP = 0.55

const MAX_DZ = 8

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** clamp() that also swallows Infinity/NaN - `distanceM` is Infinity when a span is degenerate. */
function safeDz(distanceM: number, glassDistance: number): number {
  const dz = distanceM - glassDistance
  if (!Number.isFinite(dz)) return MAX_DZ
  return clamp(dz, 0, MAX_DZ)
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('SilhouettePass: failed to create shader object')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no info log)'
    gl.deleteShader(shader)
    throw new Error(`SilhouettePass: splat shader compile failed:\n${log}`)
  }
  return shader
}

/**
 * The splat needs a real vertex shader with instanced attributes, and gl/program.ts
 * hard-wires the shared fullscreen triangle, so this one program is linked by hand.
 * It takes no uniforms - everything is per-instance.
 */
function linkSplatProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, splatVert)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, splatFrag)
  const prog = gl.createProgram()
  if (!prog) throw new Error('SilhouettePass: failed to create program object')
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '(no info log)'
    gl.deleteProgram(prog)
    throw new Error(`SilhouettePass: splat program link failed:\n${log}`)
  }
  return prog
}

export interface ContactReport {
  strength: number
  ndc: [number, number]
  handIndex: number
}

/**
 * Joins "where is a person" (the 256^2 segmentation mask) to "how far behind the glass is
 * this piece of them" (43 landmarks with a metric depth each), and writes both into one
 * RGBA16F texture at render resolution.
 */
export class SilhouettePass implements Pass {
  readonly name = 'silhouette'

  private ctx: GLContext
  private gl: WebGL2RenderingContext

  private proximity: RenderTarget
  private silhouette: PingPong

  private splatProgram: WebGLProgram
  private splatVao: WebGLVertexArrayObject
  private splatBuffer: WebGLBuffer
  private splatData = new Float32Array(MAX_SPLATS * FLOATS_PER_SPLAT)
  private splatCount = 0

  private resolveProgram: Program

  private maskTexture: WebGLTexture
  private videoTexture: WebGLTexture

  private hasMask = false
  private maskWidth = 256
  private maskHeight = 256
  private historyValid = false

  /** Video -> canvas `cover` fit. Identity until the first frame with a live video. */
  private uvScale: [number, number] = [1, 1]
  private uvOffset: [number, number] = [0, 0]
  private mirror = true
  private fallbackDz = DEFAULT_FACE_DZ + FALLBACK_DEPTH_OFFSET

  /** Max coverage-weighted contact factor this frame. Task 8 decides what to do with it. */
  contact: ContactReport | null = null

  /** RGBA16F at render resolution. R = coverage, G = dz metres, B = attribution, A = 1. */
  get output(): RenderTarget {
    return this.silhouette.read
  }

  constructor(ctx: GLContext) {
    this.ctx = ctx
    this.gl = ctx.gl

    if (!ctx.caps.colorBufferFloat) {
      throw new Error(
        'SilhouettePass requires EXT_color_buffer_float: the proximity splat accumulates ' +
          'unbounded weights and metric depths that an RGBA8 target cannot hold.'
      )
    }

    const gl = this.gl

    this.proximity = new RenderTarget(ctx, PROXIMITY_W, PROXIMITY_H, {
      format: 'rgba16f',
      filter: 'linear',
    })
    this.silhouette = new PingPong(ctx, ctx.width, ctx.height, {
      format: 'rgba16f',
      filter: 'linear',
    })

    this.splatProgram = linkSplatProgram(gl)

    const buffer = gl.createBuffer()
    if (!buffer) throw new Error('SilhouettePass: failed to create instance buffer')
    this.splatBuffer = buffer

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('SilhouettePass: failed to create VAO')
    this.splatVao = vao

    const stride = FLOATS_PER_SPLAT * 4
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.splatData.byteLength, gl.DYNAMIC_DRAW)
    // Every attribute is per-instance (divisor 1); the quad corners come from gl_VertexID.
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16)
    gl.vertexAttribDivisor(2, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    this.resolveProgram = new Program(
      ctx,
      resolveIncludes(silhouetteFrag, { 'common.glsl': commonGlsl })
    )

    this.maskTexture = createMaskTexture(ctx)
    this.videoTexture = createVideoTexture(ctx)
  }

  // --- CPU: tracking -> splat instances, uv transform, contact ---------------

  /**
   * Consumes one tracking frame: uploads mask and video, rebuilds the splat instance
   * buffer, and computes `contact`. No GPU readback anywhere - `readPixels` would stall
   * the pipeline for a number the CPU already has.
   */
  update(frame: Readonly<TrackingFrame>, f: FrameContext): void {
    const p = f.params
    this.mirror = p.mirror

    if (frame.maskData && frame.maskWidth > 0 && frame.maskHeight > 0) {
      uploadMask(this.ctx, this.maskTexture, frame.maskData, frame.maskWidth, frame.maskHeight)
      this.maskWidth = frame.maskWidth
      this.maskHeight = frame.maskHeight
      this.hasMask = true
    }

    if (frame.video && frame.videoWidth > 0 && frame.videoHeight > 0) {
      uploadVideo(this.ctx, this.videoTexture, frame.video)
      this.computeCoverFit(frame.videoWidth, frame.videoHeight)
    }

    this.buildSplats(frame, p.glassDistance)
    this.computeContact(frame, p.glassDistance, p.shatterThreshold)
  }

  /**
   * `cover` fit of a 16:9 video into an arbitrary canvas: fill the canvas, crop the
   * overflowing axis, keep the crop centred. Anything else stretches faces.
   */
  private computeCoverFit(videoWidth: number, videoHeight: number): void {
    const videoAspect = videoWidth / videoHeight
    const canvasAspect = this.ctx.width / Math.max(1, this.ctx.height)

    if (canvasAspect > videoAspect) {
      // Canvas is wider: use the full width, crop top and bottom.
      this.uvScale = [1, videoAspect / canvasAspect]
    } else {
      this.uvScale = [canvasAspect / videoAspect, 1]
    }
    this.uvOffset = [(1 - this.uvScale[0]) / 2, (1 - this.uvScale[1]) / 2]
  }

  /**
   * Video-space normalised coordinates (0..1, top-left origin, as MediaPipe emits them)
   * -> screen NDC (-1..1, y up), through the same cover fit and mirror the shader applies
   * to texture UVs. Inverting the shader's mapping here is what keeps splats registered
   * with the pixels they describe.
   */
  private videoUvToScreenNdc(x: number, y: number): [number, number] {
    const mx = this.mirror ? 1 - x : x
    const sx = (mx - this.uvOffset[0]) / this.uvScale[0]
    const sy = (y - this.uvOffset[1]) / this.uvScale[1]
    return [sx * 2 - 1, 1 - sy * 2]
  }

  /**
   * Tracking already mirrors `centroidNdc` and `eyeCenterNdc` (tracker.ts, runHands /
   * runFace), so those must NOT be mirrored again - only un-projected from video NDC
   * into screen NDC through the cover fit.
   */
  private videoNdcToScreenNdc(nx: number, ny: number): [number, number] {
    const sx = ((nx + 1) / 2 - this.uvOffset[0]) / this.uvScale[0]
    const sy = ((1 - ny) / 2 - this.uvOffset[1]) / this.uvScale[1]
    return [sx * 2 - 1, 1 - sy * 2]
  }

  private pushSplat(
    cx: number,
    cy: number,
    radiusNdc: number,
    dz: number,
    weight: number,
    conf: number
  ): void {
    if (this.splatCount >= MAX_SPLATS) return
    if (!(weight > 0)) return
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return

    // Radius is given in NDC-y units. NDC-x spans the canvas width, so the same pixel
    // radius is a smaller number there - divide by the aspect to keep splats circular.
    const aspect = this.ctx.width / Math.max(1, this.ctx.height)

    const i = this.splatCount * FLOATS_PER_SPLAT
    this.splatData[i] = cx
    this.splatData[i + 1] = cy
    this.splatData[i + 2] = radiusNdc / aspect
    this.splatData[i + 3] = radiusNdc
    this.splatData[i + 4] = dz
    this.splatData[i + 5] = weight
    this.splatData[i + 6] = conf
    this.splatCount++
  }

  private buildSplats(frame: Readonly<TrackingFrame>, glassDistance: number): void {
    this.splatCount = 0

    const face = frame.face
    const faceDz = face ? safeDz(face.distanceM, glassDistance) : DEFAULT_FACE_DZ
    this.fallbackDz = clamp(faceDz + FALLBACK_DEPTH_OFFSET, 0, MAX_DZ)

    // Hands: all 21 landmarks each. `landmarks` is raw video space (0..1, top-left,
    // NOT mirrored, NOT NDC) per the tracker - unlike centroidNdc, which is both.
    for (const hand of frame.hands) {
      const dz = safeDz(hand.distanceM, glassDistance)
      const radius = 0.09 + 0.05 * hand.palmFlatness
      const lm = hand.landmarks
      for (let j = 0; j < 21; j++) {
        const x = lm[j * 3]
        const y = lm[j * 3 + 1]
        if (x === undefined || y === undefined) continue
        const [nx, ny] = this.videoUvToScreenNdc(x, y)
        this.pushSplat(nx, ny, radius, dz, hand.confidence, hand.confidence)
      }
    }

    if (face) {
      const [fx, fy] = this.videoNdcToScreenNdc(face.eyeCenterNdc[0], face.eyeCenterNdc[1])
      this.pushSplat(fx, fy, 0.22, faceDz, face.confidence * 0.8, face.confidence)

      // The torso has no landmarks at all. One wide, weak, slightly deeper splat below the
      // face is what stops the body resolving as a flat cutout at the face's exact depth.
      // The drop is applied in VIDEO ndc (it is a body proportion, fixed relative to the
      // frame) and only then mapped through the cover fit.
      const [tx, ty] = this.videoNdcToScreenNdc(
        face.eyeCenterNdc[0],
        face.eyeCenterNdc[1] - TORSO_NDC_DROP
      )
      const torsoDz = clamp(faceDz + TORSO_DEPTH_OFFSET, 0, MAX_DZ)
      this.pushSplat(tx, ty, 0.6, torsoDz, face.confidence * 0.35, face.confidence)
    }

    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuffer)
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.splatData,
      0,
      this.splatCount * FLOATS_PER_SPLAT
    )
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  private computeContact(
    frame: Readonly<TrackingFrame>,
    glassDistance: number,
    shatterThreshold: number
  ): void {
    let best: ContactReport | null = null

    for (let i = 0; i < frame.hands.length; i++) {
      const hand = frame.hands[i]
      if (!hand) continue
      const excess = hand.distanceM - glassDistance
      if (!Number.isFinite(excess)) continue

      const proximity = clamp(1 - excess / Math.max(shatterThreshold, 1e-3), 0, 1)
      const strength = proximity * hand.palmFlatness * hand.confidence
      if (!Number.isFinite(strength)) continue

      if (!best || strength > best.strength) {
        best = { strength, ndc: [hand.centroidNdc[0], hand.centroidNdc[1]], handIndex: i }
      }
    }

    this.contact = best && best.strength >= 0.25 ? best : null
  }

  // --- GPU ------------------------------------------------------------------

  render(_f: FrameContext): void {
    const gl = this.gl

    // A. Splat the landmark depths into the low-res proximity buffer. The clear is not
    // optional: with blendFunc(ONE, ONE) and no clear the buffer integrates forever.
    this.proximity.bind()
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (this.splatCount > 0) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.useProgram(this.splatProgram)
      gl.bindVertexArray(this.splatVao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.splatCount)
      gl.bindVertexArray(null)
      gl.disable(gl.BLEND)
    }

    // B. Resolve into the silhouette field.
    const dst = this.silhouette.write
    const history = this.silhouette.read
    dst.bind()

    const prog = this.resolveProgram
    prog.use()
    prog.texture('uMask', this.maskTexture)
    prog.texture('uVideo', this.videoTexture)
    prog.texture('uProximity', this.proximity.texture)
    prog.texture('uHistory', history.texture)
    prog.set('uVideoUvScale', this.uvScale)
    prog.set('uVideoUvOffset', this.uvOffset)
    prog.set('uMirror', this.mirror ? 1 : 0)
    prog.set('uMaskTexel', [1 / this.maskWidth, 1 / this.maskHeight])
    prog.set('uOutTexel', [1 / dst.width, 1 / dst.height])
    prog.set('uFallbackDz', this.fallbackDz)
    prog.set('uHistoryBlend', this.historyValid ? 0.25 : 0)
    prog.set('uHasMask', this.hasMask ? 1 : 0)
    drawFullscreen(this.ctx)

    this.silhouette.swap()
    this.historyValid = true

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  resize(w: number, h: number): void {
    this.silhouette.resize(w, h)
    // Both ping-pong textures were reallocated with undefined contents; blending against
    // them for one frame would smear garbage into the depth.
    this.historyValid = false
  }

  dispose(): void {
    const gl = this.gl
    this.proximity.dispose()
    this.silhouette.dispose()
    this.resolveProgram.dispose()
    gl.deleteProgram(this.splatProgram)
    gl.deleteVertexArray(this.splatVao)
    gl.deleteBuffer(this.splatBuffer)
    gl.deleteTexture(this.maskTexture)
    gl.deleteTexture(this.videoTexture)
  }
}
