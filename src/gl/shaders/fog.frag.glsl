#version 300 es
// fog.frag.glsl - head-coupled volumetric fog behind the pane.
//
// This pass knows nothing about the person: no camera, no mask, no silhouette. It
// renders the raw volume and nothing else; the composite pass puts it together with
// everything in front of it.
//
// Output convention, depended on downstream: rgb is in-scattered radiance, alpha is
// TRANSMITTANCE, where 1 means completely clear and 0 means completely opaque fog.

in vec2 vUv;
out vec4 fragColor;

#include "common.glsl"
#include "volume.glsl"

// STEPS is injected as a #define by the pass (24 at full quality, 16 under load).
#ifndef STEPS
#define STEPS 24
#endif

uniform mat4 uInvViewProj;   // unprojects NDC back to world; built by the off-axis camera
uniform vec3 uEyeWorld;      // damped eye position, world metres
uniform float uTime;         // seconds

uniform float uFogDensity;   // params.fogDensity
uniform float uFogDepth;     // metres the slab extends behind the pane
uniform float uNoiseScale;   // world-space frequency of the density field

uniform vec3 uLightDir;      // direction the light TRAVELS, normalised
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform float uShafts;

/** Extinction coefficient for Beer-Lambert. Higher means the fog closes up sooner. */
const float EXTINCTION = 2.2;
/** Henyey-Greenstein asymmetry. Positive: forward-scattering toward the viewer. */
const float PHASE_G = 0.45;
/** Stop marching once the remaining light contribution is below noise. */
const float TRANSMITTANCE_CUTOFF = 0.003;
/**
 * Scattering coefficient and light power rolled into one tuned constant.
 *
 * Henyey-Greenstein carries a 1/4*PI normalisation and uLightColor is a unit-radiance
 * directional source with no irradiance term, so the strictly physical product lands
 * around 1e-4 per step: consistent, and black on screen. This lifts the result into the
 * range the composite pass expects, where fogDensity 1.0 reads as a bright fog and 0.5
 * as a soft haze.
 */
const float SCATTER_GAIN = 140.0;

/** Unprojects an NDC point through uInvViewProj and does the perspective divide. */
vec3 unproject(vec3 ndc) {
  vec4 p = uInvViewProj * vec4(ndc, 1.0);
  return p.xyz / p.w;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;

  // The world ray for this pixel, straight out of the asymmetric frustum. Because the
  // frustum is sheared by the eye offset, these rays fan differently on the left and
  // right of the screen - that shear is the entire parallax effect.
  vec3 pNear = unproject(vec3(ndc, -1.0));
  vec3 pFar = unproject(vec3(ndc, 1.0));

  vec3 ro = uEyeWorld;
  vec3 rd = normalize(pFar - pNear);

  float tEnter, tExit;
  if (!slabIntersect(ro, rd, uFogDepth, tEnter, tExit)) {
    // Looking along the pane: no volume to march. Fully transparent.
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float marchLength = tExit - tEnter;
  float stepLen = marchLength / float(STEPS);

  // Offsetting the first sample by a per-pixel dither is not polish. Without it the
  // fixed step positions line up across neighbouring pixels and the volume shows hard
  // horizontal bands, which are invisible on a laptop panel and glaring on a projector.
  float jitter = blueNoiseDither(gl_FragCoord.xy);

  // Scattering angle: outgoing direction toward the eye is -rd, incoming is uLightDir.
  float mu = dot(-rd, uLightDir);
  float phase = henyeyGreenstein(mu, PHASE_G);

  vec3 scattered = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < STEPS; i++) {
    float t = tEnter + (float(i) + jitter) * stepLen;
    if (t > tExit) break;

    vec3 p = ro + rd * t;

    float density = fogDensity(p, uTime, uNoiseScale, uFogDensity);
    if (density > 0.001) {
      float mask = shaftMask(p, uLightDir, uTime, uShafts);
      float shadow = selfShadow(p, uLightDir, uFogDepth, uFogDensity);

      // Front-to-back Beer-Lambert accumulation.
      transmittance *= exp(-density * stepLen * EXTINCTION);
      scattered += transmittance * density * stepLen * phase * mask * shadow
                 * uLightColor * uLightIntensity * SCATTER_GAIN;
    }

    if (transmittance < TRANSMITTANCE_CUTOFF) break;
  }

  fragColor = vec4(scattered, transmittance);
}
