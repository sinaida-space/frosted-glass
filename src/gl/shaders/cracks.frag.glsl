#version 300 es
precision highp float;

// One crack segment per instance, expanded to a quad by the vertex shader. Each fragment
// measures its distance to its OWN segment and the target is MAX-blended, so the result
// is the distance field of the whole crack set without any fragment looping over it.
//
// A crack is not a bright line. It is a bright line with a dark core: the fracture surface
// scatters light back at you, and the gap itself shows the unlit pane edge. Drawing only
// the bright part gives cheerful scratches instead of broken glass.

in vec2 vSegA;
in vec2 vSegB;
in vec2 vPos;
in float vDist;

uniform vec2 uResolution;
/** Crack front radius in NDC. Segments beyond it have not happened yet. */
uniform float uFront;
uniform float uAspect;
/** Line half-width in NDC-y. */
uniform float uWidth;

out vec4 fragColor;

void main() {
  // The reveal is per-fragment, not per-segment, so a long segment grows along its length
  // instead of appearing whole. That is what makes the break read as propagating.
  if (vDist > uFront) discard;

  vec2 p = vec2(vPos.x * uAspect, vPos.y);
  vec2 a = vec2(vSegA.x * uAspect, vSegA.y);
  vec2 b = vec2(vSegB.x * uAspect, vSegB.y);
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
  float d = length(p - (a + ab * t));

  // Bright flank minus a darker core.
  float line = 1.0 - smoothstep(uWidth * 0.35, uWidth, d);
  float core = 1.0 - smoothstep(0.0, uWidth * 0.35, d);

  // Freshly opened cracks flash brighter, then settle.
  float age = clamp((uFront - vDist) * 3.0, 0.0, 1.0);
  float v = line * mix(1.0, 0.65, age) - core * 0.55;

  fragColor = vec4(clamp(v, 0.0, 1.0), 0.0, 0.0, 1.0);
}
