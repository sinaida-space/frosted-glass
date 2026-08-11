#version 300 es

// The mended seam, written into the R8 mask GlassPass multiplies its condensation film by.
//
// IMPORTANT, and a real constraint rather than a choice: GlassPass computes
// `film = uCondensation * heal * ...`, so this mask can only ever THIN the condensation,
// never thicken it. Making the seam foggier than the pane is therefore done by clearing
// the pane slightly everywhere ELSE while the heal is fresh, and letting that clearing
// decay back to a uniform 1.0. When uActivity reaches 0 every texel is exactly 1.0, which
// is bit-identical to the 1x1 white texel GlassPass falls back to, so an intact pane looks
// exactly as it did before this pass existed.

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPrev;    // previous frame's mask, for temporal smoothing
uniform sampler2D uCracks;  // R8 crack field; the seam follows the mend lines
uniform float uActivity;    // 1 the instant a heal completes, decaying to 0 over ~4 s
uniform float uSeamGain;    // how much the seam stands out from the rest of the pane

void main() {
  // Snap rather than converge. The temporal blend below approaches 1.0 geometrically and
  // R8 rounding parks it at 254/255, which would leave the pane permanently 0.4% clearer
  // than it was before this pass existed.
  if (uActivity <= 0.0) {
    fragColor = vec4(1.0);
    return;
  }

  float seam = texture(uCracks, vUv).r;

  // 1 on the seam, 1 - uSeamGain across the rest of the pane, all of it fading to a flat
  // 1.0 as uActivity decays.
  float target = 1.0 - uSeamGain * uActivity * (1.0 - seam);

  // Smoothed against the previous frame so the seam breathes in rather than snapping on.
  float prev = texture(uPrev, vUv).r;
  fragColor = vec4(mix(target, prev, 0.6), 0.0, 0.0, 1.0);
}
