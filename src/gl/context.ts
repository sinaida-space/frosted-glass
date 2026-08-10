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

  let targetW = Math.max(1, Math.round(canvas.clientWidth * dpr * renderScale))
  let targetH = Math.max(1, Math.round(canvas.clientHeight * dpr * renderScale))

  if (targetW > cap) targetW = cap
  if (targetH > cap) targetH = cap

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
