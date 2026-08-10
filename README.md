# Frosted Glass

A browser instrument that turns a webcam into a pane of fogged glass. Move behind it and your body becomes a shape in the fog, lit and scattered in real time, built for stage backdrops and for footage worth keeping. Everything runs inside the browser tab: no video is uploaded, and nothing is recorded unless you press record and save the take.

**Live:** https://sinaida-space.github.io/frosted-glass/

*(Screenshot placeholder: a performer’s silhouette behind the fogged pane. Add one at `docs/screenshot.png` once a real capture exists.)*

## Local Development

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## Build

```bash
npm run build
npm run preview
```

## Type Checking & Linting

```bash
npm run typecheck
npm run lint
```

## Shortcuts

Every shortcut also has a visible control in the on-screen panel.

| Key | Action |
|---|---|
| `F` | Toggle fullscreen |
| `H` | Hide or show the UI |
| `R` | Reset the glass to its defaults |
| `Space` | Force a shatter at screen centre |
| `C` | Start or stop recording |
| `P` | Open the projector popout |
| `1`–`5` | Load built-in preset 1–5 |
| `?` | Toggle this shortcut overlay |

## Privacy

No account, no cookies, no video upload. The full breakdown, including what `localStorage` holds and which third parties the model files touch, is in the privacy panel reachable from the app’s footer.

Built by [Sinaida Krivchenko](https://sinaida.eu)

License: GPL-3.0
