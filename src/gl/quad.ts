import type { GLContext } from './context'

/**
 * Draws a fullscreen triangle (3 vertices, no bound VAO attributes - the vertex shader
 * derives position/UV from gl_VertexID). Requires a bound VAO even with no attributes,
 * so we lazily create one empty VAO per context and reuse it.
 */
const emptyVaos = new WeakMap<WebGL2RenderingContext, WebGLVertexArrayObject>()

function getEmptyVao(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  let vao = emptyVaos.get(gl)
  if (!vao) {
    const created = gl.createVertexArray()
    if (!created) throw new Error('drawFullscreen: failed to create VAO')
    vao = created
    emptyVaos.set(gl, vao)
  }
  return vao
}

export function drawFullscreen(ctx: GLContext): void {
  const { gl } = ctx
  gl.bindVertexArray(getEmptyVao(gl))
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  gl.bindVertexArray(null)
}
