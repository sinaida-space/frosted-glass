import { params } from './state/params'

const canvas = document.getElementById('stage') as HTMLCanvasElement
if (!canvas) throw new Error('Canvas not found')

const dpr = window.devicePixelRatio || 1
canvas.width = canvas.clientWidth * dpr
canvas.height = canvas.clientHeight * dpr

const ctx = canvas.getContext('2d')
if (ctx) {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

console.log('frosted-glass boot', params.get())
