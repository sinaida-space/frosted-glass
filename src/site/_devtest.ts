/* Temporary manual-verification harness for issue #11. Not part of the shipped
 * bundle — removed before handoff. Mocks the deps task 12 will supply. */
import { installSite } from './index'

let progressCb: ((p: number, label: string) => void) | null = null
let fakeProgress = 0
const labels = ['Fetching hand landmarker (0/2)', 'Fetching pose landmarker (1/2)', 'Warming up']

function tickLoad(): void {
  fakeProgress = Math.min(1, fakeProgress + 0.08)
  const label = fakeProgress >= 1 ? 'Ready' : labels[Math.floor(fakeProgress * labels.length)] ?? labels[0]!
  progressCb?.(fakeProgress, label)
  if (fakeProgress < 1) setTimeout(tickLoad, 150)
}

let shouldFailCamera: string | null = (window as any).__fgFailCamera ?? null
let distance: number | null = null

void installSite({
  onGrantCamera: async () => {
    await new Promise((r) => setTimeout(r, 200))
    if (shouldFailCamera) {
      const err = new DOMException('mock', shouldFailCamera)
      shouldFailCamera = null
      throw err
    }
    setTimeout(tickLoad, 200)
    setTimeout(() => { distance = 1.02 }, 900)
  },
  onCalibrate: (m) => {
    console.log('calibrate at', m)
    return distance !== null
  },
  getDistance: () => distance,
  loadProgress: (cb) => { progressCb = cb },
})
