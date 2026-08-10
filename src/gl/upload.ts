import type { GLContext } from './context'

/** Creates an empty RGBA8 texture configured for per-frame video uploads. */
export function createVideoTexture(ctx: GLContext): WebGLTexture {
  const { gl } = ctx
  const tex = gl.createTexture()
  if (!tex) throw new Error('createVideoTexture: failed to create texture')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return tex
}

/**
 * Uploads a <video> frame directly via texImage2D - the fastest path, avoiding a
 * round-trip through a 2D canvas.
 *
 * flip-Y is intentionally left OFF here. Later passes handle orientation entirely in
 * UV space (do not flip again downstream, and do not enable UNPACK_FLIP_Y_WEBGL here -
 * doing both would double-flip and silently invert the image).
 */
export function uploadVideo(ctx: GLContext, tex: WebGLTexture, video: HTMLVideoElement): void {
  const { gl } = ctx
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video)
  gl.bindTexture(gl.TEXTURE_2D, null)
}

/** Creates an empty R8 texture configured for mask uploads. */
export function createMaskTexture(ctx: GLContext): WebGLTexture {
  const { gl } = ctx
  const tex = gl.createTexture()
  if (!tex) throw new Error('createMaskTexture: failed to create texture')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return tex
}

/**
 * Uploads mask data as a single-channel R8 texture. UNPACK_ALIGNMENT defaults to 4,
 * which works by luck for widths that are multiples of 4 and silently corrupts rows
 * for any odd width - it must be set to 1 before an R8 upload.
 */
export function uploadMask(ctx: GLContext, tex: WebGLTexture, data: Uint8Array, w: number, h: number): void {
  const { gl } = ctx
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  gl.bindTexture(gl.TEXTURE_2D, null)
}
