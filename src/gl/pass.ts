import type { GLContext } from './context'
import type { GlassParams } from '../state/params'

export interface FrameContext {
  ctx: GLContext
  time: number
  dt: number
  params: Readonly<GlassParams>
}

export interface Pass {
  readonly name: string
  render(f: FrameContext): void
  resize(w: number, h: number): void
  dispose(): void
}
