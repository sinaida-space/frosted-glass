/**
 * Gesture diagrams for the three rites. Plain line-art SVGs, each showing hand
 * position and motion relative to the pane, not abstract shapes. Looping motion is
 * driven by CSS keyframes in site.css and is turned off under prefers-reduced-motion.
 */

const HAND = (x: number, y: number): string => `
  <g transform="translate(${x}, ${y})">
    <rect x="-16" y="-6" width="32" height="34" rx="10" fill="none" stroke="currentColor" stroke-width="2.5" />
    <line x1="-9" y1="-6" x2="-9" y2="-24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
    <line x1="-1" y1="-6" x2="-1" y2="-28" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
    <line x1="7" y1="-6" x2="7" y2="-27" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
    <line x1="15" y1="-6" x2="15" y2="-21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
    <line x1="-16" y1="4" x2="-30" y2="-2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
  </g>`

export function touchDiagram(): string {
  return `
  <svg viewBox="0 0 200 100" role="img" aria-labelledby="fg-rite-touch-title">
    <title id="fg-rite-touch-title">A hand moves toward the pane and comes to rest against the glass.</title>
    <line x1="150" y1="6" x2="150" y2="94" stroke="currentColor" stroke-width="2" opacity="0.55" />
    <g class="fg-diagram-hand" color="currentColor">
      ${HAND(45, 48)}
    </g>
  </svg>`
}

export function breakDiagram(): string {
  return `
  <svg viewBox="0 0 200 100" role="img" aria-labelledby="fg-rite-break-title">
    <title id="fg-rite-break-title">A hand pushes past the pane and it fractures into shards where the hand meets the glass.</title>
    <line x1="150" y1="6" x2="150" y2="94" stroke="currentColor" stroke-width="2" opacity="0.35" />
    <g class="fg-diagram-shatter" color="currentColor">
      <line x1="150" y1="30" x2="168" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <line x1="150" y1="45" x2="172" y2="45" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <line x1="150" y1="60" x2="166" y2="74" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <line x1="150" y1="50" x2="134" y2="30" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      <line x1="150" y1="55" x2="132" y2="66" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </g>
    <g class="fg-diagram-hand-break" color="currentColor">
      ${HAND(45, 48)}
    </g>
  </svg>`
}

export function healDiagram(): string {
  return `
  <svg viewBox="0 0 200 100" role="img" aria-labelledby="fg-rite-heal-title">
    <title id="fg-rite-heal-title">Two hands hold still on either side of the break while fog fills the gap and seals the crack.</title>
    <line x1="60" y1="15" x2="45" y2="30" stroke="currentColor" stroke-width="1.6" opacity="0.4" />
    <line x1="140" y1="20" x2="152" y2="8" stroke="currentColor" stroke-width="1.6" opacity="0.4" />
    <line x1="130" y1="60" x2="148" y2="70" stroke="currentColor" stroke-width="1.6" opacity="0.4" />
    <rect x="65" y="10" width="70" height="60" fill="currentColor" class="fg-diagram-fog" opacity="0.9" style="transform-origin: 100px 40px" />
    <g class="fg-diagram-hand-left" color="currentColor">
      ${HAND(48, 45)}
    </g>
    <g transform="scale(-1,1)">
      <g class="fg-diagram-hand-right" color="currentColor">
        ${HAND(-152, 45)}
      </g>
    </g>
  </svg>`
}
