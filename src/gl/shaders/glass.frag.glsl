#version 300 es
// glass.frag.glsl - the image. Fog behind, a body dissolving into it, a real pane in front.
//
// The body is NOT a dark shape drawn on top of the fog. It is an occluder INSIDE the fog,
// and the fog lying between it and the pane is what washes it out. That single fact is why
// a palm on the glass has near-black fingertips while a torso two feet back is mid-grey:
// the fingertips have almost no fog in front of them, the torso has 90 cm of it.

in vec2 vUv;
out vec4 fragColor;

#include "common.glsl"
#include "surface.glsl"

uniform sampler2D uScatter;   // R = coverage, G = dz metres, B = contact, A = 1
uniform sampler2D uFog;       // RGB = in-scattered radiance, A = transmittance (1 = clear)
uniform sampler2D uHealMask;  // R8, default a 1x1 white texel; task 8 binds the real one

uniform vec2 uResolution;
uniform float uTime;

uniform vec3 uGlassColor;
uniform vec3 uSilhouetteColor;
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform vec3 uLightDir;       // direction the light TRAVELS, normalised, same as the fog pass

uniform float uFogDensity;
uniform float uFogDepth;
uniform float uAbsorption;
uniform float uGrain;
uniform float uCondensation;
uniform float uDispersion;
uniform float uVignette;
uniform float uFilmGrain;

// QUALITY is injected by the pass: 1 = full, 0 = no droplets and no dispersion.
#ifndef QUALITY
#define QUALITY 1
#endif

/** Same extinction the fog pass marches with. The two must agree or the body floats. */
const float FOG_EXTINCTION = 2.2;

/** Grid pitch of the droplet field, in pixels at 1080p. */
const float DROPLET_CELL_PX = 46.0;

/**
 * Radiance arriving at the BACK face of the pane, at one sample position.
 *
 * Sampled as a function so dispersion can call it three times at three slightly different
 * offsets and keep one channel from each.
 */
vec3 behindAt(vec2 uv) {
  vec4 S = texture(uScatter, uv);
  vec4 F = texture(uFog, uv);

  float cov = S.r;  // scattered coverage
  float dz  = S.g;  // scattered depth, metres behind the pane
  float con = S.b;  // contact factor, 1 at the glass

  // 1. Transmittance of the fog lying between the body and the pane. This is the whole
  //    depth cue: at dz = 0 nothing is in the way and the body reads its own colour; at
  //    dz = 0.9 m and the default density only 37% of it survives.
  float Tbody = exp(-uFogDensity * FOG_EXTINCTION * dz);

  // 2. That near slab is lit, and its glow fills in over the body. Scaled by how much of
  //    the volume's depth the slab occupies, so a body at the back of the fog is covered
  //    by the whole lit column and one at the glass by none of it.
  vec3 fogNear = F.rgb * saturate(dz / max(uFogDepth, 1e-3));

  // 3. Radiance at the back face: the full fog where there is no person, and the occluder
  //    plus its own near slab where there is.
  vec3 behind = mix(F.rgb, uSilhouetteColor * Tbody + fogNear * (1.0 - Tbody), cov);

  // 4. Beer-Lambert darkening at the pane itself. Skin pressed on glass absorbs; this is
  //    what makes a contact patch read as a print rather than as a hole.
  behind *= mix(1.0, 1.0 - uAbsorption, con * cov);

  return behind;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float resScale = uResolution.y / 1080.0;

  // --- the pane's own surface --------------------------------------------------------
  vec4 S = texture(uScatter, vUv);
  float contact = saturate(S.b * S.r);

  // Contact wetness: skin pressed on glass is locally wet, so locally smooth. Less grain
  // and a tighter highlight exactly where a palm is touching.
  float grainLocal = uGrain * (1.0 - 0.75 * contact);

  // Micro-roughness, pinned to gl_FragCoord so it belongs to the glass and not to the
  // image behind it. UV-space noise would stretch and crawl on every resize.
  float rough = paneNoise2(px / 2.4) - 0.5;

  // Condensation: large soft blooms, drifting slowly.
  float heal = texture(uHealMask, vUv).r;
  float bloom = fbm2(px / (260.0 * resScale) + vec2(uTime * 0.013, uTime * -0.009));
  float film = uCondensation * heal * saturate(0.30 + 1.10 * bloom);
  // A palm pressed on the glass wipes the condensation off it. This is the single most
  // recognisable thing fogged glass does, and it is why a hand print reads as a window.
  film *= 1.0 - 0.90 * contact;

#if QUALITY >= 1
  // Droplets. The detail that sells it is that each one locally CLEARS the fog film -
  // uniform noise on its own just reads as dirt on the lens.
  vec4 drop = droplets(px, DROPLET_CELL_PX * resScale, uCondensation * 0.55, uTime);
  film *= 1.0 - 0.85 * drop.x;
  vec2 dropOffset = drop.yz * 0.35;
  float dropSpec = drop.w;
#else
  vec2 dropOffset = vec2(0.0);
  float dropSpec = 0.0;
#endif

  // --- sampling the world behind, through that surface --------------------------------
  // The pane's roughness displaces what you see through it by a fraction of a pixel, and
  // each droplet acts as a small lens.
  vec2 offsetPx = vec2(rough, paneNoise2(px / 2.4 + 31.7) - 0.5) * (grainLocal * 3.0) + dropOffset;
  vec2 baseUv = vUv + offsetPx / uResolution;

  vec3 behind;
#if QUALITY >= 1
  // Dispersion: the glass has a slightly different index per wavelength, so the three
  // channels arrive from marginally different directions. Radial, growing from the centre.
  vec2 radial = vUv - 0.5;
  float rFromCentre = saturate(length(radial) * 2.0);
  vec2 d = normalize(radial + 1e-6) * (uDispersion * 1.5 * resScale * rFromCentre) / uResolution;
  behind = vec3(
    behindAt(baseUv - d).r,
    behindAt(baseUv).g,
    behindAt(baseUv + d).b
  );
#else
  behind = behindAt(baseUv);
#endif

  // --- the pane as a light source ------------------------------------------------------
  // A frosted pane scatters ambient light forward. That forward scatter is why real fogged
  // glass reads as luminous milk rather than as a grey filter over the scene.
  vec3 N = vec3(0.0, 0.0, 1.0);
  float lightFacing = saturate(dot(-uLightDir, N));
  vec3 sheet = uGlassColor * uLightIntensity * (0.55 + 0.25 * lightFacing);
  // +/-6% brightness from the micro-roughness, AT grain = 1. Scaling by grainLocal is not
  // decoration: without it the modulation survives grain = 0, and the pane still carries
  // a 2.4-pixel crawl when the user has asked for perfectly smooth glass.
  sheet *= 1.0 + 0.12 * rough * grainLocal;

  // How much of the pane is sheet rather than window. A rougher, foggier pane hides more.
  // Contact clears the pane as well as smoothing it: pressed skin displaces the scattering
  // layer, which is why a print on fogged glass is a hole you can see through and not just
  // a shinier patch. Without this term the sheet floors the whole frame and a fingertip
  // cannot get below mid-grey however black the body behind it is.
  float opacity = saturate((0.16 + 0.34 * grainLocal + 0.50 * film) * (1.0 - 0.55 * contact));
  float transmit = 1.0 - 0.88 * opacity;

  vec3 col = behind * transmit + sheet * opacity;

  // --- specular ------------------------------------------------------------------------
  // Broad rough-glass lobe, plus a wet, much tighter one riding on the droplets.
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = -uLightDir;
  vec3 Hv = normalize(V + L);
  float nDotH = saturate(Hv.z);
  float roughBroad = mix(0.35, 0.85, uGrain);
  float roughWet = mix(0.22, 0.08, contact); // contact patches are smoother, so sharper
  col += uLightColor * uLightIntensity * ggxLobe(nDotH, roughBroad) * 0.05 * opacity;
  col += uLightColor * uLightIntensity * ggxLobe(nDotH, roughWet) * 0.012 * (dropSpec + contact * 0.6);

  // --- frame finish ---------------------------------------------------------------------
  col *= vignetteAt(vUv, uVignette);
  col = toneMap(col);

  // Film grain AFTER the tone step, and rolled off in the highlights - full-strength grain
  // on a white pane fizzes, and the pane is the brightest thing in the frame.
  float lum = luminance(col);
  float grainRoll = 1.0 - smoothstep(0.55, 1.0, lum);
  float fg = (hash12(px + floor(uTime * 60.0) * 17.0) - 0.5) * uFilmGrain * 0.09;
  col += fg * grainRoll;

  col = linearToSRGB(saturate(col));

  // 8-bit ordered dither. The pane is a wide, shallow gradient, which is the worst case
  // for quantisation; without this it bands, invisibly on a laptop panel and glaringly on
  // a projector.
  col += (bayer8(px) - 0.5) / 255.0;

  fragColor = vec4(col, 1.0);
}
