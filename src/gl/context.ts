/** WebGL2 context creation, capability detection and resolution management. */

export interface GLCaps {
  colorBufferFloat: boolean
  floatLinear: boolean
  maxTextureSize: number
}

export interface GLContext {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  caps: GLCaps
  /** Drawing-buffer size after renderScale and the 1920x1080 cap. */
  width: number
  height: number
  dpr: number
}

const MAX_DIMENSION = 1920

export function createGLContext(canvas: HTMLCanvasElement): GLContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    desynchronized: true,
  }) as WebGL2RenderingContext | null

  if (!gl) {
    throw new Error('WebGL2 is not available in this browser/context. This project requires WebGL2.')
  }

  // EXT_color_buffer_float: required to render into RGBA16F (or other float) targets.
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null
  // OES_texture_float_linear: required separately to LINEAR-filter a float texture.
  const floatLinear = gl.getExtension('OES_texture_float_linear') !== null

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number

  const caps: GLCaps = { colorBufferFloat, floatLinear, maxTextureSize }

  const ctx: GLContext = {
    gl,
    canvas,
    caps,
    width: canvas.width,
    height: canvas.height,
    dpr: window.devicePixelRatio || 1,
  }

  console.log(
    `[gl] caps: EXT_color_buffer_float=${caps.colorBufferFloat} OES_texture_float_linear=${caps.floatLinear} maxTextureSize=${caps.maxTextureSize}`
  )

  return ctx
}

/**
 * Resizes the canvas drawing buffer to match its display size, scaled by dpr and
 * renderScale, clamped so neither dimension exceeds MAX_DIMENSION or caps.maxTextureSize.
 * Only touches the canvas (and reallocates the drawing buffer) when the target size
 * actually changed - reallocating every frame tanks the framerate.
 */
export function resizeToDisplay(ctx: GLContext, renderScale: number): boolean {
  const { canvas, dpr, caps } = ctx
  const cap = Math.min(MAX_DIMENSION, caps.maxTextureSize)

  const wantW = Math.max(1, canvas.clientWidth * dpr * renderScale)
  const wantH = Math.max(1, canvas.clientHeight * dpr * renderScale)

  // Clamp both axes by ONE shared factor so the aspect ratio survives. Clamping
  // each axis independently silently distorts the buffer - a 1280x720 canvas at
  // dpr 2 would land on 1920x1440 (4:3) instead of 1920x1080 - and that aspect
  // feeds the off-axis frustum, so the parallax would be built for a window
  // that is not the one on screen.
  const fit = Math.min(1, cap / wantW, cap / wantH)
  const targetW = Math.max(1, Math.round(wantW * fit))
  const targetH = Math.max(1, Math.round(wantH * fit))

  if (canvas.width === targetW && canvas.height === targetH) {
    return false
  }

  canvas.width = targetW
  canvas.height = targetH
  ctx.width = targetW
  ctx.height = targetH
  ctx.dpr = dpr

  console.log(`[gl] drawing buffer reallocated: ${targetW}x${targetH}`)
  return true
}
