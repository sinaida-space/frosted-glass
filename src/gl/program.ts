import type { GLContext } from './context'

/**
 * Shared fullscreen-triangle vertex shader, compiled once and reused by every Program.
 * 3 vertices, no VAO attributes - UVs are derived from gl_VertexID. This avoids the
 * diagonal-seam derivative artefact a two-triangle quad produces at the shared edge.
 */
const VERTEX_SRC = `#version 300 es
out vec2 vUv;
out vec2 vNdc;
void main() {
  // gl_VertexID in {0,1,2} maps to a triangle that covers the full [-1,1] clip area.
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vNdc = pos * 2.0 - 1.0;
  vUv = pos;
  gl_Position = vec4(vNdc, 0.0, 1.0);
}
`

function numberedSource(src: string): string {
  return src
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')}: ${line}`)
    .join('\n')
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Failed to create shader object')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no info log)'
    gl.deleteShader(shader)
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'
    throw new Error(`${kind} shader compile failed:\n${log}\n--- source ---\n${numberedSource(source)}`)
  }
  return shader
}

const sharedVertexShader: WeakMap<WebGL2RenderingContext, WebGLShader> = new WeakMap()

function getSharedVertexShader(gl: WebGL2RenderingContext): WebGLShader {
  let shader = sharedVertexShader.get(gl)
  if (!shader) {
    shader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC)
    sharedVertexShader.set(gl, shader)
  }
  return shader
}

function buildDefines(defines?: Record<string, string | number>): string {
  if (!defines) return ''
  return (
    Object.entries(defines)
      .map(([k, v]) => `#define ${k} ${v}`)
      .join('\n') + '\n'
  )
}

export class Program {
  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private uniformCache = new Map<string, WebGLUniformLocation | null>()
  private nextTextureUnit = 0

  constructor(ctx: GLContext, fragSrc: string, defines?: Record<string, string | number>) {
    const { gl } = ctx
    this.gl = gl

    const versionMatch = /^#version[^\n]*\n/.exec(fragSrc)
    const header = versionMatch ? versionMatch[0] : '#version 300 es\n'
    const body = versionMatch ? fragSrc.slice(versionMatch[0].length) : fragSrc
    const fullFragSrc = `${header}precision highp float;\n${buildDefines(defines)}${body}`

    const vertShader = getSharedVertexShader(gl)
    const fragShader = compileShader(gl, gl.FRAGMENT_SHADER, fullFragSrc)

    const prog = gl.createProgram()
    if (!prog) throw new Error('Failed to create program object')
    gl.attachShader(prog, vertShader)
    gl.attachShader(prog, fragShader)
    gl.linkProgram(prog)
    gl.deleteShader(fragShader)

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? '(no info log)'
      gl.deleteProgram(prog)
      throw new Error(`program link failed:\n${log}\n--- fragment source ---\n${numberedSource(fullFragSrc)}`)
    }

    this.prog = prog
  }

  use(): void {
    this.gl.useProgram(this.prog)
    this.nextTextureUnit = 0
  }

  private location(name: string): WebGLUniformLocation | null {
    if (this.uniformCache.has(name)) return this.uniformCache.get(name)!
    const loc = this.gl.getUniformLocation(this.prog, name)
    this.uniformCache.set(name, loc)
    return loc
  }

  /** Cached uniform lookup; silently ignores uniforms optimised out by the compiler. */
  set(name: string, value: number | boolean | number[] | Float32Array): void {
    const gl = this.gl
    const loc = this.location(name)
    if (!loc) return

    if (typeof value === 'boolean') {
      gl.uniform1i(loc, value ? 1 : 0)
      return
    }
    if (typeof value === 'number') {
      gl.uniform1f(loc, value)
      return
    }
    const arr = value
    switch (arr.length) {
      case 1:
        gl.uniform1f(loc, arr[0]!)
        break
      case 2:
        gl.uniform2f(loc, arr[0]!, arr[1]!)
        break
      case 3:
        gl.uniform3f(loc, arr[0]!, arr[1]!, arr[2]!)
        break
      case 4:
        gl.uniform4f(loc, arr[0]!, arr[1]!, arr[2]!, arr[3]!)
        break
      case 9:
        gl.uniformMatrix3fv(loc, false, arr as Float32Array)
        break
      case 16:
        gl.uniformMatrix4fv(loc, false, arr as Float32Array)
        break
      default:
        throw new Error(`Program.set: unsupported uniform array length ${arr.length} for "${name}"`)
    }
  }

  /** Binds `tex` to the next free unit and sets the sampler uniform. Resets each use(). */
  texture(name: string, tex: WebGLTexture): void {
    const gl = this.gl
    const loc = this.location(name)
    const unit = this.nextTextureUnit++
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (loc) gl.uniform1i(loc, unit)
  }

  dispose(): void {
    this.gl.deleteProgram(this.prog)
    this.uniformCache.clear()
  }
}

/**
 * Resolves `#include "name.glsl"` directives against a module map, recursively, with
 * cycle detection. `modules` keys are the include names as they appear in the directive.
 */
export function resolveIncludes(src: string, modules: Record<string, string>): string {
  const INCLUDE_RE = /^\s*#include\s+"([^"]+)"\s*$/

  function resolve(source: string, stack: string[]): string {
    const lines = source.split('\n')
    const out: string[] = []
    for (const line of lines) {
      const match = INCLUDE_RE.exec(line)
      if (!match) {
        out.push(line)
        continue
      }
      const name = match[1]!
      if (stack.includes(name)) {
        throw new Error(`resolveIncludes: cyclic #include detected: ${[...stack, name].join(' -> ')}`)
      }
      const mod = modules[name]
      if (mod === undefined) {
        throw new Error(`resolveIncludes: missing module "${name}" (included from ${stack[stack.length - 1] ?? '<root>'})`)
      }
      out.push(resolve(mod, [...stack, name]))
    }
    return out.join('\n')
  }

  return resolve(src, [])
}
