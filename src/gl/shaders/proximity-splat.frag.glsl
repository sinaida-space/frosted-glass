#version 300 es
precision highp float;

// Fragment half of the proximity splat. This program is compiled by hand in
// SilhouettePass (it needs a custom vertex shader, so it cannot go through
// gl/program.ts, which hard-wires the fullscreen triangle) - hence the explicit
// precision qualifier above.
//
// The target is cleared to zero and blended with blendFunc(ONE, ONE), so every
// splat ADDS into the accumulation buffer. Output is premultiplied by the weight
// so the resolve downstream is a plain divide:
//
//   dz          = sum(dz_i * w_i) / sum(w_i)      -> R / G
//   attribution = sum(w_i)                        -> G
//   confidence  = sum(conf_i * w_i) / sum(w_i)    -> B / G

in vec2 vLocal;
in float vDz;
in float vWeight;
in float vConf;

out vec4 fragColor;

// exp(-3.0): the raw Gaussian value at the quad edge. Subtracting it and renormalising
// makes the falloff reach exactly zero at d = 1, so splats do not leave a visible ring
// where the quad ends.
const float EDGE_FALLOFF = 0.049787068;

void main() {
  float d2 = dot(vLocal, vLocal);
  if (d2 >= 1.0) discard; // trim the quad corners to a disc

  float gauss = (exp(-3.0 * d2) - EDGE_FALLOFF) / (1.0 - EDGE_FALLOFF);
  float w = vWeight * gauss;

  fragColor = vec4(vDz * w, w, vConf * w, 0.0);
}
