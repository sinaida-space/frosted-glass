import { params } from './state/params'
import { createGLContext, resizeToDisplay } from './gl/context'
import { RenderTarget } from './gl/target'
import { Program, resolveIncludes } from './gl/program'
import { drawFullscreen } from './gl/quad'
import commonGlsl from './gl/shaders/common.glsl?raw'

const canvas = document.getElementById('stage') as HTMLCanvasElement
if (!canvas) throw new Error('Canvas not found')

console.log('frosted-glass boot', params.get())

const glctx = createGLContext(canvas)
resizeToDisplay(glctx, params.get().renderScale)

// --- Task 3 smoke test -------------------------------------------------
// Allocates one RGBA16F target, compiles a trivial program that writes vUv into it,
// then blits it to the screen. Confirms context, targets, includes and the fullscreen
// triangle all work together. Task 12 replaces this with the real render graph.

const smokeTargetFormat = glctx.caps.colorBufferFloat ? 'rgba16f' : 'rgba8'
const smokeTarget = new RenderTarget(glctx, glctx.width, glctx.height, { format: smokeTargetFormat })

const SMOKE_FRAG_SRC = `#version 300 es
in vec2 vUv;
out vec4 fragColor;
#include "common.glsl"
void main() {
  fragColor = vec4(saturate(vUv), 0.0, 1.0);
}
`

const smokeProgram = new Program(
  glctx,
  resolveIncludes(SMOKE_FRAG_SRC, { 'common.glsl': commonGlsl })
)

const blitFrag = `#version 300 es
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
void main() {
  fragColor = texture(uSrc, vUv);
}
`
const blitProgram = new Program(glctx, blitFrag)

function frame(): void {
  const resized = resizeToDisplay(glctx, params.get().renderScale)
  if (resized) smokeTarget.resize(glctx.width, glctx.height)

  smokeTarget.bind()
  smokeProgram.use()
  drawFullscreen(glctx)

  glctx.gl.bindFramebuffer(glctx.gl.FRAMEBUFFER, null)
  glctx.gl.viewport(0, 0, glctx.width, glctx.height)
  blitProgram.use()
  blitProgram.texture('uSrc', smokeTarget.texture)
  drawFullscreen(glctx)

  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
