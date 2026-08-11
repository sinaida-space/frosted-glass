/**
 * ShatterPass - the pane breaks, the shards fall, the hole shows the fog behind, and two
 * flat palms held still put it back together.
 *
 * The physics is plain TypeScript over at most 256 structs; the GPU only ever draws what
 * the CPU has already decided. When the glass is intact and the heal mask has decayed,
 * render() draws nothing at all and `output` hands GlassPass straight through.
 */

import type { GLContext } from '../gl/context'
import type { FrameContext, Pass } from '../gl/pass'
import { PingPong, RenderTarget } from '../gl/target'
import { Program, resolveIncludes } from '../gl/program'
import { drawFullscreen } from '../gl/quad'
import type { TrackingFrame } from '../tracking/types'
import type { SilhouettePass } from '../passes/silhouette'

import commonGlsl from '../gl/shaders/common.glsl?raw'
import surfaceGlsl from '../gl/shaders/surface.glsl?raw'
import shardsVert from '../gl/shaders/shards.vert.glsl?raw'
import shardsFrag from '../gl/shaders/shards.frag.glsl?raw'
import cracksFrag from '../gl/shaders/cracks.frag.glsl?raw'
import healFrag from '../gl/shaders/heal.frag.glsl?raw'

import { FAN_VERTS, generateFracture, type Fracture } from './fracture'
import {
  applyHands,
  easeHome,
  initShards,
  integrate,
  propagate,
  updateHealGate,
  type HealGate,
  type ShardState,
} from './physics'

export type GlassState = 'intact' | 'breaking' | 'broken' | 'healing'

/** Milliseconds after any break during which another break is refused. */
const BREAK_COOLDOWN_MS = 600
/** Seconds the heal mask takes to fade back to a flat pane. */
const HEAL_DECAY_S = 4
/** How far below the pane's own condensation the un-healed glass is pushed. */
const HEAL_SEAM_GAIN = 0.45
/** Seconds the `fg:reset` fade takes. */
const RESET_FADE_S = 0.4
/** Crack line half-width, NDC-y. About 2 px at 1080p. */
const CRACK_WIDTH = 0.0035

const CRACK_VERT_SRC = `#version 300 es
layout(location = 0) in vec4 aSeg;   // x0, y0, x1, y1 - divisor 1
layout(location = 1) in float aDist; // distance from the impact - divisor 1
uniform float uAspect;
uniform float uWidth;
out vec2 vSegA;
out vec2 vSegB;
out vec2 vPos;
out float vDist;
void main() {
  vSegA = aSeg.xy;
  vSegB = aSeg.zw;
  vDist = aDist;
  // Expand the segment into a quad wide enough to hold the line and its falloff.
  vec2 d = vec2((aSeg.z - aSeg.x) * uAspect, aSeg.w - aSeg.y);
  float len = max(length(d), 1e-6);
  vec2 t = d / len;
  vec2 n = vec2(-t.y, t.x);
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vec2 mid = (aSeg.xy + aSeg.zw) * 0.5;
  vec2 offset = t * (len * 0.5 + uWidth * 2.0) * corner.x + n * uWidth * 2.5 * corner.y;
  vPos = mid + vec2(offset.x / uAspect, offset.y);
  gl_Position = vec4(vPos, 0.0, 1.0);
}
`

const HOLE_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vRestUv;
in float vAlpha;
in float vZ;
in float vEdge;
out vec4 fragColor;
void main() { fragColor = vec4(1.0, 0.0, 0.0, 1.0); }
`

/**
 * Composite. Fog through the holes, glass everywhere else, cracks over the top. Shards are
 * drawn as geometry after this, so they are not in here.
 */
const COMPOSITE_FRAG_SRC = `#version 300 es
in vec2 vUv;
out vec4 fragColor;

#include "common.glsl"
#include "surface.glsl"

uniform sampler2D uGlass;   // GlassPass output, already sRGB
uniform sampler2D uFog;     // FogPass output: rgb radiance, a transmittance. Linear.
uniform sampler2D uHole;    // R8, 1 where a shard has left
uniform sampler2D uCracks;  // R8 crack field
uniform float uCrackVisible; // 0 once the pane is whole again
uniform float uDamageFade;   // 1 normally, ramping to 0 across a reset

void main() {
  vec3 glass = texture(uGlass, vUv).rgb;

  // Through a hole there is no pane: no sheet, no condensation, no dispersion. Just the
  // raw volume, taken down a stop because the pane was the thing lighting the room.
  vec3 raw = linearToSRGB(saturate(toneMap(texture(uFog, vUv).rgb * 0.55)));

  // uDamageFade takes the hole and the cracks out over fg:reset's 0.4 s, so a reset is a
  // pane healing instantly rather than a frame of damage vanishing.
  float hole = texture(uHole, vUv).r * uDamageFade;
  vec3 col = mix(glass, raw, hole);

  // Cracks live on the pane, so they are suppressed where the pane is gone.
  // The crack field outlives the mend by a few seconds - the heal mask needs it to know
  // where the seam is - so the composite has to be told when the pane is whole again.
  float crack = texture(uCracks, vUv).r * (1.0 - hole) * uCrackVisible * uDamageFade;
  col = mix(col, vec3(1.0), saturate(crack) * 0.55);

  fragColor = vec4(col, 1.0);
}
`

interface ContactLike {
  strength: number
  ndc: [number, number]
}

export class ShatterPass implements Pass {
  readonly name = 'shatter'

  private ctx: GLContext
  private gl: WebGL2RenderingContext

  private composite: RenderTarget
  private cracks: RenderTarget
  private hole: RenderTarget
  private heal: PingPong

  private compositeProgram: Program
  private healProgram: Program

  private shardProgram: WebGLProgram
  private holeProgram: WebGLProgram
  private crackProgram: WebGLProgram

  private shardVao: WebGLVertexArrayObject
  private holeVao: WebGLVertexArrayObject
  private crackVao: WebGLVertexArrayObject
  private shardBuffer: WebGLBuffer
  private holeBuffer: WebGLBuffer
  private crackBuffer: WebGLBuffer
  /** Per-shard boundary offsets: one row per shard, FAN_VERTS texels wide, RG = offset. */
  private geomTexture: WebGLTexture

  private glass: RenderTarget | null = null
  private fog: (() => RenderTarget) | null = null

  private fracture: Fracture | null = null
  private shardState: ShardState[] = []
  private front = 0
  private impactStrength = 1
  private _state: GlassState = 'intact'
  private healElapsed = 0
  private healActivity = 0
  private cooldownMs = 0
  private gate: HealGate = { timer: 0, graceMs: 0 }

  private liveInstances = new Float32Array(0)
  private liveCount = 0
  private holeCount = 0
  private crackCount = 0
  private holeDirty = false
  /** Frozen once per update() so `output` and `render()` cannot disagree mid-frame. */
  private passthrough = true
  /** Seconds left of the fg:reset fade. */
  private resetFade = 0
  /**
   * Frames the heal mask still has to be written for after the activity reaches zero.
   * Both ping-pong buffers have to be snapped to a flat 1.0, or the pass short-circuits
   * with the mask parked one level short of white and leaves the pane permanently a
   * fraction clearer than GlassPass's own default.
   */
  private healFlush = 0
  private palms: [number, number][] = []

  private pendingShatter: [number, number] | null = null
  private pendingReset = false
  private onShatter: (e: Event) => void
  private onReset: () => void

  /**
   * RGBA8 at render resolution: the final image.
   *
   * On intact glass this is GlassPass's own target, handed straight through. Copying it
   * into a target of our own would be the single most expensive thing this pass ever did
   * in the case that is true 99% of the time - a full-frame 1920x1080 blit measured
   * 0.71 ms on this machine, against a 0.3 ms budget for the whole pass. Consumers must
   * therefore read this getter every frame and never cache the target, which is already
   * the convention here: FogPass and SilhouettePass ping-pong theirs.
   */
  get output(): RenderTarget {
    return this.passthrough && this.glass ? this.glass : this.composite
  }

  /** R8. Bind into GlassPass.setHealMask(). */
  get healMask(): RenderTarget {
    return this.heal.read
  }

  get state(): GlassState {
    return this._state
  }

  constructor(ctx: GLContext) {
    this.ctx = ctx
    this.gl = ctx.gl
    const gl = this.gl

    this.composite = new RenderTarget(ctx, ctx.width, ctx.height, {
      format: 'rgba8',
      filter: 'linear',
    })
    this.cracks = new RenderTarget(ctx, ctx.width, ctx.height, { format: 'r8', filter: 'linear' })
    this.hole = new RenderTarget(ctx, ctx.width, ctx.height, { format: 'r8', filter: 'linear' })
    this.heal = new PingPong(ctx, ctx.width >> 1, ctx.height >> 1, {
      format: 'r8',
      filter: 'linear',
    })

    this.compositeProgram = new Program(
      ctx,
      resolveIncludes(COMPOSITE_FRAG_SRC, { 'common.glsl': commonGlsl, 'surface.glsl': surfaceGlsl })
    )
    this.healProgram = new Program(ctx, healFrag)

    this.shardProgram = linkProgram(gl, shardsVert, shardsFrag, 'shards')
    this.holeProgram = linkProgram(gl, shardsVert, HOLE_FRAG_SRC, 'hole')
    this.crackProgram = linkProgram(gl, CRACK_VERT_SRC, cracksFrag, 'cracks')

    this.shardBuffer = createBuffer(gl)
    this.holeBuffer = createBuffer(gl)
    this.crackBuffer = createBuffer(gl)
    this.shardVao = this.buildShardVao(this.shardBuffer)
    this.holeVao = this.buildShardVao(this.holeBuffer)
    this.crackVao = this.buildCrackVao()

    const tex = gl.createTexture()
    if (!tex) throw new Error('ShatterPass: failed to create the shard geometry texture')
    this.geomTexture = tex

    this.onShatter = (e: Event) => {
      const detail = (e as CustomEvent<{ ndc?: [number, number] }>).detail
      const ndc = detail?.ndc
      this.pendingShatter = ndc ? [ndc[0], ndc[1]] : [0, 0]
    }
    this.onReset = () => {
      this.pendingReset = true
    }
    window.addEventListener('fg:shatter', this.onShatter)
    window.addEventListener('fg:reset', this.onReset)

    // Start from a flat white mask, so binding it changes nothing until a heal happens.
    this.clearHeal()
  }

  setSource(glass: RenderTarget): void {
    this.glass = glass
  }

  /**
   * FogPass ping-pongs its output, so this has to be a getter. The spec's contract only
   * lists setSource; the hole needs the volume behind the pane as a second input.
   */
  setFog(fog: () => RenderTarget): void {
    this.fog = fog
  }

  // --- instanced attribute layout -------------------------------------------

  private buildShardVao(buffer: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('ShatterPass: failed to create the shard VAO')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    // mat3 columns 0..2 then (restCentroid.xy, alpha, z). 13 floats, padded to 16 so the
    // stride stays a nice power of two.
    const stride = 16 * 4
    // EVERY column of the matrix needs its own divisor. Miss one and that column reads
    // instance 0's value for every shard, which collapses the whole pane onto one piece.
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i)
      gl.vertexAttribPointer(i, 3, gl.FLOAT, false, stride, i * 12)
      gl.vertexAttribDivisor(i, 1)
    }
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 36)
    gl.vertexAttribDivisor(3, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    return vao
  }

  private buildCrackVao(): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('ShatterPass: failed to create the crack VAO')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.crackBuffer)
    const stride = 8 * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 16)
    gl.vertexAttribDivisor(1, 1)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    return vao
  }

  // --- breaking -------------------------------------------------------------

  private break(ndc: [number, number], strength: number): void {
    const gl = this.gl
    const aspect = this.ctx.width / Math.max(1, this.ctx.height)
    const count = Math.round(clamp(this.shardCount, 24, 256))
    this.fracture = generateFracture(ndc, count, aspect)
    this.shardState = initShards(this.fracture)
    this.front = 0
    this.impactStrength = clamp(strength, 0, 1)
    this._state = 'breaking'
    // A break during a reset fade replaces it. Without this the fade keeps running and
    // wipes the fracture that just started, a few frames after it started.
    this.resetFade = 0
    this.healElapsed = 0
    this.cooldownMs = BREAK_COOLDOWN_MS
    this.gate.timer = 0
    this.holeDirty = true

    const shards = this.fracture.shards
    const n = shards.length
    this.liveInstances = new Float32Array(n * 16)
    // Mean cell area: the reference the detach impulse is scaled against.
    this.refArea = shards.reduce((a, s) => a + s.area, 0) / Math.max(n, 1)

    // Static boundary offsets, uploaded once per break.
    const geom = new Float32Array(FAN_VERTS * n * 2)
    for (let i = 0; i < n; i++) geom.set(shards[i]!.offsets, i * FAN_VERTS * 2)
    gl.bindTexture(gl.TEXTURE_2D, this.geomTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, FAN_VERTS, n, 0, gl.RG, gl.FLOAT, geom)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)

    // Crack instances, also static for the life of the fracture.
    const cracks = this.fracture.cracks
    const cbuf = new Float32Array(cracks.length * 8)
    for (let i = 0; i < cracks.length; i++) {
      const c = cracks[i]!
      cbuf.set([c.x0, c.y0, c.x1, c.y1, c.distanceFromImpact, 0, 0, 0], i * 8)
    }
    this.crackCount = cracks.length
    gl.bindBuffer(gl.ARRAY_BUFFER, this.crackBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, cbuf, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  private shardCount = 96
  private refArea = 0.04

  // --- per-frame ------------------------------------------------------------

  update(
    frame: Readonly<TrackingFrame>,
    contact: SilhouettePass['contact'],
    f: FrameContext
  ): void {
    const dt = Math.min(Math.max(f.dt, 0), 0.1)
    const p = f.params
    this.shardCount = p.shardCount
    this.cooldownMs = Math.max(0, this.cooldownMs - dt * 1000)

    if (this.pendingReset) {
      this.pendingReset = false
      // The state goes back immediately, but the damage is faded out rather than cut:
      // shards, cracks and holes all ramp to nothing over RESET_FADE_S.
      this._state = 'intact'
      this.gate.timer = 0
      this.resetFade = this.fracture ? RESET_FADE_S : 0
      if (!this.fracture) this.healActivity = 0
    }
    if (this.resetFade > 0) {
      this.resetFade = Math.max(0, this.resetFade - dt)
      const a = this.resetFade / RESET_FADE_S
      for (const st of this.shardState) st.alpha = a
      if (this.resetFade <= 0) {
        this.fracture = null
        this.shardState = []
        this.holeCount = 0
        this.liveCount = 0
        this.crackCount = 0
        this.healActivity = 0
      }
    }

    if (this.pendingShatter) {
      const ndc = this.pendingShatter
      this.pendingShatter = null
      this.break(ndc, 1)
    } else if (
      this._state === 'intact' &&
      this.cooldownMs <= 0 &&
      contact &&
      contact.strength >= 1
    ) {
      this.break([(contact as ContactLike).ndc[0], (contact as ContactLike).ndc[1]], contact.strength)
    }

    this.palms = frame.hands.map((h) => [h.centroidNdc[0], h.centroidNdc[1]] as [number, number])

    if (this.fracture) {
      if (this._state === 'breaking' || this._state === 'broken') {
        const before = this.countDetached()
        this.front = propagate(
          this.fracture.shards,
          this.shardState,
          this.front,
          this.impactStrength,
          this.refArea,
          dt
        )
        if (this.countDetached() !== before) this.holeDirty = true
        integrate(this.shardState, dt)
        applyHands(this.shardState, frame.hands, p, dt)
        if (this._state === 'breaking' && this.front > this.maxCrackDistance()) {
          this._state = 'broken'
        }

        if (updateHealGate(this.gate, frame, p, dt * 1000)) {
          this._state = 'healing'
          this.healElapsed = 0
          this.gate.timer = 0
        }
      } else if (this._state === 'healing') {
        this.healElapsed += dt
        const home = easeHome(this.fracture.shards, this.shardState, this.healElapsed, this.palms)
        if (home) {
          this._state = 'intact'
          this.shardState = []
          this.holeCount = 0
          this.liveCount = 0
          // `fracture` and the crack instance buffer deliberately survive: the seam has to
          // keep fogging over the mend line for the next few seconds.
          this.healActivity = 1
        }
      }
    }

    if (this.healActivity > 0) {
      this.healActivity = Math.max(0, this.healActivity - dt / HEAL_DECAY_S)
      this.healFlush = 2
    }
    if (this._state === 'intact' && this.healActivity <= 0 && this.fracture) {
      this.fracture = null
      this.crackCount = 0
    }

    this.buildInstances()

    this.passthrough =
      this._state === 'intact' &&
      this.healActivity <= 0 &&
      this.healFlush <= 0 &&
      this.liveCount === 0 &&
      this.resetFade <= 0
  }

  private countDetached(): number {
    let n = 0
    for (const s of this.shardState) if (s.detached) n++
    return n
  }

  /** How far the front still has to travel before every crack has been revealed. */
  private maxCrackDistance(): number {
    if (!this.fracture) return 0
    let m = 0
    for (const c of this.fracture.cracks) m = Math.max(m, c.distanceFromImpact)
    return m
  }

  /**
   * Packs the live shards into the instance buffer, and the detached cells into the hole
   * buffer when the detached set has changed. Retired shards are simply left out - drawing
   * them with their runaway transform would put a giant triangle across the frame.
   */
  private buildInstances(): void {
    const gl = this.gl
    // After a mend the fracture survives (the seam needs its crack lines) but the shard
    // states do not, so the two lengths disagree and there is nothing left to draw.
    if (!this.fracture || this.shardState.length !== this.fracture.shards.length) {
      this.liveCount = 0
      return
    }
    const shards = this.fracture.shards
    const buf = this.liveInstances
    let n = 0
    for (let i = 0; i < shards.length; i++) {
      const st = this.shardState[i]!
      if (st.retired || st.alpha <= 0.001) continue
      // Intact shards are still part of the pane and are already in uGlass; drawing them
      // again would double their contribution and show their rim highlights.
      if (!st.detached && this._state !== 'healing') continue
      const s = shards[i]!
      const scale = 1 + st.z * 0.25
      const c = Math.cos(st.rot) * scale
      const sn = Math.sin(st.rot) * scale
      const o = n * 16
      // Column-major mat3: rotation+scale about the seed, then translate to pos.
      buf[o] = c
      buf[o + 1] = sn
      buf[o + 2] = 0
      buf[o + 3] = -sn
      buf[o + 4] = c
      buf[o + 5] = 0
      buf[o + 6] = st.pos[0]
      buf[o + 7] = st.pos[1]
      buf[o + 8] = 1
      buf[o + 9] = s.restCentroid[0]
      buf[o + 10] = s.restCentroid[1]
      buf[o + 11] = st.alpha
      buf[o + 12] = st.z
      n++
    }
    this.liveCount = n
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shardBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW)
    if (n > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf, 0, n * 16)

    if (this.holeDirty) {
      this.holeDirty = false
      const hbuf = new Float32Array(shards.length * 16)
      let h = 0
      for (let i = 0; i < shards.length; i++) {
        if (!this.shardState[i]!.detached) continue
        const s = shards[i]!
        const o = h * 16
        hbuf[o] = 1
        hbuf[o + 4] = 1
        hbuf[o + 8] = 1
        hbuf[o + 9] = s.restCentroid[0]
        hbuf[o + 10] = s.restCentroid[1]
        hbuf[o + 11] = 1
        h++
      }
      this.holeCount = h
      gl.bindBuffer(gl.ARRAY_BUFFER, this.holeBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, hbuf, gl.DYNAMIC_DRAW)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }

  // --- GPU ------------------------------------------------------------------

  render(f: FrameContext): void {
    const gl = this.gl
    const glass = this.glass
    if (!glass) throw new Error('ShatterPass.render: setSource() was never called')

    // The common case: no draw at all. `output` is aliasing the glass target, so there is
    // nothing to copy, no crack pass, no hole pass and no shard draw.
    if (this.passthrough) return

    const aspect = this.ctx.width / Math.max(1, this.ctx.height)

    // 1. Crack field.
    this.cracks.bind()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    // Cracks keep being drawn after the mend, invisibly, because they are what tells the
    // heal mask where the seam runs.
    if (this.crackCount > 0 && (this._state !== 'intact' || this.healActivity > 0)) {
      gl.enable(gl.BLEND)
      gl.blendEquation(gl.MAX)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.useProgram(this.crackProgram)
      setFloat(gl, this.crackProgram, 'uAspect', aspect)
      setFloat(gl, this.crackProgram, 'uWidth', CRACK_WIDTH)
      setFloat(gl, this.crackProgram, 'uFront', this._state === 'healing' ? 1e3 : this.front)
      setVec2(gl, this.crackProgram, 'uResolution', this.ctx.width, this.ctx.height)
      gl.bindVertexArray(this.crackVao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.crackCount)
      gl.bindVertexArray(null)
      gl.blendEquation(gl.FUNC_ADD)
      gl.disable(gl.BLEND)
    }

    // 2. Hole mask: the rest cells of everything that has come loose.
    this.hole.bind()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (this.holeCount > 0 && this._state !== 'healing') {
      gl.useProgram(this.holeProgram)
      setInt(gl, this.holeProgram, 'uFanVerts', FAN_VERTS)
      setFloat(gl, this.holeProgram, 'uUseRest', 1)
      bindTexture(gl, this.holeProgram, 'uGeom', this.geomTexture, 0)
      gl.bindVertexArray(this.holeVao)
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, FAN_VERTS + 2, this.holeCount)
      gl.bindVertexArray(null)
    }

    // 3. Heal mask.
    this.heal.write.bind()
    this.healProgram.use()
    this.healProgram.texture('uPrev', this.heal.read.texture)
    this.healProgram.texture('uCracks', this.cracks.texture)
    this.healProgram.set('uActivity', this.healActivity)
    this.healProgram.set('uSeamGain', HEAL_SEAM_GAIN)
    drawFullscreen(this.ctx)
    this.heal.swap()
    if (this.healActivity <= 0 && this.healFlush > 0) this.healFlush--

    // 4. Composite, then the shards on top of it.
    this.composite.bind()
    const prog = this.compositeProgram
    prog.use()
    prog.texture('uGlass', glass.texture)
    prog.texture('uFog', this.fog ? this.fog().texture : glass.texture)
    prog.texture('uHole', this.hole.texture)
    prog.texture('uCracks', this.cracks.texture)
    prog.set('uCrackVisible', this._state === 'intact' && this.resetFade <= 0 ? 0 : 1)
    prog.set('uDamageFade', this.resetFade > 0 ? this.resetFade / RESET_FADE_S : 1)
    drawFullscreen(this.ctx)

    if (this.liveCount > 0) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // shards write premultiplied colour
      gl.useProgram(this.shardProgram)
      setInt(gl, this.shardProgram, 'uFanVerts', FAN_VERTS)
      setFloat(gl, this.shardProgram, 'uUseRest', 0)
      bindTexture(gl, this.shardProgram, 'uGeom', this.geomTexture, 0)
      bindTexture(gl, this.shardProgram, 'uGlass', glass.texture, 1)
      gl.bindVertexArray(this.shardVao)
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, FAN_VERTS + 2, this.liveCount)
      gl.bindVertexArray(null)
      gl.disable(gl.BLEND)
    }

    void f
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Paints both heal targets flat white, i.e. "condensation exactly as GlassPass wants it". */
  private clearHeal(): void {
    const gl = this.gl
    for (let i = 0; i < 2; i++) {
      this.heal.write.bind()
      gl.clearColor(1, 1, 1, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this.heal.swap()
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  resize(w: number, h: number): void {
    this.composite.resize(w, h)
    this.cracks.resize(w, h)
    this.hole.resize(w, h)
    this.heal.resize(Math.max(1, w >> 1), Math.max(1, h >> 1))
    // Only reset the heal mask to flat white when nothing is fading. Resizing mid-fade
    // used to snap the mended seam clear and then re-fog it, a visible flash - and the
    // adaptive quality ladder triggers resizes on its own, most often while shatter and
    // heal are the very thing making frames expensive. Mid-fade, let the next update()
    // repaint the mask at the new size from the still-running healActivity instead.
    if (this.healActivity <= 0) this.clearHeal()
    this.holeDirty = true
  }

  dispose(): void {
    const gl = this.gl
    window.removeEventListener('fg:shatter', this.onShatter)
    window.removeEventListener('fg:reset', this.onReset)
    this.composite.dispose()
    this.cracks.dispose()
    this.hole.dispose()
    this.heal.dispose()
    this.compositeProgram.dispose()
    this.healProgram.dispose()
    gl.deleteProgram(this.shardProgram)
    gl.deleteProgram(this.holeProgram)
    gl.deleteProgram(this.crackProgram)
    gl.deleteVertexArray(this.shardVao)
    gl.deleteVertexArray(this.holeVao)
    gl.deleteVertexArray(this.crackVao)
    gl.deleteBuffer(this.shardBuffer)
    gl.deleteBuffer(this.holeBuffer)
    gl.deleteBuffer(this.crackBuffer)
    gl.deleteTexture(this.geomTexture)
  }
}

// --- small GL helpers, local to this pass ------------------------------------
// gl/program.ts hard-wires the shared fullscreen triangle, so every program here that
// needs its own vertex shader is linked by hand.

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error(`ShatterPass: failed to create a shader object for ${label}`)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '(no info log)'
    gl.deleteShader(sh)
    throw new Error(`ShatterPass: ${label} shader compile failed:\n${log}`)
  }
  return sh
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
  label: string
): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc, `${label} vertex`)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc, `${label} fragment`)
  const prog = gl.createProgram()
  if (!prog) throw new Error(`ShatterPass: failed to create the ${label} program`)
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '(no info log)'
    gl.deleteProgram(prog)
    throw new Error(`ShatterPass: ${label} program link failed:\n${log}`)
  }
  return prog
}

function createBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const b = gl.createBuffer()
  if (!b) throw new Error('ShatterPass: failed to create an instance buffer')
  return b
}

function setFloat(gl: WebGL2RenderingContext, p: WebGLProgram, name: string, v: number): void {
  gl.uniform1f(gl.getUniformLocation(p, name), v)
}
function setInt(gl: WebGL2RenderingContext, p: WebGLProgram, name: string, v: number): void {
  gl.uniform1i(gl.getUniformLocation(p, name), v)
}
function setVec2(gl: WebGL2RenderingContext, p: WebGLProgram, name: string, x: number, y: number): void {
  gl.uniform2f(gl.getUniformLocation(p, name), x, y)
}
function bindTexture(
  gl: WebGL2RenderingContext,
  p: WebGLProgram,
  name: string,
  tex: WebGLTexture,
  unit: number
): void {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.uniform1i(gl.getUniformLocation(p, name), unit)
}
