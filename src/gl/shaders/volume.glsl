// volume.glsl - the fog medium itself: slab intersection, density field, phase function,
// procedural light shafts and self-shadowing. Included by fog.frag.glsl, which owns the
// ray setup and the march loop.
//
// Requires "common.glsl" to be included first (saturate, fbm2, fbm3).
//
// Every function here takes its parameters explicitly rather than reading uniforms, so
// this module stays independent of whatever uniform names the including pass picked.
//
// World convention, fixed project-wide: origin at the screen centre, +x right, +y up,
// +z out toward the viewer. The fog slab occupies z in [-fogDepth, 0].

// --- Slab intersection ------------------------------------------------------

/**
 * Intersects a ray with the infinite slab z in [-fogDepth, 0].
 * Writes the entry/exit distances (clamped so tEnter is never behind the origin) and
 * returns false when the ray misses - which for this slab means it runs parallel to the
 * pane, or the whole slab is behind the origin.
 */
bool slabIntersect(vec3 ro, vec3 rd, float fogDepth, out float tEnter, out float tExit) {
  tEnter = 0.0;
  tExit = 0.0;

  // A ray with no z component either lies inside the slab forever or never enters it.
  // Either way there is nothing sensible to march, so treat it as a miss.
  if (abs(rd.z) < 1e-5) return false;

  float inv = 1.0 / rd.z;
  float t0 = (0.0 - ro.z) * inv;          // near face of the slab, at the pane
  float t1 = (-fogDepth - ro.z) * inv;    // far face

  tEnter = max(min(t0, t1), 0.0);
  tExit = max(t0, t1);

  return tExit > tEnter;
}

/**
 * Distance from p along direction `dir` until the ray leaves the slab, capped at
 * fogDepth. Used to estimate how much medium a light ray had to push through to reach p.
 */
float slabExitDistance(vec3 p, vec3 dir, float fogDepth) {
  if (abs(dir.z) < 1e-5) return fogDepth;
  float inv = 1.0 / dir.z;
  float t0 = (0.0 - p.z) * inv;
  float t1 = (-fogDepth - p.z) * inv;
  float t = max(t0, t1);              // whichever face lies ahead of us
  return clamp(t, 0.0, fogDepth);
}

// --- Density ----------------------------------------------------------------

/**
 * Fog density at a world point.
 *
 * fbm3 drifts along +z over time so the volume breathes without the whole field
 * sliding laterally (lateral drift reads as wind and fights the parallax cue).
 * The smoothstep remap is what turns a smooth noise field into wisps with clear air
 * between them; without it the fog is a uniform grey soup.
 * The vertical gradient makes the fog pool low, which is what real cold fog does.
 */
float fogDensity(vec3 p, float time, float noiseScale, float density) {
  float d = fbm3(p * noiseScale + vec3(0.0, 0.0, time * 0.03));
  d = smoothstep(0.35, 0.9, d);
  d *= density;
  d *= mix(1.35, 0.55, saturate(p.y * 0.5 + 0.5));
  return d;
}

// --- Scattering -------------------------------------------------------------

/**
 * Henyey-Greenstein phase function. `mu` is the cosine of the scattering angle, i.e.
 * dot(directionTowardEye, lightTravelDirection). g > 0 biases forward scattering, so
 * the fog blooms when you look back along the beam.
 */
float henyeyGreenstein(float mu, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * mu;
  return (1.0 - g2) / (4.0 * PI * pow(max(denom, 1e-4), 1.5));
}

/**
 * Procedural light shafts.
 *
 * There is no geometry behind the pane to cast a shadow, so the occluder is invented:
 * an fbm gobo evaluated in the plane perpendicular to the light, drifting slowly. Every
 * point on a given light ray projects to the same gobo coordinate, so the mask is
 * constant along the beam - which is what makes it read as a shaft rather than as
 * blotchy fog. The implication of something offscreen blocking the light is the whole
 * effect.
 *
 * The gobo is deliberately ANISOTROPIC, and that is what makes the shafts survive the
 * raymarch. A view ray is not parallel to the light, so as it crosses the slab its
 * projection into the gobo plane sweeps sideways - here by about 3 m, against a volume
 * only about 2 m wide on screen. An isotropic gobo therefore gets averaged out along
 * every view ray and the result is soft blotches, not beams. Stretching the gobo along
 * the sweep axis (so it barely changes over those 3 m) while keeping it detailed across
 * that axis leaves the contrast intact through the integral.
 *
 * The sweep axis is the component of the view direction perpendicular to the light.
 * Using the screen normal (+z, the direction essentially every view ray travels) rather
 * than the per-pixel ray keeps the gobo a single consistent field in world space, so it
 * does not swim when the head moves.
 */

/** Gobo detail across the sweep axis - this is the frequency that becomes the beams. */
const float SHAFT_FREQ_ACROSS = 4.0;
/** Gobo frequency along the sweep axis. Low on purpose: see the note above. */
const float SHAFT_FREQ_ALONG = 0.2;

float shaftMask(vec3 p, vec3 lightDir, float time, float shafts) {
  // Sweep axis: view direction (+z, out of the screen) projected into the plane
  // perpendicular to the light. Degenerates only when the light points straight at the
  // viewer, in which case there is no sweep and any perpendicular axis will do.
  vec3 sweep = vec3(0.0, 0.0, 1.0) - lightDir.z * lightDir;
  float sweepLen = length(sweep);
  vec3 fallback = abs(lightDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 lAlong = sweepLen > 1e-3 ? sweep / sweepLen : normalize(cross(lightDir, fallback));
  vec3 lAcross = cross(lightDir, lAlong);

  vec2 proj = vec2(dot(p, lAlong) * SHAFT_FREQ_ALONG, dot(p, lAcross) * SHAFT_FREQ_ACROSS);
  float gobo = smoothstep(0.3, 0.75, fbm2(proj + time * 0.02));
  return mix(1.0, gobo, shafts);
}

/**
 * Crude self-shadow: Beer-Lambert attenuation over the distance the light travelled
 * through the slab to reach p. It assumes uniform density along that path, which is
 * wrong in detail and completely convincing in motion - the alternative is a secondary
 * march per sample, which this pass cannot afford.
 */
float selfShadow(vec3 p, vec3 lightDir, float fogDepth, float density) {
  float distanceThroughFog = slabExitDistance(p, -lightDir, fogDepth);
  return exp(-density * 0.6 * distanceThroughFog);
}
