#version 300 es
// scatter-source.frag.glsl - level 0 of the scatter pyramid.
//
// Repacks the silhouette field into the four channels the pyramid needs, so that a plain
// box-mipped read at level L answers two questions about the neighbourhood at once:
// how much of it is person, and how far behind the pane that person is.
//
//   R = coverage                 - averaging this gives the covered fraction of the region
//   G = coverage * dz            - COVERAGE-WEIGHTED depth. After mipping, G/R is the mean
//                                  depth OF THE PERSON in the region. A plain average of dz
//                                  would be dragged toward whatever the empty background
//                                  happens to carry, and the whole radius model reads that
//                                  number.
//   B = coverage                 - carried as specified; the scatter pass reads coverage
//                                  from R and leaves this alone.
//   A = dz, unweighted           - DEVIATION FROM THE SPEC, which asks for 1.0. The scatter
//                                  pass has to seed its fixed-point iteration outside the
//                                  silhouette too: a background pixel beside a distant torso
//                                  must know it is standing in a wide-blur region before it
//                                  can decide to sample wide. There R is 0, so G/R is 0/0 and
//                                  carries no information at all. The silhouette pass writes
//                                  a filled depth at EVERY pixel (its push-pull fill, not
//                                  just under coverage), so this channel is meaningful
//                                  everywhere and is exactly the seed that is needed.
//                                  Nothing downstream reads alpha from this target.
//
// No colour, no compositing, no blur. Blur is the pyramid; light is task 7.

in vec2 vUv;
out vec4 fragColor;

#include "common.glsl"

uniform sampler2D uSilhouette; // R = coverage, G = dz metres, B = attribution, A = 1

void main() {
  vec4 s = texture(uSilhouette, vUv);
  float coverage = saturate(s.r);
  float dz = max(s.g, 0.0);
  fragColor = vec4(coverage, coverage * dz, coverage, dz);
}
