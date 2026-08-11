import { App } from './app'
import { applyParamsFromUrl } from './rig/presets'
import { installSite } from './site'

const canvas = document.getElementById('stage') as HTMLCanvasElement | null
if (!canvas) throw new Error('Canvas #stage not found')

// Before the UI is installed, so a shared link opens on the look it encodes and every
// control renders already holding that value.
applyParamsFromUrl()

const app = new App(canvas)

// No camera work begins before consent: `installSite` resolves only once the viewer has
// been through the gate (or, on a return visit, granted the camera from the resume bar).
installSite(app.siteDeps)
  .then(() => {
    app.boot()
  })
  .catch((err: unknown) => {
    console.error('[app] boot failed', err)
  })
