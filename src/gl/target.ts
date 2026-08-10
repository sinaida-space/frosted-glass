import type { GLContext } from './context'

export type TargetFormat = 'rgba8' | 'rgba16f' | 'r8'

export interface TargetOptions {
  format?: TargetFormat
  filter?: 'nearest' | 'linear'
  mipmap?: boolean
  wrap?: 'clamp' | 'repeat'
}

interface FormatSpec {
  internalFormat: number
  format: number
  type: number
}

function formatSpec(gl: WebGL2RenderingContext, format: TargetFormat): FormatSpec {
  switch (format) {
    case 'rgba8':
      return { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE }
    case 'rgba16f':
      return { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
    case 'r8':
      return { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE }
  }
}

function fboStatusName(gl: WebGL2RenderingContext, status: number): string {
  const names: Record<number, string> = {
    [gl.FRAMEBUFFER_COMPLETE]: 'FRAMEBUFFER_COMPLETE',
    [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]: 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT',
    [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]: 'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT',
    [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS]: 'FRAMEBUFFER_INCOMPLETE_DIMENSIONS',
    [gl.FRAMEBUFFER_UNSUPPORTED]: 'FRAMEBUFFER_UNSUPPORTED',
    [gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE]: 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE',
  }
  return names[status] ?? `UNKNOWN_STATUS(0x${status.toString(16)})`
}

export class RenderTarget {
  private ctx: GLContext
  private gl: WebGL2RenderingContext
  private opts: Required<TargetOptions>

  private _texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  width: number
  height: number

  get texture(): WebGLTexture {
    return this._texture
  }

  constructor(ctx: GLContext, w: number, h: number, opts: TargetOptions = {}) {
    this.ctx = ctx
    this.gl = ctx.gl
    this.opts = {
      format: opts.format ?? 'rgba8',
      filter: opts.filter ?? 'linear',
      mipmap: opts.mipmap ?? false,
      wrap: opts.wrap ?? 'clamp',
    }
    this.width = w
    this.height = h

    const gl = this.gl
    const tex = gl.createTexture()
    if (!tex) throw new Error('RenderTarget: failed to create texture')
    this._texture = tex

    const fbo = gl.createFramebuffer()
    if (!fbo) throw new Error('RenderTarget: failed to create framebuffer')
    this.framebuffer = fbo

    this.allocate(w, h)
  }

  private allocate(w: number, h: number): void {
    const gl = this.gl
    const { format, filter, mipmap, wrap } = this.opts
    const spec = formatSpec(gl, format)

    gl.bindTexture(gl.TEXTURE_2D, this._texture)

    const levels = mipmap ? 1 + Math.floor(Math.log2(Math.max(w, h))) : 1
    gl.texStorage2D(gl.TEXTURE_2D, levels, spec.internalFormat, w, h)

    const filterMode = filter === 'linear' ? gl.LINEAR : gl.NEAREST
    const mipFilterMode = filter === 'linear' ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? mipFilterMode : filterMode)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode)

    const wrapMode = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texture, 0)

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      throw new Error(
        `RenderTarget: framebuffer incomplete (${fboStatusName(gl, status)}) for ${w}x${h} format=${format}`
      )
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)

    this.width = w
    this.height = h
  }

  bind(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.viewport(0, 0, this.width, this.height)
  }

  /** No-op unless mipmap:true. */
  generateMips(): void {
    if (!this.opts.mipmap) return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this._texture)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return
    const gl = this.gl
    // texStorage2D is immutable, so a resize means deleting and recreating the texture.
    gl.deleteTexture(this._texture)
    const tex = gl.createTexture()
    if (!tex) throw new Error('RenderTarget: failed to recreate texture on resize')
    this._texture = tex
    this.allocate(w, h)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteTexture(this._texture)
    gl.deleteFramebuffer(this.framebuffer)
  }
}

export class PingPong {
  private a: RenderTarget
  private b: RenderTarget
  private flipped = false

  constructor(ctx: GLContext, w: number, h: number, opts?: TargetOptions) {
    this.a = new RenderTarget(ctx, w, h, opts)
    this.b = new RenderTarget(ctx, w, h, opts)
  }

  get read(): RenderTarget {
    return this.flipped ? this.b : this.a
  }

  get write(): RenderTarget {
    return this.flipped ? this.a : this.b
  }

  swap(): void {
    this.flipped = !this.flipped
  }

  resize(w: number, h: number): void {
    this.a.resize(w, h)
    this.b.resize(w, h)
  }

  dispose(): void {
    this.a.dispose()
    this.b.dispose()
  }
}
