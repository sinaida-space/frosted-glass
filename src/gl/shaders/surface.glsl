// surface.glsl - the pane's own surface: micro-roughness, condensation, droplets, specular.
// Included by glass.frag.glsl. Requires common.glsl to have been included first.
//
// Everything here is a function of gl_FragCoord, never of UV. The pane is a physical object
// in front of the camera: its grain and its droplets belong to the glass, not to the image
// behind it, so they must not stretch or crawl when the window resizes.

/**
 * Two-octave value noise for the pane's micro-roughness.
 *
 * fbm2 in common.glsl runs five octaves, which is four more than a 2.4-pixel-scale grain
 * needs - beyond the first two the octaves land below one pixel and only alias.
 */
float paneNoise2(vec2 p) {
  return valueNoise2(p) * 0.667 + valueNoise2(p * 2.0) * 0.333;
}

/**
 * Condensation droplets.
 *
 * A jittered point per grid cell, kept or dropped by a hash against the density, with a
 * radial falloff. The 3x3 neighbourhood is what lets a droplet whose centre sits in the
 * next cell still reach this pixel; a single cell would tile visibly.
 *
 * Returns: x = droplet mass 0..1 (1 at a droplet's centre)
 *          yz = refraction offset in pixels, pointing out of the droplet centre
 *          w = specular dot, a much tighter version of the mass
 *
 * DROPLETS is injected by the caller: 1 for the full 3x3 sweep, 0 to skip them entirely.
 */
vec4 droplets(vec2 fragCoord, float cellPx, float density, float time) {
  vec2 g = fragCoord / cellPx;
  vec2 cell = floor(g);
  vec2 f = g - cell;

  float mass = 0.0;
  float spec = 0.0;
  vec2 push = vec2(0.0);

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 id = cell + o;

      vec2 h = hash22(id);
      // Keep only a `density` fraction of cells, so raising condensation adds droplets
      // rather than growing every droplet at once.
      if (h.x > density) continue;

      // Jitter across the WHOLE cell, not its middle half: confining the centre leaves the
      // grid pitch plainly visible as a lattice of dots, which is the first thing that
      // gives a procedural droplet field away.
      vec2 centre = o + hash22(id + 17.0);
      // Squared hash, so most droplets are small and a few are large - a real condensation
      // field is not a set of same-sized discs.
      float radius = 0.06 + 0.34 * h.y * h.y;

      vec2 d = f - centre;
      float r = length(d) / radius;
      if (r >= 1.0) continue;

      // Slow drift: a droplet swells and shrinks rather than blinking.
      float breathe = 0.85 + 0.15 * sin(time * 0.25 + h.y * 6.2831);
      float m = (1.0 - r * r);
      m = m * m * breathe;

      mass += m;
      // A sphere's refraction bends hardest at its rim, not at its centre.
      push += normalize(d + 1e-5) * m * r * radius * cellPx;
      spec += pow(saturate(1.0 - r), 8.0) * breathe;
    }
  }

  return vec4(saturate(mass), push, saturate(spec));
}

/**
 * GGX normal-distribution term, used on its own as a rough-glass specular lobe.
 * No Fresnel or geometry term: the pane is a diffuser, and the lobe here is a look
 * control rather than a BRDF to be integrated.
 */
float ggxLobe(float nDotH, float roughness) {
  float a = max(roughness * roughness, 1e-3);
  float a2 = a * a;
  float d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

/**
 * Soft filmic shoulder. An ACES fit is far too contrasty for a high-key milky pane: it
 * crushes the shadow end and drags the whites toward paper. This keeps the toe almost
 * linear and rolls the top off so that 1.0 maps to about 0.96 rather than clipping.
 */
vec3 toneMap(vec3 x) {
  // x / (1 + x^n)^(1/n): unit slope at the origin, asymptote exactly 1, and a knee whose
  // tightness is n. n = 16 leaves everything below about 0.8 untouched and puts 1.0 at
  // 0.9576, which is the "bright white paper, but still paper" the pane needs.
  const float N = 16.0;
  vec3 v = max(x, 0.0);
  return v / pow(1.0 + pow(v, vec3(N)), vec3(1.0 / N));
}

/** Radial vignette in linear space. 1 at the centre, falling off toward the corners. */
float vignetteAt(vec2 uv, float amount) {
  float r = length(uv - 0.5) * 1.41421; // 0 at the centre, 1 at a corner
  return mix(1.0, smoothstep(1.05, 0.35, r), amount);
}
