/**
 * Throwaway verification harness for issue #2. NOT part of the module's
 * public surface — delete before committing. Open demo.html (create one
 * pointing at this script, or run `npx vite` and navigate to this file's
 * directory) with a camera attached to eyeball the DoD items that need a
 * human: distance monotonicity, palm-rotation stability, eyeCenterM sign,
 * mask presence, and inference budget.
 */
import { Tracker } from './tracker'

async function main() {
  const log = document.createElement('pre')
  log.style.cssText = 'position:fixed;top:0;left:0;background:#000;color:#0f0;font:12px monospace;padding:8px;z-index:10;white-space:pre-wrap;max-width:40vw'
  document.body.appendChild(log)

  const video = document.createElement('video')
  video.style.cssText = 'position:fixed;top:0;right:0;width:40vw'
  document.body.appendChild(video)

  const tracker = await Tracker.create()
  tracker.onLoadProgress = (p, label) => {
    log.textContent = `loading ${label}: ${(p * 100).toFixed(0)}%`
  }

  function loop(nowMs: number) {
    const frame = tracker.update(nowMs)
    if (frame.video && video.srcObject !== frame.video.srcObject) {
      video.srcObject = frame.video.srcObject
      video.play()
    }
    const hand = frame.hands[0]
    const face = frame.face
    log.textContent = [
      `inferenceMs (rolling mean): ${tracker.inferenceMs.toFixed(2)}  degraded=${tracker.degraded}`,
      `calibrated: ${frame.calibrated}`,
      `mask: ${frame.maskData ? `${frame.maskWidth}x${frame.maskHeight} (${frame.maskData.length}B)` : 'null'}`,
      hand
        ? `hand[${hand.handedness}] distanceM=${hand.distanceM.toFixed(3)} spanPx=${hand.spanPx.toFixed(1)} flatness=${hand.palmFlatness.toFixed(2)}`
        : 'hand: none',
      face
        ? `face distanceM=${face.distanceM.toFixed(3)} ipdPx=${face.ipdPx.toFixed(1)} eyeCenterM=[${face.eyeCenterM.map((v) => v.toFixed(3)).join(', ')}]`
        : 'face: none',
    ].join('\n')
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)

  const calibBtn = document.createElement('button')
  calibBtn.textContent = 'Calibrate at 0.5m'
  calibBtn.style.cssText = 'position:fixed;bottom:0;left:0;z-index:10'
  calibBtn.onclick = () => {
    const ok = tracker.calibrate(0.5)
    console.log('calibrate(0.5) ->', ok)
  }
  document.body.appendChild(calibBtn)
}

main().catch((err) => {
  console.error(err)
  document.body.textContent = `Tracker failed: ${err}`
})
