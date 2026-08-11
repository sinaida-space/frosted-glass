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

/**
 * 2 hands x (21 landmarks + 5 synthesised palm-interior points), plus a face and a
 * torso splat. See PALM_FILL_INDICES for why the palm needs points of its own.
 */
const MAX_SPLATS = 2 * 26 + 2
/** centre.xy, radius.xy, dz, weight, confidence */
const FLOATS_PER_SPLAT = 7

/** Metres behind the pane assumed for the body when no face has been detected yet. */
const DEFAULT_FACE_DZ = 1.2
/** Shoulders read a little further back than the face; this is what gives the body volume. */
const TORSO_DEPTH_OFFSET = 0.18
/**
 * Last-resort depth for a frame with no landmarks anywhere. This used to be the depth of
 * every unattributed pixel, which put the forearms, elbows, shoulders and hair a metre
 * behind the hand that they are physically attached to. The push-pull fill below now
 * covers those; this constant only survives as the root of the pyramid.
 */
const FALLBACK_DEPTH_OFFSET = 0.3
/** Torso splat centre, in video NDC below the eyes. */
const TORSO_NDC_DROP = 0.55

const MAX_DZ = 8

/**
 * Per-landmark splat radius as a multiple of the hand's own apparent size.
 *
 * A constant NDC radius assumes a hand always occupies about the same slice of the frame.
 * It does not: a palm pressed against the glass fills a third of the picture while the
 * same hand across the room is a thumbnail, and one radius cannot serve both. Scaling by
 * the tracked wrist-to-middle-MCP span makes the splat follow the hand on screen.
 *
 * The value is ONE INTER-LANDMARK SPACING, which is all a splat has to cover: along a
 * finger, MCP -> PIP is 0.45 of the wrist-to-MCP span, and across the palm the synthesised
 * points below halve the 0.85-span wrist-to-MCP gap to 0.425. At exactly one spacing the
 * Gaussian is still worth 0.44 at the midpoint between two neighbours, so the hand comes
 * out solid.
 *
 * It used to be 0.85 - the radius of the whole hand blob. A hand at 5 cm behind a pane
 * 45 cm away subtends 0.60 NDC, so every one of its landmarks painted a 270 px disc, and
 * the disc reached hundreds of pixels past the hand onto the body. Measured on a synthetic
 * frame with a hand at 0.05 m over a torso at 0.90 m, a clear torso point 300 px from the
 * hand resolved 0.218 m. At 0.45 the same point reads 0.878.
 *
 * Shrinking this ALONE is not a fix and makes the palm worse - at 0.25 (the "span/4" that
 * looks right on paper) the palm interior falls between the wrist and the MCP splats and
 * resolves to the torso's depth, 0.899 instead of 0.05.
 */
const HAND_SPLAT_SPAN_SCALE = 0.45

/**
 * Landmark pairs whose midpoints get a splat of their own, plus their centroid.
 *
 * MediaPipe puts no landmark inside the palm: the nearest ones are the wrist and the four
 * MCPs, 0.85 of a span apart. That gap is what forced the old radius to be as wide as the
 * whole hand. Sampling the palm directly is what lets the radius come down.
 */
const PALM_FILL_INDICES = [5, 9, 13, 17] as const

/**
 * Exponent applied to every splat's weight before it is accumulated.
 *
 * The resolve divides sum(dz*w) by sum(w), which is an arithmetic mean - and a mean is the
 * wrong estimator for this quantity. Where a hand at 0.05 m and a torso at 0.90 m both
 * claim a pixel, their mean is a depth that describes neither surface, and the composite
 * paints the middle of a pressed palm at 161/255 instead of 77, brighter than the fingers
 * around it. What the camera actually sees at a pixel is ONE surface, so the estimator has
 * to be a mode: whichever body has the most evidence here wins, and the loser's depth is
 * suppressed rather than averaged in. Raising w to a power does exactly that, and degrades
 * back to the mean where the evidence really is equal.
 *
 * 4 is the knee. Measured on a hand at 0.05 m over a torso at 0.90 m, a clear torso point
 * resolves 0.218 at power 1, 0.498 at 3, 0.878 at 4, and the whole leak profile is
 * unchanged at 5 and 6 - so nothing above 4 buys anything, and every extra power costs
 * dynamic range in the RGBA16F accumulation.
 *
 * The rejected alternative was a confidence-weighted soft MINIMUM over depth, on the
 * argument that the camera sees the nearest surface. It fails, twice, and both failures
 * are the same mistake: a splat's disc is a guess at where a surface is, not a measurement
 * of its extent, so preferring the near depth wherever a near disc reaches claims torso
 * for the hand. The same clear torso point resolves 0.157 - WORSE than doing nothing - and
 * with no hand in frame at all it smears the 0.18 m face-to-torso step over 300 px of
 * chest instead of 80, flattening the body toward the face's depth.
 */
const SPLAT_WEIGHT_POWER = 4
/**
 * How much an edge-on palm shrinks its splats. The spec's original term swung the radius
 * by 56% between flat and edge-on, which is what dragged the hand's outer pixels off the
 * splat and into the fallback. A flat palm really does present more area than an edge-on
 * one, so the term keeps its job - it just no longer does it hard enough to matter.
 */
const HAND_SPLAT_FLATNESS_DROP = 0.15
/** Splat radius bounds in NDC-y, so a very distant or very close hand stays sane. */
const HAND_SPLAT_MIN_RADIUS = 0.04
const HAND_SPLAT_MAX_RADIUS = 0.5

/**
 * Raw splat weight at which a proximity pixel counts as fully attributed - i.e. before
 * SPLAT_WEIGHT_POWER is applied.
 */
const ATTRIBUTED_RAW_WEIGHT = 0.25
/**
 * The same threshold in the units the buffer actually holds. It has to track the power:
 * the accumulation stores w^p, so comparing it against the raw 0.25 would declare almost
 * the whole body unattributed and hand it to the push-pull fill, which then answers from
 * a coarse level where the hand and the torso are averaged together again - the exact
 * bleed this change exists to remove, re-entering by the back door.
 */
const FILL_WEIGHT_FULL = Math.pow(ATTRIBUTED_RAW_WEIGHT, SPLAT_WEIGHT_POWER)
/** Levels below the 256x144 proximity buffer. The coarsest is 8x5, which spans the frame. */
const FILL_LEVELS = 5

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** clamp() that also swallows Infinity/NaN - `distanceM` is Infinity when a span is degenerate. */
function safeDz(distanceM: number, glassDistance: number): number {
  const dz = distanceM - glassDistance
  if (!Number.isFinite(dz)) return MAX_DZ
  return clamp(dz, 0, MAX_DZ)
}

/**
 * Per-landmark splat radius in NDC-y, derived from how big the hand actually looks.
 *
 * `spanPx` is the wrist to middle-finger-MCP length in VIDEO pixels, and `ndcYPerVideoPx`
 * converts that to NDC-y on the canvas through the same `cover` fit the shader samples
 * with. Going via the video's own aspect instead would ignore the crop, and on a 4:3
 * webcam shown on a 16:9 canvas every splat would come out 25% smaller than the hand it
 * is meant to describe - which matters now that the radius means one inter-landmark
 * spacing rather than "about the size of a hand".
 *
 * Falls back to a constant NDC radius when the tracker has no usable span, which happens
 * on the first frames and whenever the wrist-to-MCP vector is degenerate.
 */
function handSplatRadius(
  spanPx: number,
  palmFlatness: number,
  ndcYPerVideoPx: number
): number {
  const flatnessTerm = 1 - HAND_SPLAT_FLATNESS_DROP * (1 - clamp(palmFlatness, 0, 1))
  if (!Number.isFinite(spanPx) || spanPx <= 0 || !(ndcYPerVideoPx > 0)) {
    return 0.09 + 0.05 * clamp(palmFlatness, 0, 1)
  }
  return clamp(
    HAND_SPLAT_SPAN_SCALE * spanPx * ndcYPerVideoPx * flatnessTerm,
    HAND_SPLAT_MIN_RADIUS,
    HAND_SPLAT_MAX_RADIUS
  )
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

/**
 * Pull half of the push-pull fill: a 2x2 box downsample of the (dz*w, w, conf*w)
 * accumulation. Because the channels are premultiplied by weight, a plain sum is already
 * the correct coarser estimate - the ratio dz = R/G comes out as the weighted mean depth
 * over the region, which is exactly what the push half needs to extrapolate from.
 */
const FILL_PULL_FRAG_SRC = `#version 300 es
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
void main() {
  vec2 o = uSrcTexel * 0.5;
  vec4 s0 = texture(uSrc, vUv + vec2(-o.x, -o.y));
  vec4 s1 = texture(uSrc, vUv + vec2( o.x, -o.y));
  vec4 s2 = texture(uSrc, vUv + vec2(-o.x,  o.y));
  vec4 s3 = texture(uSrc, vUv + vec2( o.x,  o.y));
  vec3 sum = (s0.rgb + s1.rgb + s2.rgb + s3.rgb) * 0.25;

  // Alpha is a plain "some real sample lives under this texel" flag, carried up with max
  // rather than averaged. The weighted sums above shrink by the coverage fraction at
  // every level - a coarse texel that is a tenth landmark and nine tenths empty ends up
  // with a tenth of the weight - and if the fill decided whether it had an answer from
  // that number, large empty regions would fail to fill and drop back to the constant.
  // Whether an answer exists and how confident it is are different questions.
  float has = max(
    max(max(s0.a, step(1e-5, s0.g)), max(s1.a, step(1e-5, s1.g))),
    max(max(s2.a, step(1e-5, s2.g)), max(s3.a, step(1e-5, s3.g)))
  );
  fragColor = vec4(sum, has);
}
`

/**
 * Push half: fill this level's holes from the level below it.
 *
 * Where the fine level already carries enough weight, it is kept untouched. Where it does
 * not - a forearm, an elbow, hair, the outer half of an edge-on palm, anything the 43
 * landmarks never reached - the depth is taken from the coarser level, which is a
 * weighted average of whatever real samples sit nearest in screen space. So an
 * unattributed pixel inherits the depth of the body part it is attached to instead of
 * teleporting to a constant.
 *
 * Depths are un-premultiplied before the blend and re-premultiplied after, because
 * blending (dz*w) pairs directly would let the heavier side drag the depth rather than
 * just win the vote.
 */
const FILL_PUSH_FRAG_SRC = `#version 300 es
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uFine;
uniform sampler2D uCoarse;
uniform float uWeightFull;
void main() {
  vec4 f = texture(uFine, vUv);
  vec4 c = texture(uCoarse, vUv);

  float wf = max(f.g, 0.0);
  float wc = max(c.g, 0.0);

  float dzF = f.r / max(wf, 1e-4);
  float dzC = c.r / max(wc, 1e-4);
  float cnF = f.b / max(wf, 1e-4);
  float cnC = c.b / max(wc, 1e-4);

  // 1 where this level stands on its own, 0 where it is a hole. Read from the raw pulled
  // weight, never from an already-filled one, so extrapolated depth can always be
  // overruled by real samples at a finer level and never compounds down the chain.
  float a = clamp(wf / uWeightFull, 0.0, 1.0);

  float dz = mix(dzC, dzF, a);
  float cn = mix(cnC, cnF, a);

  // Once a pixel has an answer it counts as answered, at full weight. Carrying the
  // coarse level's own (coverage-diluted) weight down instead would shrink at every step
  // and the fill would fade back into the constant exactly where it is needed most.
  float has = max(max(f.a, step(1e-5, wf)), c.a);
  float w = max(wf, has * uWeightFull);

  fragColor = vec4(dz * w, w, cn * w, has);
}
`

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

  /**
   * Push-pull pyramid over the proximity buffer. `pull[k]` is the 2x-decimated chain
   * (pull[0] is `proximity` itself); `push[k]` is the hole-filled result at that level.
   * push[0] is the one the resolve reads. The two chains are separate targets because
   * the resolve still needs the *unfilled* weights to report honest attribution.
   */
  private pull: RenderTarget[] = []
  private push: RenderTarget[] = []
  private pullProgram: Program
  private pushProgram: Program

  private splatProgram: WebGLProgram
  private splatVao: WebGLVertexArrayObject
  private splatBuffer: WebGLBuffer
  private splatData = new Float32Array(MAX_SPLATS * FLOATS_PER_SPLAT)
  private splatCount = 0
  private weightPowerLoc: WebGLUniformLocation | null = null

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

    // Pyramid. LINEAR on every level: the push step upsamples the coarse level with
    // bilinear filtering, which is what makes the filled depth vary smoothly instead of
    // showing the coarse level's blocks.
    const pyramidOpts = { format: 'rgba16f' as const, filter: 'linear' as const }
    this.pull.push(this.proximity)
    for (let k = 1; k <= FILL_LEVELS; k++) {
      const w = Math.max(1, PROXIMITY_W >> k)
      const h = Math.max(1, PROXIMITY_H >> k)
      this.pull.push(new RenderTarget(ctx, w, h, pyramidOpts))
    }
    // push[FILL_LEVELS] aliases the coarsest pull level: nothing coarser to fill from.
    for (let k = 0; k < FILL_LEVELS; k++) {
      const w = Math.max(1, PROXIMITY_W >> k)
      const h = Math.max(1, PROXIMITY_H >> k)
      this.push.push(new RenderTarget(ctx, w, h, pyramidOpts))
    }
    this.push.push(this.pull[FILL_LEVELS]!)

    this.pullProgram = new Program(ctx, FILL_PULL_FRAG_SRC)
    this.pushProgram = new Program(ctx, FILL_PUSH_FRAG_SRC)

    this.splatProgram = linkSplatProgram(gl)
    this.weightPowerLoc = gl.getUniformLocation(this.splatProgram, 'uWeightPower')

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
   * buffer, and computes `contact`. Nothing is ever read back off the GPU here: that
   * would stall the pipeline for a number the CPU already has.
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

    // One video pixel, in NDC-y on the canvas, through the `cover` fit. The fit scales
    // both axes by the same factor, so this is the whole conversion.
    const coverScale =
      frame.videoWidth > 0 && frame.videoHeight > 0
        ? Math.max(this.ctx.width / frame.videoWidth, this.ctx.height / frame.videoHeight)
        : 1
    const ndcYPerVideoPx = (2 * coverScale) / Math.max(1, this.ctx.height)

    const face = frame.face
    const faceDz = face ? safeDz(face.distanceM, glassDistance) : DEFAULT_FACE_DZ
    this.fallbackDz = clamp(faceDz + FALLBACK_DEPTH_OFFSET, 0, MAX_DZ)

    // Hands: all 21 landmarks each. `landmarks` is raw video space (0..1, top-left,
    // NOT mirrored, NOT NDC) per the tracker - unlike centroidNdc, which is both.
    for (const hand of frame.hands) {
      const dz = safeDz(hand.distanceM, glassDistance)
      const radius = handSplatRadius(hand.spanPx, hand.palmFlatness, ndcYPerVideoPx)
      const lm = hand.landmarks
      for (let j = 0; j < 21; j++) {
        const x = lm[j * 3]
        const y = lm[j * 3 + 1]
        if (x === undefined || y === undefined) continue
        const [nx, ny] = this.videoUvToScreenNdc(x, y)
        this.pushSplat(nx, ny, radius, dz, hand.confidence, hand.confidence)
      }

      // Palm interior. Wrist-to-MCP midpoints plus the palm centroid, at the same depth
      // and confidence as the real landmarks they are interpolated from - they add no
      // information, they only put samples where MediaPipe leaves a hole.
      const wristX = lm[0]
      const wristY = lm[1]
      if (wristX !== undefined && wristY !== undefined) {
        let sumX = wristX
        let sumY = wristY
        let n = 1
        for (const m of PALM_FILL_INDICES) {
          const mx = lm[m * 3]
          const my = lm[m * 3 + 1]
          if (mx === undefined || my === undefined) continue
          sumX += mx
          sumY += my
          n++
          const [mnx, mny] = this.videoUvToScreenNdc((wristX + mx) * 0.5, (wristY + my) * 0.5)
          this.pushSplat(mnx, mny, radius, dz, hand.confidence, hand.confidence)
        }
        const [pnx, pny] = this.videoUvToScreenNdc(sumX / n, sumY / n)
        this.pushSplat(pnx, pny, radius, dz, hand.confidence, hand.confidence)
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
      gl.uniform1f(this.weightPowerLoc, SPLAT_WEIGHT_POWER)
      gl.bindVertexArray(this.splatVao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.splatCount)
      gl.bindVertexArray(null)
      gl.disable(gl.BLEND)
    }

    // B. Push-pull hole fill over the proximity buffer.
    //
    // Pull: decimate to 8x5, so every level holds the weighted mean depth of a
    // progressively larger neighbourhood. Push: walk back up, and wherever a level has
    // too little weight of its own, take the level below's answer. Ten draws at 128x72
    // and smaller, so it costs nothing.
    for (let k = 1; k <= FILL_LEVELS; k++) {
      const src = this.pull[k - 1]!
      const dstLevel = this.pull[k]!
      dstLevel.bind()
      this.pullProgram.use()
      this.pullProgram.texture('uSrc', src.texture)
      this.pullProgram.set('uSrcTexel', [1 / src.width, 1 / src.height])
      drawFullscreen(this.ctx)
    }
    for (let k = FILL_LEVELS - 1; k >= 0; k--) {
      const dstLevel = this.push[k]!
      dstLevel.bind()
      this.pushProgram.use()
      this.pushProgram.texture('uFine', this.pull[k]!.texture)
      this.pushProgram.texture('uCoarse', this.push[k + 1]!.texture)
      this.pushProgram.set('uWeightFull', FILL_WEIGHT_FULL)
      drawFullscreen(this.ctx)
    }

    // C. Resolve into the silhouette field.
    const dst = this.silhouette.write
    const history = this.silhouette.read
    dst.bind()

    const prog = this.resolveProgram
    prog.use()
    prog.texture('uMask', this.maskTexture)
    prog.texture('uVideo', this.videoTexture)
    prog.texture('uProximity', this.proximity.texture)
    prog.texture('uProximityFilled', this.push[0]!.texture)
    prog.texture('uHistory', history.texture)
    prog.set('uVideoUvScale', this.uvScale)
    prog.set('uVideoUvOffset', this.uvOffset)
    prog.set('uMirror', this.mirror ? 1 : 0)
    prog.set('uMaskTexel', [1 / this.maskWidth, 1 / this.maskHeight])
    prog.set('uOutTexel', [1 / dst.width, 1 / dst.height])
    prog.set('uFallbackDz', this.fallbackDz)
    prog.set('uHistoryBlend', this.historyValid ? 0.25 : 0)
    prog.set('uHasMask', this.hasMask ? 1 : 0)
    prog.set('uWeightFullInv', 1 / FILL_WEIGHT_FULL)
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
    // pull[0] is `proximity` and push[FILL_LEVELS] aliases pull[FILL_LEVELS]; disposing
    // only the levels this pass allocated keeps that from being a double free.
    for (let k = 1; k <= FILL_LEVELS; k++) this.pull[k]!.dispose()
    for (let k = 0; k < FILL_LEVELS; k++) this.push[k]!.dispose()
    this.pullProgram.dispose()
    this.pushProgram.dispose()
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
